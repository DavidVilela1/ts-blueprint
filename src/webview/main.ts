/**
 * TSBlueprint — Webview entrypoint (browser context).
 *
 * Bundled by esbuild into `dist/webview.js` (IIFE, platform=browser). It may import only:
 *  - `../types/ipc`   (types + dependency-free helpers shared with the host)
 *  - `./renderer`     (DOM rendering)
 *  - `./styles.css`   (emitted as `dist/webview.css`)
 * Importing `vscode`, `typescript` or any Node built-in fails the build (see esbuild.mjs).
 */
import './styles.css';

import {
  dispatchMessage,
  type DocumentRef,
  type HostToWebviewMessage,
  type LogLevel,
  type MessageHandlers,
  type SourcePosition,
  type WebviewToHostMessage,
} from '../types/ipc';
import {
  createRenderer,
  DEFAULT_PREFERENCES,
  KIND_FILTERS,
  type KindFilter,
  type Renderer,
  type ViewPreferences,
} from './renderer';

/* ============================================================================================
 * VS Code Webview API (typed to our contract)
 * ========================================================================================== */

interface VsCodeApi<State> {
  postMessage(message: WebviewToHostMessage): void;
  getState(): unknown;
  setState(state: State): State;
}

declare function acquireVsCodeApi<State>(): VsCodeApi<State>;

/* ============================================================================================
 * Persisted UI state (survives the Webview being hidden and reloaded)
 * ========================================================================================== */

const STATE_VERSION = 1;
const MAX_REMEMBERED_DOCUMENTS = 50;

interface PersistedState {
  readonly version: typeof STATE_VERSION;
  readonly preferences: ViewPreferences;
  /** Collapsed model ids per document URI, most recently used last. */
  readonly collapsedByUri: ReadonlyArray<readonly [uri: string, ids: readonly string[]]>;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

const KIND_FILTER_SET: ReadonlySet<string> = new Set<KindFilter>(KIND_FILTERS);

/** getState() returns whatever an older build stored: validate everything, keep what is valid. */
function readPersistedState(raw: unknown): PersistedState {
  const fallback: PersistedState = { version: STATE_VERSION, preferences: DEFAULT_PREFERENCES, collapsedByUri: [] };
  if (!isRecord(raw) || raw.version !== STATE_VERSION) return fallback;

  const prefs = isRecord(raw.preferences) ? raw.preferences : {};
  const preferences: ViewPreferences = {
    query: typeof prefs.query === 'string' ? prefs.query : DEFAULT_PREFERENCES.query,
    kindFilter:
      typeof prefs.kindFilter === 'string' && KIND_FILTER_SET.has(prefs.kindFilter)
        ? (prefs.kindFilter as KindFilter)
        : DEFAULT_PREFERENCES.kindFilter,
    exportedOnly: typeof prefs.exportedOnly === 'boolean' ? prefs.exportedOnly : DEFAULT_PREFERENCES.exportedOnly,
  };

  const collapsedByUri: Array<readonly [string, readonly string[]]> = [];
  if (Array.isArray(raw.collapsedByUri)) {
    for (const entry of raw.collapsedByUri as unknown[]) {
      if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && isStringArray(entry[1])) {
        collapsedByUri.push([entry[0], entry[1]]);
      }
    }
  }
  return { version: STATE_VERSION, preferences, collapsedByUri: collapsedByUri.slice(-MAX_REMEMBERED_DOCUMENTS) };
}

/* ============================================================================================
 * Inbound message guard
 * ========================================================================================== */

/** Compile-time exhaustive: adding a host message type without listing it here is an error. */
const HOST_MESSAGE_TYPES: Readonly<Record<HostToWebviewMessage['type'], true>> = {
  'schema/update': true,
  'schema/syntaxError': true,
  'schema/internalError': true,
  'schema/idle': true,
};

/**
 * Structural check on the discriminant. The host is trusted, but `message` events can in
 * principle come from other sources, so anything unrecognised is ignored.
 */
function isHostMessage(value: unknown): value is HostToWebviewMessage {
  return (
    isRecord(value) &&
    typeof value.type === 'string' &&
    Object.prototype.hasOwnProperty.call(HOST_MESSAGE_TYPES, value.type) &&
    (value.type === 'schema/idle' || isRecord(value.payload))
  );
}

/* ============================================================================================
 * Application
 * ========================================================================================== */

class BlueprintClient {
  private readonly vscode: VsCodeApi<PersistedState>;
  private readonly renderer: Renderer;
  private readonly collapsedByUri: Map<string, readonly string[]>;
  private preferences: ViewPreferences;
  /** Document currently displayed; used to drop out-of-order updates and to scope reveals. */
  private current: DocumentRef | undefined;

