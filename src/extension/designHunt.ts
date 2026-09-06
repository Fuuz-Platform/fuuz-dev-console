/**
 * Find the screen design the App Designer already has in memory.
 *
 * The designer cannot render a canvas without the full craft graph, so the
 * design **is** in the page — and fetching it again over GraphQL, keyed on a tab
 * id that may not even be a screen id, is doing work the page has already done
 * and can fail in ways this cannot.
 *
 * ## Why this file must run in the MAIN world
 *
 * Chrome gives an isolated content script its own JS heap. DOM *nodes* are
 * shared, but expando properties the page adds to them are not: `__reactFiber$…`
 * is invisible from the isolated world, and so is every page global including
 * `window.__APOLLO_CLIENT__`. Anything that reads the page's own objects has to
 * live here, alongside the console hook.
 *
 * Three places the design can be, tried in order of directness:
 *
 *  1. **Apollo's normalized cache** — the designer fetched the screen version
 *     over GraphQL, so the response is cached with its `design` field intact.
 *     This is the whole document, not a reconstruction.
 *  2. **craft.js editor state**, reached by walking React fibers up from the
 *     canvas. This is what the canvas is actually rendering, so it reflects
 *     unsaved edits — which the API copy never will.
 *  3. **A page global**, scanned as a last resort.
 *
 * Read-only throughout: nothing here writes to the page.
 */

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Does this look like a Fuuz **flow** definition?
 *
 * A flow is not craft-shaped: its nodes are an *array* of objects each carrying an
 * `id` and a `type` (`transformation`, `query`, `mutate`, `http`, `switch`, …),
 * usually with `nextNodes` wiring them together. Detected separately from the
 * screen graph because the designer holds both and reporting one as the other
 * would be worse than finding neither.
 *
 * Deliberately strict on two counts: at least two nodes, and a majority carrying
 * a recognisable node `type`. A loose test matches any array of objects.
 */
const FLOW_NODE_TYPES = /^(transformation|query|mutate|http|switch|ifElse|response|request|delay|subFlow|broadcast|collect|tryCatch|validate|publish|subscribe|screenDialog|searchTable|aggregate|savedTransform|executeFlow|loop|filter|sort|map)$/i;

function isFlowNodes(value: unknown): value is Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length < 2) return false;
  const objects = value.filter(isRecord);
  if (objects.length !== value.length) return false;
  const typed = objects.filter((n) => typeof n.type === 'string' && FLOW_NODE_TYPES.test(n.type as string));
  const identified = objects.filter((n) => typeof n.id === 'string' || typeof n.name === 'string');
  return typed.length >= Math.ceil(objects.length / 2) && identified.length === objects.length;
}

/** A flow node array nested anywhere inside `value`, with the path that found it. */
function findFlowNodes(
  value: unknown,
  path = '',
  depth = 0,
  seen = new WeakSet<object>()
): { nodes: Record<string, unknown>[]; path: string } | undefined {
  if (depth > 8 || value === null || typeof value !== 'object') return undefined;
  if (seen.has(value as object)) return undefined;
  seen.add(value as object);

  if (isFlowNodes(value)) return { nodes: value, path: path || '(root)' };

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const next = path ? `${path}.${key}` : key;
    if (typeof child === 'string' && child.length > 40 && child.trimStart().startsWith('{')) {
      try {
        const hit = findFlowNodes(JSON.parse(child), `${next} (parsed JSON)`, depth + 1, seen);
        if (hit) return hit;
      } catch { /* not JSON */ }
      continue;
    }
    const hit = findFlowNodes(child, next, depth + 1, seen);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Does this look like a craft graph?
 *
 * A map whose values all carry `type` and `props`. Deliberately strict: a loose
 * test picks up any object-of-objects and would report the wrong thing as the
 * design, which is worse than reporting nothing.
 */
function isCraftGraph(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const entries = Object.values(value);
  if (entries.length < 2) return false;
  return entries.every((v) => isRecord(v) && 'type' in v && 'props' in v);
}

/** A craft graph nested anywhere inside `value`, with the path that found it. */
function findCraftGraph(
  value: unknown,
  path = '',
  depth = 0,
  seen = new WeakSet<object>()
): { graph: Record<string, unknown>; path: string } | undefined {
  if (depth > 8 || value === null || typeof value !== 'object') return undefined;
  if (seen.has(value as object)) return undefined;
  seen.add(value as object);

  if (isCraftGraph(value)) return { graph: value, path: path || '(root)' };

  // A design is often stored as a JSON *string*; parse before giving up.
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const next = path ? `${path}.${key}` : key;
    if (typeof child === 'string' && child.length > 40 && child.trimStart().startsWith('{')) {
      try {
        const parsed = JSON.parse(child);
        const hit = findCraftGraph(parsed, `${next} (parsed JSON)`, depth + 1, seen);
        if (hit) return hit;
      } catch { /* not JSON after all */ }
      continue;
    }
    const hit = findCraftGraph(child, next, depth + 1, seen);
    if (hit) return hit;
  }
  return undefined;
}

