import { describe, expect, it } from 'vitest';

import { parseSchema, type ParseResult } from '../../src/parser/engine';
import type { InterfaceModel, SchemaDocument, TypeAliasModel } from '../../src/types/ipc';

function ok(result: ParseResult): SchemaDocument {
  if (result.status !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result.document;
}

function model<K extends 'interface' | 'typeAlias'>(
  doc: SchemaDocument,
  id: string,
  kind: K,
): K extends 'interface' ? InterfaceModel : TypeAliasModel {
  const found = doc.models.find((m) => m.id === id);
  if (found?.kind !== kind) throw new Error(`model ${id} (${kind}) not found`);
  return found as K extends 'interface' ? InterfaceModel : TypeAliasModel;
}

describe('parseSchema — interfaces', () => {
  it('extracts properties with modifiers, docs and positions', () => {
    const doc = ok(
      parseSchema(
        'user.ts',
        `/** A user. */
export interface User {
  readonly id: string;
  /** Display name */
  name?: string;
  /** @deprecated use tags */
  labels: string[];
}`,
      ),
    );
    const user = model(doc, 'User', 'interface');
    expect(user.exported).toBe(true);
    expect(user.docs).toBe('A user.');
    expect(user.position).toEqual({ line: 1, character: 17 });
    expect(user.members).toMatchObject([
      { kind: 'property', name: 'id', type: 'string', readonly: true, optional: false },
      { kind: 'property', name: 'name', optional: true, docs: 'Display name' },
      { kind: 'property', name: 'labels', type: 'string[]', deprecated: true },
    ]);
  });

  it('handles methods, index/call/construct signatures and accessors', () => {
    const doc = ok(
      parseSchema(
        'x.ts',
        `interface Repo<T> {
  find<K extends keyof T>(key: K): Promise<T[K]>;
  [key: string]: unknown;
  (input: T): void;
  new (seed: T): Repo<T>;
  get size(): number;
  get mode(): string;
  set mode(v: string);
}`,
      ),
    );
    const repo = model(doc, 'Repo', 'interface');
    expect(repo.exported).toBe(false);
    expect(repo.typeParameters).toEqual([{ name: 'T' }]);
    expect(repo.members.map((m) => [m.kind, m.name])).toEqual([
      ['method', 'find'],
      ['index', '[key: string]'],
      ['call', '()'],
      ['construct', 'new ()'],
      ['property', 'size'],
      ['property', 'mode'],
    ]);
    expect(repo.members[0]?.type).toBe('<K extends keyof T>(key: K) => Promise<T[K]>');
    expect(repo.members[0]?.typeRefs).toEqual(['Promise']); // T and K excluded
    expect(repo.members[4]).toMatchObject({ readonly: true });
    expect(repo.members[5]).toMatchObject({ readonly: false, type: 'string' });
  });

  it('merges interface declarations and builds extends / reference relations', () => {
    const doc = ok(
      parseSchema(
        'x.ts',
        `interface Base { id: string }
interface Tag { label: string }
interface Post extends Base { tags: Array<Tag> }
interface Post { parent?: Post }`,
      ),
    );
    const post = model(doc, 'Post', 'interface');
    expect(post.declarationCount).toBe(2);
    expect(post.members.map((m) => m.name)).toEqual(['tags', 'parent']);
    expect(doc.relations).toEqual([
      { kind: 'extends', from: 'Post', to: 'Base' },
      { kind: 'references', from: 'Post', to: 'Tag', via: 'tags' },
      { kind: 'references', from: 'Post', to: 'Post', via: 'parent' },
    ]);
  });

  it('normalises multi-line types', () => {
    const doc = ok(parseSchema('x.ts', `interface A {\n  cfg: {\n    a: number;\n    b: string\n  }\n}`));
    expect(model(doc, 'A', 'interface').members[0]?.type).toBe('{ a: number; b: string }');
  });
});

describe('parseSchema — type aliases', () => {
  it('accepts object literals and intersections, rejects non-object aliases', () => {
    const doc = ok(
      parseSchema(
        'x.ts',
        `interface Base { id: string }
type Timestamps = { createdAt: Date };
type Entity = Base & (Timestamps & { version: number });
type Id = string;
type Status = 'on' | 'off';
type Alias = Base;
type Mapped = { [K in keyof Base]: boolean };`,
      ),
    );
    expect(doc.models.map((m) => m.id)).toEqual(['Base', 'Timestamps', 'Entity']);
    const entity = model(doc, 'Entity', 'typeAlias');
    expect(entity.intersects.map((h) => h.name)).toEqual(['Base', 'Timestamps']);
    expect(entity.members.map((m) => m.name)).toEqual(['version']);
    expect(doc.relations).toEqual([
      { kind: 'intersects', from: 'Entity', to: 'Base' },
      { kind: 'intersects', from: 'Entity', to: 'Timestamps' },
    ]);
  });
});

describe('parseSchema — scoping and exports', () => {
  it('qualifies namespaces and resolves innermost-first', () => {
    const doc = ok(
      parseSchema(
        'x.ts',
        `interface Item { root: true }
export namespace Api.V1 {
  export interface Item { id: string }
  export interface Order { items: Item[] }
}`,
      ),
    );
    expect(doc.models.map((m) => m.id)).toEqual(['Item', 'Api.V1.Item', 'Api.V1.Order']);
    expect(doc.relations).toEqual([
      { kind: 'references', from: 'Api.V1.Order', to: 'Api.V1.Item', via: 'items' },
    ]);
  });

  it('detects `export { A }` and can filter non-exported models', () => {
    const src = `interface A { x: 1 }\ninterface B { y: 2 }\nexport { A };`;
    expect(model(ok(parseSchema('x.ts', src)), 'A', 'interface').exported).toBe(true);
    const onlyExported = ok(parseSchema('x.ts', src, { includeNonExported: false }));
    expect(onlyExported.models.map((m) => m.id)).toEqual(['A']);
  });
});

describe('parseSchema — isolation & error boundaries', () => {
  it('ignores unresolvable imports (monorepo safety)', () => {
    const doc = ok(
      parseSchema(
        'C:\\repo\\packages\\app\\src\\models.ts',
        `import type { Remote } from '@acme/does-not-exist';
import { Other } from '../../../../nowhere';
export interface Local { remote: Remote; other: Other }`,
      ),
    );
    const local = model(doc, 'Local', 'interface');
    expect(local.members.flatMap((m) => m.typeRefs)).toEqual(['Remote', 'Other']);
    expect(doc.relations).toEqual([]); // external symbols never become edges
    expect(doc.fileName).toBe('C:\\repo\\packages\\app\\src\\models.ts');
  });

  it('parses TSX files', () => {
    const doc = ok(
      parseSchema(
        'Button.tsx',
        `export interface ButtonProps { label: string }
export const Button = (p: ButtonProps) => <button>{p.label}</button>;`,
      ),
    );
    expect(doc.models.map((m) => m.id)).toEqual(['ButtonProps']);
  });

  it('reports syntax errors with positions and still returns a partial document', () => {
    const result = parseSchema('broken.ts', `interface Ok { a: string }\ninterface Broken {\n  b: string\n  c: \n`);
    expect(result.status).toBe('syntaxError');
    if (result.status !== 'syntaxError') return;
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0]).toMatchObject({ code: expect.any(Number), start: { line: expect.any(Number) } });
    expect(result.partial.models.map((m) => m.id)).toContain('Ok');
  });

  it('never throws on garbage input', () => {
    for (const src of ['', '}}}{{{', 'interface', 'type = & & {', '\u0000\uFFFF']) {
      const result = parseSchema('x.ts', src);
      expect(['ok', 'syntaxError']).toContain(result.status);
    }
  });
});
