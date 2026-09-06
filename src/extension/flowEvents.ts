/**
 * Real per-node timings, from the flow engine's own events.
 *
 * The engine probe found an EventEmitter at
 * `…diagramEngine.dataFlowEngineFlow` emitting six events:
 *
 *     nodeExecutionQueued  Started  Succeeded  Finished  Failed  Aborted
 *
 * `Started` → `Finished` is the platform's **own** measurement of a node, which
 * makes the DOM-arrival proxy a fallback rather than the plan. Two things the
 * proxy could not do and this can:
 *
 *  - **Separate parallel branches.** A `broadcast` fans out in one tick, so six
 *    arrivals landed on the same millisecond with meaningless deltas. Each event
 *    carries its own execution, so concurrent runs of one node stay distinct.
 *  - **Distinguish failure from silence.** A node that threw and a node that never
 *    ran look identical in a log scrape; `Failed` and `Aborted` say which.
 *
 * MAIN world only — the engine is a page object, invisible from the isolated
 * world. Read-only: this subscribes and never invokes anything on the engine.
 */

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** The events worth recording, and how each ends an execution. */
const EVENTS = [
  'nodeExecutionQueued',
  'nodeExecutionStarted',
  'nodeExecutionSucceeded',
  'nodeExecutionFinished',
  'nodeExecutionFailed',
  'nodeExecutionAborted',
] as const;

type Phase = (typeof EVENTS)[number];

export interface NodeRun {
  /** Node display name, as the log prints it — what the cards join on. */
  node: string;
  /** Node type from the event, when it carries one. */
  type?: string;
  /** Distinguishes concurrent runs of the same node in a broadcast. */
  key: string;
  queuedAt?: number;
  startedAt?: number;
  finishedAt?: number;
  /** Platform-measured duration: Started → Finished. */
  durationMs?: number;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'aborted';
  error?: string;
  /**
   * The real payloads, from the event rather than the console's rendered text.
   *
   * This is why the native console is not needed: it prints `Array(10)` and
   * `{…}` because that is how a console renders, but the event carries the whole
   * object. Serialised with the bulk summarised rather than clipped, so a big
   * result is described honestly instead of looking complete.
   */
  /** The payload this node received — not the whole flow state. */
  input?: unknown;
  output?: unknown;
  /**
   * The accumulated flow state on the way in.
   *
   * Shown separately and collapsed: it repeats on every node from the point it was
   * stashed, so presenting it as the node's input buries the few fields that are
   * actually this node's business.
   */
  state?: unknown;
  outputState?: unknown;
  /** Set on the stripped copies, so the UI knows a fetch is worthwhile. */
  hasInput?: boolean;
  hasOutput?: boolean;
  hasState?: boolean;
}

const CAP = 400;
let runs: NodeRun[] = [];

/**
 * Raw shape of the first few events, for when the payload is not what we assumed.
 *
 * `identify()` guesses at `node` / `nodeId` / `executionId` because the probe
 * reported key *kinds*, not payloads. If that guess is wrong every event is
 * dropped and the result is an empty list that looks exactly like "the flow did
 * not run" — which is precisely what happened. So the shape is recorded: key
 * names and kinds only, never values, since a payload holds whole node inputs.
 */
const SHAPE_CAP = 6;
const shapes: { event: string; keys: Record<string, string>; nested: Record<string, string[]> }[] = [];

function describePayload(event: string, payload: unknown): void {
  if (shapes.length >= SHAPE_CAP) return;
  const keys: Record<string, string> = {};
  const nested: Record<string, string[]> = {};
  if (isRecord(payload)) {
    for (const [k, v] of Object.entries(payload)) {
      keys[k] = Array.isArray(v) ? `array(${v.length})` : v === null ? 'null' : typeof v;
      if (isRecord(v)) nested[k] = Object.keys(v).slice(0, 20);
    }
  } else {
    keys['(payload)'] = payload === undefined ? 'undefined' : typeof payload;
  }
  shapes.push({ event, keys, nested });
}
let attachedTo: object | undefined;
let attachError: string | undefined;
let unidentified = 0;

/**
 * `$appConfig`, captured from whichever event carries it.
 *
 * The flow log prints it in every row's `▶more` group, so it travels with the
 * execution rather than being a page global we could look up. One value for the
 * whole flow, so the first sighting is kept and the rest ignored — and it belongs
 * in the globals section, not repeated on 23 node cards.
 */
let appConfig: unknown;

