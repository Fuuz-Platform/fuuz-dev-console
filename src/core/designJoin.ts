/**
 * Join the runtime console against the screen's design.
 *
 * The runtime tells you a transform ran and what it produced; the design tells
 * you which element it belongs to. Neither is sufficient alone:
 *
 *  - The runtime names the owning component only for action-driven transforms
 *    (`trace.origin === 'Action'`). Everything else logs a bare `property`, so
 *    an `url` can't be attributed from the log by itself.
 *  - The design knows every element, its type and its dynamic props, but not
 *    which of them actually ran, in what order, or what they produced.
 *
 * They join exactly, because both sides carry the *same object*: the design
 * stores `props[prop] = { __transform, __cacheKey, __remote }` and the runtime
 * echoes it at `trace.dynamicProps[prop].info`. Matching on `__cacheKey` or the
 * transform source resolves the owner with no guessing — and where the design is
 * genuinely ambiguous (two columns sharing one cacheKey and transform), this
 * deliberately declines to attribute rather than pick one.
 *
 * Pure: no VS Code, no I/O.
 */
import { dig } from './classify';
import type { LogEntry } from './types';

/** One dynamic prop declared on one element in the screen design. */
export interface DesignProp {
  /** Craft node id — stable, unlike the display name. */
  nodeId: string;
  /** Runtime component name (`custom.elementName`), the key in `context.components`. */
  elementName: string;
  /** Element type, e.g. `EmbeddedWebpage`, `FlowButton`, `Form`, `TableColumn`. */
  elementType: string;
  /** The prop the transform produces, e.g. `url`, `disabled`, `linkTarget`. */
  property: string;
  transform: string;
  /** Author-supplied name for the transform; often empty. */
  cacheKey?: string;
  /** Whether the transform evaluates server-side. */
  remote: boolean;
}

export interface ScreenDesignIndex {
  screenName: string;
  version?: string;
  /** Element type by runtime component name. */
  elementTypes: Map<string, string>;
  props: DesignProp[];
  /** Candidates by cacheKey / normalized transform. >1 candidate = ambiguous. */
  byCacheKey: Map<string, DesignProp[]>;
  byTransform: Map<string, DesignProp[]>;
}

/** Compare dotted versions numerically, so 0.0.27 beats 0.0.7. */
export function compareVersions(a = '', b = ''): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Loose name match — screen names carry spaces, filenames rarely do. */
export function namesMatch(a: string, b: string): boolean {
  const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return !!a && !!b && key(a) === key(b);
}

/** Collapse whitespace so formatting differences don't break the join. */
export function normalizeTransform(src: string): string {
  return String(src ?? '').replace(/\s+/g, ' ').trim();
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Walk a screen design document and index every dynamic prop.
 *
 * Deliberately structure-tolerant: it looks for craft.js-shaped nodes
 * (`type.resolvedName` + `props`) anywhere in the document, so it works whether
 * the design arrives as a pushed screen file, an MCP payload, or a nested
 * `design.components[].props.design` blob — including when that blob is a
 * JSON string.
 */
export function indexScreenDesign(doc: unknown, fallbackName = 'Screen'): ScreenDesignIndex {
  const index: ScreenDesignIndex = {
    screenName: (isRecord(doc) && typeof doc.name === 'string' ? doc.name : fallbackName),
    version: isRecord(doc) && typeof doc.version === 'string' ? doc.version : undefined,
    elementTypes: new Map(),
    props: [],
    byCacheKey: new Map(),
    byTransform: new Map(),
  };

  const seen = new Set<unknown>();
  const visit = (node: unknown, depth: number): void => {
    if (depth > 24 || node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) { node.forEach((n) => visit(n, depth + 1)); return; }

    const rec = node as Record<string, unknown>;

    // A craft node: `{ type: { resolvedName }, props, custom: { elementName } }`.
    const resolvedName = dig(rec, 'type.resolvedName');
    if (typeof resolvedName === 'string' && isRecord(rec.props)) {
      const nodeId = typeof rec.__nodeId === 'string' ? rec.__nodeId : '';
      const elementName = (dig(rec, 'custom.elementName') as string) || nodeId || resolvedName;
      index.elementTypes.set(elementName, resolvedName);

      for (const [property, value] of Object.entries(rec.props)) {
        if (!isRecord(value) || typeof value.__transform !== 'string') continue;
        const prop: DesignProp = {
          nodeId,
          elementName,
          elementType: resolvedName,
          property,
          transform: value.__transform,
          cacheKey: typeof value.__cacheKey === 'string' && value.__cacheKey ? value.__cacheKey : undefined,
          remote: value.__remote === true,
        };
        index.props.push(prop);
        push(index.byTransform, normalizeTransform(prop.transform), prop);
        if (prop.cacheKey) push(index.byCacheKey, prop.cacheKey, prop);
      }
    }

    for (const [key, value] of Object.entries(rec)) {
      // The craft graph is often carried as a JSON string.
      if (typeof value === 'string' && key === 'design' && value.trim().startsWith('{')) {
        try { visit(withNodeIds(JSON.parse(value)), depth + 1); } catch { /* not JSON after all */ }
        continue;
      }
      if (key === 'design' && isRecord(value)) { visit(withNodeIds(value), depth + 1); continue; }
      visit(value, depth + 1);
    }
  };

  visit(doc, 0);
  return index;
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value); else map.set(key, [value]);
}

/**
 * The craft graph is `{ <nodeId>: node }`, so the id lives in the key. Stamp it
 * onto each node before walking, since `visit` only sees values.
 */
