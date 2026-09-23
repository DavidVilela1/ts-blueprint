// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InterfaceModel, SchemaDocument, SourcePosition } from '../../src/types/ipc';
import { createRenderer, DEFAULT_PREFERENCES, type Renderer, type RendererCallbacks } from '../../src/webview/renderer';

const pos = (line: number, character = 0): SourcePosition => ({ line, character });

function iface(id: string, overrides: Partial<InterfaceModel> = {}): InterfaceModel {
  return {
    kind: 'interface',
    id,
    name: id,
    namespace: [],
    exported: true,
    typeParameters: [],
    extends: [],
    members: [],
    declarationCount: 1,
    deprecated: false,
    position: pos(0),
    ...overrides,
  };
}

function doc(models: SchemaDocument['models'], relations: SchemaDocument['relations'] = []): SchemaDocument {
  return {
    fileName: '/repo/src/models.ts',
    models,
    relations,
    stats: { modelCount: models.length, memberCount: models.reduce((n, m) => n + m.members.length, 0), parseTimeMs: 1.5 },
  };
}

const SAMPLE = doc(
  [
    iface('User', {
      members: [
        { kind: 'property', name: 'id', type: 'string', typeRefs: [], optional: false, readonly: true, deprecated: false, position: pos(1, 2) },
        { kind: 'property', name: 'posts', type: 'Post[]', typeRefs: ['Post'], optional: true, readonly: false, deprecated: false, position: pos(2, 2) },
      ],
    }),
    iface('Post', {
      exported: false,
      members: [{ kind: 'property', name: 'title', type: 'string', typeRefs: [], optional: false, readonly: false, deprecated: false, position: pos(5, 2) }],
    }),
  ],
  [{ kind: 'references', from: 'User', to: 'Post', via: 'posts' }],
);