/** Find an `appConfig` key within the first couple of levels of a payload. */
function findAppConfig(payload: unknown, depth = 0): unknown {
  if (depth > 2 || !isRecord(payload)) return undefined;
  if (payload.appConfig !== undefined) return payload.appConfig;
  for (const v of Object.values(payload)) {
    const hit = findAppConfig(v, depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * The real event shape, learned from a live run rather than assumed.
 *
 * An earlier version guessed at top-level `node` / `nodeId` / `executionId` and
 * dropped **all 64 events** silently — the counter that caught it exists because
 * that failure looked exactly like "the flow did not run".
 *
 *     { message: { flow, flowId, node, nodeType, nodeId, inputState, output,
 *                  messageProperties },
 *       metrics: { executionQueuedAt } | { executionStartAt },
 *       result:  { output, outputState } }
 */
interface FlowEventPayload {
  message?: {
    node?: unknown; nodeId?: unknown; nodeType?: unknown;
    inputState?: unknown; output?: unknown;
  };
  metrics?: { executionQueuedAt?: unknown; executionStartAt?: unknown };
  result?: { output?: unknown; outputState?: unknown };
}

function identify(payload: unknown): { node: string; type?: string } | undefined {
  if (!isRecord(payload)) return undefined;
  const message = (payload as FlowEventPayload).message;
  if (!isRecord(message)) return undefined;

  // `node` is the display name the log prints, which is what the cards join on;
  // `nodeId` is the stable id. Prefer the name so the join works, keep the id.
  const raw = message.node ?? message.nodeId;
  const name = isRecord(raw) ? (raw.name ?? raw.id) : raw;
  if (typeof name !== 'string' || !name) return undefined;
  const type = typeof message.nodeType === 'string' ? message.nodeType : undefined;
  return { node: name, type };
}

/** A platform timestamp, if it looks like one. */
function stamp(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const parsed = Date.parse(v);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function record(phase: Phase, payload: unknown): void {
  describePayload(phase, payload);
  const id = identify(payload);
  // Dropped events are counted, so "no runs" can be told apart from "no events".
  if (!id) { unidentified += 1; return; }
  const at = Date.now();
  const p = payload as FlowEventPayload;

  /*
   * Match the **oldest** open run for this node, not the newest.
   *
   * A broadcast has several executions of one node in flight at once, and the
   * phases arrive in order per execution. FIFO pairs each Finished with the
   * Started that began it; LIFO would attribute the first completion to the last
   * start and skew every duration in a parallel branch.
   */
  let run = runs.find((r) => r.node === id.node && r.finishedAt === undefined);
  if (!run || phase === 'nodeExecutionQueued') {
    run = { node: id.node, type: id.type, key: `${id.node}#${runs.length}`, status: 'queued' };
    runs.push(run);
    if (runs.length > CAP) runs = runs.slice(-CAP);
  }

  if (appConfig === undefined) {
    const found = findAppConfig(payload);
    if (found !== undefined) appConfig = serialise(found);
  }

  /*
   * `inputState` is NOT the node's input.
   *
   * It is the whole accumulated flow state — everything every prior node stashed.
   * Labelling it "input" was wrong and made every node look like it received the
   * entire Bunny API response, because `Stash Library` had put it in state and it
   * travels with every subsequent node from then on.
   *
   * Fuuz's own console draws the same distinction: it shows `input:` and `output:`
   * at the top level and puts `inputState` / `outputState` under `▶more`. So they
   * are kept apart here too — `state` for the accumulated context, `input` for the
   * payload the node actually received.
   */
  const state = p.message?.inputState;
  const payloadIn = (p.message as { input?: unknown; payload?: unknown } | undefined)?.input
    ?? (p.message as { payload?: unknown } | undefined)?.payload;
  const out = p.result?.output ?? p.message?.output;
  const outState = p.result?.outputState;

  if (payloadIn !== undefined && run.input === undefined) run.input = serialise(payloadIn);
  if (state !== undefined && run.state === undefined) run.state = serialise(state);
  if (out !== undefined) run.output = serialise(out);
  if (outState !== undefined) run.outputState = serialise(outState);

  // Platform timestamps where they exist; ours only as a fallback.
  const queued = stamp(p.metrics?.executionQueuedAt);
  const started = stamp(p.metrics?.executionStartAt);

  if (phase === 'nodeExecutionQueued') run.queuedAt = queued ?? at;
  else if (phase === 'nodeExecutionStarted') { run.startedAt = started ?? at; run.status = 'running'; }
  else if (phase === 'nodeExecutionSucceeded') run.status = 'succeeded';
  else if (phase === 'nodeExecutionFailed') {
    run.status = 'failed';
    const err = isRecord(payload) ? (payload.error ?? payload.message) : undefined;
    run.error = typeof err === 'string' ? err : err ? JSON.stringify(err).slice(0, 300) : 'failed';
  } else if (phase === 'nodeExecutionAborted') run.status = 'aborted';

  if (phase === 'nodeExecutionFinished' || phase === 'nodeExecutionFailed' || phase === 'nodeExecutionAborted') {
    run.finishedAt = at;
    // Only Started→Finished is a duration. Queued→Finished would include queue
    // wait, which is not what "how long did it take" means.
    //
    // `executionStartAt` is the platform's own stamp and the finish is ours. That
    // is sound here because a Screen flow executes in this browser, so both come
    // off the same clock — it would not be for a server-side Integration flow,
    // and that case needs a platform-emitted finish stamp.
    if (run.startedAt !== undefined) run.durationMs = Math.max(0, at - run.startedAt);
  }
}

interface Emitter { on?: (e: string, fn: (p: unknown) => void) => void; addListener?: Emitter['on'] }

/** Just enough of a fiber to walk it; the full shape is React's own business. */
interface FiberLike {
  return?: FiberLike | null;
  child?: FiberLike | null;
  memoizedProps?: unknown;
  memoizedState?: unknown;
  stateNode?: unknown;
}

/**
 * Make React re-read a flow it already holds.
 *
 * Mutating `flow.nodes[i].data.transform` changes the object but nothing is
 * watching it: the designer rendered from a value it received once, so the canvas
 * and property panel keep showing what they were given. Emitting an engine event
 * does not help either — the events are about *execution*, not about the document.
 *
 * So this reaches React's own re-render mechanisms, in order of how well-defined
 * they are:
 *
 *  1. **A class component's `forceUpdate`.** Public API, documented, no internals.
 *  2. **A `useState` hook's dispatch.** Every function component's hook list is
 *     `memoizedState` chained by `next`, and a state hook carries `queue.dispatch`.
 *     Dispatching a *shallow clone* is what makes React see a new reference and
 *     re-render; dispatching the same object is a no-op because it compares equal.
 *
 * Both are React internals in the second case, and internals change between
 * versions — so every attempt is reported rather than assumed, and failure says so
 * instead of claiming the edit landed.
 */
function forceReactUpdate(anchor: Element): { ok: boolean; via?: string; tried: string[] } {
  const tried: string[] = [];
  let fiber: FiberLike | undefined;
  for (const key of Object.keys(anchor)) {
    if (/^__react(Fiber|Container|InternalInstance)\$/.test(key)) {
      fiber = (anchor as unknown as Record<string, FiberLike>)[key];
      break;
    }
  }

  for (let i = 0; i < 60 && fiber; i += 1) {
    // A class component instance sits on `stateNode` and has the public setter.
    const instance = (fiber as { stateNode?: unknown }).stateNode;
    if (isRecord(instance) && typeof instance.forceUpdate === 'function') {
      const holdsFlow = isRecord(instance.props) && (instance.props.diagramEngine || instance.props.flow);
      if (holdsFlow) {
        tried.push('forceUpdate');
        try { (instance.forceUpdate as () => void).call(instance); return { ok: true, via: 'forceUpdate', tried }; }
        catch { /* fall through */ }
      }
    }

    // A function component: walk its hook list for a state hook with a dispatch.
    let hook = (fiber as { memoizedState?: unknown }).memoizedState as
      { queue?: { dispatch?: (v: unknown) => void }; memoizedState?: unknown; next?: unknown } | undefined;
    for (let h = 0; h < 40 && isRecord(hook); h += 1) {
      const dispatch = hook.queue?.dispatch;
      const value = hook.memoizedState;
      // Only a hook actually holding the flow — dispatching into an unrelated
      // piece of state would re-render the wrong thing, or corrupt it.
      const holdsFlow = isRecord(value)
        && (Array.isArray((value as { nodes?: unknown }).nodes) || !!(value as { flow?: unknown }).flow);
      if (typeof dispatch === 'function' && holdsFlow) {
        tried.push('hookDispatch');
        try {
          // A shallow clone: same contents, new reference, so React re-renders.
          dispatch(Array.isArray(value) ? [...value] : { ...(value as Record<string, unknown>) });
          return { ok: true, via: 'hookDispatch', tried };
        } catch { /* fall through */ }
      }
      hook = hook.next as typeof hook;
    }

    fiber = fiber.return ?? undefined;
  }
  return { ok: false, tried };
}

/** Walk to the engine the same way the design hunt does. */
function findEngine(): object | undefined {
  const canvas = document.querySelector('[id$="-mfgx-data-flow-diagram"]');
  const anchor = canvas?.querySelector('[data-nodeid]') ?? canvas?.firstElementChild ?? canvas;
  if (!anchor) return undefined;

  for (const key of Object.keys(anchor)) {
    if (!/^__react(Fiber|Container|InternalInstance)\$/.test(key)) continue;
    let fiber = (anchor as unknown as Record<string, { return?: unknown; child?: unknown; memoizedProps?: unknown }>)[key];
    for (let i = 0; i < 60 && fiber; i += 1) {
      const props = fiber.memoizedProps;
      if (isRecord(props)) {
        const de = props.diagramEngine;
        if (isRecord(de) && isRecord(de.dataFlowEngineFlow)) return de.dataFlowEngineFlow;
      }
      fiber = (fiber.return ?? fiber.child) as typeof fiber;
    }
  }
  return undefined;
}

export interface FlowEventState {
  attached: boolean;
  /** `$appConfig` for this flow, once seen. Global, so never per node. */
  appConfig?: unknown;
  /** The most recent runs with payloads, so the Log tab can expand them. */
  recent?: NodeRun[];
  /** Runs left out of `recent` by the byte budget — never silently dropped. */
  recentOmitted?: number;
  /** Events received whose payload we could not identify a node from. */
  unidentified: number;
  /** The real payload shape, when the assumed one did not match. */
  shapes: { event: string; keys: Record<string, string>; nested: Record<string, string[]> }[];
  /** Which events were successfully subscribed. */
  events: string[];
  runs: NodeRun[];
  error?: string;
  /** Real platform measurement, unlike the DOM-arrival proxy. */
  source: 'engine-events';
}

/**
 * Subscribe once, idempotently.
 *
 * Re-attaching on every poll would stack listeners and multiply every recorded
 * run, so the engine instance is remembered — and re-subscribed if the designer
 * swaps it for a different flow.
 */
export function flowEvents(): FlowEventState {
  const engine = findEngine();
  if (!engine) {
    return { attached: false, unidentified, shapes, events: [], runs: [], error: 'No flow engine on this page.', source: 'engine-events' };
  }
  if (engine === attachedTo) {
    // Metadata only: 120 runs with payloads was 460 KB per push.
    const recent = recentRunsWithPayloads(runs);
    return {
      attached: true, unidentified, shapes, appConfig,
      events: [...EVENTS],
      runs: runsWithoutPayloads(runs.slice(-80)),
      recent: recent.runs,
      recentOmitted: recent.omitted,
      error: attachError, source: 'engine-events',
    };
  }

  const em = engine as Emitter;
  const on = (em.on ?? em.addListener)?.bind(engine);
  if (typeof on !== 'function') {
    attachError = 'The engine exposes no on()/addListener(), so its events cannot be observed.';
    return { attached: false, unidentified, shapes, events: [], runs: [], error: attachError, source: 'engine-events' };
  }

  if (appConfig === undefined) appConfig = appConfigFromEngine();

  const ok: string[] = [];
  for (const event of EVENTS) {
    try { on(event, (payload: unknown) => record(event, payload)); ok.push(event); }
    catch { /* one unsupported event must not lose the rest */ }
  }
  attachedTo = engine;
  attachError = ok.length ? undefined : 'No events could be subscribed.';
  // A fresh engine means a different flow; old runs would misattribute.
  runs = [];
  return { attached: ok.length > 0, unidentified, shapes, appConfig, events: ok, runs: [], error: attachError, source: 'engine-events' };
}

/* ── Full node definitions, and their live values ────────────────────────── */

/**
 * Serialise a value for the panel without shipping the whole graph.
 *
 * The engine holds real objects — entire node inputs, whole query results — so a
 * naive `JSON.stringify` would push megabytes across the bridge every poll. This
 * keeps full fidelity for the scalars and expressions a developer edits, and
 * summarises the bulk containers rather than truncating them into something that
 * looks complete but is not.
 */
function serialise(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function') return `ƒ ${(value as { name?: string }).name || 'anonymous'}`;
    // Expressions are the point of this view, so strings are kept whole up to a
    // generous limit rather than clipped to a preview length.
    if (typeof value === 'string' && value.length > 8000) return `${value.slice(0, 8000)}… (${value.length} chars)`;
    return value;
  }
  if (seen.has(value as object)) return '[circular]';
  seen.add(value as object);
  if (depth > 6) return Array.isArray(value) ? `[${value.length} items]` : '{…}';
  if (Array.isArray(value)) {
    if (value.length > 50) return [...value.slice(0, 50).map((v) => serialise(v, depth + 1, seen)), `… ${value.length - 50} more`];
    return value.map((v) => serialise(v, depth + 1, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = serialise(v, depth + 1, seen);
  return out;
}

/**
 * Method names on an object **and its prototype chain**.
 *
 * The first engine probe used `Object.entries`, which returns own enumerable
 * properties only — so it reported no functions at all and I concluded the engine
 * had no write API. Class methods live on the prototype. That omission is why
 * edits were applied by mutating the raw node, which changes the object but never
 * tells React to re-render, so the designer showed the old value.
 */
export function methodNames(obj: unknown, maxDepth = 4): string[] {
  const out = new Set<string>();
  let cursor = obj;
  for (let i = 0; i < maxDepth && cursor && cursor !== Object.prototype; i += 1) {
    for (const name of Object.getOwnPropertyNames(cursor)) {
      if (name === 'constructor') continue;
      try {
        if (typeof (cursor as Record<string, unknown>)[name] === 'function') out.add(name);
      } catch { /* a throwing getter is not a method we can use */ }
    }
    cursor = Object.getPrototypeOf(cursor);
  }
  return [...out].sort();
}

/** What the engine offers for writing, so a fix targets a real API. */
export function engineApi(): { engine: string[]; node: string[]; nodesKeys: string[] } {
  const engine = findEngine();
  const nodes = engineNodes();
  const inner = isRecord(engine) && isRecord(engine.nodes) ? engine.nodes : undefined;
  return {
    engine: isRecord(engine) ? methodNames(engine) : [],
    node: nodes.length ? methodNames(nodes[0]) : [],
    // `engine.nodes` was reported as an object, not the array — likely a map of
    // live node instances, which is where a per-node setter would be.
    nodesKeys: inner ? Object.keys(inner).slice(0, 30) : [],
  };
}

/**
 * `$appConfig` from the engine itself, not only from an event.
 *
 * Reading it off events was too narrow: if no event is recorded — which is the
 * case whenever a run finishes before we attach, or the payload parser is off —
 * the app config never appeared at all. The engine holds it for the whole flow, so
 * look there too and take whichever source answers first.
 */
function appConfigFromEngine(): unknown {
  const engine = findEngine();
  if (!isRecord(engine)) return undefined;
  // Likely homes, in order: the flow's own context, the engine's dependency bag,
  // then a shallow scan for the key.
  const candidates: unknown[] = [
    (engine as Record<string, unknown>)._context,
    (engine as Record<string, unknown>).appConfig,
    isRecord(engine.engine) ? (engine.engine as Record<string, unknown>).dependencies : undefined,
    isRecord(engine.engine) ? (engine.engine as Record<string, unknown>).options : undefined,
    engine.flow,
  ];
  for (const candidate of candidates) {
    const hit = findAppConfig(candidate, 0);
    if (hit !== undefined) return serialise(hit);
  }
  return undefined;
}

/** Live nodes off the engine, so the panel reads the same objects the designer does. */
function engineNodes(): Record<string, unknown>[] {
  const engine = findEngine();
  if (!isRecord(engine)) return [];
  const flow = engine.flow;
  const nodes = isRecord(flow) ? flow.nodes : undefined;
  return Array.isArray(nodes) ? nodes.filter(isRecord) : [];
}

/**
 * Node id → display name, for anything holding ids and needing labels.
 *
 * The store's flow log carries `nodeId` and nothing else, so without this an entry
 * reads as a uuid. The names live on the engine's own flow, which is the same place
 * the diagram reads them from — no second source to drift.
 */
export function flowNodeNames(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const node of engineNodes()) {
    const id = typeof node.id === 'string' ? node.id : undefined;
    const name = typeof node.name === 'string' ? node.name : undefined;
    if (id && name) out[id] = name;
  }
  return out;
}

/**
 * One node's **whole** definition, values included.
 *
 * Requested per node rather than pushed for all 23: the summaries are enough for
 * the card list, and only the selected node needs its expressions and config.
 * Pushing every node's full definition on a 750ms poll would be wasteful and
 * mostly unread.
 */
export function flowNodeDetail(id: string): { found: boolean; node?: unknown; error?: string } {
  const nodes = engineNodes();
  if (!nodes.length) return { found: false, error: 'No flow engine on this page.' };
  const node = nodes.find((n) => n.id === id || n.name === id);
  if (!node) return { found: false, error: `No node "${id}" in the flow.` };
  return { found: true, node: serialise(node) };
}

/**
 * Change a value on a live node.
 *
 * The engine's nodes are the objects the **designer** renders, so this edits the
 * flow in memory — not runtime state, and not the saved definition. That is a
 * sharper thing than the screen-side edits: those are discarded by a reload,
 * whereas this becomes real if the developer then presses save in the designer.
 *
 * So it says exactly that, and never writes without an explicit call. Nothing
 * calls this on a timer or as a side effect of reading.
 */
export function setFlowNodeValue(id: string, path: string, value: unknown): { ok: boolean; error?: string; note?: string } {
  const nodes = engineNodes();
  const node = nodes.find((n) => n.id === id || n.name === id);
  if (!node) return { ok: false, error: `No node "${id}" in the flow.` };

  const parts = path.split('.').filter(Boolean);
  if (!parts.length) return { ok: false, error: 'No path given.' };

  let cursor: Record<string, unknown> = node;
  for (const key of parts.slice(0, -1)) {
    const next = cursor[key];
    // Refuse to create structure. Inventing a parent object would put the node
    // into a shape the designer never produces.
    if (!isRecord(next)) return { ok: false, error: `${path} does not exist on this node — refusing to create it.` };
    cursor = next;
  }
  const leaf = parts[parts.length - 1];
  if (!(leaf in cursor)) return { ok: false, error: `${path} does not exist on this node — refusing to create it.` };

  const before = cursor[leaf];
  try {
    cursor[leaf] = value;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  /*
   * Mutating the object is not enough, and that is why edits did not appear.
   *
   * The designer renders from React state; a raw write changes the value nobody
   * is watching. So after the write, ask the engine to publish the change through
   * whatever API it actually has — tried in order of directness, and the caller is
   * told which one worked rather than being told "applied" regardless.
   */
  const engine = findEngine();
  const attempts: string[] = [];
  let notified: string | undefined;

  const tryCall = (target: unknown, name: string, args: unknown[]) => {
    if (notified || !isRecord(target)) return;
    const fn = (target as Record<string, unknown>)[name];
    if (typeof fn !== 'function') return;
    attempts.push(name);
    try { (fn as (...a: unknown[]) => unknown).apply(target, args); notified = name; }
    catch { /* wrong signature — keep looking */ }
  };

  // A dedicated node update, if one exists.
  for (const name of ['updateNode', 'setNode', 'setNodeData', 'replaceNode', 'updateNodeData',
    'setNodeProperty', 'patchNode', 'commitNode', 'save', 'markDirty']) {
    tryCall(engine, name, [id, node]);
  }
  // Otherwise a whole-flow refresh.
  for (const name of ['setFlow', 'updateFlow', 'refresh', 'repaint', 'redraw', 'update']) {
    tryCall(engine, name, []);
  }
  // Otherwise the emitter: publishing a change is what React is listening for.
  if (!notified && isRecord(engine) && typeof engine.emit === 'function') {
    for (const event of ['flowChanged', 'nodeChanged', 'change', 'update']) {
      attempts.push(`emit:${event}`);
      try { (engine.emit as (e: string, p?: unknown) => unknown).call(engine, event, { nodeId: id, node }); notified = `emit:${event}`; break; }
      catch { /* keep looking */ }
    }
  }

  /*
   * If no engine API published the change, make React re-read directly.
   *
   * This is what was missing: the write landed on the object and the designer
   * never looked again.
   */
  if (!notified) {
    const canvas = document.querySelector('[id$="-mfgx-data-flow-diagram"]');
    const anchor = canvas?.querySelector('[data-nodeid]') ?? canvas;
    if (anchor) {
      const forced = forceReactUpdate(anchor);
      attempts.push(...forced.tried);
      if (forced.ok) notified = forced.via;
    }
  }

  return {
    ok: true,
    // Honest about the two very different outcomes.
    note: notified
      ? `Written and published via ${notified}. Permanent only if you then save in the designer; reload to discard.`
      : 'Written to the node object, but the designer was NOT notified — it renders from React state, so '
        + `the canvas will keep showing the old value until it re-reads. Tried: ${attempts.join(', ') || 'no API found'}. `
        + `Previous value: ${JSON.stringify(before)?.slice(0, 120)}`,
    api: notified,
    tried: attempts,
  } as { ok: boolean; note: string; api?: string; tried: string[] };
}

/**
 * Runs without their payloads.
 *
 * The payloads are the whole point of capturing events — and they are also 460 KB
 * of a 755 KB snapshot that the panel re-serialises every 750ms, which made the
 * UI unusable. So the pushed snapshot carries only what the card list needs
 * (node, type, status, timings) and payloads are fetched per node on demand,
 * exactly like the node definitions.
 */
export function runsWithoutPayloads(list: NodeRun[]): NodeRun[] {
  return list.map(({ input, output, state, outputState, ...rest }) => {
    void input; void output; void outputState;
    // Say whether a payload exists, so the UI offers the fetch only where there
    // is something to fetch.
    return {
      ...rest,
      hasInput: input !== undefined,
      hasOutput: output !== undefined,
      hasState: state !== undefined,
    } as NodeRun;
  });
}

/**
 * Recent runs **with** their payloads, under a byte budget.
 *
 * The Log tab needs real objects to be expandable, and it renders from the pushed
 * snapshot rather than fetching per row. Pushing all 80 runs with payloads was
 * 460 KB every 750ms and made the panel unusable — so this sends the most recent
 * few and stops as soon as it reaches the budget.
 *
 * Budgeted rather than counted: ten small runs are cheap and two enormous ones are
 * not, so the limit is on size, with the count reported so a truncated set never
 * reads as the whole run.
 */
const RECENT_BUDGET = 90_000;

export function recentRunsWithPayloads(list: NodeRun[]): { runs: NodeRun[]; omitted: number } {
  const out: NodeRun[] = [];
  let bytes = 0;
  // Newest first while filling, so what survives the budget is what just happened.
  for (const run of [...list].reverse()) {
    const size = JSON.stringify(run)?.length ?? 0;
    if (bytes + size > RECENT_BUDGET && out.length) break;
    out.push(run);
    bytes += size;
  }
  return { runs: out.reverse(), omitted: Math.max(0, list.length - out.length) };
}

/** Payloads for one node's runs, fetched only when a developer opens it. */
export function flowRunPayloads(node: string): {
  node: string;
  runs: {
    key: string; status: string; durationMs?: number;
    input?: unknown; output?: unknown; state?: unknown; outputState?: unknown;
  }[];
} {
  return {
    node,
    runs: runs
      .filter((r) => r.node === node)
      .map((r) => ({
        key: r.key, status: r.status, durationMs: r.durationMs,
        input: r.input, output: r.output,
        // Carried, but the UI keeps it collapsed — it is context, not this node's.
        state: r.state, outputState: r.outputState,
      })),
  };
}

/** Per-node totals, for the card list. */
export function runSummary(list: NodeRun[]): {
  node: string; runs: number; totalMs: number; slowestMs: number; failed: number;
}[] {
  const by = new Map<string, { node: string; runs: number; totalMs: number; slowestMs: number; failed: number }>();
  for (const r of list) {
    const row = by.get(r.node) ?? { node: r.node, runs: 0, totalMs: 0, slowestMs: 0, failed: 0 };
    row.runs += 1;
    if (r.durationMs !== undefined) {
      row.totalMs += r.durationMs;
      row.slowestMs = Math.max(row.slowestMs, r.durationMs);
    }
    if (r.status === 'failed' || r.status === 'aborted') row.failed += 1;
    by.set(r.node, row);
  }
  // Slowest first: that is the question a timing view is opened to answer.
  return [...by.values()].sort((a, b) => b.totalMs - a.totalMs);
}


/* ── The link model, which is where wires are actually defined ────────────── */

export interface LinkFact {
  /** Matches the canvas's `data-linkid`, so the DOM element is addressable. */
  id: string;
  sourceNode?: string;
  targetNode?: string;
  sourcePort?: string;
  targetPort?: string;
}

/**
 * Every link, read from the diagram model rather than measured off the canvas.
 *
 * Geometry was always a proxy: an endpoint near a node is *evidence* of a connection, and on a
 * zoomed-out canvas that evidence is weak enough to claim wires that merely pass by. The model has
 * the answer serialised — each link knows its source and target ports, and each port knows its node —
 * so "which wires touch this node" stops being a measurement and becomes a lookup.
 *
 * Several model shapes are tried because the diagram library's accessors differ by version, and the
 * one that worked is reported: a silent fall back to geometry would look like the surgical version
 * working badly rather than not running at all.
 */
export function flowLinks(): { links: LinkFact[]; via?: string; error?: string } {
  const engine = findEngine() as Record<string, unknown> | undefined;
  if (!engine) return { links: [], error: 'The flow engine was not found on this page.' };

  const model = pickModel(engine);
  if (!model) return { links: [], error: 'The engine exposed no diagram model.' };

  const raw = readLinks(model);
  if (!raw.links.length) return { links: [], via: raw.via, error: 'The model exposed no links.' };
  return raw;
}

/** The diagram model, however this build exposes it. */
function pickModel(engine: Record<string, unknown>): Record<string, unknown> | undefined {
  const candidates: unknown[] = [
    typeof engine.getModel === 'function' ? (engine.getModel as () => unknown)() : undefined,
    (engine as { diagramModel?: unknown }).diagramModel,
    (engine as { model?: unknown }).model,
    // Fuuz keeps its own graph beside the renderer's.
    (engine as { flow?: unknown }).flow,
    engine,
  ];
  return candidates.find(isRecord) as Record<string, unknown> | undefined;
}

/**
 * Links from a model, by whichever accessor it has.
 *
 * `getLinks()` is the library's own API; `links` as a map or array is what the serialised model
 * carries. All are tried, and the *node* ids are resolved through the ports because a link records
 * ports and only a port knows its node.
 */
function readLinks(model: Record<string, unknown>): { links: LinkFact[]; via?: string } {
  const collections: [string, unknown][] = [
    ['getLinks()', typeof model.getLinks === 'function' ? (model.getLinks as () => unknown)() : undefined],
    ['model.links', model.links],
    ['layers', typeof model.getLayers === 'function' ? (model.getLayers as () => unknown)() : undefined],
  ];

  for (const [via, collection] of collections) {
    const list = toArray(collection);
    const links = list.map(readLink).filter((l): l is LinkFact => !!l);
    if (links.length) return { links, via };
  }
  return { links: [] };
}

/** A collection that may be an array, a map object, or a layered structure. */
function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap((v) => (isRecord(v) && (v.links || v.models) ? toArray(v.links ?? v.models) : [v]));
  if (isRecord(value)) return Object.values(value);
  return [];
}

function readLink(link: unknown): LinkFact | undefined {
  if (!isRecord(link)) return undefined;
  const id = String(
    (typeof link.getID === 'function' ? (link.getID as () => unknown)() : undefined)
    ?? link.id ?? ''
  );
  if (!id) return undefined;

  const port = (which: 'Source' | 'Target') => {
    const getter = link[`get${which}Port`];
    const direct = typeof getter === 'function' ? (getter as () => unknown)() : undefined;
    return isRecord(direct) ? direct : (isRecord(link[which.toLowerCase()]) ? link[which.toLowerCase()] as Record<string, unknown> : undefined);
  };
  /*
   * A port's node, which is the fact we are after.
   *
   * The serialised form often carries `parentNode` or a plain node id instead of a live object, so
   * both are read — otherwise a model that serialises rather than instantiates yields links with no
   * nodes, which is indistinguishable from no links at all.
   */
  const nodeOf = (p: Record<string, unknown> | undefined) => {
    if (!p) return undefined;
    const node = typeof p.getNode === 'function' ? (p.getNode as () => unknown)() : undefined;
    if (isRecord(node)) {
      const nid = typeof node.getID === 'function' ? (node.getID as () => unknown)() : node.id;
      if (nid) return String(nid);
    }
    const parent = p.parentNode ?? p.nodeId ?? p.node;
    return parent === undefined || parent === null ? undefined : String(parent);
  };
  const nameOf = (p: Record<string, unknown> | undefined) => {
    if (!p) return undefined;
    const n = typeof p.getName === 'function' ? (p.getName as () => unknown)() : p.name;
    return n === undefined || n === null ? undefined : String(n);
  };

  const source = port('Source');
  const target = port('Target');
  return {
    id,
    sourceNode: nodeOf(source) ?? (link.sourceNode ? String(link.sourceNode) : undefined),
    targetNode: nodeOf(target) ?? (link.targetNode ? String(link.targetNode) : undefined),
    sourcePort: nameOf(source),
    targetPort: nameOf(target),
  };
}
