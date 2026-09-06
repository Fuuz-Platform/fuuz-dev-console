/**
 * Change a screen or flow *definition* — the thing the native Fuuz UI reads.
 *
 * Everything else this console writes is runtime-only: an `fn` call, an inline style,
 * a previewed transform, all discarded by a reload. `docs/property-inspector-plan.md`
 * said "nothing is ever saved", on the grounds that a tool which silently altered what
 * it diagnoses would undermine everything else it reports. That reasoning still holds,
 * so persistence here is deliberately **not silent**:
 *
 *  - every patch is computed against the design as read, and returns a `before`/`after`
 *    for the exact path it touched — a caller that cannot show a diff cannot apply one;
 *  - a target that does not resolve to exactly one node is **refused**, not guessed;
 *  - the version id the patch was computed from travels with it, so a write can be
 *    rejected if the designer saved underneath us rather than silently clobbering;
 *  - nothing here performs I/O. Building a patch and sending it are separate decisions
 *    in separate modules, so a dry run is the same code path minus the send.
 *
 * ## The two documents
 *
 * A screen version holds `design.components[].props.design` — the craft graph, keyed by
 * node id, each node `{ type: { resolvedName }, props, displayName, parent, nodes }`.
 * A prop is either a literal or a transform object
 * `{ __transform, __cacheKey, __remote, __dynamicFields }`.
 *
 * A flow version holds `flow.nodes[]`, each `{ id, name, type, data }`, and the
 * designer's own save sends the whole `flow` back. So a flow patch is a node-data patch
 * over that array.
 *
 * Pure: no DOM, no network, no clock.
 */

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A prop written as a transform rather than a literal. */
export interface TransformValue {
  __transform: string;
  __cacheKey?: string;
  __remote?: boolean;
}

export interface ScreenEdit {
  /** Craft node id — exact, and stable across renames. Preferred. */
  nodeId?: string;
  /** Element name, used only when no node id is known. Ambiguity is refused. */
  elementName?: string;
  /** The prop to write, e.g. `url`, `disabled`, `label`. */
  property: string;
  /** A literal value, or a transform object to store in its place. */
  value: unknown;
}

export interface FlowEdit {
  /** Flow node id, or its name when the id is not to hand. Ambiguity is refused. */
  nodeId?: string;
  nodeName?: string;
  /** Dot path within the node's `data`, e.g. `payload`, `query.variables`. */
  path: string;
  value: unknown;
}

export interface PatchResult<T> {
  ok: true;
  /** The whole document, patched — ready to be sent as the update. */
  document: T;
  /** Where the change landed, in words a diff can show. */
  change: { target: string; property: string; before: unknown; after: unknown; kind: 'literal' | 'transform' };
}

export interface PatchRefusal {
  ok: false;
  /** Why this was not applied — shown to the user, never swallowed. */
  reason: string;
  /** Candidates, when the refusal was ambiguity rather than absence. */
  candidates?: string[];
}

export type Patch<T> = PatchResult<T> | PatchRefusal;

/** Deep clone that keeps the document independent of the one we read. */
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** The craft graph inside a screen design document, with the component that holds it. */
function craftGraph(design: unknown): { graph: Record<string, unknown>; owner: Record<string, unknown> } | undefined {
  const components = isRecord(design) && isRecord(design.design) ? design.design.components : undefined;
  if (!Array.isArray(components)) return undefined;
  for (const component of components) {
    if (!isRecord(component)) continue;
    const props = isRecord(component.props) ? component.props : undefined;
    if (!props || !isRecord(props.design)) continue;
    return { graph: props.design as Record<string, unknown>, owner: props };
  }
  return undefined;
}

/**
 * Which craft node an edit means.
 *
 * A node id resolves exactly. A name has to be matched against `displayName` and the
 * key itself, and two elements can share a display name — that case returns every
 * candidate rather than picking the first, because picking would write to an element
 * the user did not mean and they would have no way to tell.
 */
function resolveNode(graph: Record<string, unknown>, edit: ScreenEdit): { id: string } | PatchRefusal {
  if (edit.nodeId) {
    if (!isRecord(graph[edit.nodeId])) {
      return { ok: false, reason: `No element with node id "${edit.nodeId}" in this screen design.` };
    }
    return { id: edit.nodeId };
  }
  if (!edit.elementName) return { ok: false, reason: 'An edit needs a node id or an element name.' };

  const matches = Object.entries(graph).filter(([key, node]) =>
    key === edit.elementName || (isRecord(node) && node.displayName === edit.elementName));
  if (!matches.length) return { ok: false, reason: `No element named "${edit.elementName}" in this screen design.` };
  if (matches.length > 1) {
    return {
      ok: false,
      reason: `"${edit.elementName}" matches ${matches.length} elements, so this edit is ambiguous. Use a node id.`,
      candidates: matches.map(([key]) => key),
    };
  }
  return { id: matches[0][0] };
}