describe('renderer', () => {
  let root: HTMLElement;
  let callbacks: { [K in keyof RendererCallbacks]: ReturnType<typeof vi.fn> };
  let renderer: Renderer;

  beforeEach(() => {
    document.body.replaceChildren();
    root = document.createElement('div');
    document.body.append(root);
    callbacks = {
      onReveal: vi.fn(),
      onRefresh: vi.fn(),
      onPreferencesChange: vi.fn(),
      onCollapsedChange: vi.fn(),
    };
    renderer = createRenderer(root, callbacks as unknown as RendererCallbacks);
  });

  afterEach(() => renderer.dispose());

  const cards = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('.tsb-card')];
  const visibleCards = (): HTMLElement[] => cards().filter((c) => !c.hidden);

  it('renders idle instructions and hides the toolbar', () => {
    renderer.render({ kind: 'idle', reason: 'noModels', fileName: 'empty.ts' });
    expect(root.querySelector('.tsb-empty-title')?.textContent).toBe('No models in empty.ts');
    expect(root.querySelector<HTMLElement>('.tsb-toolbar')?.hidden).toBe(true);
  });

  it('renders one card per model with members and relation chips', () => {
    renderer.render({ kind: 'schema', document: SAMPLE });
    expect(cards()).toHaveLength(2);
    expect(root.querySelector('.tsb-file')?.textContent).toBe('models.ts');
    const names = [...root.querySelectorAll('.tsb-member-name')].map((n) => n.textContent);
    expect(names).toEqual(['id', 'posts', 'title']);
    expect(root.querySelector('.tsb-chip--small')?.textContent).toBe('→ Post');
    expect(root.querySelector('.tsb-relation-row--incoming')?.textContent).toContain('User');
  });

  it('never interprets source text as HTML', () => {
    const evil = '<img src=x onerror="alert(1)">';
    renderer.render({
      kind: 'schema',
      document: doc([
        iface(evil, {
          members: [{ kind: 'property', name: evil, type: `<script>alert(1)</script>`, typeRefs: [], optional: false, readonly: false, deprecated: false, position: pos(0) }],
          docs: '<b>bold</b>',
        }),
      ]),
    });
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('script')).toBeNull();
    expect(root.querySelector('b')).toBeNull();
    expect(root.querySelector('.tsb-name')?.textContent).toBe(evil);
  });

  it('collapses and expands a card from its header', () => {
    renderer.render({ kind: 'schema', document: SAMPLE });
    const toggle = root.querySelector<HTMLButtonElement>('.tsb-card-toggle')!;
    const body = root.querySelector<HTMLElement>('.tsb-card-body')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(body.hidden).toBe(true);
    expect(callbacks.onCollapsedChange).toHaveBeenLastCalledWith(['User']);

    toggle.querySelector<HTMLElement>('.tsb-name')!.click(); // clicks on inner spans bubble to the toggle
    expect(body.hidden).toBe(false);
  });

  it('reuses unchanged card nodes across updates', () => {
    renderer.render({ kind: 'schema', document: SAMPLE });
    const [userBefore, postBefore] = cards();
    const changedPost = { ...SAMPLE.models[1]!, docs: 'changed' } as InterfaceModel;
    renderer.render({ kind: 'schema', document: doc([SAMPLE.models[0]!, changedPost], SAMPLE.relations) });
    const [userAfter, postAfter] = cards();
    expect(userAfter).toBe(userBefore);
    expect(postAfter).not.toBe(postBefore);
  });

  it('filters by query, kind and export state', () => {
    renderer.render({ kind: 'schema', document: SAMPLE });
    renderer.setPreferences({ ...DEFAULT_PREFERENCES, query: 'title' });
    expect(visibleCards().map((c) => c.querySelector('.tsb-name')?.textContent)).toEqual(['Post']);
    expect(root.querySelector('.tsb-member.tsb-match .tsb-member-name')?.textContent).toBe('title');

    renderer.setPreferences({ ...DEFAULT_PREFERENCES, exportedOnly: true });
    expect(visibleCards()).toHaveLength(1);

    renderer.setPreferences({ ...DEFAULT_PREFERENCES, kindFilter: 'typeAlias' });
    expect(visibleCards()).toHaveLength(0);
    expect(root.querySelector('.tsb-empty-title')?.textContent).toBe('No models match your filters');
  });

  it('reports reveal requests with source positions', () => {
    renderer.render({ kind: 'schema', document: SAMPLE });
    root.querySelectorAll<HTMLButtonElement>('.tsb-member-name')[1]!.click();
    expect(callbacks.onReveal).toHaveBeenCalledWith(pos(2, 2));
  });

  it('shows syntax diagnostics with clickable locations and a partial blueprint', () => {
    renderer.render({
      kind: 'syntaxError',
      fileName: '/repo/src/broken.ts',
      diagnostics: [{ message: "';' expected.", code: 1005, start: pos(9, 4), length: 1 }],
      partial: SAMPLE,
    });
    const banner = root.querySelector<HTMLElement>('.tsb-banner')!;
    expect(banner.hidden).toBe(false);
    expect(banner.classList.contains('tsb-banner--warning')).toBe(true);
    expect(banner.textContent).toContain('1 syntax error in broken.ts');
    const location = banner.querySelector<HTMLButtonElement>('.tsb-diagnostic-location')!;
    expect(location.textContent).toBe('Ln 10, Col 5');
    location.click();
    expect(callbacks.onReveal).toHaveBeenCalledWith(pos(9, 4));
    expect(root.querySelector('.tsb-models')?.classList.contains('tsb-partial')).toBe(true);

    renderer.render({ kind: 'schema', document: SAMPLE });
    expect(banner.hidden).toBe(true);
  });

  it('keeps the last blueprint visible (stale) on internal errors', () => {
    renderer.render({ kind: 'schema', document: SAMPLE });
    renderer.render({ kind: 'internalError', fileName: 'models.ts', message: 'boom' });
    expect(cards()).toHaveLength(2);
    expect(root.querySelector('.tsb-models')?.classList.contains('tsb-stale')).toBe(true);
    root.querySelector<HTMLButtonElement>('.tsb-banner .tsb-button')!.click();
    expect(callbacks.onRefresh).toHaveBeenCalled();
  });
});
