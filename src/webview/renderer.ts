/**
 * TSBlueprint — Webview renderer (browser context).
 *
 * A self-contained DOM module: it knows nothing about `acquireVsCodeApi` or message transport.
 * `main.ts` feeds it `ViewState`s and receives user intents through `RendererCallbacks`.
 *
 * Security: the DOM is built exclusively with `createElement` + `textContent` / `setAttribute`.
 * `innerHTML`, `outerHTML`, `insertAdjacentHTML` and `document.write` are never used, so type
 * text, member names and diagnostics coming from the user's source file cannot inject markup.
 *
 * Performance:
 *  - Keyed reconciliation: each model card is cached by id with a content signature. On every
 *    update only changed cards are rebuilt; unchanged cards are reused and only re-ordered.
 *  - Filtering and collapsing toggle `hidden` / classes on existing nodes — no rebuilds.
 *  - Filter input is coalesced to one pass per animation frame.
 *  - One delegated click listener; action payloads live in a WeakMap (no data-* parsing).
 */
import type {
  HeritageRef,
  IdleReason,
  MemberSchema,
  ParseDiagnostic,
  SchemaDocument,
  SchemaModel,
  SchemaRelation,
  SourcePosition,
  TypeParameterSchema,
} from '../types/ipc';

/* ============================================================================================
 * Public API
 * ========================================================================================== */

export type ViewState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'idle'; readonly reason: IdleReason; readonly fileName?: string }
  | { readonly kind: 'schema'; readonly document: SchemaDocument }
  | {
      readonly kind: 'syntaxError';
      readonly fileName: string;
      readonly diagnostics: readonly ParseDiagnostic[];
      readonly partial: SchemaDocument;
    }
  | { readonly kind: 'internalError'; readonly fileName: string; readonly message: string };

export type KindFilter = 'all' | 'interface' | 'typeAlias';

export const KIND_FILTERS: readonly KindFilter[] = ['all', 'interface', 'typeAlias'];

export interface ViewPreferences {
  readonly query: string;
  readonly kindFilter: KindFilter;
  readonly exportedOnly: boolean;
}

export const DEFAULT_PREFERENCES: ViewPreferences = {
  query: '',
  kindFilter: 'all',
  exportedOnly: false,
};

export interface RendererCallbacks {
  /** User asked to navigate to a location in the tracked source file. */
  readonly onReveal: (position: SourcePosition) => void;
  /** User asked the host to re-parse the current file. */
  readonly onRefresh: () => void;
  /** Filter preferences changed (for persistence). */
  readonly onPreferencesChange: (preferences: ViewPreferences) => void;
  /** The set of collapsed model ids for the current document changed (for persistence). */
  readonly onCollapsedChange: (collapsedIds: readonly string[]) => void;
}

export interface RendererOptions {
  readonly preferences?: ViewPreferences;
  readonly collapsed?: Iterable<string>;
}

export interface Renderer {
  render(view: ViewState): void;
  /** Replaces the collapsed set, e.g. when the host switches to another document. */
  setCollapsed(ids: Iterable<string>): void;
  /** Replaces filter preferences and re-applies them synchronously. */
  setPreferences(preferences: ViewPreferences): void;
  getPreferences(): ViewPreferences;
  dispose(): void;
}

/* ============================================================================================
 * Internal types
 * ========================================================================================== */

type Action =
  | { readonly type: 'toggle'; readonly modelId: string }
  | { readonly type: 'reveal'; readonly position: SourcePosition }
  | { readonly type: 'jump'; readonly modelId: string }
  | { readonly type: 'setKind'; readonly kind: KindFilter }
  | { readonly type: 'expandAll' }
  | { readonly type: 'collapseAll' }
  | { readonly type: 'clearFilters' }
  | { readonly type: 'refresh' };

interface MemberRow {
  readonly element: HTMLElement;
  readonly searchText: string;
}

interface Card {
  readonly id: string;
  readonly model: SchemaModel;
  readonly signature: string;
  readonly element: HTMLElement;
  readonly toggle: HTMLButtonElement;
  readonly body: HTMLElement;
  readonly matchBadge: HTMLElement;
  readonly searchText: string;
  readonly rows: readonly MemberRow[];
}

