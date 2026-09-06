/**
 * Build the screen-state tree.
 *
 * The runtime logs a **complete `context` snapshot** with every transform —
 * `{ metadata, components, showScreenDialog }`, with each component's real data,
 * form state and current view. So the tree is read from the newest snapshot
 * rather than reconstructed from writes: components that were never written
 * still appear, and values are the platform's own, not our replay of them.
 *
 * Two things the snapshot does *not* carry are layered on top:
 *
 *  - **Computed props.** `IntakePrepare.disabled` and the embedded page's `url`
 *    are produced by transforms and applied to the rendered component; they
 *    never appear in `context.components`. They come from the entries' writes.
 *  - **Provenance.** Which writes produced a value, walked from the read/write
 *    graph (see `provenance.ts`) — the whole point of the `⌁ n` affordance.
 *
 * Pure: no VS Code, no I/O.
 */
import { formatValue } from './classify';
import { provenanceIndex } from './provenance';
import type { LogEntry, StateNode, ValueKind } from './types';

/** Order the roots the way the runtime nests them, so the tree doesn't reshuffle. */
const ROOT_ORDER = ['metadata', 'components', 'variables', 'context', 'state', 'props', '(computed)', '(local)'];

/** Depth cap. Component `fn` bags and form state nest deeply and add no value below this. */
const MAX_DEPTH = 6;
/** Per-object key cap, so one enormous object can't stall the panel. */
const MAX_KEYS = 200;

function valueKind(v: unknown): ValueKind {
  if (typeof v === 'string') return v.startsWith('ƒ ') ? 'fn' : 'str';
  if (typeof v === 'number') return 'num';
  if (typeof v === 'boolean' || v === null) return 'bool';
  if (typeof v === 'function') return 'fn';
  return 'obj';
}

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `${v.length} ${v.length === 1 ? 'item' : 'items'}`;
  if (typeof v === 'string' && v.startsWith('ƒ ')) return 'function';
  return typeof v;
}

const isBranch = (v: unknown): boolean =>
  v !== null && typeof v === 'object' && (Array.isArray(v) ? v.length > 0 : Object.keys(v).length > 0);

/** Walk a plain-JSON snapshot into tree nodes. */
function nodesFrom(value: unknown, path: string, depth: number): StateNode[] {
  if (depth >= MAX_DEPTH || !isBranch(value)) return [];
  const entries: [string, unknown][] = Array.isArray(value)
    ? value.slice(0, MAX_KEYS).map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, unknown>).slice(0, MAX_KEYS);

  return entries.map(([key, v]) => {
    const id = path ? `${path}.${key}` : key;
    const children = nodesFrom(v, id, depth + 1);
    return children.length
      ? { id, label: key, type: typeName(v), vk: 'obj' as ValueKind, children, trace: [], changed: false }
      : { id, label: key, type: typeName(v), value: formatValue(v), vk: valueKind(v), trace: [], changed: false };
  });
}

/** Insert (or replace) a leaf at a dot path, creating group nodes as needed. */
function put(roots: StateNode[], path: string, leaf: Omit<StateNode, 'id' | 'label'>): void {
  const segments = path.split('.');
  let level = roots;
  let id = '';
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    id = id ? `${id}.${seg}` : seg;
    const last = i === segments.length - 1;
    let node = level.find((n) => n.label === seg);
    if (!node) {
      node = { id, label: seg, type: 'object', vk: 'obj', trace: [], changed: false, ...(last ? {} : { children: [] }) };
      level.push(node);
    }
    if (last) Object.assign(node, leaf, { id, label: seg });
    else {
      if (!node.children) node.children = [];
      level = node.children;
    }
  }
}

/** Mark a path and every ancestor as changed during this run. */
function markChanged(roots: StateNode[], path: string): void {
  const segments = path.split('.');
  let level: StateNode[] | undefined = roots;
  for (const seg of segments) {
    const node: StateNode | undefined = level?.find((n) => n.label === seg);
    if (!node) return;
    node.changed = true;
    level = node.children;
  }
}

/** Attach provenance to every node whose path has one. */
function attachTraces(nodes: StateNode[], traces: Map<string, string[]>): void {
  for (const n of nodes) {
    const trace = traces.get(n.id);
    if (trace?.length) n.trace = trace;
    if (n.children) attachTraces(n.children, traces);
  }
}

/**
 * @param entries     Classified entries, ascending by `seq`.
 * @param screenName  Label for the synthetic root, e.g. the screen under test.
 */
export function buildStateTree(entries: LogEntry[], screenName = 'Screen'): StateNode[] {
  // The newest snapshot wins — it is the current state by construction.
  const snapshot = [...entries].reverse().find((e) => isBranch(e.context))?.context;
  const roots: StateNode[] = snapshot ? nodesFrom(snapshot, '', 0) : [];

  // Layer on the computed props, which the snapshot never carries.
  for (const e of entries) {
    if (!e.write) continue;
    const value = e.after ?? formatValue(undefined);
    put(roots, e.write, {
      type: e.after === undefined ? 'unknown' : inferType(e.after),
      value,
      vk: e.kind === 'error' ? 'err' : inferKind(e.after),
      trace: [],
      changed: true,
    });
  }
  for (const e of entries) if (e.write) markChanged(roots, e.write);

  attachTraces(roots, provenanceIndex(entries));

  if (!roots.length) return [];
  roots.sort((a, b) => {
    const ai = ROOT_ORDER.indexOf(a.label), bi = ROOT_ORDER.indexOf(b.label);
    return (ai < 0 ? ROOT_ORDER.length : ai) - (bi < 0 ? ROOT_ORDER.length : bi) || a.label.localeCompare(b.label);
  });

  return [{
    id: '__screen__',
    label: 'Screen',
    type: screenName,
    vk: 'obj',
    children: roots,
    trace: [],
    changed: false,
  }];
}

/**
 * `after` arrives pre-formatted (see `formatValue`), so type and colour are
 * read back off the formatting rather than the original value.
 */
function inferType(formatted: string): string {
  if (/^".*"$/.test(formatted)) return 'string';
  if (/^-?\d+(\.\d+)?$/.test(formatted)) return 'number';
  if (formatted === 'true' || formatted === 'false') return 'boolean';
  if (formatted === 'null') return 'null';
  if (formatted.startsWith('[')) return 'array';
  if (formatted.startsWith('{')) return 'object';
  return 'string';
}

function inferKind(formatted: string | undefined): ValueKind {
  switch (formatted === undefined ? 'unknown' : inferType(formatted)) {
    case 'string': return 'str';
    case 'number': return 'num';
    case 'boolean': case 'null': return 'bool';
    default: return 'obj';
  }
}

/** Find a node by its full dot path. */
export function findNode(nodes: StateNode[], id: string): StateNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    const hit = n.children && findNode(n.children, id);
    if (hit) return hit;
  }
  return undefined;
}
