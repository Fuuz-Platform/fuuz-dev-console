/**
 * Shared shapes for the Fuuz Dev Console console — the live view of a Fuuz screen
 * under test, fed from the Chrome console over CDP.
 *
 * The pipeline is: CDP `Runtime.consoleAPICalled` → {@link RawConsoleEvent} →
 * {@link classify} → {@link LogEntry} → {@link buildStateTree} → {@link StateNode}.
 * Everything after the CDP step is pure, so the interesting logic is unit
 * testable without a browser (see `test/core.test.ts`).
 */

/** What a log entry represents, which drives its badge and colour. */
export type EntryKind = 'query' | 'debug' | 'flow' | 'error' | 'log';

/** How a value is coloured in the state tree / expanded body. */
export type ValueKind = 'str' | 'num' | 'bool' | 'fn' | 'obj' | 'err';

/**
 * One console call, with its arguments already resolved from CDP RemoteObjects
 * into plain JSON. Objects are serialized by value, so nothing here holds a
 * live handle into the page.
 */
export interface RawConsoleEvent {
  /** Capture order. Monotonic within a session; the stable sort key. */
  seq: number;
  /** CDP console API type — log, debug, info, warning, error, … */
  level: string;
  /** Wall-clock ms since epoch, from the CDP event. */
  timestamp: number;
  /** Resolved arguments. Primitives inline; objects as plain JSON. */
  args: unknown[];
  /** Top stack frame (`url:line`), when the page supplied one. */
  origin?: string;
}

/**
 * A classified console entry. `write` and `reads` are what make the console
 * more than a console: they turn the log into a dependency graph over screen
 * state, which is what the trace ("⌁ n") affordance walks.
 */
export interface LogEntry {
  id: string;
  seq: number;
  /** `HH:MM:SS.mmm`, local time — matches how the platform stamps its own logs. */
  ts: string;
  epoch: number;
  kind: EntryKind;
  title: string;
  /** Pre-formatted duration (`34ms`, `1.2s`); empty when the entry carried none. */
  dur: string;
  durMs?: number;
  /** Normalized dot path this entry wrote, or '' when it writes no state. */
  write: string;
  /** Normalized dot paths this entry read, derived from its expression. */
  reads: string[];
  /** The expression text, when the entry carried one. */
  expr?: string;
  /** Formatted result of the write, shown as the `→ after` half of a trace step. */
  after?: string;
  /** Console severity, kept so unclassified entries still colour correctly. */
  level: string;
  origin?: string;
  /** The resolved console arguments, rendered as a coloured JSON body. */
  payload: unknown[];
  /**
   * The screen context the runtime logged alongside this entry —
   * `{ metadata, components, … }`. This is a *complete* live snapshot, so the
   * state tree is read from the newest one rather than reconstructed from
   * writes; writes only supply the computed props and the change markers.
   */
  context?: unknown;

  /* ── Filled in by the design join (see `designJoin.ts`) ─────────────── */

  /** Element type from the screen design, e.g. `EmbeddedWebpage`, `FlowButton`. */
  elementType?: string;
  /** The transform's author-given name in the design, when it has one. */
  cacheKey?: string;
  /** Whether the design declares this transform as evaluating server-side. */
  remote?: boolean;
  /** How the owning element was resolved — kept so the join stays auditable. */
  attribution?: 'runtime' | 'cacheKey' | 'transform' | 'property' | 'ambiguous' | 'unknown';
  /**
   * Craft node id of the owning element. Stable across renames, unlike
   * `elementName` — so a saved session still resolves after someone renames a
   * component in the designer.
   */
  nodeId?: string;
  /** Runtime component name of the owning element — the key in `context.components`. */
  elementName?: string;
  /** The prop this transform produced, e.g. `url`, `disabled`. */
  property?: string;

  /* ── Filled in by the event scope pass (see `eventScope.ts`) ────────── */

  /** The screen event this entry was attributed to, `evt-<root entry id>`. */
  eventId?: string;
  /** 1-based position *within* that event — the serial tie the flat log lacks. */
  eventSeq?: number;
  /** The event's name: an action name, menu title, or its bare origin. */
  eventLabel?: string;
  /**
   * Whether this entry *is* the interaction, followed one, or belongs to none.
   * Kept because the grouping is inferred from order, not stated by the runtime.
   */
  eventVia?: 'root' | 'follow' | 'unscoped';

