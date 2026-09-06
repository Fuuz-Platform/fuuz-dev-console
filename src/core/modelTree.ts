/**
 * A Fuuz data model as a browsable tree.
 *
 * The schema designer draws boxes and lines. What it does not show you, without
 * clicking into each field, is the whole shape at once: which fields are required,
 * which are relations and to what, which are lists, what the platform actually calls
 * them. That is all in the API's own introspection, which the extension can already
 * read — the same `__type` query the log-type discovery uses.
 *
 * Introspection is the right source rather than scraping the canvas, for a reason
 * worth stating: the canvas shows the model *as drawn*, and the API shows it **as
 * deployed**. When those disagree, the disagreement is the bug — and only one of the
 * two can tell you about a field that failed to deploy.
 *
 * Pure.
 */

/** A GraphQL type reference, as introspection returns it. */
export interface TypeRef {
  kind?: string;
  name?: string | null;
  ofType?: TypeRef | null;
}

export interface IntrospectedField {
  name?: string;
  description?: string | null;
  type?: TypeRef;
}

export interface IntrospectedType {
  name?: string;
  kind?: string;
  description?: string | null;
  fields?: IntrospectedField[] | null;
}

export interface ModelField {
  name: string;
  /** The type as GraphQL writes it — `[Order!]!`, `String`, `ID!`. */
  type: string;
  /** The underlying named type, with list and non-null stripped. */
  baseType: string;
  required: boolean;
  list: boolean;
  /**
   * True when the base type is another model rather than a scalar.
   *
   * This is the distinction the schema designer draws as a line, and the one that
   * decides whether a field can be expanded further.
   */
  relation: boolean;
  description?: string;
}

export interface ModelShape {
  name: string;
  description?: string;
  fields: ModelField[];
  /** Counts worth seeing without expanding: `12 fields · 3 relations · 5 required`. */
  summary: { fields: number; relations: number; required: number };
}

const SCALARS = new Set(['ID', 'String', 'Int', 'Float', 'Boolean', 'DateTime', 'Date', 'JSON', 'JSONObject', 'Upload', 'BigInt', 'Decimal']);

/**
 * Render a type reference the way GraphQL writes it.
 *
 * Recursive because the wrappers nest: a required list of required strings is
 * `NON_NULL(LIST(NON_NULL(String)))`, and flattening that by hand gets the
 * exclamation marks in the wrong places — which would misreport whether a field is
 * required.
 */
export function typeName(ref: TypeRef | undefined | null): string {
  if (!ref) return 'unknown';
  if (ref.kind === 'NON_NULL') return `${typeName(ref.ofType)}!`;
  if (ref.kind === 'LIST') return `[${typeName(ref.ofType)}]`;
  return ref.name ?? 'unknown';
}

/** The named type under every wrapper. */
export function baseTypeName(ref: TypeRef | undefined | null): string {
  let cursor = ref;
  while (cursor && (cursor.kind === 'NON_NULL' || cursor.kind === 'LIST')) cursor = cursor.ofType ?? undefined;
  return cursor?.name ?? 'unknown';
}

/** Whether the outermost wrapper makes the field non-null. */
const isRequired = (ref?: TypeRef | null) => ref?.kind === 'NON_NULL';

function isList(ref?: TypeRef | null): boolean {
  let cursor = ref;
  while (cursor) {
    if (cursor.kind === 'LIST') return true;
    cursor = cursor.ofType ?? undefined;
  }
  return false;
}

/**
 * Turn an introspected type into a model shape.
 *
 * Returns undefined for a type that does not exist, so the pane can say "no such
 * model in this environment" — which is a real and common answer when the canvas
 * shows a model that has not been deployed.
 */
export function toModelShape(type: IntrospectedType | undefined | null): ModelShape | undefined {
  if (!type?.name) return undefined;
  const fields: ModelField[] = (type.fields ?? []).map((f) => {
    const base = baseTypeName(f.type);
    return {
      name: f.name ?? '?',
      type: typeName(f.type),
      baseType: base,
      required: isRequired(f.type),
      list: isList(f.type),
      // A relation is anything whose base type is not a scalar or an enum-like name.
      relation: !SCALARS.has(base) && /^[A-Z]/.test(base),
      description: f.description ?? undefined,
    };
  });
  return {
    name: type.name,
    description: type.description ?? undefined,
    fields,
    summary: {
      fields: fields.length,
      relations: fields.filter((f) => f.relation).length,
      required: fields.filter((f) => f.required).length,
    },
  };
}

/**
 * A starter query for this model, ready to run in the GraphQL tab.
 *
 * Scalars only. Including relations would produce a query that fails to compile
 * without sub-selections, and handing someone a broken query is worse than handing
 * them a narrow one they can widen.
 */
export function starterQuery(model: ModelShape, first = 25): string {
  const scalars = model.fields.filter((f) => !f.relation).map((f) => f.name);
  const selection = (scalars.length ? scalars : ['id']).map((n) => `    ${n}`).join('\n');
  // Fuuz's collection field is the model name lower-camel with `Collection`, which is
  // the convention the platform's own generated queries use.
  const collection = `${model.name.charAt(0).toLowerCase()}${model.name.slice(1)}Collection`;
  return `query ${model.name}Rows {\n  ${collection}(first: ${first}) {\n${selection}\n  }\n}`;
}

/**
 * Filter a model's fields, keeping the model if its own name matches.
 *
 * Searching for `Order` should show the Order model whole, not the Order model with
 * every field hidden because no field is called "order" — that reads as an empty
 * model, which is a different and alarming answer.
 */
export function filterModel(model: ModelShape, query: string): ModelShape | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return model;
  if (model.name.toLowerCase().includes(q)) return model;
  const fields = model.fields.filter((f) =>
    f.name.toLowerCase().includes(q)
    || f.baseType.toLowerCase().includes(q)
    || (f.description ?? '').toLowerCase().includes(q));
  return fields.length ? { ...model, fields } : undefined;
}
