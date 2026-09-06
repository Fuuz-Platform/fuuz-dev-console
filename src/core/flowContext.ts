/**
 * Separating what every flow node shares from what is actually its own.
 *
 * A node's input state carries a lot that is identical on all of them —
 * `metadata` (tenant, flow id, version, log level), `claims` (user and tenant),
 * the app config. Repeating that on 23 node cards is 23 copies of the same
 * paragraph, and it buries the two or three fields that differ, which are the
 * only reason to open the node.
 *
 * So: compare every node's state, hoist the paths whose value is identical
 * everywhere into a shared "globally available" section, and leave each node
 * showing only what makes it different.
 *
 * Two rules this follows carefully:
 *
 *  - **A path is global only if every node has it, with the same value.** Present
 *    on some nodes and not others means it is not shared, however identical the
 *    values are where it appears — hoisting it would tell you a node has a field
 *    it does not.
 *  - **One node is never "all nodes".** With a single node everything would
 *    trivially be global and the node would look empty, so the partition needs at
 *    least two and says so otherwise.
 *
 * Pure.
 */

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Flatten to leaf paths, so `metadata.version` can be shared while siblings differ. */
export function leafPaths(
  value: unknown,
  prefix = '',
  out = new Map<string, unknown>(),
  depth = 0
): Map<string, unknown> {
  if (depth > 8 || !isRecord(value)) {
    if (prefix) out.set(prefix, value);
    return out;
  }
  const entries = Object.entries(value);
  if (!entries.length && prefix) { out.set(prefix, value); return out; }
  for (const [key, child] of entries) {
    const path = prefix ? `${prefix}.${key}` : key;
    // Arrays are compared whole: a per-item diff would produce paths like
    // `rows.0.id` that mean nothing once the array length changes between runs.
    if (Array.isArray(child) || !isRecord(child)) out.set(path, child);
    else leafPaths(child, path, out, depth + 1);
  }
  return out;
}

/** Stable comparison of two leaf values, arrays and objects included. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

export interface NodeStateInput {
  /** Node name, as the log prints it. */
  name: string;
  /** The node's input state, or whatever object is being compared. */
  state: unknown;
}

export interface StatePartition {
  /**
   * Paths present with the same value on **every** node — shown once, globally.
   * `claims`, `metadata` and the app config land here in practice.
   */
  /**
   * Shown once. `shared: true` means singular by construction (the app config);
   * absent means observed to be identical on every node.
   */
  global: { path: string; value: unknown; shared?: true; prefix?: string }[];
  /** Per node, only the paths that are its own or hold a different value. */
  perNode: { name: string; unique: { path: string; value: unknown }[] }[];
  /**
   * Why the partition is what it is. With fewer than two nodes there is nothing
   * to compare, and saying so beats presenting everything as "shared".
   */
  comparable: boolean;
  /** How much repetition was removed — the reason this exists. */
  savedPerNode: number;
}

/**
 * Objects that are global by construction, not by comparison.
 *
 * `$appConfig` is one value for the whole flow — it is not part of any node's
 * state, so it can never be *discovered* as shared by diffing nodes. It belongs
 * in the global section for the same reason `metadata` ends up there: showing it
 * per node would be 23 copies of one object.
 *
 * Kept separate from the diffed paths so the UI can say which is which — one is
 * observed to be identical, the other is known to be singular.
 */
export interface SharedObject {
  /** Root name as an expression would use it: `appConfig`, `metadata`, … */
  root: string;
  value: unknown;
  /** How a copied path should be prefixed. */
  prefix: string;
}

export function partitionNodeState(
  nodes: NodeStateInput[],
  shared: SharedObject[] = []
): StatePartition {
  const flattened = nodes.map((n) => ({ name: n.name, paths: leafPaths(n.state) }));

  // Always-global objects are added whatever the node count: they are singular by
  // definition, so there is nothing for a comparison to establish.
  const fromShared = shared.flatMap((sh) =>
    [...leafPaths(sh.value, sh.root)].map(([path, value]) => ({ path, value, shared: true as const, prefix: sh.prefix }))
  );

  if (flattened.length < 2) {
    return {
      global: fromShared,
      perNode: flattened.map((f) => ({
        name: f.name,
        unique: [...f.paths].map(([path, value]) => ({ path, value })),
      })),
      comparable: false,
      savedPerNode: fromShared.length,
    };
  }

  const [first, ...rest] = flattened;
  const globalPaths: { path: string; value: unknown }[] = [];
  for (const [path, value] of first.paths) {
    // Every node must *have* the path, not merely agree where present.
    const shared = rest.every((f) => f.paths.has(path) && same(f.paths.get(path), value));
    if (shared) globalPaths.push({ path, value });
  }
  const globalSet = new Set(globalPaths.map((g) => g.path));

  return {
    global: [...fromShared, ...globalPaths].sort((a, b) => a.path.localeCompare(b.path)),
    perNode: flattened.map((f) => ({
      name: f.name,
      unique: [...f.paths]
        .filter(([path]) => !globalSet.has(path))
        .map(([path, value]) => ({ path, value }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    })),
    comparable: true,
    savedPerNode: globalSet.size,
  };
}

/* ── Copyable paths ──────────────────────────────────────────────────────── */

/**
 * The expression a developer would actually paste.
 *
 * Flow nodes read their state through `$state`, the way a screen transform reads
 * `$components` — so a path copied out of here has to be prefixed to be usable,
 * and copying the bare path would produce something that silently evaluates to
 * nothing.
 */
export function toStateExpression(path: string): string {
  return `$state.${path}`;
}

/** The app config equivalent, which flows read through `$appConfig`. */
export function toAppConfigExpression(path: string): string {
  return `$appConfig.${path}`;
}

/**
 * Group paths by their first segment, for rendering.
 *
 * `metadata.*`, `claims.*` and the rest each become one collapsible section
 * rather than a flat list of thirty dotted strings.
 */
export function groupByRoot(
  entries: { path: string; value: unknown }[]
): { root: string; entries: { path: string; value: unknown }[] }[] {
  const groups = new Map<string, { path: string; value: unknown }[]>();
  for (const entry of entries) {
    const root = entry.path.split('.')[0];
    const list = groups.get(root);
    if (list) list.push(entry);
    else groups.set(root, [entry]);
  }
  return [...groups]
    .map(([root, list]) => ({ root, entries: list }))
    .sort((a, b) => a.root.localeCompare(b.root));
}