  /**
   * Which designer surface was open when this was captured.
   *
   * The Application Designer keeps several tabs open, and the log used to pool everything from
   * all of them — so a flow tab showed a screen's transforms and vice versa, with no way to
   * tell which was which. Stamping the surface lets the panel show one tab's log without
   * discarding the others: switch back and they are still there.
   */
  surface?: string;
}

/** A node in the derived screen-state tree. */
export interface StateNode {
  /** Full dot path — also the React key and the selection id. */
  id: string;
  label: string;
  /** Declared or inferred type, shown dimmed beside the label. */
  type: string;
  /** Formatted value preview. Absent on group nodes. */
  value?: string;
  vk: ValueKind;
  children?: StateNode[];
  /** Entry ids that produced this value, oldest first (see `provenanceFor`). */
  trace: string[];
  /** Whether anything wrote this path during the captured run. */
  changed: boolean;
}

/**
 * A declarative classification rule. The defaults are seeded from the shapes
 * the Fuuz screen runtime emits; users override them via the
 * `fuuz.devConsole.rules` setting when a tenant's build logs something new,
 * so a format change never needs an extension release.
 */
export interface ClassifyRule {
  id: string;
  kind: EntryKind;
  /** Regex source, matched case-insensitively against the entry's text head. */
  match: string;
  /**
   * Title template. `$1`…`$9` interpolate `match` groups; `{{a.b}}` interpolates
   * a dot path from the payload object.
   */
  title: string;
  /** Candidate payload paths for the state path this entry wrote, first hit wins. */
  writeFrom?: string[];
  /**
   * Candidate payload paths whose values are *joined with `.`* to compose the
   * write target, for runtimes that log the component and property separately.
   * Only used when `writeFrom` finds nothing.
   */
  writeJoin?: string[];
  /** Prefix applied when the resolved write target has no recognised root. */
  writeRoot?: string;
  /**
   * Last-resort candidates for the write target, used when the component can't
   * be attributed. Paired with `fallbackRoot` so unattributed values are
   * visibly bucketed instead of being hung off a guessed component.
   */
  fallbackFrom?: string[];
  fallbackRoot?: string;
  /** Candidate paths holding the screen context snapshot. */
  contextFrom?: string[];
  /** Candidate payload paths for the expression text. */
  exprFrom?: string[];
  /** Candidate payload paths for a duration, in ms. */
  durationFrom?: string[];
  /** Candidate payload paths for the resulting value. */
  resultFrom?: string[];
}

/** Extension → webview payload. */
export interface ScreenRunnerPayload {
  status: 'idle' | 'connecting' | 'attached' | 'detached' | 'error';
  /** Human-readable status line under the title. */
  statusDetail: string;
  target: { title: string; url: string };
  screenName: string;
  entries: LogEntry[];
  tree: StateNode[];
  /** `HH:MM:SS.mmm` of the newest entry — the snapshot the tree reflects. */
  snapshotAt: string;
  /** Entries dropped because the ring buffer is full. */
  dropped: number;
  /**
   * Entries and requests captured under a *different* designer tab.
   *
   * Reported so a suddenly-short log reads as "scoped to this tab" rather than "the capture
   * was lost" — nothing is discarded, and switching back shows it again.
   */
  withheld?: number;
  /**
   * The screen events found in this log, oldest first — one per interaction that
   * opened a scope. Each entry carries the matching `eventId`, so the panel can
   * group, filter or number without re-deriving anything.
   */
  events?: import('./eventScope').EventScope[];
  /**
   * How many entries the console keeps before dropping the oldest. `0` means
   * unlimited. Surfaced so the footer can state the limit that is producing
   * `dropped`, rather than leaving it as invisible policy.
   */
  retention?: number;
  /**
   * Where the flow entries came from — the two sources are not equivalent, so the
   * panel says which it is showing rather than letting them look alike.
   *
   * `redux-store`   the app's own log: platform ids, full workflow state, whole run.
   * `store-empty`   the store was reachable but has logged nothing yet.
   * `drawer-scrape` the fallback: the last few rendered rows, parsed from the DOM.
   */
  flowLogSource?: 'redux-store' | 'store-empty' | 'drawer-scrape';
  /** Present when a matching screen design was found and joined against. */
  design?: {
    screenName: string;
    version?: string;
    coverage: {
      total: number;
      exercised: number;
      unexercised: { elementName: string; elementType: string; property: string; cacheKey?: string; remote: boolean }[];
    };
  };
}
