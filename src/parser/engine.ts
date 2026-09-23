/**
 * TSBlueprint — AST extraction engine.
 *
 * Pure function of (fileName, sourceText) → ParseResult.
 * - No `vscode` import: unit-testable with vitest, reusable from a CLI or LSP later.
 * - No regular expressions: every decision is taken on TypeScript AST nodes.
 * - Monorepo-safe: the file is parsed in total isolation. No module resolution, no lib files,
 *   no filesystem access — unresolved imports and path aliases cannot break parsing.
 */
import * as ts from 'typescript';

import type {
  CallMember,
  HeritageRef,
  IndexMember,
  InterfaceModel,
  MemberSchema,
  MethodMember,
  ParseDiagnostic,
  PropertyMember,
  SchemaDocument,
  SchemaModel,
  SchemaRelation,
  SourcePosition,
  TypeAliasModel,
  TypeParameterSchema,
} from '../types/ipc';

/* ============================================================================================
 * Public API
 * ========================================================================================== */

export type ParseResult =
  | { readonly status: 'ok'; readonly document: SchemaDocument }
  | {
      readonly status: 'syntaxError';
      readonly diagnostics: readonly ParseDiagnostic[];
      /** Best-effort extraction: TS's parser is error-tolerant, so we still get a usable tree. */
      readonly partial: SchemaDocument;
    }
  | { readonly status: 'internalError'; readonly message: string };

export interface ParseOptions {
  /** Include non-exported declarations. Default: true. */
  readonly includeNonExported?: boolean;
  /** Cap on diagnostics returned for broken files. Default: 20. */
  readonly maxDiagnostics?: number;
}

/**
 * Parse a single TypeScript/TSX source text and extract interfaces and object-shaped type aliases.
 * Never throws: every failure mode is represented in the returned union.
 */
export function parseSchema(
  fileName: string,
  sourceText: string,
  options: ParseOptions = {},
): ParseResult {
  const startedAt = performance.now();
  try {
    const sourceFile = ts.createSourceFile(
      toVirtualFileName(fileName),
      sourceText,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true, // required by the JSDoc helpers
      scriptKindFor(fileName),
    );

    const extracted = extractModels(sourceFile, options.includeNonExported ?? true);
    const relations = buildRelations(extracted);
    const models = extracted.map((e) => e.model);

    const document: SchemaDocument = {
      fileName,
      models,
      relations,
      stats: {
        modelCount: models.length,
        memberCount: models.reduce((sum, m) => sum + m.members.length, 0),
        parseTimeMs: roundMs(performance.now() - startedAt),
      },
    };

    const diagnostics = getSyntacticDiagnostics(sourceFile, options.maxDiagnostics ?? 20);
    return diagnostics.length > 0
      ? { status: 'syntaxError', diagnostics, partial: document }
      : { status: 'ok', document };
  } catch (error: unknown) {
    return {
      status: 'internalError',
      message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }
}

/* ============================================================================================
 * Isolation & diagnostics
 * ========================================================================================== */

/**
 * The parser only sees a synthetic, platform-neutral path. This guarantees that nothing
 * depends on the real location (Windows drive letters, symlinked workspaces, monorepo roots),
 * while preserving the extension so `.d.ts` / `.tsx` semantics stay correct.
 */
const VIRTUAL_ROOT = '/__tsblueprint__/';

function baseName(fileName: string): string {
  const cut = Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\'));
  const name = fileName.slice(cut + 1);
  return name.length > 0 ? name : 'untitled.ts';
}

function toVirtualFileName(fileName: string): string {
  return VIRTUAL_ROOT + baseName(fileName);
}

function scriptKindFor(fileName: string): ts.ScriptKind {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.tsx')) return ts.ScriptKind.TSX;
  return ts.ScriptKind.TS;
}

/**
 * Syntactic diagnostics through the PUBLIC API, without touching the disk:
 * a throwaway Program over an in-memory host that knows exactly one file,
 * with `noResolve` + `noLib` so imports and lib.d.ts are never looked up.
 * `getSyntacticDiagnostics` does no type-checking, so this stays cheap.
 */
function getSyntacticDiagnostics(sourceFile: ts.SourceFile, max: number): ParseDiagnostic[] {
  const target = sourceFile.fileName;
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === target ? sourceFile : undefined),
    fileExists: (name) => name === target,
    readFile: () => undefined,
    writeFile: () => undefined,
    getDefaultLibFileName: () => VIRTUAL_ROOT + 'lib.d.ts',
    getCurrentDirectory: () => VIRTUAL_ROOT,
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
  };
  const program = ts.createProgram({
    rootNames: [target],
    options: { noResolve: true, noLib: true, types: [], noEmit: true },
    host,
  });

  return program
    .getSyntacticDiagnostics(sourceFile)
    .slice(0, max)
    .map((d): ParseDiagnostic => {
      const start = d.start ?? 0;
      return {
        message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
        code: d.code,
        start: toPosition(sourceFile, start),
        length: d.length ?? 0,
      };
    });
}

