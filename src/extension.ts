/**
 * TSBlueprint — Extension Host entrypoint (Node.js context).
 *
 * Responsibilities:
 *  - Single-instance Webview panel lifecycle (create / reveal / dispose).
 *  - Tracking the active TypeScript document and re-parsing it on a 300 ms trailing debounce.
 *  - Translating parser results into strict `HostToWebviewMessage`s.
 *  - Validating every inbound `WebviewToHostMessage` (the Webview is an untrusted boundary).
 *  - Serving Webview HTML under a strict, nonce-based Content Security Policy.
 *
 * Nothing in this file may be imported by the Webview bundle; the only shared module is
 * `types/ipc.ts`, which has no runtime dependencies.
 */
import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';

import * as vscode from 'vscode';

import { parseSchema } from './parser/engine';
import {
  dispatchMessage,
  isWebviewToHostMessage,
  type HostToWebviewMessage,
  type IdleReason,
  type MessageHandlers,
  type MessageOfType,
  type WebviewToHostMessage,
} from './types/ipc';

/* ============================================================================================
 * Constants
 * ========================================================================================== */

const COMMAND_OPEN_PREVIEW = 'tsblueprint.openPreview';
const VIEW_TYPE = 'tsblueprint.preview';
const PANEL_TITLE_PREFIX = 'Blueprint';
const DEBOUNCE_MS = 300;

/** Language ids VS Code assigns to `.ts` and `.tsx` files. */
const SUPPORTED_LANGUAGE_IDS: ReadonlySet<string> = new Set(['typescript', 'typescriptreact']);
/** Must stay in sync with the `when` clauses in package.json. */
const SUPPORTED_EXTENSIONS: readonly string[] = ['.ts', '.tsx'];
/**
 * URI schemes that represent real, user-editable documents. Everything else (output channels,
 * git/diff views, settings, SCM input) is ignored so it cannot hijack the blueprint.
 */
const TRACKABLE_SCHEMES: ReadonlySet<string> = new Set([
  'file',
  'untitled',
  'vscode-remote',
  'vscode-vfs',
  'vscode-userdata',
]);

/* ============================================================================================
 * Utilities
 * ========================================================================================== */

/**
 * Trailing-edge debouncer. Each `schedule()` resets the window; the callback runs once the
 * caller has been quiet for `delayMs`. Disposing cancels any pending run and makes the
 * instance inert, so a timer can never fire into a disposed panel.
 */
class Debouncer implements vscode.Disposable {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  public constructor(
    private readonly delayMs: number,
    private readonly callback: () => void,
  ) {}

  public get isPending(): boolean {
    return this.timer !== undefined;
  }

  public schedule(): void {
    if (this.disposed) return;
    this.cancel();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.disposed) this.callback();
    }, this.delayMs);
  }

  public cancel(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** Runs a pending callback immediately (no-op when nothing is pending). */
  public flush(): void {
    if (!this.isPending) return;
    this.cancel();
    this.callback();
  }

  public dispose(): void {
    this.disposed = true;
    this.cancel();
  }
}

function createNonce(): string {
  return randomBytes(16).toString('hex');
}

function escapeHtml(value: string): string {
  let out = '';
  for (const ch of value) {
    switch (ch) {
      case '&':
        out += '&amp;';
        break;
      case '<':
        out += '&lt;';
        break;
      case '>':
        out += '&gt;';
        break;
      case '"':
        out += '&quot;';
        break;
      case "'":
        out += '&#39;';
        break;
      default:
        out += ch;
    }
  }
  return out;
}

function documentBaseName(document: vscode.TextDocument): string {
  return document.isUntitled ? document.uri.path : posix.basename(document.uri.path);
}

function isTrackableDocument(document: vscode.TextDocument): boolean {
  return TRACKABLE_SCHEMES.has(document.uri.scheme);
}

function isSupportedDocument(document: vscode.TextDocument): boolean {
  if (!isTrackableDocument(document) || !SUPPORTED_LANGUAGE_IDS.has(document.languageId)) {
    return false;
  }
  // Untitled buffers have no extension; the language id is the only signal available.
  if (document.isUntitled) return true;
  const path = document.uri.path.toLowerCase();
  return SUPPORTED_EXTENSIONS.some((ext) => path.endsWith(ext));
}

function sameUri(a: vscode.Uri, b: vscode.Uri): boolean {
  return a.toString() === b.toString();
}

/* ============================================================================================
 * Blueprint panel (singleton)
 * ========================================================================================== */

class BlueprintPanel implements vscode.Disposable {
  private static current: BlueprintPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private readonly debouncer: Debouncer;