/** Is this value a transform object rather than a literal? */
export function isTransform(value: unknown): value is TransformValue {
  return isRecord(value) && typeof value.__transform === 'string';
}

/**
 * Apply one property change to a screen design document.
 *
 * Returns the whole document because that is what the platform stores: `design` is a
 * single JSONObject on the screen version, so a write replaces it wholesale. Patching
 * a clone of what we read — rather than composing a fresh document — means every part
 * of the screen we do not understand survives untouched.
 */
export function patchScreenDesign(design: unknown, edit: ScreenEdit): Patch<unknown> {
  const found = craftGraph(design);
  if (!found) return { ok: false, reason: 'This document has no craft graph (design.components[].props.design).' };

  const resolved = resolveNode(found.graph, edit);
  if ('ok' in resolved) return resolved;

  const next = clone(design) as Record<string, unknown>;
  const graph = craftGraph(next)!.graph;
  const node = graph[resolved.id] as Record<string, unknown>;
  const props = isRecord(node.props) ? node.props : (node.props = {} as Record<string, unknown>);
  const before = props[edit.property];
  props[edit.property] = edit.value;

  return {
    ok: true,
    document: next,
    change: {
      target: resolved.id,
      property: edit.property,
      before,
      after: edit.value,
      kind: isTransform(edit.value) ? 'transform' : 'literal',
    },
  };
}

/** Set a dot path inside an object, creating intermediate records. */
function setPath(target: Record<string, unknown>, path: string, value: unknown): unknown {
  const parts = path.split('.').filter(Boolean);
  let cursor: Record<string, unknown> = target;
  for (const part of parts.slice(0, -1)) {
    if (!isRecord(cursor[part])) cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  const before = cursor[last];
  cursor[last] = value;
  return before;
}

/** Read a dot path, for the `before` half of the diff. */
function readPath(source: unknown, path: string): unknown {
  return path.split('.').filter(Boolean).reduce<unknown>((acc, part) => (isRecord(acc) ? acc[part] : undefined), source);
}

/**
 * Apply one change to a flow version's node data.
 *
 * The flow document is `{ id, type, name, version, nodes[] }` — the same object the
 * designer sends back on save, so the patched document can be handed to the same
 * mutation the designer uses.
 */
export function patchFlowVersion(flow: unknown, edit: FlowEdit): Patch<unknown> {
  if (!isRecord(flow) || !Array.isArray(flow.nodes)) {
    return { ok: false, reason: 'This document has no flow.nodes array.' };
  }
  const nodes = flow.nodes.filter(isRecord);
  const matches = edit.nodeId
    ? nodes.filter((n) => n.id === edit.nodeId)
    : nodes.filter((n) => n.name === edit.nodeName);
  const label = edit.nodeId ?? edit.nodeName ?? '(unnamed)';

  if (!edit.nodeId && !edit.nodeName) return { ok: false, reason: 'An edit needs a node id or a node name.' };
  if (!matches.length) return { ok: false, reason: `No flow node "${label}" in this version.` };
  if (matches.length > 1) {
    return {
      ok: false,
      reason: `"${label}" matches ${matches.length} nodes, so this edit is ambiguous. Use a node id.`,
      candidates: matches.map((n) => String(n.id ?? n.name)),
    };
  }

  const next = clone(flow) as Record<string, unknown>;
  const target = (next.nodes as Record<string, unknown>[]).find((n) =>
    (edit.nodeId ? n.id === edit.nodeId : n.name === edit.nodeName))!;
  if (!isRecord(target.data)) target.data = {};
  const before = readPath(target.data, edit.path);
  setPath(target.data as Record<string, unknown>, edit.path, edit.value);

  return {
    ok: true,
    document: next,
    change: {
      target: String(target.id ?? target.name),
      property: `data.${edit.path}`,
      before,
      after: edit.value,
      kind: isTransform(edit.value) ? 'transform' : 'literal',
    },
  };
}

/** One line a human can read before approving a write. */
export function describeChange(change: PatchResult<unknown>['change']): string {
  const show = (v: unknown) => {
    if (v === undefined) return '(unset)';
    if (isTransform(v)) return `ƒ ${v.__transform}`;
    return typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? String(v);
  };
  return `${change.target}.${change.property}: ${show(change.before)} → ${show(change.after)}`;
}