  public constructor(root: HTMLElement) {
    this.vscode = acquireVsCodeApi<PersistedState>();
    const persisted = readPersistedState(this.vscode.getState());
    this.preferences = persisted.preferences;
    this.collapsedByUri = new Map(persisted.collapsedByUri);

    this.renderer = createRenderer(
      root,
      {
        onReveal: (position) => this.reveal(position),
        onRefresh: () => this.post({ type: 'webview/requestRefresh' }),
        onPreferencesChange: (preferences) => {
          this.preferences = preferences;
          this.persist();
        },
        onCollapsedChange: (ids) => {
          if (this.current === undefined) return;
          this.rememberCollapsed(this.current.uri, ids);
          this.persist();
        },
      },
      { preferences: this.preferences },
    );
    this.renderer.render({ kind: 'loading' });
  }

  public start(): void {
    window.addEventListener('message', this.onMessage);
    window.addEventListener('error', this.onError);
    window.addEventListener('unhandledrejection', this.onUnhandledRejection);
    // Handshake: the host replays the latest state as soon as it sees this.
    this.post({ type: 'webview/ready' });
  }

  /* ------------------------------------------------------------------ inbound -------- */

  private readonly handlers: MessageHandlers<HostToWebviewMessage> = {
    'schema/update': ({ payload }) => {
      if (!this.accept(payload)) return;
      this.renderer.render({ kind: 'schema', document: payload.document });
    },
    'schema/syntaxError': ({ payload }) => {
      if (!this.accept(payload)) return;
      this.renderer.render({
        kind: 'syntaxError',
        fileName: payload.fileName,
        diagnostics: payload.diagnostics,
        partial: payload.partial,
      });
    },
    'schema/internalError': ({ payload }) => {
      if (!this.accept(payload)) return;
      this.renderer.render({ kind: 'internalError', fileName: payload.fileName, message: payload.message });
    },
    'schema/idle': ({ payload }) => {
      this.current = undefined;
      this.renderer.render(
        payload.fileName !== undefined
          ? { kind: 'idle', reason: payload.reason, fileName: payload.fileName }
          : { kind: 'idle', reason: payload.reason },
      );
    },
  };

  private readonly onMessage = (event: MessageEvent<unknown>): void => {
    const data = event.data;
    if (!isHostMessage(data)) return;
    try {
      dispatchMessage(data, this.handlers);
    } catch (error: unknown) {
      this.log('error', `Failed to handle '${data.type}': ${describeError(error)}`);
    }
  };

  /**
   * Version gate. Same document → only newer-or-equal versions (equal = forced refresh).
   * Different document → always accepted; restores that document's collapsed state.
   */
  private accept(ref: DocumentRef): boolean {
    const current = this.current;
    if (current !== undefined && current.uri === ref.uri) {
      if (ref.version < current.version) return false;
    } else {
      this.renderer.setCollapsed(this.collapsedByUri.get(ref.uri) ?? []);
    }
    this.current = { uri: ref.uri, version: ref.version };
    return true;
  }

  /* ------------------------------------------------------------------ outbound ------- */

  private reveal(position: SourcePosition): void {
    if (this.current === undefined) return;
    this.post({ type: 'webview/revealPosition', payload: { uri: this.current.uri, position } });
  }

  private post(message: WebviewToHostMessage): void {
    this.vscode.postMessage(message);
  }

  private log(level: LogLevel, message: string): void {
    this.post({ type: 'webview/log', payload: { level, message } });
  }

  private readonly onError = (event: ErrorEvent): void => {
    this.log('error', `${event.message} (${event.filename}:${event.lineno}:${event.colno})`);
  };

  private readonly onUnhandledRejection = (event: PromiseRejectionEvent): void => {
    this.log('error', `Unhandled rejection: ${describeError(event.reason)}`);
  };

  /* ------------------------------------------------------------------ persistence ---- */

  private rememberCollapsed(uri: string, ids: readonly string[]): void {
    // Re-insert to mark as most recently used; evict the oldest beyond the cap.
    this.collapsedByUri.delete(uri);
    if (ids.length > 0) this.collapsedByUri.set(uri, [...ids]);
    while (this.collapsedByUri.size > MAX_REMEMBERED_DOCUMENTS) {
      const oldest = this.collapsedByUri.keys().next();
      if (oldest.done === true) break;
      this.collapsedByUri.delete(oldest.value);
    }
  }

  private persist(): void {
    this.vscode.setState({
      version: STATE_VERSION,
      preferences: this.preferences,
      collapsedByUri: [...this.collapsedByUri],
    });
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/* ============================================================================================
 * Boot
 * ========================================================================================== */

function boot(): void {
  const root = document.getElementById('root');
  if (root === null) {
    // The host HTML always provides #root; failing loudly here surfaces template regressions.
    acquireVsCodeApi<PersistedState>().postMessage({
      type: 'webview/log',
      payload: { level: 'error', message: 'TSBlueprint: #root element missing from Webview HTML.' },
    });
    return;
  }
  new BlueprintClient(root).start();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