  /** The document currently rendered. Survives focus moving into the Webview itself. */
  private trackedDocument: vscode.TextDocument | undefined;
  /** Last message posted; replayed when the Webview (re)loads and sends `webview/ready`. */
  private lastMessage: HostToWebviewMessage | undefined;
  /** Identity of the last parsed snapshot, used to skip redundant re-parses. */
  private lastRenderedKey: string | undefined;
  private webviewReady = false;
  private disposed = false;

  /**
   * Opens the panel, or reveals the existing one. `targetUri` is supplied when the command is
   * invoked from the editor title button; otherwise the active editor is used.
   */
  public static createOrShow(
    extensionUri: vscode.Uri,
    log: vscode.LogOutputChannel,
    targetUri: vscode.Uri | undefined,
  ): void {
    const document = BlueprintPanel.resolveTargetDocument(targetUri);

    if (BlueprintPanel.current !== undefined) {
      BlueprintPanel.current.reveal();
      if (document !== undefined) BlueprintPanel.current.track(document);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      PANEL_TITLE_PREFIX,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        enableCommandUris: false,
        enableFindWidget: true,
        // The Webview re-syncs through the `webview/ready` handshake, so there is no need to
        // pay the memory cost of keeping a hidden Webview alive.
        retainContextWhenHidden: false,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],
      },
    );

    BlueprintPanel.current = new BlueprintPanel(panel, extensionUri, log);
    BlueprintPanel.current.track(document);
  }

  public static disposeCurrent(): void {
    BlueprintPanel.current?.dispose();
  }

  private static resolveTargetDocument(targetUri: vscode.Uri | undefined): vscode.TextDocument | undefined {
    if (targetUri !== undefined) {
      const open = vscode.workspace.textDocuments.find((d) => sameUri(d.uri, targetUri));
      if (open !== undefined) return open;
    }
    return vscode.window.activeTextEditor?.document;
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.debouncer = new Debouncer(DEBOUNCE_MS, () => this.renderTracked(false));
    this.disposables.push(this.debouncer);

    this.panel.webview.html = this.buildHtml(this.panel.webview);

    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),

      this.panel.webview.onDidReceiveMessage((raw: unknown) => this.onWebviewMessage(raw)),

      // With `retainContextWhenHidden: false` a hidden Webview is torn down; hold messages
      // until it reloads and sends `webview/ready` again.
      this.panel.onDidChangeViewState(({ webviewPanel }) => {
        if (!webviewPanel.visible) this.webviewReady = false;
      }),

      vscode.workspace.onDidChangeTextDocument((event) => this.onDocumentChanged(event)),

      vscode.window.onDidChangeActiveTextEditor((editor) => this.onActiveEditorChanged(editor)),

      vscode.workspace.onDidCloseTextDocument((document) => this.onDocumentClosed(document)),

      // Changing a document's language mode closes and reopens it with a new language id.
      vscode.workspace.onDidOpenTextDocument((document) => {
        const active = vscode.window.activeTextEditor?.document;
        if (active !== undefined && active === document) this.track(document);
      }),
    );
  }

  /* ---------------------------------------------------------------------------------------
   * Lifecycle
   * ------------------------------------------------------------------------------------- */

  public reveal(): void {
    this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Beside, true);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    BlueprintPanel.current = undefined;

    // Dispose listeners and the debouncer first so nothing can post into a dead Webview.
    while (this.disposables.length > 0) {
      const disposable = this.disposables.pop();
      try {
        disposable?.dispose();
      } catch (error: unknown) {
        this.log.error('Failed to dispose resource', error);
      }
    }
    // Safe when disposal was triggered by the user closing the panel (dispose is idempotent).
    this.panel.dispose();

    this.trackedDocument = undefined;
    this.lastMessage = undefined;
    this.lastRenderedKey = undefined;
    this.log.info('Blueprint panel disposed; all listeners released.');
  }

  /* ---------------------------------------------------------------------------------------
   * Document tracking
   * ------------------------------------------------------------------------------------- */

  /** Switches the blueprint to `document` (or to an idle state when it is unusable). */
  private track(document: vscode.TextDocument | undefined): void {
    if (this.disposed) return;
    this.debouncer.cancel();

    if (document === undefined) {
      if (this.trackedDocument === undefined) this.postIdle('noActiveEditor');
      return;
    }

    if (!isSupportedDocument(document)) {
      this.trackedDocument = undefined;
      this.lastRenderedKey = undefined;
      this.setTitle(undefined);
      this.postIdle('unsupportedLanguage', documentBaseName(document));
      return;
    }

    const switched = this.trackedDocument === undefined || !sameUri(this.trackedDocument.uri, document.uri);
    this.trackedDocument = document;
    if (switched) this.setTitle(document);
    this.renderTracked(false);
  }

  private onActiveEditorChanged(editor: vscode.TextEditor | undefined): void {
    // `undefined` also fires when focus moves into the Webview itself; keep the current
    // blueprint in that case instead of blanking it.
    if (editor === undefined) return;
    // Output channels, diff views, etc. must not steal the blueprint.
    if (!isTrackableDocument(editor.document)) return;
    this.track(editor.document);
  }

  private onDocumentChanged(event: vscode.TextDocumentChangeEvent): void {
    const tracked = this.trackedDocument;
    if (tracked === undefined || !sameUri(event.document.uri, tracked.uri)) return;
    // Dirty-state flips fire with an empty change list; nothing to re-parse.
    if (event.contentChanges.length === 0) return;
    this.debouncer.schedule();
  }

  private onDocumentClosed(document: vscode.TextDocument): void {
    const tracked = this.trackedDocument;
    if (tracked === undefined || !sameUri(document.uri, tracked.uri)) return;

    this.debouncer.cancel();
    this.trackedDocument = undefined;
    this.lastRenderedKey = undefined;
    this.setTitle(undefined);

    const active = vscode.window.activeTextEditor;
    if (active !== undefined && isTrackableDocument(active.document) && active.document !== document) {
      this.track(active.document);
    } else {
      this.postIdle('noActiveEditor');
    }
  }

  /* ---------------------------------------------------------------------------------------
   * Parsing → IPC
   * ------------------------------------------------------------------------------------- */

  /**
   * Parses the tracked document and posts the resulting message. The parser never throws by
   * contract, but this method is still an error boundary: a failure here must never take down
   * the extension host or leave the Webview in an inconsistent state.
   */
  private renderTracked(force: boolean): void {
    const document = this.trackedDocument;
    if (this.disposed || document === undefined) return;
    if (document.isClosed) {
      this.onDocumentClosed(document);
      return;
    }

    const uri = document.uri.toString();
    const version = document.version;
    const renderKey = `${uri}@${version}`;
    if (!force && renderKey === this.lastRenderedKey) return;

    const fileName = documentBaseName(document);
    try {
      const result = parseSchema(document.fileName, document.getText());
      this.lastRenderedKey = renderKey;

      switch (result.status) {
        case 'ok':
          if (result.document.models.length === 0) {
            this.postIdle('noModels', fileName);
          } else {
            this.post({ type: 'schema/update', payload: { uri, version, document: result.document } });
          }
          break;
        case 'syntaxError':
          this.post({
            type: 'schema/syntaxError',
            payload: {
              uri,
              version,
              fileName,
              diagnostics: result.diagnostics,
              partial: result.partial,
            },
          });
          break;
        case 'internalError':
          this.log.error(`Parser internal error in ${fileName}: ${result.message}`);
          this.post({ type: 'schema/internalError', payload: { uri, version, fileName, message: result.message } });
          break;
        default: {
          const exhaustive: never = result;
          throw new Error(`Unhandled parse result: ${JSON.stringify(exhaustive)}`);
        }
      }
    } catch (error: unknown) {
      // Do not cache the key: the next edit or a manual refresh must retry.
      this.lastRenderedKey = undefined;
      const message = error instanceof Error ? error.message : String(error);
      this.log.error(`Failed to render blueprint for ${fileName}`, error);
      this.post({ type: 'schema/internalError', payload: { uri, version, fileName, message } });
    }
  }

  private postIdle(reason: IdleReason, fileName?: string): void {
    this.post({
      type: 'schema/idle',
      payload: fileName !== undefined ? { reason, fileName } : { reason },
    });
  }

  /**
   * Posts a message to the Webview. Always remembered as `lastMessage` so a reloading Webview
   * can be re-synchronised; only actually sent once the Webview has announced it is ready.
   */
  private post(message: HostToWebviewMessage): void {
    if (this.disposed) return;
    this.lastMessage = message;
    if (!this.webviewReady) return;

    this.panel.webview.postMessage(message).then(
      (delivered) => {
        if (!delivered && !this.disposed) this.log.warn(`Webview did not accept '${message.type}'.`);
      },
      (error: unknown) => this.log.error(`postMessage '${message.type}' failed`, error),
    );
  }

  /* ---------------------------------------------------------------------------------------
   * Webview → Host
   * ------------------------------------------------------------------------------------- */

  private readonly webviewHandlers: MessageHandlers<WebviewToHostMessage> = {
    'webview/ready': () => this.onWebviewReady(),
    'webview/requestRefresh': () => this.renderTracked(true),
    'webview/revealPosition': (message) => {
      void this.revealPosition(message);
    },
    'webview/log': (message) => {
      const { level, message: text } = message.payload;
      const line = `[webview] ${text}`;
      if (level === 'error') this.log.error(line);
      else if (level === 'warn') this.log.warn(line);
      else this.log.info(line);
    },
  };

  private onWebviewMessage(raw: unknown): void {
    if (this.disposed) return;
    if (!isWebviewToHostMessage(raw)) {
      this.log.warn('Rejected malformed message from Webview.');
      return;
    }
    dispatchMessage(raw, this.webviewHandlers);
  }

  /** The Webview (re)loaded: typically first open, or re-shown after being hidden. */
  private onWebviewReady(): void {
    this.webviewReady = true;
    if (this.trackedDocument !== undefined) {
      // A pending edit is rendered right away instead of waiting out the debounce window.
      if (this.debouncer.isPending) {
        this.debouncer.flush();
        return;
      }
      this.renderTracked(true);
      return;
    }
    if (this.lastMessage !== undefined) this.post(this.lastMessage);
    else this.postIdle('noActiveEditor');
  }

  private async revealPosition(message: MessageOfType<WebviewToHostMessage, 'webview/revealPosition'>): Promise<void> {
    const tracked = this.trackedDocument;
    // Only the document being displayed may be navigated; never open arbitrary URIs on
    // behalf of the Webview.
    if (tracked === undefined || tracked.isClosed || tracked.uri.toString() !== message.payload.uri) {
      this.log.warn('Ignored reveal request for a document that is not being tracked.');
      return;
    }

    const position = tracked.validatePosition(
      new vscode.Position(message.payload.position.line, message.payload.position.character),
    );
    const selection = new vscode.Range(position, position);
    const existing = vscode.window.visibleTextEditors.find((e) => sameUri(e.document.uri, tracked.uri));

    try {
      const editor = await vscode.window.showTextDocument(tracked, {
        viewColumn: existing?.viewColumn ?? vscode.ViewColumn.One,
        selection,
        preserveFocus: false,
        preview: false,
      });
      editor.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    } catch (error: unknown) {
      this.log.error('Failed to reveal position in source', error);
    }
  }

  /* ---------------------------------------------------------------------------------------
   * Presentation
   * ------------------------------------------------------------------------------------- */

  private setTitle(document: vscode.TextDocument | undefined): void {
    if (this.disposed) return;
    this.panel.title =
      document === undefined ? PANEL_TITLE_PREFIX : `${PANEL_TITLE_PREFIX}: ${documentBaseName(document)}`;
  }

  /**
   * Webview shell. The UI itself is rendered by `dist/webview.js` (browser bundle).
   *
   * CSP:
   *  - `default-src 'none'`     → deny everything not explicitly allowed (fetch, frames, media, …).
   *  - `script-src 'nonce-…'`   → only the single <script> tag below, loaded from the extension's
   *                               own `dist` folder (enforced again by `localResourceRoots`).
   *                               No inline handlers, no eval, no remote scripts.
   *  - `style-src`              → the extension's stylesheet plus one nonce'd inline block.
   *  - `img-src` / `font-src`   → local resources only (+ data: images for inline SVG icons).
   *  - `base-uri` / `form-action 'none'` → no base-tag hijacking, no form submissions.
   */
  private buildHtml(webview: vscode.Webview): string {
    const nonce = createNonce();
    const distRoot = vscode.Uri.joinPath(this.extensionUri, 'dist');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distRoot, 'webview.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(distRoot, 'webview.css'));
    const source = webview.cspSource;

    const csp = [
      `default-src 'none'`,
      `script-src 'nonce-${nonce}'`,
      `style-src ${source} 'nonce-${nonce}'`,
      `img-src ${source} data:`,
      `font-src ${source}`,
      `base-uri 'none'`,
      `form-action 'none'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(PANEL_TITLE_PREFIX)}</title>
  <link rel="stylesheet" href="${escapeHtml(styleUri.toString())}">
  <style nonce="${nonce}">
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      padding: 0;
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    #tsb-boot {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      color: var(--vscode-descriptionForeground);
    }
  </style>
</head>
<body>
  <div id="root" data-debounce-ms="${DEBOUNCE_MS}">
    <div id="tsb-boot" role="status" aria-live="polite">Loading blueprint…</div>
  </div>
  <script nonce="${nonce}" src="${escapeHtml(scriptUri.toString())}"></script>
</body>
</html>`;
  }
}

/* ============================================================================================
 * Activation
 * ========================================================================================== */

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('TSBlueprint', { log: true });
  context.subscriptions.push(log);

  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_OPEN_PREVIEW, (uri?: unknown) => {
      // The editor-title button passes the resource URI; the Command Palette passes nothing.
      const targetUri = uri instanceof vscode.Uri ? uri : undefined;
      BlueprintPanel.createOrShow(context.extensionUri, log, targetUri);
    }),
    // Guarantees the panel and its listeners are released if the extension is deactivated.
    { dispose: () => BlueprintPanel.disposeCurrent() },
  );

  log.info('TSBlueprint activated.');
}

export function deactivate(): void {
  BlueprintPanel.disposeCurrent();
}