/* ============================================================================================
 * Model extraction
 * ========================================================================================== */

/** Internal carrier: the public model plus data needed for relation building only. */
interface ExtractedModel {
  model: SchemaModel;
  /** Type names referenced at model level (type args of heritage clauses). */
  readonly modelRefs: Set<string>;
}

interface Scope {
  readonly namespace: readonly string[];
  /** Whether declarations in this scope are visible outside the file. */
  readonly exportedByDefault: boolean;
}

function extractModels(sourceFile: ts.SourceFile, includeNonExported: boolean): ExtractedModel[] {
  const byId = new Map<string, ExtractedModel>();
  const namedExports = collectNamedExports(sourceFile);

  const visitStatements = (statements: ts.NodeArray<ts.Statement>, scope: Scope): void => {
    // Only statement lists are walked — interfaces/type aliases are always statements,
    // so we never descend into expressions, function bodies or JSX.
    for (const statement of statements) {
      if (ts.isInterfaceDeclaration(statement)) {
        const exported = isExported(statement, scope, namedExports);
        if (exported || includeNonExported) {
          addInterface(byId, statement, sourceFile, scope, exported);
        }
      } else if (ts.isTypeAliasDeclaration(statement)) {
        const exported = isExported(statement, scope, namedExports);
        if (exported || includeNonExported) {
          addTypeAlias(byId, statement, sourceFile, scope, exported);
        }
      } else if (ts.isModuleDeclaration(statement)) {
        visitModule(statement, scope);
      }
    }
  };

  const visitModule = (decl: ts.ModuleDeclaration, scope: Scope): void => {
    const namespace = [...scope.namespace, decl.name.text];
    const body = decl.body;
    if (body === undefined) return;
    // `namespace A.B.C {}` is encoded as nested ModuleDeclarations.
    if (ts.isModuleDeclaration(body)) {
      visitModule(body, { namespace, exportedByDefault: scope.exportedByDefault });
    } else if (ts.isModuleBlock(body)) {
      // Ambient `declare module 'x'` / `declare global` blocks export everything implicitly.
      const ambient = hasModifier(decl, ts.SyntaxKind.DeclareKeyword);
      visitStatements(body.statements, { namespace, exportedByDefault: ambient });
    }
  };

  visitStatements(sourceFile.statements, { namespace: [], exportedByDefault: false });
  return [...byId.values()];
}

