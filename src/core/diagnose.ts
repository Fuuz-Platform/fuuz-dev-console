/**
 * Turn a captured run into a list of things that are probably wrong.
 *
 * The console and the network tab tell you what happened; this says what to
 * look at. Every rule here comes from a failure mode seen on a real Fuuz
 * screen — a transform re-evaluating in a loop, a GraphQL error hiding inside
 * an HTTP 200, the same query fired once per row.
 *
 * Each issue carries its evidence (log entry ids, request ids, the state path)
 * so the UI can jump straight to it and the report can quote it.
 *
 * Pure: no VS Code, no chrome, no I/O.
 */
import { entryOwner } from './designJoin';
import { churn, parseSocketMessage } from './subscriptions';
import { provenanceFor } from './provenance';
import type { NetworkEntry } from './network';
import type { LogEntry } from './types';

export type Severity = 'high' | 'medium' | 'low';

export interface Issue {
  id: string;
  /** Stable rule key, so a fix can be verified against the same rule. */
  rule: string;
  severity: Severity;
  title: string;
  /** One or two sentences: what this is, and why it matters. */
  detail: string;
  /** How many times the pattern occurred. */
  count: number;
  /** Log entries that evidence it, newest-relevant first. */
  entryIds: string[];
  /** Network requests that evidence it. */
  requestIds: string[];
  /** The state path implicated, when there is one. */
  path?: string;
  /**
   * The element that owns this, when it is attributable.
   *
   * `components.AssetIntakeForm.disabled` names it; `(computed).url` does not, and
   * the difference decides whether the panel can outline the element in the page.
   */
  element?: string;
  /** The expression at fault, trimmed — so the issue names the transform itself. */
  expression?: string;
}

export interface DiagnoseOptions {
  /** A transform re-running this many times in `loopWindowMs` is a loop. */
  loopThreshold: number;
  loopWindowMs: number;
  /** Identical requests beyond this count in `duplicateWindowMs` are redundant. */
  duplicateThreshold: number;
  duplicateWindowMs: number;
  /** A transform slower than this is worth a look. */
  slowTransformMs: number;
  /** A request slower than this is worth a look. */
  slowRequestMs: number;
  /** A response bigger than this is worth a look. */
  largeResponseBytes: number;
}

export const DEFAULTS: DiagnoseOptions = {
  loopThreshold: 5,
  loopWindowMs: 3000,
  duplicateThreshold: 3,
  duplicateWindowMs: 5000,
  slowTransformMs: 250,
  slowRequestMs: 2000,
  largeResponseBytes: 2 * 1024 * 1024,
};

const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

/** Group by a key, preserving first-seen order. */
function groupBy<T>(items: T[], key: (item: T) => string | undefined): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    if (k === undefined) continue;
    const list = out.get(k);
    if (list) list.push(item); else out.set(k, [item]);
  }
  return out;
}

/**
 * The largest number of items falling inside any `windowMs` sliding window.
 * Counting over the whole run would flag a screen you simply used for a while.
 */
function burst<T extends { epoch: number }>(items: T[], windowMs: number): T[] {
  if (items.length < 2) return items;
  const sorted = [...items].sort((a, b) => a.epoch - b.epoch);
  let best: T[] = [];
  let start = 0;
  for (let end = 0; end < sorted.length; end++) {
    while (sorted[end].epoch - sorted[start].epoch > windowMs) start++;
    if (end - start + 1 > best.length) best = sorted.slice(start, end + 1);
  }
  return best;
}