/* ── Source 1: Apollo's cache ────────────────────────────────────────────── */

function fromApollo(): DesignHit | undefined {
  const client = (window as unknown as { __APOLLO_CLIENT__?: {
    cache?: { extract?: () => unknown };
  } }).__APOLLO_CLIENT__;
  const extract = client?.cache?.extract;
  if (typeof extract !== 'function') return undefined;

  let snapshot: unknown;
  try { snapshot = extract.call(client!.cache); } catch { return undefined; }
  if (!isRecord(snapshot)) return undefined;

  // Prefer an entry that is recognisably a screen version, so a design belonging
  // to something else in the cache is not mistaken for this screen's.
  const candidates = Object.entries(snapshot).sort(([a], [b]) => {
    const score = (k: string) => (/screenVersion/i.test(k) ? 0 : /screen/i.test(k) ? 1 : 2);
    return score(a) - score(b);
  });

  for (const [key, entry] of candidates) {
    const hit = findCraftGraph(entry);
    if (!hit) continue;
    return {
      source: 'apollo',
      where: `__APOLLO_CLIENT__.cache.extract()["${key}"].${hit.path}`,
      nodeCount: Object.keys(hit.graph).length,
      graph: hit.graph,
      screenName: pickString(entry, ['name', 'screenName']),
      version: pickString(entry, ['number', 'version']),
    };
  }
  return undefined;
}

function pickString(entry: unknown, keys: string[]): string | undefined {
  if (!isRecord(entry)) return undefined;
  for (const k of keys) {
    const v = entry[k];
    if (typeof v === 'string' && v) return v;
    if (typeof v === 'number') return String(v);
  }
  return undefined;
}

/* ── Source 2: craft's own editor state, via React fibers ────────────────── */

// `__reactFiber$` sits on rendered nodes. A `createRoot` *container* gets
// `__reactContainer$` instead, which is why anchoring on the canvas element
// itself found nothing — the canvas is the container, not a rendered node.
const FIBER_PREFIXES = ['__reactFiber$', '__reactInternalInstance$', '__reactContainer$'];

interface FiberLike {
  return?: FiberLike | null;
  child?: FiberLike | null;
  memoizedProps?: Record<string, unknown> | null;
  memoizedState?: unknown;
}

function fiberFor(node: Element): FiberLike | undefined {
  for (const key of Object.keys(node)) {
    if (FIBER_PREFIXES.some((p) => key.startsWith(p))) {
      return (node as unknown as Record<string, FiberLike>)[key];
    }
  }
  return undefined;
}

/**
 * Walk up from the canvas looking for craft's node map.
 *
 * This copy reflects **unsaved edits**, which is why it is worth reaching for
 * even when Apollo has a design: what the developer is looking at and what the
 * API would return are not the same document mid-edit.
 */
