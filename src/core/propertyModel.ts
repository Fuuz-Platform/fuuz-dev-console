/**
 * Every property of one element, with its documentation, its live value, and an
 * honest account of whether it can be changed.
 *
 * The four states this exists to keep apart — because three of them look
 * identical in a naive listing, and conflating them is how a tool starts lying:
 *
 *   dynamic   a transform computes it; we have the expression and the result
 *   static    the skill says it accepts a transform, this screen sets a literal
 *   fixed     it never accepts a transform
 *   unknown   the skill documents no table for this element type
 *
 * `unknown` is not `fixed`. Saying "this element has no transformable props"
 * about a type we have never read would be inventing a fact, so an undocumented
 * type reports itself as undocumented and offers nothing.
 *
 * Pure.
 */
import { editability, isDocumented, propsFor, type Editability, type ElementProp } from './elementRegistry';
import type { StructureNode } from './structure';

export type PropState = 'dynamic' | 'static' | 'fixed' | 'unknown';

export interface PropertyRow {
  name: string;
  state: PropState;
  /** Field type from the skill — `transform`, `text`, `switch`, … */
  type: string;
  description: string;
  section?: string;
  /** The documented default, when the skill records one. */
  defaultValue?: string;
  /** The JSONata behind a dynamic prop. */
  expression?: string;
  /** The value the runtime most recently produced or holds. */
  value?: unknown;
  /** Whether `value` was actually found, so `undefined` is not read as null. */
  hasValue: boolean;
  /** Whether and how this can be changed on the running screen. */
  edit: Editability;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Read `a.b.c` out of a context snapshot. Dots only — Fuuz paths have no brackets. */
export function readPath(root: unknown, path: string): { found: boolean; value?: unknown } {
  let cursor = root;
  for (const key of path.split('.')) {
    if (!isRecord(cursor) || !(key in cursor)) return { found: false };
    cursor = cursor[key];
  }
  return { found: true, value: cursor };
}

/**
 * Build the inspector's rows for one element.
 *
 * `context` is the runtime's own snapshot, which is why values are read rather
 * than reconstructed: the runtime is the authority on what a prop currently is,
 * and a value we computed ourselves would drift from what the screen shows.
 */
export function propertyRows(node: StructureNode, context: unknown): PropertyRow[] {
  const documented = isDocumented(node.type);
  const docs = propsFor(node.type);
  const dynamic = new Set(node.props);

  const rowFor = (doc: ElementProp | undefined, name: string): PropertyRow => {
    const isDynamic = dynamic.has(name);
    const transformable = doc?.type === 'transform' || doc?.type === 'jsonata';
    const state: PropState = isDynamic
      ? 'dynamic'
      : !documented || !doc
        ? 'unknown'
        : transformable
          ? 'static'
          : 'fixed';

    const live = readPath(context, `components.${node.name}.${name}`);
    return {
      name,
      state,
      type: doc?.type ?? 'unknown',
      description: doc?.description ?? '',
      section: doc?.section,
      defaultValue: doc?.default,
      value: live.value,
      hasValue: live.found,
      edit: editability(node.type, name),
    };
  };

  const rows = docs.map((doc) => rowFor(doc, doc.name));

  // A prop the design uses but the skill never documents still has to appear —
  // it is real, it is on screen, and hiding it would make the inspector look
  // complete while omitting the one you are debugging.
  const known = new Set(docs.map((d) => d.name));
  for (const name of node.props) {
    if (!known.has(name)) rows.push(rowFor(undefined, name));
  }

  return rows;
}

/** Group rows the way the designer's own panel does. */
export function bySection(rows: PropertyRow[]): { section: string; rows: PropertyRow[] }[] {
  const groups = new Map<string, PropertyRow[]>();
  for (const row of rows) {
    const key = row.section ?? 'Other';
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }
  return [...groups].map(([section, list]) => ({ section, rows: list }));
}

/* ── Editing ─────────────────────────────────────────────────────────────── */

export type EditKind = 'string' | 'boolean' | 'number' | 'null' | 'json' | 'expression' | 'choice';

/**
 * The control a property should be edited with, from the skill's own field type.
 *
 * The registry records what the designer offers for each prop — `switch`,
 * `options`, `slider`, `transform` — so the console can present the same control
 * instead of a text box for everything. A `switch` typed into a text field is the
 * `"false"`-is-truthy trap; an `options` field typed by hand is a guess at the
 * allowed values.
 *
 * `choice` is returned when the field is a fixed set, but the skill records the
 * *type* and not the members — so the caller must supply the options or fall back
 * to text rather than presenting an empty dropdown.
 */
export function controlFor(fieldType: string, value: unknown): EditKind {
  switch (fieldType) {
    case 'switch':
    case 'checkbox':
      return 'boolean';
    case 'options':
    case 'combobox':
      return 'choice';
    case 'slider':
    case 'integer':
      return 'number';
    case 'transform':
    case 'jsonata':
      return 'expression';
    case 'json':
    case 'action':
    case 'graphqlWhere':
    case 'graphql':
    case 'chart':
    case 'fieldGroup':
      return 'json';
    default:
      // Unknown field type: fall back to what the value itself is, which is at
      // least true of the data even when the schema is silent.
      return editorFor(value, value !== undefined).kind;
  }
}

/**
 * How a value should be edited, and the text to start editing from.
 *
 * The rule the plan sets: **edit the value, never its punctuation.** A string
 * displayed as `"Screen Runner capture"` opens with the caret in
 * `Screen Runner capture` — no quotes to retype and none to accidentally leave
 * behind.
 *
 * The text comes from the real value, never from a display string. The tree
 * summarises (`[ 12 items ]`), and round-tripping a summary as text would
 * silently destroy the data it stands for.
 */
export function editorFor(value: unknown, hasValue: boolean): { kind: EditKind; text: string; multiline: boolean } {
  if (!hasValue || value === undefined) return { kind: 'string', text: '', multiline: false };
  if (value === null) return { kind: 'null', text: 'null', multiline: false };
  if (typeof value === 'boolean') return { kind: 'boolean', text: String(value), multiline: false };
  if (typeof value === 'number') return { kind: 'number', text: String(value), multiline: false };
  if (typeof value === 'string') return { kind: 'string', text: value, multiline: value.includes('\n') };
  return { kind: 'json', text: JSON.stringify(value, null, 2), multiline: true };
}

export interface CommitResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

/**
 * Turn edited text back into a value of the original type.
 *
 * Type is preserved from what was there, not guessed from what was typed —
 * otherwise editing a boolean `true` to `false` would commit the *string*
 * `"false"`, which is truthy, and the screen would behave as though nothing
 * changed. Invalid input is rejected whole; nothing is ever partially applied.
 */
export function commitValue(kind: EditKind, text: string): CommitResult {
  switch (kind) {
    case 'boolean': {
      const t = text.trim().toLowerCase();
      if (t === 'true') return { ok: true, value: true };
      if (t === 'false') return { ok: true, value: false };
      return { ok: false, error: 'Expected true or false.' };
    }
    case 'number': {
      const t = text.trim();
      if (!t) return { ok: false, error: 'Expected a number.' };
      const n = Number(t);
      if (!Number.isFinite(n)) return { ok: false, error: `"${t}" is not a number.` };
      return { ok: true, value: n };
    }
    case 'json': {
      try { return { ok: true, value: JSON.parse(text) }; }
      catch (e) { return { ok: false, error: e instanceof Error ? e.message : 'Invalid JSON.' }; }
    }
    case 'null':
      // `null` typed back unchanged stays null; anything else becomes a string,
      // which is the only reading that lets a null be replaced with a value.
      return text.trim() === 'null' ? { ok: true, value: null } : { ok: true, value: text };
    case 'expression':
      return text.trim() ? { ok: true, value: text } : { ok: false, error: 'An expression cannot be empty.' };
    case 'choice':
      // The set is not in the registry, so any non-empty value is accepted — but
      // it is committed as-is rather than coerced, since these are usually ids.
      return text.trim() ? { ok: true, value: text.trim() } : { ok: false, error: 'Choose a value.' };
    case 'string':
    default:
      return { ok: true, value: text };
  }
}

/**
 * The `fn` call that would apply a new value, given what the component exposes.
 *
 * Returns undefined when nothing documented can carry the change — which the
 * caller must render as a disabled control with a reason, never as a control
 * that appears to work.
 */
export function applyCall(
  row: PropertyRow,
  node: StructureNode,
  value: unknown,
  reachableFns: string[]
): { fn: string; args: unknown[] } | undefined {
  if (row.edit.tier !== 'runtime') return undefined;
  const has = (name: string) => reachableFns.includes(name);

  if ((/^data\./.test(row.name) || row.name === 'dataPath') && has('setValue')) {
    const field = row.name.replace(/^data\./, '');
    return { fn: 'setValue', args: [field, value] };
  }
  if (row.name === 'data' && has('setData')) return { fn: 'setData', args: [value] };
  if (row.name === 'visible' || row.name === 'hidden') {
    const show = row.name === 'visible' ? value === true : value === false;
    if (has(show ? 'show' : 'hide')) return { fn: show ? 'show' : 'hide', args: [] };
  }
  if (row.name === 'disabled') {
    if (value === true && has('disableField')) return { fn: 'disableField', args: [node.dataPath ?? node.name] };
    if (value === false && has('enableField')) return { fn: 'enableField', args: [node.dataPath ?? node.name] };
  }
  return undefined;
}
