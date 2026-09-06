/**
 * Turn a raw Chrome console call into a classified {@link LogEntry}.
 *
 * Classification is rule-driven rather than hard-coded: the Fuuz screen runtime
 * logs a handful of recognisable shapes (transform debugging, transform errors,
 * queries, flow calls), but tenants run different platform builds, so the rule
 * set ships as a default and is overridable from settings. Anything that
 * matches nothing still becomes an entry — it just contributes no state.
 *
 * Pure: no VS Code, no I/O.
 */
import type { ClassifyRule, EntryKind, LogEntry, RawConsoleEvent } from './types';

/** Roots the screen runtime writes into. A path starting with one is already absolute. */
const ROOTS = ['context', 'components', 'variables', 'state', 'props', 'metadata', 'route'];

/** JSONata/runtime builtins that look like reads but are calls or magic values. */
const NOT_A_READ = new Set([
  '$', '$$', '$this', '$now', '$me', '$millis', '$floor', '$ceil', '$round', '$abs',
  '$string', '$number', '$boolean', '$exists', '$not', '$count', '$sum', '$max', '$min',
  '$map', '$filter', '$reduce', '$sort', '$keys', '$lookup', '$merge', '$append',
  '$substring', '$split', '$join', '$match', '$replace', '$trim', '$uppercase', '$lowercase',
  '$base64encode', '$base64decode', '$fromMillis', '$toMillis', '$executeFlow', '$eval',
  '$type', '$error', '$assert', '$each', '$sift', '$distinct', '$zip', '$single',
]);

/**
 * Normalize a runtime path into the tree's dot-path form.
 *
 * `$components.Foo.url` → `components.Foo.url`; a bare `$doc` (a transform-local
 * binding, not screen state) is namespaced under `(local)` so locals show in the
 * trace chain without colliding with real state.
 */
export function normalizePath(raw: string, writeRoot?: string): string {
  let p = String(raw ?? '').trim();
  if (!p) return '';
  p = p.replace(/^\$+/, (m) => (m.length > 1 ? '' : '$'));
  if (p.startsWith('$')) {
    const bare = p.slice(1);
    const head = bare.split('.')[0];
    if (ROOTS.includes(head)) return bare;
    // A single-segment `$name` is a transform-local binding.
    return bare.includes('.') ? bare : `(local) $${bare}`;
  }
  const head = p.split('.')[0];
  if (ROOTS.includes(head) || head === '(local)') return p;
  return writeRoot ? `${writeRoot}.${p}` : p;
}

/**
 * Pull the paths an expression reads. This is what lets the console answer
 * "how was this value produced" rather than only "what wrote it last": a read
 * of `$components.TicketTable.data` links this entry to whichever earlier entry
 * wrote that path.
 *
 * Tokens immediately followed by `(` are function calls, not reads.
 */
export function extractReads(expr: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /\$[A-Za-z_$][A-Za-z0-9_]*(?:\.[A-Za-z_$][A-Za-z0-9_]*)*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expr)) !== null) {
    const token = m[0];
    if (expr[re.lastIndex] === '(') continue;
    if (NOT_A_READ.has(token)) continue;
    const norm = normalizePath(token);
    if (norm && !seen.has(norm)) { seen.add(norm); out.push(norm); }
  }
  return out;
}