function fromFibers(): DesignHit | undefined {
  const anchor =
    document.getElementById('mfgx-screen-designer-canvas') ??
    document.querySelector('[data-system-name]') ??
    document.querySelector('li[role="treeitem"][data-node-id]');
  if (!anchor) return undefined;

  let fiber = fiberFor(anchor);
  if (!fiber) return undefined;

  for (let i = 0; i < 60 && fiber; i += 1) {
    for (const bag of [fiber.memoizedProps, fiber.memoizedState] as unknown[]) {
      const hit = findCraftGraph(bag);
      if (hit) {
        return {
          source: 'craft-fiber',
          where: `fiber #${i} ${hit.path}`,
          nodeCount: Object.keys(hit.graph).length,
          graph: hit.graph,
        };
      }
    }
    fiber = fiber.return ?? undefined;
  }
  return undefined;
}

/* ── Source 3: a page global ─────────────────────────────────────────────── */

function fromGlobals(): DesignHit | undefined {
  const w = window as unknown as Record<string, unknown>;
  for (const key of Object.keys(w)) {
    // Skip the noisy standard globals; a design will not be on `location`.
    if (/^(window|document|location|navigator|self|top|parent|frames|history)$/.test(key)) continue;
    let value: unknown;
    try { value = w[key]; } catch { continue; }   // some globals throw on access
    const hit = findCraftGraph(value, key, 1);
    if (hit) {
      return {
        source: 'global',
        where: `window.${hit.path}`,
        nodeCount: Object.keys(hit.graph).length,
        graph: hit.graph,
      };
    }
  }
  return undefined;
}

/* ── Public ──────────────────────────────────────────────────────────────── */

export interface DesignHit {
  source: 'apollo' | 'craft-fiber' | 'global';
  /** Exactly where it was found, so the finding is checkable rather than magic. */
  where: string;
  nodeCount: number;
  graph: Record<string, unknown>;
  screenName?: string;
  version?: string;
}

/** A flow definition found in the page, summarised per node. */
export interface FlowFound {
  where: string;
  nodeCount: number;
  /** One entry per node: what it is, and which of its fields hold logic. */
  nodes: {
    id?: string;
    name?: string;
    type?: string;
    /** Field names whose value is an expression — the transforms and queries. */
    logic: string[];
    nextNodes?: string[];
  }[];
}

/**
 * What the flow engine object actually exposes.
 *
 * The definition was found at `…diagramEngine.dataFlowEngineFlow.flow.nodes`,
 * which means `diagramEngine` is a live handle the designer itself drives. If
 * execution state, node status or timings exist anywhere in the page, that is the
 * likeliest place — and guessing method names would waste a round trip each time.
 *
 * So this reports the *shape*: key names and what kind of thing each is. Names
 * only, never values — an engine holds whole payloads, and copying those into a
 * snapshot pushed every 750ms would be reckless.
 */
export interface EngineProbe {
  where: string;
  keys: Record<string, string>;
  nested: Record<string, Record<string, string>>;
}

/**
 * Whether the page already ships a code editor we could reuse.
 *
 * Fuuz's own transform fields are code editors, so Monaco is very likely already
 * loaded — and reusing the page's instance from the MAIN world costs nothing,
 * where bundling our own would add megabytes to a panel that currently ships
 * ~400 KB. Worth establishing before choosing.
 */
export interface EditorProbe {
  /** A global Monaco, and whether it exposes what an embed needs. */
  monaco: boolean;
  monacoApi: string[];
  /** Registered languages, so we can see whether JSONata is one of them. */
  languages: string[];
  /** CodeMirror, as the lighter alternative if it happens to be present. */
  codeMirror: boolean;
  /** Editor instances already on the page, which can be read for configuration. */
  instances: number;
}

