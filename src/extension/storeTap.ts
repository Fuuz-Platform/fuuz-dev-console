/**
 * Reach the app's redux store from the MAIN world, and read the flow log out of it.
 *
 * Why the store and not the drawer: the flow designer is the one surface with no
 * console emission at all. A screen transform is announced through
 * `console[level](message, data)` at the action creator, *before* it reaches redux —
 * so the console stream this extension already captures is a superset of the
 * platform's own (50-capped, navigation-cleared) `transformDebuggingLogs`, and
 * tapping that store would be a downgrade. The flow designer's `log(e)` prints
 * nothing; it pushes into `logBuffer`, which flushes into `dataFlowEditor[tab].logs`
 * and is never capped. Scraping the rendered drawer was the workaround for that.
 *
 * Discovery is React-Redux's own Provider, which holds the store on its props. The
 * app publishes no global store handle — checked — so there is no shortcut, and the
 * direction of the walk depends on where you start: the root container's fiber is
 * the HostRoot, *above* the Provider, so it has to be descended into, while a
 * mounted element inside the app is below it and climbs. Both are tried.
 *
 * Discovery only. Nothing here dispatches: reading a log must not be able to change
 * the app's state.
 */
import { FlowLogCursor, toFlowEntries, type FlowLogGroup } from '../core/flowLogs';
import type { LogEntry } from '../core/types';

/** The part of a redux store this needs. `dispatch` is deliberately not used. */
interface StoreLike {
  getState(): unknown;
  subscribe(listener: () => void): () => void;
}

interface FiberLike {
  return?: FiberLike | null;
  child?: FiberLike | null;
  sibling?: FiberLike | null;
  memoizedProps?: Record<string, unknown> | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

const isStore = (v: unknown): v is StoreLike =>
  isRecord(v) && typeof v.getState === 'function' && typeof v.subscribe === 'function';

function fiberFor(node: Element): FiberLike | undefined {
  for (const key of Object.keys(node)) {
    if (/^__react(Fiber|Container|InternalInstance)\$/.test(key)) {
      return (node as unknown as Record<string, FiberLike>)[key];
    }
  }
  return undefined;
}

/**
 * Climb from one fiber to the Provider above it.
 *
 * Bounded at 400 ancestors: the Fuuz tree is deep, but a walk that long without a
 * Provider means the assumption is wrong, and an unbounded climb on a cyclic
 * structure would hang the page rather than report a miss.
 */
function climbToStore(start: FiberLike | undefined): StoreLike | undefined {
  let fiber = start;
  for (let i = 0; i < 400 && fiber; i += 1) {
    const props = fiber.memoizedProps;
    if (isRecord(props) && isStore(props.store)) return props.store;
    fiber = fiber.return ?? undefined;
  }
  return undefined;
}

/**
 * Descend from the root container's fiber to the Provider below it.
 *
 * The mount point carries `__reactContainer$`, and that fiber is the **HostRoot** —
 * the top of the tree, with the Provider as a descendant. Climbing from it therefore
 * finds nothing, which is what the first version of this did: it anchored on `#root`,
 * walked up from the root, and reported "no store" on a page that had one.
 *
 * Breadth-first and bounded, because the Provider sits within a few levels of the
 * root and a depth-first walk of a whole app tree would be a page-freezing amount
 * of work to find something three nodes down.
 */
function descendToStore(root: FiberLike | undefined, limit = 4000): StoreLike | undefined {
  if (!root) return undefined;
  const queue: FiberLike[] = [root];
  for (let seen = 0; queue.length && seen < limit; seen += 1) {
    const fiber = queue.shift()!;
    const props = fiber.memoizedProps;
    if (isRecord(props) && isStore(props.store)) return props.store;
    if (fiber.child) queue.push(fiber.child);
    if (fiber.sibling) queue.push(fiber.sibling);
  }
  return undefined;
}

/**
 * The store.
 *
 * Two routes, because the anchor decides which one can work: a mounted element
 * inside the app climbs to the Provider, while the root container starts *above* it
 * and has to descend. Both are tried — an app shell that renders nothing yet has no
 * deep nodes to climb from, and a portal'd node may have no path down from the root.
 */
export function findStore(): StoreLike | undefined {
  const containers = [document.querySelector('#root'), document.body].filter((el): el is Element => !!el);
  for (const container of containers) {
    const found = descendToStore(fiberFor(container));
    if (found) return found;
  }

  // Deep nodes, sampled from both ends of the document so a large page costs a
  // bounded amount of work rather than a walk of every element.
  const all = document.body ? Array.from(document.body.querySelectorAll('*')) : [];
  const sample = [...all.slice(0, 20), ...all.slice(-20)];
  for (const el of sample) {
    const found = climbToStore(fiberFor(el));
    if (found) return found;
  }
  return undefined;
}

export interface FlowLogTapState {
  /** Whether the store was found — the panel says which source it is showing. */
  attached: boolean;
  /** New entries since the last read, oldest first. */
  entries: LogEntry[];
  /** Designer tabs seen holding a log, so a tab switch is visible. */
  tabs: string[];
  /** How many entries have been reported over this page's lifetime. */
  reported: number;
  error?: string;
  /** Named so a consumer can tell store-read entries from drawer-scraped ones. */
  source: 'redux-store';
}

let store: StoreLike | undefined;
const cursor = new FlowLogCursor();
let reported = 0;

/**
 * New flow log entries since the last call.
 *
 * Polled rather than pushed. `store.subscribe` fires on *every* action — typing in
 * the designer included — so a subscription would wake this on thousands of
 * irrelevant dispatches; the cursor makes polling cheap and idempotent, and the
 * caller already polls for flow events on the same cadence.
 */
export function flowLogs(seqBase: number, names?: Record<string, string>): FlowLogTapState {
  if (!store) store = findStore();
  if (!store) {
    return { attached: false, entries: [], tabs: [], reported, source: 'redux-store', error: 'No redux store reachable from the page.' };
  }

  let groups: FlowLogGroup[];
  try {
    groups = cursor.advance(store.getState());
  } catch (e) {
    return { attached: true, entries: [], tabs: [], reported, source: 'redux-store', error: `Store read failed: ${(e as Error).message}` };
  }

  const at = Date.now();
  const nameMap = names ? new Map(Object.entries(names)) : undefined;
  const entries: LogEntry[] = [];
  for (const group of groups) {
    entries.push(...toFlowEntries(group.entries, {
      seqBase: seqBase + entries.length,
      at,
      names: nameMap,
      surface: group.tab,
    }));
  }
  reported += entries.length;

  return { attached: true, entries, tabs: groups.map((g) => g.tab), reported, source: 'redux-store' };
}

/** Forget what has been reported — after a clear-logs, or when retargeting. */
export function resetFlowLogs(): void {
  cursor.reset();
  reported = 0;
}

/** Drop the cached store handle, so the next read re-discovers it. */
export function detachStore(): void {
  store = undefined;
}
