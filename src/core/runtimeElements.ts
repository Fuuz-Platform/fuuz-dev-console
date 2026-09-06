/**
 * The runtime's own element list, from `$components`.
 *
 * The DOM scrape finds what is *rendered and marked*, and on a live screen that turned out to be
 * the form fields and little else — a chart, a button, a container the renderer marks differently
 * or not at all simply never appeared. Meanwhile the captured context carries `$components` with
 * **every element on the screen**, keyed by the exact name a transform would use.
 *
 * So `$components` is the source of the list and the DOM enriches it. Separate from
 * `runtimeScrape` because this needs no DOM at all, which means it can be unit-tested — and the
 * decision it encodes (what counts as an element on a running screen) is worth testing.
 *
 * Pure.
 */
/**
 * One element, in the shape the element tree consumes.
 *
 * Declared here rather than imported from `runtimeScrape`: that module needs `lib.dom` and is
 * excluded from the Node build, and importing a type from it would drag this module out of the
 * unit tests along with it. The shape is small and stable enough that a local declaration costs
 * less than the coupling.
 */
export interface RuntimeElement {
  nodeId: string;
  name: string;
  type: string;
  label?: string;
  dataPath?: string;
  via: string;
  children: RuntimeElement[];
  origin: 'runtime';
  named: boolean;
  props: string[];
}

/**
 * Every element the runtime knows about, from `$components`.
 *
 * The DOM scrape finds what is *rendered and marked*, and on a live screen that turned out to be
 * the form fields and little else — a chart, a button, a container the renderer marks differently
 * or not at all simply never appeared. Meanwhile the captured context carries `$components` with
 * **every element on the screen**, keyed by the exact name a transform would use.
 *
 * So `$components` becomes the source of the list and the DOM enriches it: types, bound paths and
 * containment where the scrape found them, nothing lost where it did not. An element in the DOM
 * but not in `$components` is kept too — the runtime holds no state for it, which is a real
 * answer and not a reason to hide it.
 *
 * The tree flattens for context-only elements, because `$components` is a flat map: it says what
 * exists, not what contains what. Claiming a hierarchy we do not have would be worse than
 * showing a flat list.
 */
export function mergeWithComponents(
  scraped: RuntimeElement[],
  components: unknown
): { roots: RuntimeElement[]; fromContext: number; fromDom: number } {
  const names = (components !== null && typeof components === 'object' && !Array.isArray(components))
    ? Object.keys(components as Record<string, unknown>)
    : [];

  // Everything the scrape found, by name, so the context can enrich rather than duplicate.
  const seen = new Set<string>();
  const collect = (nodes: RuntimeElement[]) => {
    for (const node of nodes) { seen.add(node.name); collect(node.children); }
  };
  collect(scraped);

  const extra: RuntimeElement[] = names
    .filter((name) => !seen.has(name))
    .map((name) => ({
      nodeId: `${name}@components`,
      name,
      // The DOM would have told us the type; the context does not carry one.
      type: 'Unknown',
      via: '$components',
      children: [],
      origin: 'runtime' as const,
      // Named by the runtime itself, which is as authoritative as it gets.
      named: true,
      props: [],
    }));

  return {
    roots: [...scraped, ...extra],
    fromContext: extra.length,
    fromDom: seen.size,
  };
}