function probeEditors(): EditorProbe {
  const w = window as unknown as Record<string, unknown>;
  const monaco = w.monaco as { editor?: Record<string, unknown>; languages?: {
    getLanguages?: () => { id: string }[];
  } } | undefined;

  let languages: string[] = [];
  try {
    languages = monaco?.languages?.getLanguages?.().map((l) => l.id).sort() ?? [];
  } catch { /* a partially initialised Monaco */ }

  let instances = 0;
  try {
    const getModels = (monaco?.editor as { getModels?: () => unknown[] } | undefined)?.getModels;
    instances = typeof getModels === 'function' ? getModels.call(monaco!.editor).length : 0;
  } catch { /* not ready */ }

  return {
    monaco: !!monaco?.editor,
    // Method names, so an embed targets a real API rather than a guess — the
    // mistake that cost a round trip on the flow engine.
    monacoApi: monaco?.editor ? Object.keys(monaco.editor).filter((k) => typeof (monaco.editor as Record<string, unknown>)[k] === 'function').sort() : [],
    languages,
    codeMirror: !!(w.CodeMirror || w.cm6 || document.querySelector('.cm-editor')),
    instances,
  };
}

export interface DesignHuntResult {
  found?: Omit<DesignHit, 'graph'> & { graph?: Record<string, unknown> };
  /** What was tried and what happened, so a miss is diagnosable. */
  tried: { source: string; ok: boolean; note?: string }[];
  /** The flow definition, when this is a flow designer tab. */
  flow?: FlowFound;
  /** The flow engine's shape, for finding execution hooks. */
  engine?: EngineProbe;
  /** Whether the page already has a code editor we could reuse. */
  editors?: EditorProbe;
  /** Whether the page exposes React fibers to this world at all. */
  fibersVisible: boolean;
  apolloPresent: boolean;
}

/**
 * Look for the design. `includeGraph` is opt-in because a full craft graph is
 * large, and most callers only need to know whether one is there and where.
 */
/**
 * Which of a node's fields carry logic.
 *
 * Fuuz names them by convention — `*Transform`, `transformation`, `query`,
 * `predicate`, `responseTransform` — and the values are JSONata or GraphQL. Only
 * the field *names* and a short preview go back: a full flow's expressions can be
 * hundreds of KB and this rides in a snapshot pushed every ~750ms.
 */
const LOGIC_FIELD = /transform|transformation|query|predicate|expression|script|filter|variables|body|headers|input/i;

/** Describe a value by kind, never by content. */
function kindOf(v: unknown): string {
  if (typeof v === 'function') return 'fn';
  if (Array.isArray(v)) return `array(${v.length})`;
  if (v === null) return 'null';
  if (isRecord(v)) return 'object';
  return typeof v;
}

/** Key names and kinds for one object, plus one level of nested objects. */
function describeHandle(where: string, obj: unknown): EngineProbe | undefined {
  if (!isRecord(obj)) return undefined;
  const keys: Record<string, string> = {};
  const nested: Record<string, Record<string, string>> = {};
  for (const [k, v] of Object.entries(obj)) {
    keys[k] = kindOf(v);
    // One level down only: enough to spot `execute`/`state`/`metrics` without
    // walking an engine that holds the entire flow payload.
    if (isRecord(v)) {
      const inner: Record<string, string> = {};
      for (const [k2, v2] of Object.entries(v)) inner[k2] = kindOf(v2);
      nested[k] = inner;
    }
  }
  return { where, keys, nested };
}

