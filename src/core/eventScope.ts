/**
 * Tie every log entry to the screen event that caused it.
 *
 * The runtime's own log is a flat stream: a click on "Save" produces an action
 * transform, then a query, then eight prop recomputations, and nothing in any of
 * those entries says they belong together. The console showed them in order and
 * left the grouping to the reader's memory.
 *
 * Three ties are wanted, and they come from three different places:
 *
 *  - **serially** — `LogEntry.seq`, stamped at capture. That is the only total
 *    order that survives: the runtime batches its own logs through a debounce, so
 *    neither timestamps nor array position within a batch are reliable on their own.
 *  - **transform / element** — `designJoin.applyDesign`, which resolves the owning
 *    element from the design and stamps `nodeId` / `elementName` / `property`.
 *  - **screen event** — this module.
 *
 * ## What counts as an event, and why this is a heuristic
 *
 * The runtime names an interaction only through `trace.origin`, a component-type
 * label written by each component's `mapPropsToTrace` (24 of them in the shipped
 * bundle; see `TELEMETRY-FINDINGS.md`). Eight of those carry a name —
 * `actionName`, `fieldName`, `menuTitle`, `name` — and the other sixteen are a bare
 * `{origin}`. There is **no event id and no causal link** in the payload: nothing
 * says "this recomputation happened because that action ran".
 *
 * So scoping is: an interaction origin opens a scope, and following entries join it
 * until the next root or a quiet gap. That is an inference, not a fact the runtime
 * gave us, and `eventVia` says which entries are which so the panel can render the
 * difference rather than implying a certainty we do not have.
 *
 * Pure: no DOM, no I/O, no clock. Deterministic for a given entry list — ids derive
 * from the root entry's id, so two runs over the same capture agree.
 */
import { dig } from './classify';
import type { LogEntry } from './types';

/**
 * Component-type labels the runtime writes as `trace.origin` for things a person
 * (or a schedule) *initiates*, as opposed to a prop recomputing in response.
 *
 * Taken from the `mapPropsToTrace` call sites in the shipped bundle. The
 * remaining origins — `Container`, `Paper`, `GridCell`, `Accordion`,
 * `DynamicTableColumn`, `Screen`, … — are layout and display components whose
 * transforms are *consequences*, so they follow a scope rather than opening one.
 */
export const EVENT_ORIGINS = new Set([
  'Action',
  'ActionAdapter',
  'Action Button',
  'Button Group',
  'Flow Button',
  'FlowAdapter',
  'MenuBarItem',
  'MenuBarMenuItem',
  'SplitButton',
  'ScheduleConfigurationRun',
]);

/** How an entry came to carry the event it carries — kept so the grouping is auditable. */
export type EventVia =
  /** This entry *is* the interaction — the scope opens here. */
  | 'root'
  /** Followed an open scope: same burst of work, inferred from order. */
  | 'follow'
  /** No scope was open — initial render, a subscription push, or after a quiet gap. */
  | 'unscoped';

export interface EventScope {
  /** Derived from the root entry id, so it is stable across re-renders of the same capture. */
  id: string;
  /** 1-based, in capture order — the serial the panel shows as `E3`. */
  seq: number;
  /** `Save` / `Refresh Assets` / `Flow Button` — the best name the runtime gave us. */
  label: string;
  /** The raw `trace.origin` that opened it. */
  origin: string;
  /** `seq` of the root entry, so the scope can be located in the flat log. */
  rootSeq: number;
  rootId: string;
  /** How many entries were attributed to it. */
  count: number;
}

export interface EventScopeOptions {
  /**
   * Quiet time that closes an open scope, in ms.
   *
   * Without it, a click at 10:00 would adopt a subscription push at 10:04 as its
   * own consequence. 1500 ms is comfortably longer than a burst of dependent
   * recomputation (they land in the same debounce window) and far shorter than a
   * person's next click.
   */
  idleMs?: number;
}

const DEFAULT_IDLE_MS = 1500;

/** The object argument the runtime logs alongside the message. */
function payloadOf(entry: LogEntry): unknown {
  return entry.payload.find((a) => a && typeof a === 'object');
}

/** `trace.origin`, when the entry carried one. */
export function traceOrigin(entry: LogEntry): string | undefined {
  const value = dig(payloadOf(entry), 'trace.origin');
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * The name of the thing that ran, from whichever field this origin uses.
 *
 * Falls back to the origin itself: `Flow Button` with no name is still a better
 * label than a blank, and it is honest about what the runtime told us.
 */
function labelFor(entry: LogEntry, origin: string): string {
  const payload = payloadOf(entry);
  for (const path of ['trace.actionName', 'trace.menuTitle', 'trace.name', 'trace.fieldName']) {
    const value = dig(payload, path);
    if (typeof value === 'string' && value) return value;
  }
  return origin;
}

/** Does this entry open a scope? */
export function isEventRoot(entry: LogEntry): boolean {
  const origin = traceOrigin(entry);
  if (origin && EVENT_ORIGINS.has(origin)) return true;
  // A flow call is an event in its own right: it is initiated, it takes time, and
  // everything it writes afterwards is its consequence.
  return entry.kind === 'flow';
}

export interface ScopedLog {
  entries: LogEntry[];
  scopes: EventScope[];
}

/**
 * Stamp `eventId` / `eventSeq` / `eventLabel` / `eventVia` onto each entry.
 *
 * Input order is respected as given (the host appends in capture order and `seq`
 * is monotonic within a session); this does not re-sort, so an entry list that
 * was filtered stays filtered.
 */
export function assignEventScopes(entries: LogEntry[], options: EventScopeOptions = {}): ScopedLog {
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const scopes: EventScope[] = [];
  let open: EventScope | undefined;
  let lastEpoch = 0;

  const out = entries.map((entry) => {
    const epoch = Number.isFinite(entry.epoch) ? entry.epoch : lastEpoch;

    if (isEventRoot(entry)) {
      const origin = traceOrigin(entry) ?? (entry.kind === 'flow' ? 'Flow' : 'Event');
      open = {
        id: `evt-${entry.id}`,
        seq: scopes.length + 1,
        label: labelFor(entry, origin),
        origin,
        rootSeq: entry.seq,
        rootId: entry.id,
        count: 0,
      };
      scopes.push(open);
    } else if (open && epoch - lastEpoch > idleMs) {
      // Quiet long enough that the next entry is a new cause, not a late effect.
      open = undefined;
    }

    lastEpoch = epoch;
    if (!open) return { ...entry, eventVia: 'unscoped' as EventVia };

    open.count += 1;
    return {
      ...entry,
      eventId: open.id,
      eventSeq: open.count,
      eventLabel: open.label,
      eventVia: (entry.id === open.rootId ? 'root' : 'follow') as EventVia,
    };
  });

  return { entries: out, scopes };
}

/** The entries belonging to one event, in capture order. */
export function entriesForEvent(entries: LogEntry[], eventId: string): LogEntry[] {
  return entries.filter((e) => e.eventId === eventId);
}