interface CardRelations {
  readonly incoming: readonly SchemaRelation[];
  readonly heritageTargets: readonly string[];
  /** member name → local model ids referenced by that member */
  readonly memberTargets: ReadonlyMap<string, readonly string[]>;
}

const MAX_DIAGNOSTICS_SHOWN = 10;
const FLASH_MS = 1200;

const KIND_LABELS: Readonly<Record<KindFilter, string>> = {
  all: 'All',
  interface: 'Interfaces',
  typeAlias: 'Types',
};

const IDLE_COPY: Readonly<Record<IdleReason, { readonly title: (file?: string) => string; readonly detail: string }>> = {
  noActiveEditor: {
    title: () => 'Open a TypeScript file',
    detail: 'Open a .ts or .tsx file in the editor and its interfaces and object types will appear here.',
  },
  unsupportedLanguage: {
    title: (file) => (file !== undefined ? `${file} is not a TypeScript file` : 'Unsupported file'),
    detail: 'TSBlueprint visualises .ts and .tsx files. Switch to one to see its blueprint.',
  },
  noModels: {
    title: (file) => (file !== undefined ? `No models in ${file}` : 'No models yet'),
    detail: 'Declare an interface or an object type alias and it will appear here as you type.',
  },
};

/* ============================================================================================
 * DOM helpers (text-only, never HTML)
 * ========================================================================================== */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return path.slice(cut + 1);
}

function formatTypeParameter(p: TypeParameterSchema): string {
  let text = p.name;
  if (p.constraint !== undefined) text += ` extends ${p.constraint}`;
  if (p.default !== undefined) text += ` = ${p.default}`;
  return text;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else if (!list.includes(value)) list.push(value);
}

/** Picks the relation target matching a heritage clause name (`Base` ↔ `Ns.Base`). */
function resolveHeritageTarget(ref: HeritageRef, targets: readonly string[]): string | undefined {
  return targets.find((id) => id === ref.name || id.endsWith(`.${ref.name}`));
}

/* ============================================================================================
 * Renderer
 * ========================================================================================== */

