/**
 * TSBlueprint — IPC contract between the Extension Host (Node.js) and the Webview (browser).
 *
 * RULES FOR THIS FILE
 * - Zero runtime imports. It is consumed by BOTH bundles (extension host + webview), so it must
 *   never pull in `vscode`, `typescript`, or any Node built-in.
 * - Every message is a member of a discriminated union keyed on `type`.
 * - Everything is `readonly`: messages are immutable snapshots once posted.
 * - Webview → Host messages are untrusted input and MUST pass `isWebviewToHostMessage` before use.
 */

/* ============================================================================================
 * 1. Domain model (the "schema" the parser produces and the webview renders)
 * ========================================================================================== */

/** Zero-based position, identical semantics to `vscode.Position` so the host can reveal it directly. */
export interface SourcePosition {
  readonly line: number;
  readonly character: number;
}

export interface TypeParameterSchema {
  readonly name: string;
  readonly constraint?: string;
  readonly default?: string;
}

/** A reference in an `extends` clause (interfaces) or an intersection operand (type aliases). */
export interface HeritageRef {
  /** Resolvable name, e.g. `Base` or `Models.Base`. Used to build relations. */
  readonly name: string;
  /** Display text including type arguments, e.g. `Base<string>`. */
  readonly text: string;
}

interface MemberBase {
  readonly name: string;
  /** Source text of the type annotation, whitespace-normalised. `any` when the annotation is omitted. */
  readonly type: string;
  /** Identifiers of type references found inside `type` (type parameters excluded). */
  readonly typeRefs: readonly string[];
  readonly docs?: string;
  readonly deprecated: boolean;
  readonly position: SourcePosition;
}

export interface PropertyMember extends MemberBase {
  readonly kind: 'property';
  readonly optional: boolean;
  readonly readonly: boolean;
}

export interface MethodMember extends MemberBase {
  readonly kind: 'method';
  readonly optional: boolean;
}

/** `[key: string]: T` */
export interface IndexMember extends MemberBase {
  readonly kind: 'index';
  readonly readonly: boolean;
}

/** `(x: T): R` and `new (x: T): R` */
export interface CallMember extends MemberBase {
  readonly kind: 'call' | 'construct';
}

export type MemberSchema = PropertyMember | MethodMember | IndexMember | CallMember;
export type MemberKind = MemberSchema['kind'];

interface ModelBase {
  /** Stable, namespace-qualified identifier, e.g. `User` or `Api.v1.User`. Unique within a document. */
  readonly id: string;
  readonly name: string;
  /** Enclosing namespace / module path, empty for top-level declarations. */
  readonly namespace: readonly string[];
  readonly exported: boolean;
  readonly typeParameters: readonly TypeParameterSchema[];
  readonly members: readonly MemberSchema[];
  readonly docs?: string;
  readonly deprecated: boolean;
  readonly position: SourcePosition;
}

export interface InterfaceModel extends ModelBase {
  readonly kind: 'interface';
  readonly extends: readonly HeritageRef[];
  /** Number of declarations merged into this model (interface declaration merging). */
  readonly declarationCount: number;
}

export interface TypeAliasModel extends ModelBase {
  readonly kind: 'typeAlias';
  /** Non-literal operands of an intersection: `type A = B & C<D> & { ... }` → `B`, `C<D>`. */
  readonly intersects: readonly HeritageRef[];
}

export type SchemaModel = InterfaceModel | TypeAliasModel;
export type ModelKind = SchemaModel['kind'];

export type RelationKind = 'extends' | 'intersects' | 'references';

/** Edge between two models declared in the SAME file (external symbols are never resolved). */
export interface SchemaRelation {
  readonly kind: RelationKind;
  readonly from: string;
  readonly to: string;
  /** Member name for `references` edges originating from a property/method. */
  readonly via?: string;
}

export interface SchemaDocument {
  /** Original file name as reported by the host (display only). */
  readonly fileName: string;
  readonly models: readonly SchemaModel[];
  readonly relations: readonly SchemaRelation[];
  readonly stats: {
    readonly modelCount: number;
    readonly memberCount: number;
    readonly parseTimeMs: number;
  };
}

export interface ParseDiagnostic {
  readonly message: string;
  /** TypeScript diagnostic code, e.g. 1005 for "';' expected". */
  readonly code: number;
  readonly start: SourcePosition;
  readonly length: number;
}

