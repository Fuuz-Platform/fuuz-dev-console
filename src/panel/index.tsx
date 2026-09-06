import { StrictMode, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { writeSatisfiesRead } from '../core/provenance';
import { resolveHost, type Inbound, type Snapshot } from './host';
import { IssuesPane } from './IssuesPane';
import { NetworkPane } from './NetworkPane';
import { ScriptPane } from './ScriptPane';
import { GraphqlPane } from './GraphqlPane';
import { API_ACCESS } from '../core/apiAccess';
import { SchemaPane } from './SchemaPane';
import { ElementsPane } from './ElementsPane';
import { FlowPane } from './FlowPane';
import { ConnectPane } from './ConnectPane';
import { toMarkdown } from '../core/report';
import { parseDisplayValue, toTransformPath, toValueJson } from '../core/copyPaths';
import { entryOwner } from '../core/designJoin';
import { CopyBits } from './CopyBits';
import type { LogEntry, ScreenRunnerPayload, StateNode } from '../core/types';
import './styles.css';

const host = resolveHost();
const post = (m: Inbound) => host.post(m);

/* ── Coloured JSON rendering ──────────────────────────────────────────────
 * The expanded body of an entry is its console arguments, printed the way the
 * browser console prints them but with the tokens we care about picked out.
 */

type Tok = { s: string; c: string };
type Line = { indent: number; toks: Tok[] };

const PUNC = 'tok-punc', KEY = 'tok-key', STR = 'tok-str', NUM = 'tok-num', BOOL = 'tok-bool', ERR = 'tok-err';
const MAX_LINES = 400;

/** Is this key one whose value should read as an error? */
const errorish = (key: string) => /^(error|err|exception|stack|jse_\w+|message)$/i.test(key);

function scalarToks(v: unknown, asError: boolean): Tok[] {
  if (typeof v === 'string') return [{ s: JSON.stringify(v), c: asError ? ERR : STR }];
  if (typeof v === 'number') return [{ s: String(v), c: NUM }];
  if (typeof v === 'boolean' || v === null) return [{ s: String(v), c: BOOL }];
  if (v === undefined) return [{ s: 'undefined', c: BOOL }];
  return [{ s: String(v), c: PUNC }];
}

function emit(value: unknown, indent: number, out: Line[], prefix: Tok[] = [], asError = false): void {
  if (out.length >= MAX_LINES) return;
  const scalar = value === null || typeof value !== 'object';
  if (scalar) {
    out.push({ indent, toks: [...prefix, ...scalarToks(value, asError)] });
    return;
  }
  if (Array.isArray(value)) {
    if (!value.length) { out.push({ indent, toks: [...prefix, { s: '[]', c: PUNC }] }); return; }
    out.push({ indent, toks: [...prefix, { s: '[', c: PUNC }] });
    value.forEach((item) => emit(item, indent + 1, out, [], asError));
    out.push({ indent, toks: [{ s: ']', c: PUNC }] });
    return;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length) { out.push({ indent, toks: [...prefix, { s: '{}', c: PUNC }] }); return; }
  out.push({ indent, toks: [...prefix, { s: '{', c: PUNC }] });
  for (const [k, v] of entries) {
    emit(v, indent + 1, out, [{ s: k, c: errorish(k) ? ERR : KEY }, { s: ': ', c: PUNC }], asError || errorish(k));
  }
  out.push({ indent, toks: [{ s: '}', c: PUNC }] });
}

function jsonLines(args: unknown[]): Line[] {
  const out: Line[] = [];
  for (const arg of args) {
    if (typeof arg === 'string' && args.length > 1 && arg === args[0]) continue; // the head is already the title
    emit(arg, 0, out);
  }
  if (out.length >= MAX_LINES) out.push({ indent: 0, toks: [{ s: `… output truncated at ${MAX_LINES} lines`, c: PUNC }] });
  return out;
}

/**
 * An expandable JSON value.
 *
 * `jsonLines` flattens everything to a fixed list of lines, which is fine for a
 * three-key object and useless for a captured payload: a 400-line dump with no way
 * to collapse the parts you are not reading. This renders each object and array as
 * a node you can open and close.
 *
 * Collapsed by default past the first level, showing a summary — `{ 8 keys }`,
 * `[ 16 items ]` — so the shape is visible before the contents. Depth 0 and 1 open
 * automatically, because a value nobody can see is not much better than one that
 * was truncated.
 */
/**
 * Copy text, with a fallback for when the Clipboard API is refused.
 *
 * Shared by the path and value buttons so both behave identically — a copy that
 * silently fails is worse than one that says it did.
 */
async function copyText(value: unknown): Promise<boolean> {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch { return false; }
  }
}

function JsonNode({ label, value, depth, path, expr }: {
  label?: string;
  value: unknown;
  depth: number;
  path: string;
  /**
   * The expression this value sits at, accumulated on the way down.
   *
   * A screen transform reads `$components.…` and `$metadata.…`, which are the
   * roots the runtime binds — so the copied text is something that evaluates,
   * rather than a bare dotted path that silently returns nothing.
   */
  expr: string;
}) {
  const container = value !== null && typeof value === 'object';
  const [open, setOpen] = useState(depth < 2);

  const copy = (
    <>
      <button className="csslink" title={`Copy ${expr}`}
        onClick={(e) => { e.stopPropagation(); void copyText(expr); }}>path</button>
      <button className="csslink" title="Copy this value as JSON"
        onClick={(e) => { e.stopPropagation(); void copyText(value); }}>value</button>
    </>
  );

  if (!container) {
    return (
      <div className="jsonrow" style={{ paddingLeft: 8 + depth * 13 }}>
        {label !== undefined && <span className={errorish(label) ? 'tok-err' : 'tok-key'}>{label}: </span>}
        <span className={
          typeof value === 'string' ? 'tok-str'
            : typeof value === 'number' ? 'tok-num' : 'tok-bool'
        }>{typeof value === 'string' ? JSON.stringify(value) : String(value)}</span>
        {copy}
      </div>
    );
  }

  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, unknown>);
  const summary = Array.isArray(value)
    ? `[ ${entries.length} item${entries.length === 1 ? '' : 's'} ]`
    : `{ ${entries.length} key${entries.length === 1 ? '' : 's'} }`;

  return (
    <>
      <div className="jsonrow" style={{ paddingLeft: 8 + depth * 13, cursor: 'pointer' }}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}>
        <span className="tok-punc" style={{ width: 12, display: 'inline-block' }}>{open ? '▾' : '▸'}</span>
        {label !== undefined && <span className={errorish(label) ? 'tok-err' : 'tok-key'}>{label}: </span>}
        <span className="tok-punc">{summary}</span>
        {copy}
      </div>
      {open && entries.map(([k, v]) => (
        <JsonNode key={`${path}.${k}`} label={k} value={v} depth={depth + 1} path={`${path}.${k}`}
          /* Bracketed for arrays: a dotted index is not valid JSONata. */
          expr={Array.isArray(value) ? `${expr}[${k}]` : `${expr}.${k}`} />
      ))}
    </>
  );
}