function addInterface(
  byId: Map<string, ExtractedModel>,
  node: ts.InterfaceDeclaration,
  sf: ts.SourceFile,
  scope: Scope,
  exported: boolean,
): void {
  const id = qualify(scope.namespace, node.name.text);
  const typeParams = readTypeParameters(node.typeParameters, sf);
  const typeParamNames = new Set(typeParams.map((p) => p.name));
  const modelRefs = new Set<string>();
  const heritage: HeritageRef[] = [];

  for (const clause of node.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
    for (const expr of clause.types) {
      const name = expressionName(expr.expression);
      if (name === undefined) continue;
      heritage.push({ name, text: normalizeText(expr.getText(sf)) });
      for (const arg of expr.typeArguments ?? []) collectTypeRefs(arg, typeParamNames, modelRefs);
    }
  }

  const members = readMembers(node.members, sf, typeParamNames);
  const docInfo = readDocs(node);
  const existing = byId.get(id);

  // Interface declaration merging: `interface A {x}` + `interface A {y}` → one model.
  if (existing !== undefined && existing.model.kind === 'interface') {
    const prev = existing.model;
    existing.model = {
      ...prev,
      exported: prev.exported || exported,
      extends: dedupeHeritage([...prev.extends, ...heritage]),
      members: [...prev.members, ...members],
      declarationCount: prev.declarationCount + 1,
      deprecated: prev.deprecated || docInfo.deprecated,
    };
    for (const ref of modelRefs) existing.modelRefs.add(ref);
    return;
  }

  const model: InterfaceModel = {
    kind: 'interface',
    id: uniqueId(byId, id),
    name: node.name.text,
    namespace: scope.namespace,
    exported,
    typeParameters: typeParams,
    extends: heritage,
    members,
    declarationCount: 1,
    deprecated: docInfo.deprecated,
    position: toPosition(sf, node.name.getStart(sf)),
    ...(docInfo.docs !== undefined ? { docs: docInfo.docs } : {}),
  };
  byId.set(model.id, { model, modelRefs });
}

function addTypeAlias(
  byId: Map<string, ExtractedModel>,
  node: ts.TypeAliasDeclaration,
  sf: ts.SourceFile,
  scope: Scope,
  exported: boolean,
): void {
  const shape = decomposeObjectType(node.type);
  if (shape === undefined) return; // unions, primitives, mapped/conditional types: not a "model"

  const typeParams = readTypeParameters(node.typeParameters, sf);
  const typeParamNames = new Set(typeParams.map((p) => p.name));
  const modelRefs = new Set<string>();
  const intersects: HeritageRef[] = [];

  for (const ref of shape.references) {
    intersects.push({ name: entityNameText(ref.typeName), text: normalizeText(ref.getText(sf)) });
    for (const arg of ref.typeArguments ?? []) collectTypeRefs(arg, typeParamNames, modelRefs);
  }

  const members: MemberSchema[] = [];
  for (const literal of shape.literals) members.push(...readMembers(literal.members, sf, typeParamNames));

  const docInfo = readDocs(node);
  const model: TypeAliasModel = {
    kind: 'typeAlias',
    id: uniqueId(byId, qualify(scope.namespace, node.name.text)),
    name: node.name.text,
    namespace: scope.namespace,
    exported,
    typeParameters: typeParams,
    intersects,
    members,
    deprecated: docInfo.deprecated,
    position: toPosition(sf, node.name.getStart(sf)),
    ...(docInfo.docs !== undefined ? { docs: docInfo.docs } : {}),
  };
  byId.set(model.id, { model, modelRefs });
}

interface ObjectShape {
  readonly literals: ts.TypeLiteralNode[];
  readonly references: ts.TypeReferenceNode[];
}

/**
 * Accepts `{ ... }` and intersections composed only of type literals and type references
 * (`A & B<C> & { ... }`), unwrapping parentheses. Anything else returns `undefined`.
 */
function decomposeObjectType(type: ts.TypeNode): ObjectShape | undefined {
  const shape: ObjectShape = { literals: [], references: [] };

  const visit = (node: ts.TypeNode): boolean => {
    if (ts.isParenthesizedTypeNode(node)) return visit(node.type);
    if (ts.isTypeLiteralNode(node)) {
      shape.literals.push(node);
      return true;
    }
    if (ts.isIntersectionTypeNode(node)) return node.types.every(visit);
    if (ts.isTypeReferenceNode(node)) {
      shape.references.push(node);
      return true;
    }
    return false;
  };

  let root = type;
  while (ts.isParenthesizedTypeNode(root)) root = root.type;
  // A bare reference (`type A = B`) is a plain alias, not a model.
  if (!ts.isTypeLiteralNode(root) && !ts.isIntersectionTypeNode(root)) return undefined;
  return visit(root) ? shape : undefined;
}