function withNodeIds(graph: unknown): unknown {
  if (!isRecord(graph)) return graph;
  const out: Record<string, unknown> = {};
  for (const [id, node] of Object.entries(graph)) {
    out[id] = isRecord(node) && dig(node, 'type.resolvedName') ? { ...node, __nodeId: id } : node;
  }
  return out;
}

/** How an entry got attributed to an element — surfaced so the join is auditable. */
export type AttributionVia = 'runtime' | 'cacheKey' | 'transform' | 'property' | 'ambiguous' | 'unknown';

export interface Attribution {
  /** The element the transform belongs to, when resolvable. */
  prop?: DesignProp;
  via: AttributionVia;
}

/** Pull the design-side info the runtime echoed for this entry, if present. */
function traceInfo(entry: LogEntry): { cacheKey?: string; transform?: string; property?: string } {
  const payload = entry.payload.find((a) => a && typeof a === 'object');
  const property = dig(payload, 'trace.property') as string | undefined;
  const info = property ? dig(payload, `trace.dynamicProps.${property}.info`) : undefined;
  return {
    property,
    cacheKey: (dig(info, '__cacheKey') as string) || undefined,
    // The runtime truncates `__transform` in the trace, so prefer the full
    // `expression` it logs alongside.
    transform: entry.expr ?? (dig(info, '__transform') as string | undefined),
  };
}

/**
 * Attribute one entry to a design element.
 *
 * Order is most-trustworthy first, and every step requires a *unique* match —
 * an ambiguous design (two elements sharing a transform) reports `ambiguous`
 * rather than picking one.
 */
export function attributeEntry(entry: LogEntry, index: ScreenDesignIndex): Attribution {
  const { cacheKey, transform, property } = traceInfo(entry);

  // The runtime already named the component; use the design only for its type.
  if (entry.write.startsWith('components.') && property) {
    const elementName = entry.write.split('.')[1];
    const exact = index.props.find((p) => p.elementName === elementName && p.property === property);
    if (exact) return { prop: exact, via: 'runtime' };
    if (index.elementTypes.has(elementName)) {
      return { prop: { nodeId: '', elementName, elementType: index.elementTypes.get(elementName)!, property, transform: transform ?? '', remote: false }, via: 'runtime' };
    }
  }

  const lookups: { via: AttributionVia; candidates?: DesignProp[] }[] = [
    { via: 'cacheKey', candidates: cacheKey ? index.byCacheKey.get(cacheKey) : undefined },
    { via: 'transform', candidates: transform ? index.byTransform.get(normalizeTransform(transform)) : undefined },
  ];
  for (const { via, candidates } of lookups) {
    if (!candidates?.length) continue;
    if (candidates.length > 1) return { via: 'ambiguous' };
    return { prop: candidates[0], via };
  }

  // Last resort: exactly one element in the whole screen declares this property.
  if (property) {
    const byProperty = index.props.filter((p) => p.property === property);
    if (byProperty.length === 1) return { prop: byProperty[0], via: 'property' };
    if (byProperty.length > 1) return { via: 'ambiguous' };
  }

  return { via: 'unknown' };
}

/**
 * Re-point entries at their real owners using the design.
 *
 * This is what turns `(computed).url` into `components.AssetPlayer.url`: the
 * runtime couldn't say, and the design could.
 */
export function applyDesign(entries: LogEntry[], index: ScreenDesignIndex): LogEntry[] {
  return entries.map((entry) => {
    if (!entry.write) return entry;
    const { prop, via } = attributeEntry(entry, index);
    if (!prop) return via === 'ambiguous' ? { ...entry, attribution: via } : entry;
    return {
      ...entry,
      write: `components.${prop.elementName}.${prop.property}`,
      elementType: prop.elementType,
      // Stamped explicitly rather than left encoded in `write`: the node id is the
      // only identifier that survives a rename, and a consumer that wants "which
      // element produced this" should not have to parse a dot path to get it.
      nodeId: prop.nodeId || undefined,
      elementName: prop.elementName,
      property: prop.property,
      cacheKey: prop.cacheKey,
      remote: prop.remote,
      attribution: via,
    };
  });
}

export interface DesignCoverage {
  /** Dynamic props declared in the design. */
  total: number;
  /** Those observed evaluating at runtime. */
  exercised: number;
  /** Declared but never seen — unreached branches, or logic the run never hit. */
  unexercised: DesignProp[];
}

/**
 * What the design declares versus what the run actually evaluated. The
 * unexercised list is the interesting half: a `disabled` transform that never
 * ran is a branch this test never reached.
 */
export function designCoverage(entries: LogEntry[], index: ScreenDesignIndex): DesignCoverage {
  const hit = new Set<string>();
  for (const entry of entries) {
    if (!entry.write) continue;
    const { prop } = attributeEntry(entry, index);
    if (prop) hit.add(`${prop.elementName}.${prop.property}`);
  }
  const unexercised = index.props.filter((p) => !hit.has(`${p.elementName}.${p.property}`));
  return { total: index.props.length, exercised: index.props.length - unexercised.length, unexercised };
}


/**
 * Which element a log entry belongs to, for highlighting it in the page.
 *
 * The join has already normalised a transform's write to
 * `components.<elementName>.<property>` — from the runtime for action-driven
 * transforms, from the design for everything else. So the owner is readable off
 * `write` with no further guessing, and an entry whose write is not
 * component-scoped (a query, a screen-level flow) honestly has no owning element
 * to point at.
 *
 * Pure.
 */
export function entryOwner(entry: Pick<LogEntry, 'write' | 'elementType'>): {
  name: string; property?: string; type?: string;
} | undefined {
  const parts = String(entry.write ?? '').split('.');
  if (parts[0] !== 'components' || !parts[1]) return undefined;
  return { name: parts[1], property: parts[2], type: entry.elementType };
}