function summariseNode(node: Record<string, unknown>): FlowFound['nodes'][number] {
  const logic: string[] = [];
  const scan = (obj: Record<string, unknown>, prefix = '', depth = 0) => {
    if (depth > 3) return;
    for (const [k, v] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (typeof v === 'string' && v.trim() && LOGIC_FIELD.test(k)) logic.push(path);
      else if (isRecord(v)) scan(v, path, depth + 1);
    }
  };
  scan(node);
  const next = node.nextNodes;
  return {
    id: typeof node.id === 'string' ? node.id : undefined,
    name: typeof node.name === 'string' ? node.name : undefined,
    type: typeof node.type === 'string' ? node.type : undefined,
    logic,
    nextNodes: Array.isArray(next) ? next.filter((n): n is string => typeof n === 'string') : undefined,
  };
}

export function huntDesign(includeGraph = false): DesignHuntResult {
  const tried: DesignHuntResult['tried'] = [];
  const anchor =
    document.getElementById('mfgx-screen-designer-canvas') ??
    document.querySelector('[data-system-name]') ??
    document.querySelector('li[role="treeitem"][data-node-id]');

  const result: DesignHuntResult = {
    tried,
    // If this is false in a browser but true in a test, the test is running
    // without world isolation and is not proving anything about fibers.
    fibersVisible: !!(anchor && fiberFor(anchor)),
    apolloPresent: !!(window as unknown as { __APOLLO_CLIENT__?: unknown }).__APOLLO_CLIENT__,
  };

  // The flow definition is looked for in the same places, since the designer
  // holds it the same way — in React state rather than Apollo, as it turned out.
  try {
    const anchors: unknown[] = [];
    const canvas = document.querySelector('[id$="-mfgx-data-flow-diagram"]');
    // Prefer a rendered node inside the canvas: those carry `__reactFiber$` and
    // sit closer to the component holding the flow than the container does.
    const anchor = canvas?.querySelector('[data-nodeid]') ?? canvas?.firstElementChild ?? canvas;
    if (anchor) {
      let fiber = fiberFor(anchor);
      for (let i = 0; i < 60 && fiber; i += 1) {
        anchors.push(fiber.memoizedProps, fiber.memoizedState);
        // A container fiber has no `return`; its tree hangs off `child`.
        fiber = (fiber.return ?? (fiber as { child?: FiberLike }).child) ?? undefined;
      }
    }
    for (const bag of anchors) {
      const hit = findFlowNodes(bag);
      if (!hit) continue;
      result.flow = {
        where: hit.path,
        nodeCount: hit.nodes.length,
        nodes: hit.nodes.map(summariseNode),
      };
      // The engine sits just above the nodes on the same path; describe it so we
      // can see whether it exposes execution state or timings before guessing.
      const enginePath = hit.path.replace(/\.flow\.nodes$/, '');
      let handle: unknown = bag;
      for (const seg of enginePath.split('.')) {
        if (!isRecord(handle)) { handle = undefined; break; }
        handle = handle[seg];
      }
      result.engine = describeHandle(enginePath, handle);
      break;
    }
    tried.push({ source: 'flow-nodes', ok: !!result.flow,
      note: result.flow ? `${result.flow.nodeCount} nodes at ${result.flow.where}` : 'no flow node array found' });
  } catch (e) {
    tried.push({ source: 'flow-nodes', ok: false, note: e instanceof Error ? e.message : String(e) });
  }

  try { result.editors = probeEditors(); }
  catch (e) { tried.push({ source: 'editors', ok: false, note: e instanceof Error ? e.message : String(e) }); }

  for (const [source, fn] of [
    ['apollo', fromApollo],
    ['craft-fiber', fromFibers],
    ['global', fromGlobals],
  ] as const) {
    let hit: DesignHit | undefined;
    try { hit = fn(); } catch (e) {
      tried.push({ source, ok: false, note: e instanceof Error ? e.message : String(e) });
      continue;
    }
    tried.push({ source, ok: !!hit, note: hit ? `${hit.nodeCount} nodes at ${hit.where}` : 'nothing craft-shaped found' });
    if (hit && !result.found) {
      const { graph, ...rest } = hit;
      result.found = includeGraph ? { ...rest, graph } : rest;
    }
  }
  return result;
}
