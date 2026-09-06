/**
 * The screen's element tree, from the design.
 *
 * The DOM shows you `div` inside `div`; this shows the elements as authored —
 * `TusUploader <EmbeddedWebpage>` inside `UploaderSlot` — which is the only
 * naming a Fuuz developer actually thinks in.
 *
 * Built from the craft graph's `parent` / `nodes` / `linkedNodes` links.
 *
 * Pure.
 */

export interface StructureNode {
  /** Craft node id — stable, and what the highlighter keys on. */
  nodeId: string;
  /** `custom.elementName`, or the node id when the element is unnamed. */
  name: string;
  /** Whether the author named it; unnamed nodes are layout containers. */
  named: boolean;
  type: string;
  /** Dynamic props declared on this element. */
  props: string[];
  /** A bound field, for inputs. */
  dataPath?: string;
  label?: string;
  /** The element's `style` prop — Fuuz's "additional styles", a plain CSS object. */
  style?: Record<string, string>;
  /** Whether the element type accepts a `style` prop at all. */
  stylable: boolean;
  /**
   * Where this node came from. `designer-dom` nodes are scraped from the App
   * Designer's own tree and carry no type or prop information, so anything
   * derived from the design must not be asserted about them.
   */
  origin?: 'design' | 'designer-dom' | 'canvas';
  /** Children the designer claims exist but has not rendered (collapsed row). */
  unrendered?: number;
  children: StructureNode[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Find the craft graph inside whatever wrapper the design arrived in. */
export function craftGraph(doc: unknown, depth = 0): Record<string, unknown> | undefined {
  if (depth > 12 || !isRecord(doc)) return undefined;
  // A graph is a map whose values look like craft nodes.
  const values = Object.values(doc);
  if (values.length && values.every((v) => isRecord(v) && 'type' in v && 'props' in v)) {
    return doc;
  }
  for (const [key, value] of Object.entries(doc)) {
    if (key === 'design' && typeof value === 'string' && value.trim().startsWith('{')) {
      try { const hit = craftGraph(JSON.parse(value), depth + 1); if (hit) return hit; } catch { /* not JSON */ }
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) { const hit = craftGraph(item, depth + 1); if (hit) return hit; }
      continue;
    }
    const hit = craftGraph(value, depth + 1);
    if (hit) return hit;
  }
  return undefined;
}

export function buildStructure(doc: unknown): StructureNode[] {
  const graph = craftGraph(doc);
  if (!graph) return [];

  const node = (id: string, depth: number, seen: Set<string>): StructureNode | undefined => {
    if (depth > 24 || seen.has(id)) return undefined;
    seen.add(id);
    const raw = graph[id];
    if (!isRecord(raw)) return undefined;

    const props = isRecord(raw.props) ? raw.props : {};
    const custom = isRecord(raw.custom) ? raw.custom : {};
    const elementName = typeof custom.elementName === 'string' ? custom.elementName : undefined;
    const type = (isRecord(raw.type) && typeof raw.type.resolvedName === 'string') ? raw.type.resolvedName : 'Unknown';

    const childIds = [
      ...(Array.isArray(raw.nodes) ? raw.nodes.filter((c): c is string => typeof c === 'string') : []),
      ...(isRecord(raw.linkedNodes) ? Object.values(raw.linkedNodes).filter((c): c is string => typeof c === 'string') : []),
    ];

    return {
      nodeId: id,
      name: elementName ?? id,
      named: !!elementName,
      type,
      // Dynamic props are the ones with a transform behind them.
      props: Object.entries(props)
        .filter(([, v]) => isRecord(v) && typeof v.__transform === 'string')
        .map(([k]) => k),
      dataPath: typeof props.dataPath === 'string' ? props.dataPath : undefined,
      label: typeof props.label === 'string' ? props.label : undefined,
      style: isRecord(props.style)
        ? Object.fromEntries(Object.entries(props.style).map(([k, v]) => [k, String(v)]))
        : undefined,
      // `style` present in the design (even as {}) means the element accepts it.
      stylable: 'style' in props,
      children: childIds.map((c) => node(c, depth + 1, seen)).filter((c): c is StructureNode => !!c),
    };
  };

  const roots = Object.keys(graph).filter((id) => !isRecord(graph[id]) || !(graph[id] as Record<string, unknown>).parent);
  const seen = new Set<string>();
  return roots.map((r) => node(r, 0, seen)).filter((n): n is StructureNode => !!n);
}

/** Flatten for search, keeping depth for indentation. */
export function flattenStructure(nodes: StructureNode[], depth = 0): { node: StructureNode; depth: number }[] {
  return nodes.flatMap((n) => [{ node: n, depth }, ...flattenStructure(n.children, depth + 1)]);
}