/** Read a dot path out of a plain object, tolerating anything non-object. */
export function dig(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** First candidate path that resolves to a usable scalar, across every payload arg. */
function pick(args: unknown[], paths: string[] | undefined): unknown {
  if (!paths) return undefined;
  for (const p of paths) {
    for (const arg of args) {
      const v = p === '.' ? arg : dig(arg, p);
      if (v !== undefined && v !== null && v !== '') return v;
    }
  }
  return undefined;
}

const asText = (v: unknown): string | undefined =>
  v === undefined || v === null ? undefined : typeof v === 'string' ? v : String(v);

/**
 * Default rules, written against a real capture from the platform's screen
 * runner (Fuuz Administration, 2026-08-16). The runtime emits:
 *
 *   console.debug('Transform Debugging: ', {
 *     expression, context, payload, trace, remote, language, result
 *   })
 *
 * where `trace` carries `{ runtime, property, dynamicPropPaths, dynamicProps }`
 * plus `{ origin: 'Action', actionName }` **only for action-owned props**.
 *
 * That last part is the important limitation: a transform driven by an action
 * names its component, and every other transform does not. Rather than guess an
 * owner, unattributed props land under a `(computed)` root — see `fallbackRoot`.
 */
export const DEFAULT_RULES: ClassifyRule[] = [
  {
    id: 'transform-debug',
    kind: 'debug',
    match: '^\\s*transform\\s*debug',
    title: 'Transform Debugging · {{trace.property}}',
    // `origin: 'Action'` is the only case that names its component.
    writeJoin: ['trace.actionName', 'trace.property'],
    writeRoot: 'components',
    fallbackFrom: ['trace.property'],
    fallbackRoot: '(computed)',
    exprFrom: ['expression'],
    // `trace.runtime` is the transform's own evaluation time, in ms.
    durationFrom: ['trace.runtime', 'duration', 'elapsed'],
    resultFrom: ['result'],
    contextFrom: ['context'],
  },
  {
    id: 'transform-error',
    kind: 'error',
    match: '^\\s*transform\\s*error',
    title: 'Transform Error · {{trace.property}}',
    writeJoin: ['trace.actionName', 'trace.property'],
    writeRoot: 'components',
    fallbackFrom: ['trace.property'],
    fallbackRoot: '(computed)',
    exprFrom: ['expression'],
    durationFrom: ['trace.runtime', 'duration', 'elapsed'],
    // The platform surfaces restify/verror-shaped errors from `$executeFlow`.
    resultFrom: ['error.jse_shortmsg', 'error.message', 'error.name', 'result'],
    contextFrom: ['context'],
  },
  {
    id: 'query',
    kind: 'query',
    match: '^\\s*(query|graphql)\\b',
    title: 'Query · {{operationName}}{{model}}{{name}}',
    writeFrom: ['target', 'statePath', 'path'],
    writeJoin: ['component', 'property'],
    writeRoot: 'components',
    durationFrom: ['took', 'duration', 'responseTime', 'elapsed'],
    resultFrom: ['result', 'data', 'rows'],
    contextFrom: ['context'],
  },
  {
    id: 'flow',
    kind: 'flow',
    match: 'executeflow|^\\s*flow\\b',
    title: 'Flow · {{flowId}}{{flowName}}{{name}}',
    writeFrom: ['target', 'statePath', 'path'],
    durationFrom: ['duration', 'took', 'elapsed'],
    resultFrom: ['result', 'response'],
    contextFrom: ['context'],
  },
];

/**
 * Fold the user's rules into the defaults.
 *
 * A user rule sharing a default's `id` replaces it in place, so tuning one
 * shape can't reorder the rest. A rule with a new id is tried *before* the
 * defaults, so a tenant-specific shape wins over the generic match.
 */
export function mergeRules(userRules: ClassifyRule[] | undefined, defaults = DEFAULT_RULES): ClassifyRule[] {
  if (!userRules?.length) return defaults;
  const overrides = new Map(userRules.filter((r) => r?.id).map((r) => [r.id, r]));
  const patched = defaults.map((d) => overrides.get(d.id) ?? d);
  const known = new Set(defaults.map((d) => d.id));
  const added = userRules.filter((r) => r?.id && r.match && !known.has(r.id));
  return [...added, ...patched];
}

/** `{{a.b}}` from the payload, `$1`… from the regex match. Unresolved slots vanish. */
function renderTitle(tpl: string, args: unknown[], m: RegExpMatchArray | null): string {
  const withGroups = tpl.replace(/\$(\d)/g, (_s, d: string) => (m && m[Number(d)]) || '');
  const filled = withGroups.replace(/\{\{([^}]+)\}\}/g, (_s, path: string) => asText(pick(args, [path.trim()])) ?? '');
  return filled.replace(/\s*·\s*$/, '').trim();
}