export function createRenderer(
  root: HTMLElement,
  callbacks: RendererCallbacks,
  options: RendererOptions = {},
): Renderer {
  let preferences: ViewPreferences = { ...(options.preferences ?? DEFAULT_PREFERENCES) };
  let collapsed = new Set<string>(options.collapsed ?? []);
  let cards = new Map<string, Card>();
  let totalModels = 0;
  let baseStats = '';
  let frameHandle: number | undefined;
  let bodyCounter = 0;
  let disposed = false;

  const actions = new WeakMap<Element, Action>();

  const bind = <T extends HTMLElement>(node: T, action: Action): T => {
    actions.set(node, action);
    return node;
  };

  const button = (className: string, label: string, action: Action, title?: string): HTMLButtonElement => {
    const node = el('button', className, label);
    node.type = 'button';
    if (title !== undefined) {
      node.title = title;
      node.setAttribute('aria-label', title);
    }
    return bind(node, action);
  };

  /* ------------------------------------------------------------------ static shell ---- */

  root.replaceChildren();
  root.classList.add('tsb-app');

  const toolbar = el('header', 'tsb-toolbar');
  const titleRow = el('div', 'tsb-title-row');
  const fileLabel = el('h1', 'tsb-file');
  const statsLabel = el('span', 'tsb-stats');
  statsLabel.setAttribute('aria-live', 'polite');
  const refreshButton = button('tsb-icon-button', '↻', { type: 'refresh' }, 'Re-parse file');
  titleRow.append(fileLabel, statsLabel, refreshButton);

  const controls = el('div', 'tsb-controls');
  const searchInput = el('input', 'tsb-search');
  searchInput.type = 'search';
  searchInput.placeholder = 'Filter models and members';
  searchInput.setAttribute('aria-label', 'Filter models and members');
  searchInput.spellcheck = false;
  searchInput.autocomplete = 'off';

  const kindGroup = el('div', 'tsb-segmented');
  kindGroup.setAttribute('role', 'group');
  kindGroup.setAttribute('aria-label', 'Model kind');
  const kindButtons = new Map<KindFilter, HTMLButtonElement>();
  for (const kind of KIND_FILTERS) {
    const b = button('tsb-segment', KIND_LABELS[kind], { type: 'setKind', kind });
    kindButtons.set(kind, b);
    kindGroup.append(b);
  }

  const exportedLabel = el('label', 'tsb-checkbox');
  const exportedInput = el('input');
  exportedInput.type = 'checkbox';
  exportedLabel.append(exportedInput, el('span', undefined, 'Exported only'));

  const bulkGroup = el('div', 'tsb-bulk');
  bulkGroup.append(
    button('tsb-link-button', 'Expand all', { type: 'expandAll' }),
    button('tsb-link-button', 'Collapse all', { type: 'collapseAll' }),
  );

  controls.append(searchInput, kindGroup, exportedLabel, bulkGroup);
  toolbar.append(titleRow, controls);

  const banner = el('section', 'tsb-banner');
  banner.setAttribute('role', 'alert');

  const content = el('main', 'tsb-content');
  const emptyState = el('div', 'tsb-empty');
  const list = el('div', 'tsb-models');
  content.append(emptyState, list);

  root.append(toolbar, banner, content);

  /* ---------------------------------------------------------------- event wiring ------ */

  const onClick = (event: MouseEvent): void => {
    let node: Element | null = event.target instanceof Element ? event.target : null;
    while (node !== null && node !== root) {
      const action = actions.get(node);
      if (action !== undefined) {
        event.preventDefault();
        handleAction(action);
        return;
      }
      node = node.parentElement;
    }
  };

  const onSearchInput = (): void => {
    preferences = { ...preferences, query: searchInput.value };
    scheduleFilters();
    callbacks.onPreferencesChange(preferences);
  };

  const onSearchKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && searchInput.value !== '') {
      event.preventDefault();
      searchInput.value = '';
      onSearchInput();
    }
  };

  const onExportedChange = (): void => {
    preferences = { ...preferences, exportedOnly: exportedInput.checked };
    applyFilters();
    callbacks.onPreferencesChange(preferences);
  };

  root.addEventListener('click', onClick);
  searchInput.addEventListener('input', onSearchInput);
  searchInput.addEventListener('keydown', onSearchKeyDown);
  exportedInput.addEventListener('change', onExportedChange);

  function handleAction(action: Action): void {
    switch (action.type) {
      case 'toggle': {
        const card = cards.get(action.modelId);
        if (card === undefined) return;
        if (collapsed.has(card.id)) collapsed.delete(card.id);
        else collapsed.add(card.id);
        applyExpanded(card);
        callbacks.onCollapsedChange([...collapsed]);
        return;
      }
      case 'reveal':
        callbacks.onReveal(action.position);
        return;
      case 'jump':
        jumpTo(action.modelId);
        return;
      case 'setKind':
        preferences = { ...preferences, kindFilter: action.kind };
        syncControls();
        applyFilters();
        callbacks.onPreferencesChange(preferences);
        return;
      case 'expandAll':
        for (const id of cards.keys()) collapsed.delete(id);
        for (const card of cards.values()) applyExpanded(card);
        callbacks.onCollapsedChange([...collapsed]);
        return;
      case 'collapseAll':
        for (const id of cards.keys()) collapsed.add(id);
        for (const card of cards.values()) applyExpanded(card);
        callbacks.onCollapsedChange([...collapsed]);
        return;
      case 'clearFilters':
        preferences = { ...DEFAULT_PREFERENCES };
        syncControls();
        applyFilters();
        callbacks.onPreferencesChange(preferences);
        searchInput.focus();
        return;
      case 'refresh':
        callbacks.onRefresh();
        return;
      default: {
        const exhaustive: never = action;
        throw new Error(`Unhandled action ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  /* ---------------------------------------------------------------- view states ------- */

  function render(view: ViewState): void {
    if (disposed) return;
    switch (view.kind) {
      case 'loading':
        clearDocument();
        hideBanner();
        showEmpty('Loading blueprint…');
        return;
      case 'idle': {
        clearDocument();
        hideBanner();
        const copy = IDLE_COPY[view.reason];
        showEmpty(copy.title(view.fileName), copy.detail);
        return;
      }
      case 'schema':
        hideBanner();
        showDocument(view.document, false);
        return;
      case 'syntaxError':
        showSyntaxBanner(view.fileName, view.diagnostics);
        showDocument(view.partial, true);
        return;
      case 'internalError':
        showInternalErrorBanner(view.fileName, view.message);
        if (cards.size > 0) {
          // Keep the last good blueprint visible, visibly marked as stale.
          list.classList.add('tsb-stale');
        } else {
          toolbar.hidden = true;
          showEmpty('Blueprint unavailable', 'Details were written to the TSBlueprint output channel.');
        }
        return;
      default: {
        const exhaustive: never = view;
        throw new Error(`Unhandled view ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  function clearDocument(): void {
    cards = new Map();
    totalModels = 0;
    list.replaceChildren();
    list.hidden = true;
    toolbar.hidden = true;
  }

  function showEmpty(title: string, detail?: string, withClearFilters = false): void {
    const children: HTMLElement[] = [el('h2', 'tsb-empty-title', title)];
    if (detail !== undefined) children.push(el('p', 'tsb-empty-detail', detail));
    if (withClearFilters) children.push(button('tsb-button', 'Clear filters', { type: 'clearFilters' }));
    emptyState.replaceChildren(...children);
    emptyState.hidden = false;
  }

  function hideEmpty(): void {
    emptyState.hidden = true;
    emptyState.replaceChildren();
  }

  function hideBanner(): void {
    banner.hidden = true;
    banner.className = 'tsb-banner';
    banner.replaceChildren();
  }

  function showSyntaxBanner(fileName: string, diagnostics: readonly ParseDiagnostic[]): void {
    banner.className = 'tsb-banner tsb-banner--warning';
    const heading = el(
      'h2',
      'tsb-banner-title',
      `${plural(diagnostics.length, 'syntax error')} in ${baseName(fileName)}`,
    );
    const detail = el('p', 'tsb-banner-detail', 'Showing a partial blueprint until the file parses cleanly.');
    const items = el('ul', 'tsb-diagnostics');
    for (const d of diagnostics.slice(0, MAX_DIAGNOSTICS_SHOWN)) {
      const item = el('li', 'tsb-diagnostic');
      const location = button(
        'tsb-diagnostic-location',
        `Ln ${d.start.line + 1}, Col ${d.start.character + 1}`,
        { type: 'reveal', position: d.start },
        `Go to line ${d.start.line + 1}`,
      );
      item.append(location, el('span', 'tsb-diagnostic-message', d.message), el('span', 'tsb-diagnostic-code', `TS${d.code}`));
      items.append(item);
    }
    const children: HTMLElement[] = [heading, detail, items];
    if (diagnostics.length > MAX_DIAGNOSTICS_SHOWN) {
      children.push(el('p', 'tsb-banner-detail', `and ${diagnostics.length - MAX_DIAGNOSTICS_SHOWN} more`));
    }
    banner.replaceChildren(...children);
    banner.hidden = false;
  }

  function showInternalErrorBanner(fileName: string, message: string): void {
    banner.className = 'tsb-banner tsb-banner--error';
    banner.replaceChildren(
      el('h2', 'tsb-banner-title', `Could not build the blueprint for ${baseName(fileName)}`),
      el('p', 'tsb-banner-detail', message),
      button('tsb-button', 'Try again', { type: 'refresh' }),
    );
    banner.hidden = false;
  }

  function showDocument(doc: SchemaDocument, partial: boolean): void {
    toolbar.hidden = false;
    list.hidden = false;
    list.classList.remove('tsb-stale');
    list.classList.toggle('tsb-partial', partial);
    fileLabel.textContent = baseName(doc.fileName);
    fileLabel.title = doc.fileName;
    totalModels = doc.models.length;
    baseStats = `${plural(doc.stats.modelCount, 'model')} · ${plural(doc.stats.memberCount, 'member')} · ${doc.stats.parseTimeMs} ms`;
    reconcile(doc);
    syncControls();
    applyFilters();
  }

  /* ---------------------------------------------------------------- reconciliation ---- */

  function reconcile(doc: SchemaDocument): void {
    const incoming = new Map<string, SchemaRelation[]>();
    const heritage = new Map<string, string[]>();
    const memberTargets = new Map<string, Map<string, string[]>>();

    for (const relation of doc.relations) {
      if (relation.from !== relation.to) {
        const bucket = incoming.get(relation.to);
        if (bucket === undefined) incoming.set(relation.to, [relation]);
        else bucket.push(relation);
      }
      if (relation.kind === 'references') {
        if (relation.via === undefined) continue;
        let byMember = memberTargets.get(relation.from);
        if (byMember === undefined) {
          byMember = new Map();
          memberTargets.set(relation.from, byMember);
        }
        pushTo(byMember, relation.via, relation.to);
      } else {
        pushTo(heritage, relation.from, relation.to);
      }
    }

    const next = new Map<string, Card>();
    for (const model of doc.models) {
      const relations: CardRelations = {
        incoming: incoming.get(model.id) ?? [],
        heritageTargets: heritage.get(model.id) ?? [],
        memberTargets: memberTargets.get(model.id) ?? new Map(),
      };
      const signature = JSON.stringify([model, relations.incoming, relations.heritageTargets, [...relations.memberTargets]]);
      const existing = cards.get(model.id);
      next.set(model.id, existing !== undefined && existing.signature === signature ? existing : buildCard(model, relations, signature));
    }

    // 1. Drop nodes that are gone or were rebuilt.
    for (const [id, card] of cards) {
      if (next.get(id) !== card) card.element.remove();
    }
    // 2. Place nodes in document order, touching the DOM only where order differs.
    let index = 0;
    for (const card of next.values()) {
      const current = list.children[index] ?? null;
      if (current !== card.element) list.insertBefore(card.element, current);
      applyExpanded(card);
      index++;
    }
    cards = next;
  }

  function buildCard(model: SchemaModel, relations: CardRelations, signature: string): Card {
    const isInterface = model.kind === 'interface';
    const article = el('article', `tsb-card tsb-card--${isInterface ? 'interface' : 'type'}`);
    if (model.deprecated) article.classList.add('tsb-deprecated');

    const bodyId = `tsb-body-${++bodyCounter}`;

    /* header */
    const header = el('header', 'tsb-card-header');
    const toggle = el('button', 'tsb-card-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-controls', bodyId);
    bind(toggle, { type: 'toggle', modelId: model.id });

    const chevron = el('span', 'tsb-chevron');
    chevron.setAttribute('aria-hidden', 'true');
    const kindBadge = el('span', 'tsb-kind', isInterface ? 'interface' : 'type');
    toggle.append(chevron, kindBadge);
    if (model.namespace.length > 0) toggle.append(el('span', 'tsb-namespace', `${model.namespace.join('.')}.`));
    toggle.append(el('span', 'tsb-name', model.name));
    if (model.typeParameters.length > 0) {
      toggle.append(el('span', 'tsb-type-params', `<${model.typeParameters.map(formatTypeParameter).join(', ')}>`));
    }
    const count = el('span', 'tsb-count', String(model.members.length));
    count.title = plural(model.members.length, 'member');
    toggle.append(count);

    const flags = el('span', 'tsb-flags');
    if (model.exported) flags.append(el('span', 'tsb-flag', 'export'));
    if (model.kind === 'interface' && model.declarationCount > 1) {
      const merged = el('span', 'tsb-flag', `merged ×${model.declarationCount}`);
      merged.title = 'Declaration merging: this interface is declared more than once';
      flags.append(merged);
    }
    if (model.deprecated) flags.append(el('span', 'tsb-flag tsb-flag--warning', 'deprecated'));

    const matchBadge = el('span', 'tsb-match-badge');
    matchBadge.hidden = true;

    const revealButton = button('tsb-icon-button', '↗', { type: 'reveal', position: model.position }, `Go to ${model.name} in source`);
    header.append(toggle, flags, matchBadge, revealButton);

    /* body */
    const body = el('div', 'tsb-card-body');
    body.id = bodyId;

    if (model.docs !== undefined) body.append(el('p', 'tsb-docs', model.docs));

    const heritageRefs = model.kind === 'interface' ? model.extends : model.intersects;
    if (heritageRefs.length > 0) {
      const row = el('div', 'tsb-relation-row');
      row.append(el('span', 'tsb-relation-label', isInterface ? 'extends' : 'intersects'));
      for (const ref of heritageRefs) {
        const target = resolveHeritageTarget(ref, relations.heritageTargets);
        row.append(
          target !== undefined
            ? button('tsb-chip tsb-chip--link', ref.text, { type: 'jump', modelId: target }, `Show ${target}`)
            : externalChip(ref.text),
        );
      }
      body.append(row);
    }

    const rows: MemberRow[] = [];
    if (model.members.length === 0) {
      body.append(el('p', 'tsb-muted', 'No members'));
    } else {
      const members = el('ul', 'tsb-members');
      for (const member of model.members) {
        const row = buildMemberRow(member, relations.memberTargets.get(member.name) ?? []);
        members.append(row);
        rows.push({ element: row, searchText: member.name.toLowerCase() });
      }
      body.append(members);
    }

    const usedBy = [...new Set(relations.incoming.map((r) => r.from))];
    if (usedBy.length > 0) {
      const row = el('div', 'tsb-relation-row tsb-relation-row--incoming');
      row.append(el('span', 'tsb-relation-label', 'used by'));
      for (const from of usedBy) row.append(button('tsb-chip tsb-chip--link', from, { type: 'jump', modelId: from }, `Show ${from}`));
      body.append(row);
    }

    article.append(header, body);
    return {
      id: model.id,
      model,
      signature,
      element: article,
      toggle,
      body,
      matchBadge,
      searchText: model.id.toLowerCase(),
      rows,
    };
  }

  function buildMemberRow(member: MemberSchema, targets: readonly string[]): HTMLLIElement {
    const row = el('li', `tsb-member tsb-member--${member.kind}`);
    if (member.deprecated) row.classList.add('tsb-deprecated');

    const line = el('div', 'tsb-member-line');
    const glyph = el('span', 'tsb-member-glyph');
    glyph.setAttribute('aria-hidden', 'true');
    glyph.title = member.kind;
    line.append(glyph);

    if ((member.kind === 'property' || member.kind === 'index') && member.readonly) {
      line.append(el('span', 'tsb-modifier', 'readonly'));
    }

    const name = button('tsb-member-name', member.name, { type: 'reveal', position: member.position }, `Go to ${member.name} in source`);
    line.append(name);
    if ((member.kind === 'property' || member.kind === 'method') && member.optional) {
      line.append(el('span', 'tsb-optional', '?'));
    }

    const separator = member.kind === 'property' || member.kind === 'index' ? ': ' : ' ';
    line.append(el('span', 'tsb-punct', separator));
    const type = el('span', 'tsb-type', member.type);
    type.title = member.type;
    line.append(type);

    for (const target of targets) {
      line.append(button('tsb-chip tsb-chip--link tsb-chip--small', `→ ${target}`, { type: 'jump', modelId: target }, `Show ${target}`));
    }
    row.append(line);

    if (member.docs !== undefined) row.append(el('p', 'tsb-member-docs', member.docs));
    return row;
  }

  function externalChip(text: string): HTMLElement {
    const chip = el('span', 'tsb-chip tsb-chip--external', text);
    chip.title = 'Declared outside this file';
    return chip;
  }

  /* ---------------------------------------------------------------- state appliers ---- */

  function applyExpanded(card: Card): void {
    const expanded = !collapsed.has(card.id);
    card.toggle.setAttribute('aria-expanded', String(expanded));
    card.body.hidden = !expanded;
    card.element.classList.toggle('tsb-collapsed', !expanded);
  }

  function syncControls(): void {
    if (searchInput.value !== preferences.query) searchInput.value = preferences.query;
    exportedInput.checked = preferences.exportedOnly;
    for (const [kind, b] of kindButtons) b.setAttribute('aria-pressed', String(kind === preferences.kindFilter));
  }

  function isFiltering(): boolean {
    return preferences.query.trim() !== '' || preferences.kindFilter !== 'all' || preferences.exportedOnly;
  }

  function scheduleFilters(): void {
    if (frameHandle !== undefined) return;
    frameHandle = window.requestAnimationFrame(() => {
      frameHandle = undefined;
      applyFilters();
    });
  }

  function applyFilters(): void {
    if (frameHandle !== undefined) {
      window.cancelAnimationFrame(frameHandle);
      frameHandle = undefined;
    }
    const query = preferences.query.trim().toLowerCase();
    let visible = 0;

    for (const card of cards.values()) {
      const kindOk = preferences.kindFilter === 'all' || card.model.kind === preferences.kindFilter;
      const exportOk = !preferences.exportedOnly || card.model.exported;
      let matches = 0;
      let show = kindOk && exportOk;

      if (show && query !== '') {
        const nameMatch = card.searchText.includes(query);
        for (const row of card.rows) {
          const hit = row.searchText.includes(query);
          row.element.classList.toggle('tsb-match', hit);
          if (hit) matches++;
        }
        show = nameMatch || matches > 0;
      } else {
        for (const row of card.rows) row.element.classList.remove('tsb-match');
      }

      card.element.hidden = !show;
      card.matchBadge.hidden = !(show && matches > 0);
      card.matchBadge.textContent = matches > 0 ? plural(matches, 'match', 'matches') : '';
      if (show) visible++;
    }

    statsLabel.textContent = isFiltering() ? `Showing ${visible} of ${totalModels} · ${baseStats}` : baseStats;

    if (totalModels > 0 && visible === 0) {
      showEmpty('No models match your filters', undefined, true);
    } else {
      hideEmpty();
    }
  }

  function jumpTo(modelId: string): void {
    const card = cards.get(modelId);
    if (card === undefined) return;

    if (card.element.hidden) {
      preferences = { ...DEFAULT_PREFERENCES };
      syncControls();
      applyFilters();
      callbacks.onPreferencesChange(preferences);
    }
    if (collapsed.delete(card.id)) {
      applyExpanded(card);
      callbacks.onCollapsedChange([...collapsed]);
    }

    if (typeof card.element.scrollIntoView === 'function') {
      card.element.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    }
    card.toggle.focus({ preventScroll: true });

    card.element.classList.remove('tsb-flash');
    // Force a reflow so re-adding the class restarts the animation.
    void card.element.offsetWidth;
    card.element.classList.add('tsb-flash');
    window.setTimeout(() => card.element.classList.remove('tsb-flash'), FLASH_MS);
  }

  /* ---------------------------------------------------------------- initial paint ----- */

  syncControls();
  toolbar.hidden = true;
  list.hidden = true;
  hideBanner();

  return {
    render,
    setCollapsed(ids: Iterable<string>): void {
      collapsed = new Set(ids);
      for (const card of cards.values()) applyExpanded(card);
    },
    setPreferences(next: ViewPreferences): void {
      preferences = { ...next };
      syncControls();
      applyFilters();
    },
    getPreferences(): ViewPreferences {
      return preferences;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (frameHandle !== undefined) window.cancelAnimationFrame(frameHandle);
      root.removeEventListener('click', onClick);
      searchInput.removeEventListener('input', onSearchInput);
      searchInput.removeEventListener('keydown', onSearchKeyDown);
      exportedInput.removeEventListener('change', onExportedChange);
      cards.clear();
      root.replaceChildren();
    },
  };
}