/* ============================================================================================
 * Members
 * ========================================================================================== */

function readMembers(
  elements: ts.NodeArray<ts.TypeElement>,
  sf: ts.SourceFile,
  outerTypeParams: ReadonlySet<string>,
): MemberSchema[] {
  const result: MemberSchema[] = [];
  /** get/set accessor pairs collapse into a single property. */
  const accessorIndex = new Map<string, number>();

  for (const element of elements) {
    const position = toPosition(sf, element.getStart(sf));
    const docInfo = readDocs(element);
    const base = {
      deprecated: docInfo.deprecated,
      position,
      ...(docInfo.docs !== undefined ? { docs: docInfo.docs } : {}),
    };

    if (ts.isPropertySignature(element)) {
      const member: PropertyMember = {
        ...base,
        kind: 'property',
        name: propertyNameText(element.name, sf),
        type: typeText(element.type, sf),
        typeRefs: refsOf(element.type, outerTypeParams),
        optional: element.questionToken !== undefined,
        readonly: hasModifier(element, ts.SyntaxKind.ReadonlyKeyword),
      };
      result.push(member);
    } else if (ts.isMethodSignature(element)) {
      const scoped = withTypeParams(outerTypeParams, element.typeParameters);
      const member: MethodMember = {
        ...base,
        kind: 'method',
        name: propertyNameText(element.name, sf),
        type: signatureText(element, sf),
        typeRefs: signatureRefs(element, scoped),
        optional: element.questionToken !== undefined,
      };
      result.push(member);
    } else if (ts.isIndexSignatureDeclaration(element)) {
      const param = element.parameters[0];
      const keyText =
        param !== undefined
          ? `[${param.name.getText(sf)}: ${typeText(param.type, sf)}]`
          : '[key: unknown]';
      const member: IndexMember = {
        ...base,
        kind: 'index',
        name: keyText,
        type: typeText(element.type, sf),
        typeRefs: refsOf(element.type, outerTypeParams),
        readonly: hasModifier(element, ts.SyntaxKind.ReadonlyKeyword),
      };
      result.push(member);
    } else if (ts.isCallSignatureDeclaration(element) || ts.isConstructSignatureDeclaration(element)) {
      const scoped = withTypeParams(outerTypeParams, element.typeParameters);
      const isCall = ts.isCallSignatureDeclaration(element);
      const member: CallMember = {
        ...base,
        kind: isCall ? 'call' : 'construct',
        name: isCall ? '()' : 'new ()',
        type: signatureText(element, sf),
        typeRefs: signatureRefs(element, scoped),
      };
      result.push(member);
    } else if (ts.isGetAccessorDeclaration(element) || ts.isSetAccessorDeclaration(element)) {
      const name = propertyNameText(element.name, sf);
      const isGetter = ts.isGetAccessorDeclaration(element);
      const typeNode = isGetter ? element.type : element.parameters[0]?.type;
      const existingIndex = accessorIndex.get(name);
      if (existingIndex !== undefined) {
        // getter + setter → writable property; keep the getter's type if present.
        const prev = result[existingIndex] as PropertyMember;
        result[existingIndex] = {
          ...prev,
          readonly: false,
          ...(isGetter ? { type: typeText(typeNode, sf), typeRefs: refsOf(typeNode, outerTypeParams) } : {}),
        };
        continue;
      }
      accessorIndex.set(name, result.length);
      const member: PropertyMember = {
        ...base,
        kind: 'property',
        name,
        type: typeText(typeNode, sf),
        typeRefs: refsOf(typeNode, outerTypeParams),
        optional: false,
        readonly: isGetter,
      };
      result.push(member);
    }
  }
  return result;
}

type SignatureLike =
  | ts.MethodSignature
  | ts.CallSignatureDeclaration
  | ts.ConstructSignatureDeclaration;

function signatureText(node: SignatureLike, sf: ts.SourceFile): string {
  const typeParams =
    node.typeParameters !== undefined && node.typeParameters.length > 0
      ? `<${node.typeParameters.map((p) => p.getText(sf)).join(', ')}>`
      : '';
  const params = node.parameters.map((p) => normalizeText(p.getText(sf))).join(', ');
  return `${typeParams}(${params}) => ${typeText(node.type, sf)}`;
}