/** A whole set of console arguments, each expandable. */
function JsonBody({ args }: { args: unknown[] }) {
  return (
    <>
      {args.map((arg, i) => (
        // The head string is already the entry's title; repeating it is noise.
        typeof arg === 'string' && i === 0 && args.length > 1
          ? null
          /*
           * `$` as the root, not `$state`.
           *
           * A log entry's payload is whatever the runtime logged — for a screen
           * transform the roots are already `metadata` and `components`, so the
           * copied path becomes `$metadata.user.id` rather than a doubled prefix.
           */
          : <JsonNode key={i} value={arg} depth={0} path={`a${i}`} expr="$" />
      ))}
    </>
  );
}

/* ── Small helpers ───────────────────────────────────────────────────────── */

/**
 * The Fuuz mark, inline.
 *
 * Inline rather than an <img> so it inherits crisp rendering at any DPI and
 * needs no packaged asset lookup from the panel page. It replaces the product
 * name in the top bar — the tab is already labelled, so repeating the name just
 * spends horizontal space the toolbar needs.
 */
/**
 * Horizontally scrollable tab strip.
 *
 * The panel has more tabs than fit a narrow DevTools drawer, and a wrapped
 * toolbar would eat vertical space that belongs to the log. So the strip
 * scrolls, and the chevrons appear only when there is something to scroll to —
 * the same affordance the browser's own tab bar uses.
 */
/**
 * Overflow menu for the actions you use occasionally.
 *
 * The toolbar has to hold a tab strip, a target chip and a status line; spending
 * its width on buttons pressed once a session squeezes the tabs. Reload and Pick
 * stay out here because they're used mid-flow — the rest live behind `⋯`.
 */
