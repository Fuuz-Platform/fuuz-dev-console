/**
 * The flow designer's own log, read from the app's store instead of its drawer.
 *
 * The flow console is the one surface that genuinely has no console emission: the
 * screen runtime announces every transform through `console[level](message, data)`
 * before it ever reaches redux, but the flow designer's `log(e)` only pushes into
 * `logBuffer`, which flushes into `dataFlowEditor[tab].logs`. Nothing is printed.
 * That is why this console scraped the rendered drawer — and why scraping was
 * always going to be lossy:
 *
 *   - the drawer renders a *sample* (the last N rows), the store holds the run;
 *   - a collapsed row's value is not in the DOM at all, so the payload was
 *     recoverable only for rows the user happened to expand;
 *   - `▶segment: value` text had to be re-parsed into fields the store already has;
 *   - row index made an unstable id, so entries renumbered as the log grew.
 *
 * The store entries are `{id, level, nodeId, message, data}` where `data` is the
 * full workflow state at that step — payload, context, claims, batches.
 *
 * One thing the store does **not** carry is a timestamp. The platform stamps a
 * cuid and nothing else, so ordering comes from array position and time comes from
 * when we observed the entry. That is an arrival stamp, not an execution time, and
 * it is labelled as one wherever it surfaces — the same honesty the scraped path
 * kept about its `+Nms` proxy.
 *
 * Pure: no DOM, no store handle, no clock. The tap supplies both.
 */
import type { LogEntry } from './types';

/** One entry as the platform's `log(e)` left it in the store. */
export interface StoredFlowLog {
  /** cuid stamped by the logging HOC — stable, unlike the row's index. */
  id: string;
  level?: string;
  nodeId?: string;
  message?: string;
  /** The full workflow state at this step, already JSON-serialized by the platform. */
  data?: unknown;
}

/** The logs found under one designer tab. */
export interface FlowLogGroup {
  /** The `dataFlowEditor` key they sat under — one open designer tab. */
  tab: string;
  entries: StoredFlowLog[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Pull every flow log out of a store snapshot.
 *
 * Deliberately shape-tolerant rather than reproducing the platform's tab-key
 * derivation: `dataFlowEditor` is keyed by tab id with a `currentTabId` pointer,
 * and hard-coding that lookup would break the day it changes. Anything under the
 * slice carrying a `logs` array is a tab's log, which is true of the current shape
 * and of any reasonable successor.
 */
export function extractFlowLogs(state: unknown): FlowLogGroup[] {
  const slice = isRecord(state) ? state.dataFlowEditor : undefined;
  if (!isRecord(slice)) return [];

  const groups: FlowLogGroup[] = [];
  for (const [tab, value] of Object.entries(slice)) {
    if (!isRecord(value) || !Array.isArray(value.logs)) continue;
    const entries = value.logs.filter(isRecord).filter((e) => typeof e.id === 'string') as unknown as StoredFlowLog[];
    if (entries.length) groups.push({ tab, entries });
  }
  return groups;
}

export interface FlowEntryOptions {
  /** Where this batch starts in the console's serial order. */
  seqBase: number;
  /** Observation time, in ms — an arrival stamp, since the store carries none. */
  at: number;
  /**
   * Node id → display name, when the caller has the diagram open.
   *
   * Without it entries are titled by node id, which is honest but unreadable; the
   * store simply does not carry the name.
   */
  names?: Map<string, string>;
  /** Designer tab, so entries from one tab do not surface under another. */
  surface?: string;
}

/**
 * Convert stored logs into console entries.
 *
 * `kind: 'flow'` so they colour distinctly from screen transforms, and `data`
 * becomes the expandable body — the whole workflow state, rather than the single
 * truncated line the drawer showed.
 */
export function toFlowEntries(logs: StoredFlowLog[], options: FlowEntryOptions): LogEntry[] {
  const { seqBase, at, names, surface } = options;
  return logs.map((log, i) => {
    const label = (log.nodeId && names?.get(log.nodeId)) || log.nodeId || 'flow';
    const epoch = at;
    return {
      id: log.id,
      seq: seqBase + i,
      ts: new Date(epoch).toTimeString().slice(0, 8) + '.' + String(epoch % 1000).padStart(3, '0'),
      epoch,
      kind: 'flow' as const,
      title: log.message ? `Flow · ${label} · ${log.message}` : `Flow node · ${label}`,
      // Empty rather than a proxy: the store gives no duration, and a fabricated
      // one would be indistinguishable from a measured one in the UI.
      dur: '',
      write: `flow.${label}`,
      reads: [],
      level: log.level ?? 'result',
      payload: log.data === undefined ? [{ nodeId: log.nodeId, message: log.message }] : [log.data],
      surface,
    };
  });
}

/**
 * Keeps track of which stored entries have already been reported.
 *
 * The store is cumulative and read repeatedly, so the interesting question on
 * every read is "what is new". Keyed on the platform's own cuid, which is why the
 * id-stamping detail matters: row position would renumber under the same log.
 */
export class FlowLogCursor {
  private seen = new Set<string>();

  /** New entries since the last call, oldest first, grouped per designer tab. */
  advance(state: unknown): FlowLogGroup[] {
    const fresh: FlowLogGroup[] = [];
    for (const group of extractFlowLogs(state)) {
      const entries = group.entries.filter((e) => !this.seen.has(e.id));
      for (const e of entries) this.seen.add(e.id);
      if (entries.length) fresh.push({ tab: group.tab, entries });
    }
    return fresh;
  }

  /** After a clear-logs, or when switching tabs: forget what was reported. */
  reset(): void {
    this.seen.clear();
  }

  get size(): number {
    return this.seen.size;
  }
}