/** `34ms`, `1.2s` — matched to how the platform renders its own durations. */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** `HH:MM:SS.mmm` in local time. */
export function formatTs(epoch: number): string {
  const d = new Date(epoch);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** A compact one-line preview of any value, for the tree and the trace steps. */
export function formatValue(v: unknown, max = 96): string {
  let s: string;
  if (v === undefined) s = 'undefined';
  else if (v === null) s = 'null';
  else if (typeof v === 'string') s = JSON.stringify(v);
  else if (typeof v === 'number' || typeof v === 'boolean') s = String(v);
  else if (Array.isArray(v)) s = `[ ${v.length} ${v.length === 1 ? 'item' : 'items'} ]`;
  else {
    const entries = Object.entries(v as Record<string, unknown>);
    const head = entries.slice(0, 2).map(([k, val]) => `${k}: ${formatValue(val, 24)}`).join(', ');
    s = entries.length ? `{ ${head}${entries.length > 2 ? ', …' : ''} }` : '{}';
  }
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** The text we match rules against: the first string argument, or the first key-ish field. */
function textHead(args: unknown[]): string {
  const first = args.find((a) => typeof a === 'string');
  if (typeof first === 'string') return first;
  const named = asText(pick(args, ['type', 'event', 'kind', 'message']));
  return named ?? '';
}

const KIND_FROM_LEVEL: Record<string, EntryKind> = {
  error: 'error', assert: 'error', warning: 'log', warn: 'log',
};

/**
 * Classify one console call. Never throws and never returns null — an entry the
 * rules don't recognise is still shown, so a platform change degrades to a
 * plain (but still searchable) console rather than a blank pane.
 */
export function classify(ev: RawConsoleEvent, rules: ClassifyRule[] = DEFAULT_RULES): LogEntry {
  const head = textHead(ev.args);
  const base: LogEntry = {
    id: `e${ev.seq}`,
    seq: ev.seq,
    ts: formatTs(ev.timestamp),
    epoch: ev.timestamp,
    kind: KIND_FROM_LEVEL[ev.level] ?? 'log',
    title: head || `console.${ev.level}`,
    dur: '',
    write: '',
    reads: [],
    level: ev.level,
    origin: ev.origin,
    payload: ev.args,
  };

  for (const rule of rules) {
    let m: RegExpMatchArray | null = null;
    try {
      m = head.match(new RegExp(rule.match, 'i'));
    } catch {
      continue; // A malformed user-supplied regex skips its rule, it doesn't break capture.
    }
    if (!m) continue;

    const expr = asText(pick(ev.args, rule.exprFrom));
    const durRaw = pick(ev.args, rule.durationFrom);
    const durMs = typeof durRaw === 'number' ? durRaw : Number.parseFloat(String(durRaw ?? ''));

    // Ownership, most-attributable first: an explicit target, then a composed
    // component+property, and only then the unattributed bucket. The runtime
    // omits the component for non-action transforms, so `(computed)` is a real
    // outcome — we say we don't know rather than guessing an owner.
    let write = asText(pick(ev.args, rule.writeFrom));
    let root = rule.writeRoot;
    if (!write && rule.writeJoin) {
      const parts = rule.writeJoin.map((p) => asText(pick(ev.args, [p])));
      if (parts.every(Boolean)) write = parts.join('.');
    }
    if (!write && rule.fallbackFrom) {
      write = asText(pick(ev.args, rule.fallbackFrom));
      root = rule.fallbackRoot ?? rule.writeRoot;
    }

    const resultRaw = pick(ev.args, rule.resultFrom);
    return {
      ...base,
      kind: rule.kind,
      title: renderTitle(rule.title, ev.args, m) || base.title,
      write: write ? normalizePath(write, root) : '',
      context: pick(ev.args, rule.contextFrom),
      reads: expr ? extractReads(expr) : [],
      expr,
      dur: formatDuration(Number.isFinite(durMs) ? durMs : undefined),
      durMs: Number.isFinite(durMs) ? durMs : undefined,
      after: resultRaw === undefined ? undefined : formatValue(resultRaw),
    };
  }

  return base;
}