function OverflowMenu({ items }: {
  items: ({ label: string; onClick: () => void; detail?: string; checked?: boolean } | 'separator')[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="overflow" ref={ref}>
      <button className={`btn ${open ? 'on' : ''}`} title="More actions"
        aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>⋯</button>
      {open && (
        <div className="overflow-menu" role="menu">
          {items.map((item, i) => item === 'separator'
            ? <div className="overflow-sep" key={`s${i}`} />
            : (
              <button className="overflow-item" role="menuitem" key={item.label}
                onClick={() => { item.onClick(); setOpen(false); }}>
                <span className="oi-check">{item.checked ? '✓' : ''}</span>
                <span className="oi-label">{item.label}</span>
                {item.detail && <span className="oi-detail">{item.detail}</span>}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

function TabStrip({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [over, setOver] = useState({ left: false, right: false });

  const measure = () => {
    const el = ref.current;
    if (!el) return;
    setOver({
      left: el.scrollLeft > 2,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2,
    });
  };

  useEffect(() => {
    measure();
    const el = ref.current;
    if (!el) return;
    // Both the container and its contents can change size. ResizeObserver is
    // absent in test environments, so fall back to window resize rather than
    // letting a missing global take the whole panel down.
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    Array.from(el.children).forEach((c) => ro.observe(c));
    return () => ro.disconnect();
  });

  const nudge = (dir: -1 | 1) => ref.current?.scrollBy({ left: dir * 160, behavior: 'smooth' });

  return (
    <div className="tabstrip-wrap">
      {over.left && <button className="tabnudge left" onClick={() => nudge(-1)} title="Scroll tabs left">‹</button>}
      <div className="tabstrip" ref={ref} onScroll={measure}>{children}</div>
      {over.right && <button className="tabnudge right" onClick={() => nudge(1)} title="Scroll tabs right">›</button>}
    </div>
  );
}

function FuuzMark() {
  return (
    <span className="brand" role="img" aria-label="Fuuz Dev Console" title="Fuuz Dev Console">
      <svg viewBox="0 0 256 256" width="22" height="22" aria-hidden="true">
        <path fill="#5B30DF" d="M211.59,256H44.41C19.88,256,0,236.12,0,211.59L0,44.41C0,19.88,19.88,0,44.41,0l167.18,0C236.12,0,256,19.88,256,44.41v167.18C256,236.12,236.12,256,211.59,256z" />
        <polygon fill="#fff" points="196.44,100.7 196.44,123.79 187.36,132.87 143.75,89.27 96.61,136.42 75.99,115.8 116.7,75.08 170.81,75.08" />
        <polygon fill="#fff" points="180.01,140.2 139.3,180.92 85.19,180.92 59.56,155.3 59.56,132.22 68.65,123.13 112.25,166.73 159.39,119.58" />
        <path fill="#fff" d="M136,141.1h-16c-2.82,0-5.1-2.28-5.1-5.1v-16c0-2.82,2.28-5.1,5.1-5.1h16c2.82,0,5.1,2.28,5.1,5.1v16C141.1,138.82,138.82,141.1,136,141.1z" />
      </svg>
    </span>
  );
}

const BADGE: Record<string, string> = { query: 'Q', debug: 'ƒ', flow: '▶', error: '!', log: '·' };

/** Every ancestor id of a path, so revealing a node can open the branch. */
function ancestorsOf(id: string): Record<string, boolean> {
  const acc: Record<string, boolean> = { __screen__: true };
  const parts = id.split('.');
  for (let i = 1; i <= parts.length; i++) acc[parts.slice(0, i).join('.')] = true;
  return acc;
}

function findNode(nodes: StateNode[], id: string): StateNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    const hit = n.children && findNode(n.children, id);
    if (hit) return hit;
  }
  return undefined;
}

/** The value at `path` immediately before `entry` ran — the `before →` half of a step. */
function valueBefore(entries: LogEntry[], entry: LogEntry): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.seq >= entry.seq) continue;
    if (writeSatisfiesRead(e.write, entry.write)) return e.after ?? 'undefined';
  }
  return 'undefined';
}

/* ── Panes ───────────────────────────────────────────────────────────────── */

interface LogPaneProps {
  payload: ScreenRunnerPayload;
  visible: LogEntry[];
  query: string;
  onQuery: (v: string) => void;
  open: Record<string, boolean>;
  onToggle: (id: string) => void;
  focusId: string | null;
  tracing: boolean;
  tracePath: string;
  traceIds: string[];
  onExitTrace: () => void;
  onReveal: (entry: LogEntry) => void;
  /**
   * Outline the element a transform belongs to, in the page.
   *
   * The log tells you `disabled` was recomputed; it does not tell you *which*
   * button went grey. Hovering the row draws the outline on the running screen,
   * which is the join between a function and the thing it controls.
   */
  onHighlightOwner: (entry: LogEntry | null) => void;
  stick: boolean;
  onStick: () => void;
  /** Current buffer limit; `0` is unlimited. Absent when the shell has no setting. */
  retention?: number;
  onRetention?: (entries: number) => void;
  /** Show only the entries belonging to one screen event. */
  eventFilter: string | null;
  onEventFilter: (eventId: string | null) => void;
}

/** Buffer sizes offered in the log footer. `0` is unlimited. */
const RETENTION_CHOICES = [1000, 5000, 20000, 100000, 0];

/** How each flow-log source is described, and what it means for what you are reading. */
const FLOW_SOURCE = {
  'redux-store': {
    label: "the app's store",
    hint: "Read from dataFlowEditor[tab].logs: every entry of the run, with the platform's own id and the full workflow state. No timing — the store carries none.",
  },
  'store-empty': {
    label: 'store reachable · nothing logged yet',
    hint: 'The tap found the store, but the designer has not run a node. Run one and entries appear here.',
  },
  'drawer-scrape': {
    label: "scraped from Fuuz's drawer (fallback)",
    hint: 'No store was reachable, so these are the last few rendered rows parsed from the DOM: collapsed values are missing and ids are row positions.',
  },
} as const;

/** The scope record for an event id, for the filter bar's label and count. */
function scopeOf(payload: ScreenRunnerPayload, eventId: string) {
  return payload.events?.find((s) => s.id === eventId);
}

function LogPane(p: LogPaneProps) {
  const scroller = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (p.stick && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [p.visible.length, p.stick]);

  const total = p.payload.entries.length;
  const count = p.tracing
    ? `${p.visible.length} of ${total} logs · trace filter on`
    : p.eventFilter
      ? `${p.visible.length} of ${total} logs · one event`
    : `${p.visible.length} log${p.visible.length === 1 ? '' : 's'}${p.payload.dropped ? ` · ${p.payload.dropped} dropped` : ''}`
      // Not "lost": scoped to this designer tab, and still there when you switch back.
      + (p.payload.withheld ? ` · ${p.payload.withheld} from another tab` : '');

  return (
    <div className="pane log" style={{ flex: 1.15 }}>
      <div className="panehead">
        <span className="label">Execution log</span>
        <input className="filter" value={p.query} placeholder="Filter" onChange={(e) => p.onQuery(e.target.value)} />
        <span className="count">{count}</span>
      </div>

      {/* Which flow source is feeding the log. The two are not equivalent — the store
          carries the whole run with the platform's own ids, the scrape carries the last
          few rendered rows — so the panel states it rather than letting them look alike. */}
      {p.payload.flowLogSource && (
        <div className="legend design">
          <span title={FLOW_SOURCE[p.payload.flowLogSource].hint}>
            FLOW LOG · {FLOW_SOURCE[p.payload.flowLogSource].label}
          </span>
        </div>
      )}

      {p.tracing && (
        <div className="tracebar">
          <span className="dot" />
          <div style={{ minWidth: 0 }}>
            <div className="title">TRACING <code>{p.tracePath}</code></div>
            <div className="note">
              {p.traceIds.length} write{p.traceIds.length === 1 ? '' : 's'} produced this value · newest last · click a step to expand it
            </div>
          </div>
          <button className="btn spacer focusbtn" onClick={p.onExitTrace}>Show all logs</button>
        </div>
      )}

      {p.eventFilter && (
        <div className="tracebar">
          <span className="dot" />
          <div style={{ minWidth: 0 }}>
            <div className="title">EVENT <code>{scopeOf(p.payload, p.eventFilter)?.label ?? p.eventFilter}</code></div>
            <div className="note">
              {scopeOf(p.payload, p.eventFilter)?.count ?? 0} entr
              {(scopeOf(p.payload, p.eventFilter)?.count ?? 0) === 1 ? 'y' : 'ies'} attributed to this interaction ·
              grouped by capture order and a 1.5s idle gap, so treat the tail as inferred
            </div>
          </div>
          <button className="btn spacer focusbtn" onClick={() => p.onEventFilter(null)}>Show all logs</button>
        </div>
      )}

      <div className="scroll" ref={scroller} style={{ padding: '6px 0 24px' }}
        onMouseLeave={() => p.onHighlightOwner(null)}>
        {p.visible.length === 0 && (
          <div className="empty">
            {total === 0
              ? 'Nothing captured yet. Interact with the screen in the attached browser.'
              : 'No entries match this filter.'}
          </div>
        )}
        {p.visible.map((e) => {
          const isOpen = p.open[e.id] ?? (e.kind === 'error' || p.tracing);
          const step = p.traceIds.indexOf(e.id);
          const owner = entryOwner(e);
          return (
            <div key={e.id} className={`entry ${e.kind === 'error' ? 'error' : ''} ${p.focusId === e.id ? 'focus' : ''}`}
              onMouseEnter={() => p.onHighlightOwner(e)}>
              <div className="head" onClick={() => p.onToggle(e.id)}>
                <span className={`badge ${e.kind}`}>{BADGE[e.kind] ?? '·'}</span>
                {/* The serial, not the clock: the runtime batches its logs through a
                    debounce, so `seq` is the only order that is actually total. */}
                <span className="seq" title={`Capture order · entry ${e.seq}`}>#{e.seq}</span>
                {e.eventId && (
                  <span
                    className={`evtchip ${e.eventVia === 'root' ? 'root' : ''}`}
                    title={e.eventVia === 'root'
                      ? `${e.eventLabel} — this entry is the interaction. Click to show only its work.`
                      : `Step ${e.eventSeq} of ${e.eventLabel} — grouped by capture order, not stated by the runtime. Click to show only this event.`}
                    onClick={(ev) => { ev.stopPropagation(); p.onEventFilter(p.eventFilter ? null : e.eventId!); }}
                  >
                    {e.eventLabel}<em>·{e.eventSeq}</em>
                  </span>
                )}
                <span className="title">{e.title}</span>
                <span className="ts">{e.ts}</span>
                <span className="spacer" style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 'none' }}>
                  {e.dur && <span className="dur">{e.dur}</span>}
                  {e.write && (
                    <span
                      className="writechip"
                      title={owner ? `Reveal in state tree · hovering outlines ${owner.name} in the page` : 'Reveal in state tree'}
                      onClick={(ev) => { ev.stopPropagation(); p.onReveal(e); }}
                    >
                      → {p.tracing && step >= 0 ? `${step + 1} · ` : ''}{e.write}
                      {e.elementType && <em className="etype">{e.elementType}</em>}
                      {e.remote && <em className="etype remote">remote</em>}
                    </span>
                  )}
                </span>
              </div>
              {/* Expandable rather than a flat dump: a captured payload runs to
                  hundreds of lines, and collapsing what you are not reading is the
                  difference between usable and unusable. Its own scroll, so one
                  large entry cannot push the rest of the log away. */}
              {isOpen && (
                <div className="body" style={{ maxHeight: '50vh', overflowY: 'auto' }}>
                  <JsonBody args={e.payload} />
                  {e.origin && <div className="origin">{e.origin}</div>}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="logfoot">
        <span>{count}</span>
        {p.onRetention && (
          <label className="keep" title="Entries kept before the oldest are dropped. The platform's own console keeps 50; this one is yours to set.">
            Keep
            <select
              value={String(p.retention ?? 5000)}
              onChange={(ev) => p.onRetention!(Number(ev.target.value))}
            >
              {RETENTION_CHOICES.map((n) => (
                <option key={n} value={n}>{n === 0 ? 'All' : n.toLocaleString()}</option>
              ))}
            </select>
          </label>
        )}
        <button className={`toggle spacer ${p.stick ? 'on' : ''}`} onClick={p.onStick}>
          <span className="track"><span className="knob" /></span>
          Stick to bottom
        </button>
      </div>
    </div>
  );
}

interface Row { node: StateNode; depth: number; open: boolean; hasKids: boolean }

/**
 * Screen → root → element is three levels, so open to depth 2 by default: the
 * point of the pane is the leaf values, and burying them behind two clicks per
 * component defeats it. Deeper nesting (`context.metadata.user.…`) stays closed.
 * An explicit toggle always wins over the default.
 */
const openByDefault = (depth: number) => depth <= 2;

function flatten(tree: StateNode[], expanded: Record<string, boolean>, query: string): Row[] {
  const q = query.trim().toLowerCase();
  const matches = (n: StateNode): boolean =>
    !q || n.label.toLowerCase().includes(q) || (n.value ?? '').toLowerCase().includes(q) || (n.children ?? []).some(matches);

  const out: Row[] = [];
  const walk = (nodes: StateNode[], depth: number) => {
    for (const n of nodes) {
      if (q && !matches(n)) continue;
      const kids = n.children ?? [];
      // A search shows every match in place, regardless of expansion.
      const open = q ? true : (expanded[n.id] ?? openByDefault(depth));
      out.push({ node: n, depth, open, hasKids: kids.length > 0 });
      if (kids.length && open) walk(kids, depth + 1);
    }
  };
  walk(tree, 0);
  return out;
}

/** Explicitly close every group but the root — the defaults can't express this. */
function collapsedMap(tree: StateNode[]): Record<string, boolean> {
  const acc: Record<string, boolean> = { __screen__: true };
  const walk = (nodes: StateNode[]) => {
    for (const n of nodes) {
      if (!n.children?.length) continue;
      if (n.id !== '__screen__') acc[n.id] = false;
      walk(n.children);
    }
  };
  walk(tree);
  return acc;
}

interface StatePaneProps {
  payload: ScreenRunnerPayload;
  expanded: Record<string, boolean>;
  /** `open` is the row's *current* state, so the toggle works off the default too. */
  onExpand: (id: string, open: boolean) => void;
  onCollapseAll: () => void;
  query: string;
  onQuery: (v: string) => void;
  selected: string | null;
  onSelect: (id: string) => void;
  onTrace: (id: string) => void;
  tracing: boolean;
  onToggleTracing: () => void;
  onClearSelection: () => void;
  focusId: string | null;
  onFocusStep: (id: string) => void;
}

function StatePane(p: StatePaneProps) {
  const rows = useMemo(
    () => flatten(p.payload.tree, p.expanded, p.query),
    [p.payload.tree, p.expanded, p.query]
  );
  const selected = p.selected ? findNode(p.payload.tree, p.selected) : undefined;
  const traceIds = selected?.trace ?? [];
  const byId = useMemo(() => new Map(p.payload.entries.map((e) => [e.id, e])), [p.payload.entries]);

  return (
    <div className="pane state" style={{ flex: 1 }}>
      <div className="panehead">
        <span className="label">Current state</span>
        <input
          className="filter" value={p.query} placeholder="Search elements, properties…"
          onChange={(e) => p.onQuery(e.target.value)}
        />
        <button className="btn" onClick={p.onCollapseAll}>Collapse</button>
      </div>

      <div className="legend">
        <span>LIVE SNAPSHOT · {p.payload.snapshotAt}</span>
        <span><span className="swatch" />changed this run</span>
        <span><code>⌁ n</code>writes behind the value</span>
      </div>

      {p.payload.design && (
        <div className="legend design">
          <span>
            DESIGN · {p.payload.design.screenName}
            {p.payload.design.version ? ` v${p.payload.design.version}` : ''}
          </span>
          <span className={p.payload.design.coverage.unexercised.length ? 'warn' : 'ok'}>
            {p.payload.design.coverage.exercised}/{p.payload.design.coverage.total} dynamic props evaluated
          </span>
          {p.payload.design.coverage.unexercised.length > 0 && (
            <span
              className="never"
              title={p.payload.design.coverage.unexercised
                .map((u) => `${u.elementName}.${u.property} (${u.elementType})`)
                .join('\n')}
            >
              {p.payload.design.coverage.unexercised.length} never ran
            </span>
          )}
        </div>
      )}

      <div className="scroll" style={{ padding: '4px 0 20px' }}>
        {rows.length === 0 && (
          <div className="empty">
            {p.payload.entries.length === 0
              ? 'State is derived from the writes announced in the console — it fills in as the screen runs.'
              : 'No state matches this search.'}
          </div>
        )}
        {rows.map(({ node, depth, open, hasKids }) => (
          <div
            key={node.id}
            className={`treerow ${hasKids ? `group d${depth}` : ''} ${p.selected === node.id ? 'sel' : ''}`}
            style={{ paddingLeft: 8 + depth * 15 }}
            onClick={() => (hasKids ? p.onExpand(node.id, open) : p.onSelect(node.id))}
          >
            <span className="caret">{hasKids ? (open ? '▼' : '▶') : ''}</span>
            <span className="icon" />
            <span className="label">{node.label}</span>
            <span className="type">{node.type}</span>
            <span className={`value tok-${node.vk === 'obj' ? 'punc' : node.vk === 'err' ? 'err' : node.vk}`}>
              {node.value ?? ''}
            </span>
            <span className="right">
              <CopyBits
                path={toTransformPath(node.id)}
                value={node.value !== undefined ? toValueJson(node.id, parseDisplayValue(node.value)) : undefined}
              />
              {node.changed && <span className="changed" />}
              {node.trace.length > 0 && (
                <span
                  className="tracechip"
                  title="Trace how this value was produced"
                  onClick={(ev) => { ev.stopPropagation(); p.onTrace(node.id); }}
                >
                  ⌁ {node.trace.length}
                </span>
              )}
            </span>
          </div>
        ))}
      </div>

      {selected && traceIds.length > 0 && (
        <div className="trace">
          <div className="head">
            <span className="label">Trace</span>
            <span className="path">{selected.id}</span>
            <button className={`btn spacer focusbtn ${p.tracing ? 'on' : ''}`} onClick={p.onToggleTracing}>
              ⌁ Focus in log
            </button>
            <button className="btn" onClick={p.onClearSelection} style={{ border: 0 }}>✕</button>
          </div>
          <div className="val">{selected.value}</div>
          <div style={{ padding: '0 12px 14px' }}>
            {traceIds.map((id, i) => {
              const e = byId.get(id);
              if (!e) return null;
              return (
                <div
                  key={id}
                  className={`step ${p.focusId === id ? 'on' : ''} ${e.kind === 'error' ? 'err' : ''}`}
                  onClick={() => p.onFocusStep(id)}
                >
                  <span className="rail">
                    <span className="n">{i + 1}</span>
                    <span className="wire" />
                  </span>
                  <span className="main">
                    <span className="row1">
                      <span className="stitle">{e.title}</span>
                      <span className="meta">{e.ts}{e.dur ? ` · ${e.dur}` : ''}</span>
                    </span>
                    {e.expr && <span className="expr">{e.expr}</span>}
                    <span className="delta">
                      {e.write}: {valueBefore(p.payload.entries, e)} → <span className="after">{e.after ?? '—'}</span>
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── App ─────────────────────────────────────────────────────────────────── */

type Mode = 'split' | 'log' | 'state' | 'network' | 'issues' | 'structure'
  | 'connect' | 'css' | 'props' | 'script' | 'graphql' | 'schema';

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [copied, setCopied] = useState(false);
  const [shotError, setShotError] = useState<string | undefined>();
  const [highlightMiss, setHighlightMiss] = useState<string | undefined>();
  const [tabs, setTabs] = useState<{ id: number; title: string; url: string; active: boolean }[]>([]);
  const [pickingTab, setPickingTab] = useState(false);
  /** A starter query handed over from the schema browser. */
  const [querySeed, setQuerySeed] = useState<string | undefined>();
  const [picked, setPicked] = useState<{ name: string; type: string; field?: string; label?: string } | undefined>();
  const [mode, setMode] = useState<Mode>('split');
  const [query, setQuery] = useState('');
  const [treeQuery, setTreeQuery] = useState('');
  // Empty = every group takes its depth-based default (see `openByDefault`).
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [tracing, setTracing] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [stick, setStick] = useState(true);
  /** When set, the log shows one screen event's work and nothing else. */
  const [eventFilter, setEventFilter] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = host.subscribe(setSnapshot);
    host.onHighlightMiss?.((name) => {
      setHighlightMiss(name);
      setTimeout(() => setHighlightMiss(undefined), 4000);
    });
    post({ type: 'ready' });
    return unsubscribe;
  }, []);

  const buildReport = () => snapshot ? toMarkdown({
    payload: snapshot.payload, network: snapshot.network,
    issues: [...snapshot.issues, ...snapshot.designFindings], pageUrl: snapshot.pageUrl,
  }) : '';

  /** Save the report as a file — the practical way to attach it to a web chat. */
  const downloadReport = () => {
    const md = buildReport();
    if (!md) return;
    const name = `fuuz-${(snapshot?.payload.screenName || 'screen').replace(/\W+/g, '-').toLowerCase()}.md`;
    const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  /** The whole run as markdown, for pasting into an LLM. */
  const canMutate = snapshot?.environment?.tier === 'permitted';

  // Switching to a flow tab while Design or ƒx is open would leave the pane blank
  // with its own tab no longer rendered — so fall back to the Flow view.
  useEffect(() => {
    const kind = snapshot?.designer?.kind;
    // Script and GraphQL are surface-independent, so no surface may evict them.
    // The schema designer has no element tree, so `structure` would render an empty
    // one; and Models is meaningless anywhere else.
    if (kind === 'schema' && mode === 'structure') setMode('schema');
    if (kind !== 'schema' && mode === 'schema') setMode('structure');
    // A mode whose pane is not rendered would leave the panel blank.
    if (!API_ACCESS && mode === 'graphql') setMode('script');
  }, [snapshot?.designer?.kind, mode]);

  /**
   * Reset the view when the developer switches designer tabs.
   *
   * The Application Designer swaps a screen for a flow for a schema underneath us
   * with no navigation, no reconnect, and no change to the browser tab — so every
   * bit of view state we hold silently outlives what it described. An expanded
   * element, a selected state path, an active trace: all of them belong to the
   * surface that is no longer open.
   *
   * The host has already dropped the design-derived caches; this drops the *view*
   * state that pointed into them. Deliberately not cleared: the filter text, which
   * is usually what you were looking for and is cheap to retype if not.
   */
  useEffect(() => {
    if (snapshot?.surfaceEpoch === undefined) return;
    setExpanded({});
    setOpen({});
    setSelected(null);
    setTracing(false);
    setFocusId(null);
    setPicked(undefined);
    setHighlightMiss(undefined);
    // Nothing is outlined on a surface we have just left.
    host.highlight?.(null);
  }, [snapshot?.surfaceEpoch]);

  /**
   * Take a screenshot and hand it to the developer as a download.
   *
   * The viewer sandbox blocks a page-initiated download in some shells, so the
   * image is also opened in a tab — one of the two always works, and a capture
   * you cannot get at is no capture at all.
   */
  const takeScreenshot = async () => {
    const shot = await host.screenshot?.();
    if (!shot?.ok || !shot.dataUrl) {
      setShotError(shot?.error ?? 'The capture failed.');
      setTimeout(() => setShotError(undefined), 6000);
      return;
    }
    /*
     * Clipboard, not a download.
     *
     * A screenshot is nearly always pasted straight into a ticket or a chat, so a
     * file on disk to find, open and delete is pure friction. Needs a real
     * `ClipboardItem` — writing the data URI as text pastes the base64 string.
     */
    try {
      const blob = await (await fetch(shot.dataUrl)).blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      setShotError('Screenshot copied to the clipboard');
    } catch (e) {
      setShotError(`Could not copy: ${e instanceof Error ? e.message : String(e)}`);
    }
    setTimeout(() => setShotError(undefined), 4000);
  };

  const copyReport = async () => {
    if (!snapshot) return;
    const md = buildReport();
    try { await navigator.clipboard.writeText(md); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { post({ type: 'copy', text: md }); }
  };

  const payload = snapshot?.payload ?? null;

  const selectedNode = payload && selected ? findNode(payload.tree, selected) : undefined;
  const traceIds = selectedNode?.trace ?? [];
  const isTracing = tracing && traceIds.length > 0;

  const visible = useMemo(() => {
    if (!payload) return [];
    let list = payload.entries;
    if (isTracing) list = list.filter((e) => traceIds.includes(e.id));
    if (eventFilter) list = list.filter((e) => e.eventId === eventFilter);
    const q = query.trim().toLowerCase();
    if (q) list = list.filter((e) => `${e.title} ${e.write} ${e.expr ?? ''}`.toLowerCase().includes(q));
    return list;
  }, [payload, query, isTracing, traceIds, eventFilter]);

  if (!payload || !snapshot) {
    return (
      <div className="empty booting">
        <FuuzMark />
        <span>Starting…</span>
      </div>
    );
  }

  const reveal = (entry: LogEntry) => {
    if (!entry.write) return;
    setSelected(entry.write);
    setFocusId(entry.id);
    setExpanded((prev) => ({ ...prev, ...ancestorsOf(entry.write) }));
    if (mode === 'log') setMode('split');
  };

  const showLog = mode === 'split' || mode === 'log';
  // Split shows log and state side by side. State has no tab of its own now —
  // the Screen tab supersedes it — but this renderer is still Split's right half.
  const showState = mode === 'split';
  const failed = payload.status === 'error';
  /*
   * Runtime findings and design-lint findings as one ranked list.
   *
   * The lint had its own tab, which was always empty because it depends on a design
   * fetch that rarely lands — so the tab implied there was nothing wrong when the real
   * answer was that nothing had been checked. Merged here, they are ranked alongside
   * everything else, which is where a developer already looks.
   */
  const allIssues = [...snapshot.issues, ...snapshot.designFindings];

  return (
    <>
      <div className="topbar">
        <FuuzMark />
        <div
          className={`sub ${failed ? 'err' : ''}`}
          title={[payload.screenName, payload.status, snapshot.role?.roleId, snapshot.role?.tenantId, payload.statusDetail]
            .filter(Boolean).join(' · ')}
        >
          {/* Nothing here duplicates the target button beside it: that button
              already names the tab and carries capture state in its colour, so a
              status dot, a second copy of the name and an environment chip were
              four controls' worth of chrome saying one thing. */}
          {snapshot.role?.roleId && (
            <span className="rolechip" title="The role this capture is running as">{snapshot.role.roleId}</span>
          )}

          {shotError && <span className="statusdetail err">{shotError}</span>}
          {/* Detail only when it says something the dot and name don't — while
              attached it just repeats the screen name. */}
          {payload.status !== 'attached' && payload.statusDetail && (
            <span className="statusdetail">{payload.statusDetail}</span>
          )}
        </div>
        {/* Docked outside the designer, the panel is bound to its own page: the
            button becomes a label rather than a picker, because a docked console
            reading another tab is incoherent. Floating keeps the picker. */}
        {!host.targeting?.canSwitch && (
          <span className="btn target st-attached" style={{ cursor: 'default' }}
            title={`This console is attached to the tab it is docked in:\n${payload.target.url || ''}`}>
            ▣ {payload.target.title || payload.screenName || 'this tab'}
          </span>
        )}
        {host.targeting?.canSwitch && (
          <button
            className={`btn target ${pickingTab ? 'on' : ''} st-${payload.status} ${canMutate ? '' : 'locked'}`}
            title={[
              `Watching: ${payload.screenName}`,
              `Capture: ${payload.status}`,
              snapshot.environment?.slug
                ? `Environment: ${snapshot.environment.slug}${canMutate ? '' : ' (read-only)'}`
                : '',
              'Click to switch tab',
            ].filter(Boolean).join('\n')}
            onClick={async () => {
              const list = await host.targeting!.list();
              setTabs(list);
              setPickingTab((v) => !v);
            }}
          >
            ▣ {payload.target.title || payload.screenName || 'no tab'}
          </button>
        )}
        <div className="actions-group spacer">
          {host.reloadTab && (
            <button className="btn"
              title={`Reload ${payload.target.title || 'the watched tab'} — this window stays open`}
              onClick={() => host.reloadTab!()}>Reload</button>
          )}
          {host.pickElement && (
            <button className="btn" title="Resolve the element selected in Elements ($0) to its Fuuz element"
              onClick={async () => { const hit = await host.pickElement!(); if (hit) { setPicked(hit); setMode('structure'); } }}>
              Pick
            </button>
          )}
          <OverflowMenu
            items={[
              { label: copied ? 'Copied' : 'Copy report', detail: 'markdown', onClick: copyReport },
              { label: 'Download report', detail: '.md', onClick: downloadReport },
              'separator',
              // Two switches, because they are two different tools. The flow log
              // shows per-node execution this panel does not reproduce, so it is
              // shown by default; the frontend console it does replace.
              ...(host.nativeConsole ? [{
                label: "Hide Fuuz's frontend console",
                detail: 'alt+3',
                checked: host.nativeConsole.hidden('frontend'),
                onClick: () => host.nativeConsole!.setHidden(!host.nativeConsole!.hidden('frontend'), 'frontend'),
              }] : []),
              // Only offered where the drawer exists — it mounts on a data flow
              // tab and nowhere else, so on any other page this switch would be
              // a control that does nothing.
              ...(host.nativeConsole && snapshot.consoles?.flowLog ? [{
                label: "Hide Fuuz's flow log console",
                detail: 'alt+2 · data flow',
                checked: host.nativeConsole.hidden('flowLog'),
                onClick: () => host.nativeConsole!.setHidden(!host.nativeConsole!.hidden('flowLog'), 'flowLog'),
              }] : []),
              'separator',
              // Only offer what can actually do something: undo, clear and put-away
              // are meaningless with no tools armed and no shapes drawn.
              ...(host.markup ? ([
                {
                  label: snapshot.markup?.active ? 'Markup: armed' : 'Markup the page',
                  detail: snapshot.markup?.active ? 'ctrl+shift+U to stop' : 'ctrl+shift+U',
                  checked: snapshot.markup?.active === true,
                  onClick: () => host.markup!(snapshot.markup?.active ? 'off' : 'on'),
                },
                ...(snapshot.markup?.selected ? [
                  { label: 'Retype selected label', detail: 'or double-click it', onClick: () => host.markup!('editText') },
                  { label: 'Delete selected shape', onClick: () => host.markup!('deleteSelected') },
                  { label: 'Deselect', onClick: () => host.markup!('deselect') },
                ] : []),
                ...(snapshot.markup?.shapes ? [
                  { label: 'Undo last shape', detail: 'ctrl+U', onClick: () => host.markup!('undo') },
                  { label: `Clear ${snapshot.markup.shapes} shape${snapshot.markup.shapes === 1 ? '' : 's'}`, detail: 'this tab only', onClick: () => host.markup!('clear') },
                ] : []),
                ...(snapshot.markup?.active ? [
                  { label: 'Put markup tools away', onClick: () => host.markup!('clearAndClose') },
                ] : []),
                'separator' as const,
              ]) : []),
              // Docking was wired but unreachable: no control existed for it.
              ...(host.overlay ? ([
                { label: 'Dock console right', detail: 'in page', onClick: () => host.overlay!('right') },
                { label: 'Dock console bottom', detail: 'in page', onClick: () => host.overlay!('bottom') },
                { label: 'Float console', detail: 'in page', onClick: () => host.overlay!('float') },
                { label: 'Close in-page console', onClick: () => host.overlay!('off') },
                {
                  label: 'Prefer a separate window',
                  detail: 'what the toolbar icon opens',
                  /*
                   * The only way to choose the window.
                   *
                   * Closing the in-page console used to be read as this, which meant one close reset
                   * "dock it right" to "open a window" — so the toolbar stopped honouring the dock.
                   */
                  onClick: () => host.overlay!('window'),
                },
                'separator' as const,
              ]) : []),
              ...(host.screenshot ? [{
                label: 'Screenshot',
                detail: canMutate ? 'ctrl+shift+S · to clipboard' : 'disabled here',
                onClick: takeScreenshot,
              }] : []),
              'separator' as const,
              { label: 'Clear capture', onClick: () => post({ type: 'clear' }) },
              { label: 'Dump raw console', detail: 'for rule authoring', onClick: () => post({ type: 'dumpRaw' }) },
            ]}
          />
        </div>

        <TabStrip>
          <button className={`btn ${mode === 'split' ? 'on' : ''}`} onClick={() => setMode('split')}>Split</button>
          <button className={`btn ${mode === 'log' ? 'on' : ''}`} onClick={() => setMode('log')}>Log</button>
          <button className={`btn ${mode === 'network' ? 'on' : ''}`} onClick={() => setMode('network')}>
            Network{snapshot.network.length ? ` (${snapshot.network.length})` : ''}
          </button>
          <button className={`btn ${mode === 'issues' ? 'on' : ''} ${allIssues.some(i => i.severity === 'high') ? 'alert' : ''}`}
            onClick={() => setMode('issues')}>
            Issues{allIssues.length ? ` (${allIssues.length})` : ''}
          </button>
          {/* One tab, named for whatever surface is open — a schema designer has no
              element tree and no flow, so offering either would be a dead end. */}
          {snapshot.designer?.kind === 'schema' ? (
            <button className={`btn ${mode === 'schema' ? 'on' : ''}`} onClick={() => setMode('schema')}>
              Models{snapshot.schema?.models.length ? ` (${snapshot.schema.models.length})` : ''}
            </button>
          ) : (
            <button className={`btn ${mode === 'structure' ? 'on' : ''}`} onClick={() => setMode('structure')}>
              {snapshot.designer?.kind === 'flow'
                ? `Flow${snapshot.designHunt?.flow ? ` (${snapshot.designHunt.flow.nodeCount})` : ''}`
                : `Screen${snapshot.structure.length ? ` (${snapshot.structure.length})` : ''}`}
            </button>
          )}
          {/* Always present, on every surface and on none: neither needs a capture, a
              design or even an attached tab, and the moment you want to work an
              expression out is before there is a screen to run it in. */}
          <button className={`btn ${mode === 'script' ? 'on' : ''}`} onClick={() => setMode('script')}>Script</button>
          {/* Hidden while API access is off: the console could only ever refuse every
              query, and a tab that cannot work is worse than an absent one. */}
          {API_ACCESS && (
            <button className={`btn ${mode === 'graphql' ? 'on' : ''}`} onClick={() => setMode('graphql')}>GraphQL</button>
          )}
          <button
            className={`btn claude ${mode === 'connect' ? 'on' : ''} ${host.bridge?.state().enabled ? 'live' : ''}`}
            title="Let Claude read this screen's diagnostics directly"
            onClick={() => setMode('connect')}
          >
            {host.bridge?.state().enabled ? '● Claude' : 'Send to Claude'}
          </button>
        </TabStrip>
      </div>

      {pickingTab && (
        <div className="tabpicker">
          <div className="tphead">
            Watching tab <b>{host.targeting?.current() ?? '—'}</b>. Pick another Fuuz tab to follow —
            the capture resets, since a different tab is a different screen.
          </div>
          {tabs.length === 0 && <div className="tprow muted">No Fuuz tabs open.</div>}
          {tabs.map((t) => (
            <div
              key={t.id}
              className={`tprow ${t.id === host.targeting?.current() ? 'cur' : ''}`}
              onClick={() => { host.targeting?.watch(t.id); setPickingTab(false); }}
            >
              <span className="tpname">{t.title || '(untitled)'}</span>
              <span className="tpurl">{t.url.replace(/^https:\/\//, '')}</span>
              {t.active && <span className="tpbadge">frontmost</span>}
              {t.id === host.targeting?.current() && <span className="tpbadge cur">watching</span>}
            </div>
          ))}
        </div>
      )}

      {!failed && snapshot.health && !snapshot.health.eventsSeen && (
        <div className="diagbar">
          {!snapshot.health.hookInstalled ? (
            <>
              <b>Not capturing.</b> The page was open before the extension loaded, so the console
              hook was never injected. Press <b>Reload screen</b> above — this window stays open.
            </>
          ) : snapshot.designer ? (
            <>
              <b>You're in the {snapshot.designer.kind} designer{snapshot.designer.tabName ? ` — ${snapshot.designer.tabName}` : ''}.</b>{' '}
              {snapshot.designer.kind === 'flow' ? (
                <>Open the <b>Flow</b> tab for its nodes and executions.</>
              ) : (
                <>
                  {/* The earlier copy claimed the designer renders the screen inert and that no
                      transforms execute. A live capture disproved it: transforms DO run here —
                      what's empty is the context they carry (`urlParameters: {}`, `screen: null`,
                      `components: []`). */}
                  Transforms <b>do</b> run here, but the context they get is a shell — no{' '}
                  <code>screen</code>, no <code>components</code> — so most read nothing useful.
                  The <b>Screen</b> tab reads the element tree from the canvas instead. Open the
                  screen itself to see transforms run against real state.
                </>
              )}
            </>
          ) : (
            <>
              <b>Hook installed and waiting.</b> Nothing logged yet — the runtime skips logging for
              transforms served from its result cache, so a soft navigation is often silent.
              Press <b>Reload screen</b> for a cold evaluation, or interact to invalidate the cache.
            </>
          )}
        </div>
      )}

      {failed ? (
        <div className="empty err">
          <h2>Not attached</h2>
          <div>{payload.statusDetail}</div>
          <div className="actions">
            <button className="btn" onClick={() => post({ type: 'reattach' })}>Try again</button>
          </div>
        </div>
      ) : (
        <div className="panes" key={snapshot.surfaceEpoch ?? 0}>
          {/* Keyed on the surface: a remount is the only thing that clears state held
              *inside* the panes — an element's open property editor, a flow node's
              selection, every StateRows caret. Reconciling would preserve exactly the
              things that no longer apply. */}
          {mode === 'network' && <NetworkPane network={snapshot.network} />}
          {mode === 'connect' && (
            <ConnectPane
              host={host}
              screenName={payload.screenName}
              entries={payload.entries.length}
              requests={snapshot.network.length}
              onCopyReport={copyReport}
              onDownloadReport={downloadReport}
            />
          )}
          {/* The tab follows the surface: a flow tab gets the flow, not an element
              tree it can never populate. That empty search was the flicker. */}
          {mode === 'structure' && snapshot.designer?.kind === 'flow' && (
            <FlowPane snapshot={snapshot} host={host} environment={snapshot.environment} />
          )}
          {mode === 'structure' && snapshot.designer?.kind !== 'flow' && (
            <ElementsPane
              structure={snapshot.structure}
              stateTree={payload.tree}
              entries={payload.entries}
              context={snapshot.context}
              host={host}
              environment={snapshot.environment}
              structureNote={snapshot.designer?.structureNote}
              diag={snapshot.structureDiag}
              designerSelected={snapshot.designerSelected}
              highlightMiss={highlightMiss}
              onHighlight={(target, reveal) => host.highlight?.(target, reveal)}
            />
          )}
          {mode === 'script' && (
            <ScriptPane
              host={host}
              seedContext={snapshot.context}
              /* The design's elements, so `$components.<name>` and each element's `fn`
                 bag complete before anything has run. */
              elements={snapshot.designElements}
              /*
               * Every node that ran — the summary, not the payload-bearing runs.
               *
               * Those are byte-budgeted, so one integration node with a large API response left only
               * itself in the picker. Payloads are fetched per node on demand.
               */
              flowSummary={snapshot.flowEvents?.summary ?? []}
              /* Only the modes that fit this page are offered. */
              surface={snapshot.designer?.kind}
            />
          )}
          {API_ACCESS && mode === 'graphql' && (
            <GraphqlPane host={host} environment={snapshot.environment} seedQuery={querySeed} />
          )}
          {mode === 'schema' && (
            <SchemaPane
              models={snapshot.schema?.models ?? []}
              shapes={snapshot.schema?.shapes ?? {}}
              selection={snapshot.canvasSelection}
              onHighlight={(target) => host.highlight?.(target)}
              onSeedQuery={(q) => { setQuerySeed(q); setMode('graphql'); }}
            />
          )}
          {mode === 'issues' && (
            <IssuesPane
              /* The design lint had its own tab and it was always empty, so the tab is
                 gone — but the findings are not: static design problems and runtime
                 ones belong in the same ranked list anyway, which is where a developer
                 already looks. */
              issues={allIssues}
              entries={payload.entries}
              network={snapshot.network}
              onHighlight={(target, reveal) => host.highlight?.(target, reveal)}
              onReveal={(path) => {
                setSelected(path);
                setExpanded((prev) => ({ ...prev, ...ancestorsOf(path) }));
                setMode('split');
              }}
            />
          )}
          {showLog && (
            <LogPane
              payload={payload}
              visible={visible}
              query={query}
              onQuery={setQuery}
              open={open}
              onToggle={(id) => setOpen((p) => ({ ...p, [id]: !(p[id] ?? false) }))}
              focusId={focusId}
              tracing={isTracing}
              tracePath={selectedNode?.id ?? ''}
              traceIds={traceIds}
              onExitTrace={() => { setTracing(false); setFocusId(null); }}
              onReveal={reveal}
              onHighlightOwner={(entry) => {
                const owner = entry ? entryOwner(entry) : undefined;
                // No owner means there is genuinely nothing to point at — a query or
                // a screen-level flow. Clearing is right; guessing would not be.
                host.highlight?.(owner ? { name: owner.name, type: owner.type } : null);
              }}
              stick={stick}
              onStick={() => setStick((s) => !s)}
              retention={payload.retention}
              onRetention={host.retention ? (n) => host.retention!.setMax(n) : undefined}
              eventFilter={eventFilter}
              onEventFilter={setEventFilter}
            />
          )}
          {showState && (
            <StatePane
              payload={payload}
              expanded={expanded}
              onExpand={(id, open) => setExpanded((p) => ({ ...p, [id]: !open }))}
              onCollapseAll={() => setExpanded(collapsedMap(payload.tree))}
              query={treeQuery}
              onQuery={setTreeQuery}
              selected={selected}
              onSelect={(id) => { setSelected(id); setFocusId(null); }}
              onTrace={(id) => { setSelected(id); setTracing(true); setFocusId(null); if (mode !== 'split') setMode('split'); }}
              tracing={isTracing}
              onToggleTracing={() => setTracing((t) => !t)}
              onClearSelection={() => { setSelected(null); setTracing(false); setFocusId(null); }}
              focusId={focusId}
              onFocusStep={(id) => {
                setFocusId((cur) => (cur === id ? null : id));
                setTracing(true);
                setOpen((p) => ({ ...p, [id]: true }));
              }}
            />
          )}
        </div>
      )}
    </>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