const trim = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function diagnose(
  entries: LogEntry[],
  network: NetworkEntry[],
  options: Partial<DiagnoseOptions> = {}
): Issue[] {
  const o = { ...DEFAULTS, ...options };
  const issues: Issue[] = [];
  let n = 0;
  const add = (issue: Omit<Issue, 'id'>) => issues.push({ ...issue, id: `i${++n}` });

  /* ── Transform errors ───────────────────────────────────────────────── */

  /*
   * Subscription socket messages are pulled out before the error rules see them.
   *
   * The platform logs them at `console.error`, so every one arrived as an error entry
   * and got grouped under `transform-error` — dozens of `io client disconnect` lines
   * attributed to a transform that had nothing to do with them, burying the real
   * findings. They get their own rule below, where the volume can be read properly.
   */
  const socket = entries
    .map((e) => ({ entry: e, socket: parseSocketMessage(e.title) ?? parseSocketMessage(String(e.after ?? '')) }))
    .filter((x): x is { entry: LogEntry; socket: NonNullable<ReturnType<typeof parseSocketMessage>> } => !!x.socket);
  const socketIds = new Set(socket.map((x) => x.entry.id));

  const errors = entries.filter((e) => e.kind === 'error' && !socketIds.has(e.id));
  for (const [message, group] of groupBy(errors, (e) => e.after ?? e.title)) {
    add({
      rule: 'transform-error',
      severity: 'high',
      title: group[0].write ? `${group[0].write} failed` : trim(group[0].title),
      detail: `${trim(String(message))}${group.length > 1 ? ` — raised ${group.length} times` : ''}.`,
      count: group.length,
      entryIds: group.map((e) => e.id),
      requestIds: [],
      path: group[0].write || undefined,
      element: entryOwner(group[0])?.name,
      expression: group[0].expr ? trim(group[0].expr.replace(/\s+/g, ' '), 200) : undefined,
    });
  }

  /* ── Runaway transforms ─────────────────────────────────────────────── */

  /*
   * Whether the design was joined, which decides what may be claimed.
   *
   * `cacheKey` is undefined both when a transform has no cache key *and* when we
   * never read the design — opposite meanings from identical data. `attribution` is
   * only ever set by the join, so its presence anywhere is the proof that a missing
   * cacheKey means missing rather than unknown.
   */
  const designJoined = entries.some((e) => e.attribution);

  const writes = entries.filter((e) => e.write && e.kind !== 'error');
  for (const [path, group] of groupBy(writes, (e) => e.write)) {
    const window = burst(group, o.loopWindowMs);
    if (window.length < o.loopThreshold) continue;
    // Re-computing to the same value is the signature of a feedback loop; a
    // changing value is more likely legitimate work.
    const distinct = new Set(window.map((e) => e.after ?? '')).size;
    const owner = entryOwner(window[0]);
    const expression = window.find((e) => e.expr)?.expr;
    const shared = {
      count: window.length,
      entryIds: window.map((e) => e.id),
      requestIds: [] as string[],
      path,
      element: owner?.name,
      expression: expression ? trim(expression.replace(/\s+/g, ' '), 200) : undefined,
    };
    // How the issue names itself: the element and its property when we know them,
    // because "disabled recomputed 40×" is not something you can go and fix.
    const subject = owner?.property ? `${owner.name}.${owner.property}` : path;

    /*
     * A missing cache key is a *different* issue from a feedback loop, with a
     * different fix, so it gets its own rule rather than a footnote on the loop.
     *
     * Without a cache key the runtime has nothing to compare against and re-runs
     * the transform on every render — the most common cause of a screen whose log
     * is unreadable. Reported only when the design was actually consulted.
     */
    const noCacheKey = designJoined && !window.some((e) => e.cacheKey);
    if (noCacheKey) {
      add({
        rule: 'transform-no-cache-key',
        severity: 'high',
        title: `${subject} has no cache key and ran ${window.length}× in ${(o.loopWindowMs / 1000).toFixed(0)}s`,
        detail:
          'With no cache key the runtime cannot tell that the inputs are unchanged, so the transform '
          + `re-evaluates on every render${distinct === 1 ? ' and produced the same value every time' : ''}. `
          + `Set a cache key on ${owner?.property ?? path} in the designer — that alone usually silences the log.`,
        ...shared,
      });
      continue;
    }

    add({
      rule: 'transform-loop',
      severity: distinct === 1 ? 'high' : 'medium',
      title: `${subject} recomputed ${window.length}× in ${(o.loopWindowMs / 1000).toFixed(0)}s`,
      detail: distinct === 1
        ? `Every evaluation produced the same value (${trim(String(window[0].after), 60)}), which usually means a transform is reacting to its own output.`
        : `The value changed across evaluations, so this may be legitimate — but ${window.length} runs in ${(o.loopWindowMs / 1000).toFixed(0)}s will cost you frames.`,
      ...shared,
    });
  }

  /* ── Slow transforms ────────────────────────────────────────────────── */

  const slow = entries.filter((e) => (e.durMs ?? 0) >= o.slowTransformMs);
  for (const [path, group] of groupBy(slow, (e) => e.write || e.title)) {
    const worst = Math.max(...group.map((e) => e.durMs ?? 0));
    add({
      rule: 'slow-transform',
      severity: worst >= o.slowTransformMs * 4 ? 'medium' : 'low',
      title: `${path} took ${Math.round(worst)}ms`,
      detail: `Transforms run on the UI thread, so anything this slow shows up as jank.`,
      count: group.length,
      entryIds: group.map((e) => e.id),
      requestIds: [],
      path: group[0].write || undefined,
      element: entryOwner(group[0])?.name,
      expression: group[0].expr ? trim(group[0].expr.replace(/\s+/g, ' '), 200) : undefined,
    });
  }

  /* ── Failed requests ────────────────────────────────────────────────── */

  for (const [key, group] of groupBy(network.filter((r) => r.failed), (r) => `${r.status} ${r.path}`)) {
    const status = group[0].status;
    add({
      rule: 'request-failed',
      severity: 'high',
      title: `${status || 'no response'} · ${group[0].method} ${trim(group[0].path, 70)}`,
      detail: status === 0
        ? 'The request never completed — blocked, aborted, or the host was unreachable.'
        : `The server rejected ${group.length > 1 ? `${group.length} calls` : 'this call'} with HTTP ${status}.`,
      count: group.length,
      entryIds: [],
      requestIds: group.map((r) => r.id),
      path: key,
    });
  }

  /* ── GraphQL errors inside a 200 ────────────────────────────────────── */

  const graphqlFailures = network.filter((r) => r.graphqlErrors?.length && !r.failed);
  for (const [message, group] of groupBy(graphqlFailures, (r) => r.graphqlErrors![0])) {
    add({
      rule: 'graphql-error',
      severity: 'high',
      title: `GraphQL error on ${group[0].operation ?? trim(group[0].path, 50)}`,
      detail: `${trim(message)} — returned inside an HTTP 200, so the browser's own Network tab shows this call as successful.`,
      count: group.length,
      entryIds: [],
      requestIds: group.map((r) => r.id),
    });
  }

  /* ── Redundant requests ─────────────────────────────────────────────── */

  for (const [, group] of groupBy(network, (r) => r.fingerprint)) {
    const window = burst(group, o.duplicateWindowMs);
    if (window.length < o.duplicateThreshold) continue;
    add({
      rule: 'duplicate-request',
      severity: window.length >= o.duplicateThreshold * 3 ? 'high' : 'medium',
      title: `${window[0].method} ${trim(window[0].operation ?? window[0].path, 60)} sent ${window.length}×`,
      detail: `The identical request (same body) repeated ${window.length} times within ${(o.duplicateWindowMs / 1000).toFixed(0)}s — usually a query re-firing per row or per render rather than once.`,
      count: window.length,
      entryIds: [],
      requestIds: window.map((r) => r.id),
    });
  }

  /* ── Slow and heavy responses ───────────────────────────────────────── */

  for (const request of network.filter((r) => r.durationMs >= o.slowRequestMs)) {
    add({
      rule: 'slow-request',
      severity: 'medium',
      title: `${Math.round(request.durationMs)}ms · ${request.method} ${trim(request.operation ?? request.path, 60)}`,
      detail: 'The screen is waiting on this before it can settle.',
      count: 1,
      entryIds: [],
      requestIds: [request.id],
    });
  }

  for (const request of network.filter((r) => r.sizeBytes >= o.largeResponseBytes)) {
    add({
      rule: 'large-response',
      severity: 'low',
      title: `${(request.sizeBytes / 1024 / 1024).toFixed(1)} MB · ${trim(request.operation ?? request.path, 60)}`,
      detail: 'Large payloads cost parse time on the UI thread as well as transfer time.',
      count: 1,
      entryIds: [],
      requestIds: [request.id],
    });
  }

  /* ── Subscription sockets ───────────────────────────────────────────── */

  if (socket.length) {
    const verdict = churn(socket.map((x) => x.socket));
    /*
     * Three different findings from the same lines, because they call for different
     * action: a fault reason is a connectivity problem, a repeated id is a
     * resubscribe loop in the screen, and everything else is lifecycle noise that
     * should be *acknowledged* rather than either hidden or alarming.
     */
    const fault = socket.find((x) => !x.socket.benign);
    if (fault) {
      add({
        rule: 'subscription-fault',
        severity: 'medium',
        title: `Subscription socket failed — ${verdict.worstReason ?? 'unknown reason'}`,
        detail:
          `${socket.length} socket message(s) across ${verdict.ids.length} subscription(s), and at least one `
          + `was not a clean close. \`transport error\` and \`ping timeout\` mean the connection to the `
          + 'subscription service is dropping — live data will be stale or missing while it is down.',
        count: socket.length,
        entryIds: socket.map((x) => x.entry.id),
        requestIds: [],
      });
    } else if (verdict.loop) {
      add({
        rule: 'subscription-resubscribe-loop',
        severity: 'medium',
        title: `One subscription disconnected ${verdict.worstCount}× — it is resubscribing in a loop`,
        detail:
          'Every close was clean (`io client disconnect`), so the client is tearing its own subscription '
          + 'down and rebuilding it — normally a component resubscribing on each render. Harmless to '
          + 'correctness, but it churns sockets and floods the log, which is what hid this.',
        count: verdict.worstCount,
        entryIds: socket.map((x) => x.entry.id),
        requestIds: [],
      });
    } else {
      add({
        rule: 'subscription-lifecycle',
        severity: 'low',
        title: `${socket.length} subscription socket close${socket.length === 1 ? '' : 's'}, all clean`,
        detail:
          'These are logged at error level by the platform but are not errors: `io client disconnect` '
          + 'means the client closed the socket deliberately. Listed so their absence from the error '
          + 'findings is a decision rather than an oversight.',
        count: socket.length,
        entryIds: socket.map((x) => x.entry.id),
        requestIds: [],
      });
    }
  }

  /* ── Unattributed computed props ────────────────────────────────────── */

  const unattributed = entries.filter((e) => e.write.startsWith('(computed).'));
  if (unattributed.length) {
    add({
      rule: 'unattributed-transform',
      severity: 'low',
      title: `${new Set(unattributed.map((e) => e.write)).size} transform(s) could not be tied to an element`,
      detail: 'The runtime names the owning component only for action-driven transforms. Open this screen with its design available to attribute the rest.',
      count: unattributed.length,
      entryIds: unattributed.map((e) => e.id),
      requestIds: [],
    });
  }

  return issues.sort((a, b) => RANK[a.severity] - RANK[b.severity] || b.count - a.count);
}

/**
 * The write chain behind an issue — the same provenance the `⌁` badge walks,
 * so a diagnostic can be followed back to its cause.
 */
export function issueTrace(issue: Issue, entries: LogEntry[]): string[] {
  if (!issue.path) return issue.entryIds;
  const chain = provenanceFor(entries, issue.path);
  return chain.length ? chain : issue.entryIds;
}