/* ============================================================================================
 * 2. Host → Webview messages
 * ========================================================================================== */

/** Identity of the text document a message refers to. Lets the webview drop stale messages. */
export interface DocumentRef {
  /** `vscode.Uri.toString()` */
  readonly uri: string;
  /** `TextDocument.version` at parse time — monotonically increasing per document. */
  readonly version: number;
}

export type IdleReason = 'noActiveEditor' | 'unsupportedLanguage' | 'noModels';

export type HostToWebviewMessage =
  | {
      readonly type: 'schema/update';
      readonly payload: DocumentRef & { readonly document: SchemaDocument };
    }
  | {
      /** The file has syntax errors. `partial` is best-effort output from TS's error-tolerant parser. */
      readonly type: 'schema/syntaxError';
      readonly payload: DocumentRef & {
        readonly fileName: string;
        readonly diagnostics: readonly ParseDiagnostic[];
        readonly partial: SchemaDocument;
      };
    }
  | {
      /** The parser itself threw. Should never happen; surfaced instead of crashing the host. */
      readonly type: 'schema/internalError';
      readonly payload: DocumentRef & { readonly fileName: string; readonly message: string };
    }
  | {
      readonly type: 'schema/idle';
      readonly payload: { readonly reason: IdleReason; readonly fileName?: string };
    };

/* ============================================================================================
 * 3. Webview → Host messages
 * ========================================================================================== */

export type LogLevel = 'info' | 'warn' | 'error';

export type WebviewToHostMessage =
  | { readonly type: 'webview/ready' }
  | { readonly type: 'webview/requestRefresh' }
  | {
      /** User clicked a model/member: reveal it in the source editor. */
      readonly type: 'webview/revealPosition';
      readonly payload: { readonly uri: string; readonly position: SourcePosition };
    }
  | {
      readonly type: 'webview/log';
      readonly payload: { readonly level: LogLevel; readonly message: string };
    };

/* ============================================================================================
 * 4. Type-level utilities
 * ========================================================================================== */

export type IpcMessage = HostToWebviewMessage | WebviewToHostMessage;

/** Narrow a union to the member with the given discriminant. */
export type MessageOfType<U extends { readonly type: string }, T extends U['type']> = Extract<
  U,
  { readonly type: T }
>;

/**
 * Exhaustive handler map. Adding a new message type to a union makes every handler map that
 * doesn't handle it a compile error — no silent drops.
 */
export type MessageHandlers<U extends { readonly type: string }> = {
  readonly [K in U['type']]: (message: MessageOfType<U, K>) => void;
};

/** Dispatch helper that keeps the handler call type-safe without casts at call sites. */
export function dispatchMessage<U extends { readonly type: string }>(
  message: U,
  handlers: MessageHandlers<U>,
): void {
  const handler = handlers[message.type as U['type']] as (m: U) => void;
  handler(message);
}

/** Compile-time exhaustiveness check for `switch (msg.type)` statements. */
export function assertNever(value: never, context = 'Unhandled discriminant'): never {
  throw new Error(`${context}: ${JSON.stringify(value)}`);
}

/* ============================================================================================
 * 5. Runtime validation (the webview is a trust boundary)
 * ========================================================================================== */

type UnknownRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isSourcePosition(value: unknown): value is SourcePosition {
  return isRecord(value) && isNonNegativeInteger(value.line) && isNonNegativeInteger(value.character);
}

const LOG_LEVELS: ReadonlySet<string> = new Set<LogLevel>(['info', 'warn', 'error']);

/**
 * Validates a message received through `webview.onDidReceiveMessage`. Anything that does not
 * match the contract exactly is rejected (returns false) — the host must ignore it.
 */
export function isWebviewToHostMessage(value: unknown): value is WebviewToHostMessage {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }
  const type = value.type as WebviewToHostMessage['type'];
  switch (type) {
    case 'webview/ready':
    case 'webview/requestRefresh':
      return true;
    case 'webview/revealPosition': {
      const p = value.payload;
      return isRecord(p) && typeof p.uri === 'string' && isSourcePosition(p.position);
    }
    case 'webview/log': {
      const p = value.payload;
      return (
        isRecord(p) &&
        typeof p.level === 'string' &&
        LOG_LEVELS.has(p.level) &&
        typeof p.message === 'string'
      );
    }
    default:
      // `type` is `never` here for known values; unknown strings fall through to rejection.
      return false;
  }
}