function signatureRefs(node: SignatureLike, typeParams: ReadonlySet<string>): string[] {
  const refs = new Set<string>();
  for (const p of node.parameters) if (p.type !== undefined) collectTypeRefs(p.type, typeParams, refs);
  if (node.type !== undefined) collectTypeRefs(node.type, typeParams, refs);
  return [...refs];
}

/* ============================================================================================
 * Type reference collection (bounded sub-tree walks)
 * ========================================================================================== */

function refsOf(type: ts.TypeNode | undefined, typeParams: ReadonlySet<string>): string[] {
  if (type === undefined) return [];
  const refs = new Set<string>();
  collectTypeRefs(type, typeParams, refs);
  return [...refs];
}

/** Walks ONLY the given type node's subtree, collecting referenced type names. */
function collectTypeRefs(root: ts.Node, typeParams: ReadonlySet<string>, out: Set<string>): void {
  const visit = (node: ts.Node): void => {
    if (ts.isTypeReferenceNode(node)) {
      const name = entityNameText(node.typeName);
      if (!typeParams.has(name)) out.add(name);
    } else if (ts.isExpressionWithTypeArguments(node)) {
      const name = expressionName(node.expression);
      if (name !== undefined && !typeParams.has(name)) out.add(name);
    } else if (ts.isTypeQueryNode(node) || ts.isImportTypeNode(node)) {
      // `typeof value` and `import('pkg').X` point outside the model graph — skip subtree.
      return;
    } else if (ts.isFunctionTypeNode(node) || ts.isConstructorTypeNode(node) || ts.isMappedTypeNode(node)) {
      // These introduce their own type parameters: extend the exclusion set for the subtree.
      const scoped = ts.isMappedTypeNode(node)
        ? new Set([...typeParams, node.typeParameter.name.text])
        : withTypeParams(typeParams, node.typeParameters);
      ts.forEachChild(node, (child) => collectTypeRefs(child, scoped, out));
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
}

function withTypeParams(
  outer: ReadonlySet<string>,
  params: ts.NodeArray<ts.TypeParameterDeclaration> | undefined,
): ReadonlySet<string> {
  if (params === undefined || params.length === 0) return outer;
  const scoped = new Set(outer);
  for (const p of params) scoped.add(p.name.text);
  return scoped;
}

/* ============================================================================================
 * Relations
 * ========================================================================================== */

function buildRelations(extracted: readonly ExtractedModel[]): SchemaRelation[] {
  const ids = new Set(extracted.map((e) => e.model.id));
  const seen = new Set<string>();
  const relations: SchemaRelation[] = [];

  const push = (relation: SchemaRelation): void => {
    const key = `${relation.kind}|${relation.from}|${relation.to}|${relation.via ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    relations.push(relation);
  };

  for (const { model, modelRefs } of extracted) {
    const resolve = (name: string): string | undefined => resolveLocal(name, model.namespace, ids);

    const heritage = model.kind === 'interface' ? model.extends : model.intersects;
    const heritageKind = model.kind === 'interface' ? 'extends' : 'intersects';
    for (const h of heritage) {
      const to = resolve(h.name);
      if (to !== undefined && to !== model.id) push({ kind: heritageKind, from: model.id, to });
    }
    for (const ref of modelRefs) {
      const to = resolve(ref);
      if (to !== undefined && to !== model.id) push({ kind: 'references', from: model.id, to });
    }
    for (const member of model.members) {
      for (const ref of member.typeRefs) {
        const to = resolve(ref);
        // Self-references (trees, linked lists) are legitimate edges.
        if (to !== undefined) push({ kind: 'references', from: model.id, to, via: member.name });
      }
    }
  }
  return relations;
}

/** TypeScript-like lookup: innermost enclosing namespace first, then outwards to the file root. */
function resolveLocal(
  name: string,
  namespace: readonly string[],
  ids: ReadonlySet<string>,
): string | undefined {
  for (let depth = namespace.length; depth >= 0; depth--) {
    const candidate = qualify(namespace.slice(0, depth), name);
    if (ids.has(candidate)) return candidate;
  }
  return undefined;
}

/* ============================================================================================
 * Small AST helpers
 * ========================================================================================== */

function collectNamedExports(sf: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  for (const statement of sf.statements) {
    // `export { A, B as C }` without a module specifier re-exports local declarations.
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier === undefined &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const spec of statement.exportClause.elements) {
        const local = spec.propertyName ?? spec.name;
        if (ts.isIdentifier(local)) names.add(local.text);
      }
    } else if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
      names.add(statement.expression.text);
    }
  }
  return names;
}

function isExported(
  node: ts.InterfaceDeclaration | ts.TypeAliasDeclaration,
  scope: Scope,
  namedExports: ReadonlySet<string>,
): boolean {
  if (scope.exportedByDefault || hasModifier(node, ts.SyntaxKind.ExportKeyword)) return true;
  return scope.namespace.length === 0 && namedExports.has(node.name.text);
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  return ts.getModifiers(node)?.some((m) => m.kind === kind) ?? false;
}

function readTypeParameters(
  params: ts.NodeArray<ts.TypeParameterDeclaration> | undefined,
  sf: ts.SourceFile,
): TypeParameterSchema[] {
  return (params ?? []).map((p) => ({
    name: p.name.text,
    ...(p.constraint !== undefined ? { constraint: normalizeText(p.constraint.getText(sf)) } : {}),
    ...(p.default !== undefined ? { default: normalizeText(p.default.getText(sf)) } : {}),
  }));
}

function readDocs(node: ts.Node): { docs?: string; deprecated: boolean } {
  const deprecated = ts.getJSDocDeprecatedTag(node) !== undefined;
  const blocks = ts.getJSDocCommentsAndTags(node).filter(ts.isJSDoc);
  const last = blocks[blocks.length - 1];
  const text = last !== undefined ? ts.getTextOfJSDocComment(last.comment)?.trim() : undefined;
  return text !== undefined && text.length > 0 ? { docs: text, deprecated } : { deprecated };
}

function propertyNameText(name: ts.PropertyName, sf: ts.SourceFile): string {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
    return name.text;
  }
  return normalizeText(name.getText(sf)); // computed: `[Symbol.iterator]`
}

function entityNameText(name: ts.EntityName): string {
  return ts.isIdentifier(name) ? name.text : `${entityNameText(name.left)}.${name.right.text}`;
}

function expressionName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) {
    const left = expressionName(expr.expression);
    return left !== undefined ? `${left}.${expr.name.text}` : undefined;
  }
  return undefined;
}

function typeText(type: ts.TypeNode | undefined, sf: ts.SourceFile): string {
  return type === undefined ? 'any' : normalizeText(type.getText(sf));
}

/** Collapses any whitespace run (incl. newlines) to a single space. Linear, no regex. */
function normalizeText(text: string): string {
  let out = '';
  let pendingSpace = false;
  for (const ch of text) {
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) out += ' ';
    pendingSpace = false;
    out += ch;
  }
  return out;
}

function dedupeHeritage(refs: readonly HeritageRef[]): HeritageRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => (seen.has(r.text) ? false : (seen.add(r.text), true)));
}

function qualify(namespace: readonly string[], name: string): string {
  return namespace.length === 0 ? name : `${namespace.join('.')}.${name}`;
}

/** Guarantees id uniqueness for pathological files (e.g. duplicate type alias names). */
function uniqueId(byId: ReadonlyMap<string, unknown>, id: string): string {
  if (!byId.has(id)) return id;
  let n = 2;
  while (byId.has(`${id}#${n}`)) n++;
  return `${id}#${n}`;
}

function toPosition(sf: ts.SourceFile, offset: number): SourcePosition {
  const { line, character } = sf.getLineAndCharacterOfPosition(offset);
  return { line, character };
}

function roundMs(ms: number): number {
  return Math.round(ms * 100) / 100;
}
