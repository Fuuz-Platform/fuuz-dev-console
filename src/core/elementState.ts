/**
 * The screen as one thing: every element, with the state it is actually holding.
 *
 * Structure and State answered halves of the same question and neither was
 * usable alone. The tree told you `AssetIntakeForm` exists and sits inside
 * `IntakeFormSlot`; the state told you something called `AssetIntakeForm` has
 * `data.title = "…"` — and joining them was left to the developer's memory.
 * Here the element tree is the spine and state hangs off it.
 *
 * Three things this makes visible that neither view could:
 *
 *  - **an element with no state at all** — it never rendered, or never ran its
 *    query, which is a different bug from one holding the wrong values;
 *  - **state with no element** — something is in `context.components` that the
 *    structure does not contain, which means the structure is incomplete (a
 *    collapsed designer row, a filtered tree, a stale design);
 *  - **screen-level context** alongside the elements that read it, rather than
 *    in a separate tab.
 *
 * Pure.
 */
import type { StateNode } from './types';
import type { StructureNode } from './structure';

export interface ElementStateNode {
  /** The element, as authored. */
  element: StructureNode;
  /** Its live state subtree, when the runtime is holding any. */
  state?: StateNode;
  /** Whether the runtime has state for it — distinct from state being empty. */
  hasState: boolean;
  /** Top-level state keys, for the collapsed summary: `data, loading, errors`. */
  stateKeys: string[];
  children: ElementStateNode[];
}

export interface MergedScreen {
  /** The element tree, each node carrying its state. */
  elements: ElementStateNode[];
  /**
   * Component state with no matching element.
   *
   * Never silently dropped: an orphan is evidence the element tree is missing
   * something, and hiding it would make a partial tree look complete.
   */
  orphans: StateNode[];
  /** Screen-level roots that are not components — `metadata`, `context`, … */
  screen: StateNode[];
  /** Elements the runtime holds no state for at all. */
  withoutState: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** The `components` group from a built state tree, whatever depth it sits at. */
function componentsGroup(tree: StateNode[]): StateNode | undefined {
  for (const root of tree) {
    if (root.label === 'components') return root;
    const nested = root.children?.find((c) => c.label === 'components');
    if (nested) return nested;
  }
  return undefined;
}

/** Screen-level roots — everything the tree holds that is not `components`. */
function screenRoots(tree: StateNode[]): StateNode[] {
  const out: StateNode[] = [];
  for (const root of tree) {
    if (root.label === 'components') continue;
    // A single `Screen` root wraps the real groups; unwrap it so `metadata` and
    // `context` sit at the top rather than one pointless level down.
    if (root.children?.some((c) => c.label === 'components')) {
      out.push(...root.children.filter((c) => c.label !== 'components'));
      continue;
    }
    out.push(root);
  }
  return out;
}

/**
 * Join the element tree to the state tree.
 *
 * Matched by element **name**, which is what the runtime keys `context.components`
 * by — not by craft node id, which never appears in state.
 */
export function mergeScreen(structure: StructureNode[], stateTree: StateNode[]): MergedScreen {
  const group = componentsGroup(stateTree);
  const byName = new Map<string, StateNode>();
  for (const child of group?.children ?? []) byName.set(child.label, child);

  const claimed = new Set<string>();
  let withoutState = 0;

  const walk = (nodes: StructureNode[]): ElementStateNode[] =>
    nodes.map((element) => {
      const state = byName.get(element.name);
      if (state) claimed.add(element.name);
      else withoutState += 1;
      return {
        element,
        state,
        hasState: !!state,
        stateKeys: (state?.children ?? []).map((c) => c.label),
        children: walk(element.children),
      };
    });

  const elements = walk(structure);
  const orphans = (group?.children ?? []).filter((c) => !claimed.has(c.label));

  return { elements, orphans, screen: screenRoots(stateTree), withoutState };
}

/** Flatten for rendering and search, keeping depth for indentation. */
export function flattenMerged(
  nodes: ElementStateNode[],
  depth = 0
): { node: ElementStateNode; depth: number }[] {
  return nodes.flatMap((n) => [{ node: n, depth }, ...flattenMerged(n.children, depth + 1)]);
}

/**
 * One line summarising an element's state, for the collapsed row.
 *
 * Deliberately distinguishes the three states a developer confuses: no state at
 * all, state that is present but empty, and state with values.
 */
export function stateSummary(node: ElementStateNode): string {
  if (!node.hasState) return 'no state';
  if (!node.stateKeys.length) return node.state?.value ?? 'empty';
  return node.stateKeys.slice(0, 4).join(', ') + (node.stateKeys.length > 4 ? ', …' : '');
}

/** Does this element, or anything under it, match the query? */
export function matchesQuery(node: ElementStateNode, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const own = `${node.element.name} ${node.element.type} ${node.element.label ?? ''} ${node.stateKeys.join(' ')}`;
  if (own.toLowerCase().includes(q)) return true;
  return node.children.some((c) => matchesQuery(c, q));
}

/** Keep only branches that match, preserving ancestors of a match. */
export function filterMerged(nodes: ElementStateNode[], query: string): ElementStateNode[] {
  if (!query.trim()) return nodes;
  return nodes
    .filter((n) => matchesQuery(n, query))
    .map((n) => ({ ...n, children: filterMerged(n.children, query) }));
}

/** Search a value deep inside an element's state, for "who holds this value?". */
export function findInState(node: StateNode | undefined, needle: string, depth = 0): boolean {
  if (!node || depth > 12) return false;
  const n = needle.toLowerCase();
  if (node.label.toLowerCase().includes(n)) return true;
  if (node.value?.toLowerCase().includes(n)) return true;
  return (node.children ?? []).some((c) => findInState(c, needle, depth + 1));
}

/** Read `components.<name>` straight out of a raw context, for callers without a tree. */
export function componentState(context: unknown, name: string): { found: boolean; value?: unknown } {
  if (!isRecord(context)) return { found: false };
  const components = context.components;
  if (!isRecord(components) || !(name in components)) return { found: false };
  return { found: true, value: components[name] };
}
