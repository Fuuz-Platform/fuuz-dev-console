import { useEffect, useMemo, useRef, useState } from 'react';
import { buildFlowCards, flowSummary, type FlowNodeCard } from '../core/flowInspect';
import { groupByRoot, partitionNodeState, toStateExpression } from '../core/flowContext';
import type { FlowEventReply, Host, Snapshot } from './host';

/**
 * A data flow as node cards with a detail panel beside them.
 *
 * The Screen tab has nothing to say about a flow — no elements, no screen state —
 * so on a flow tab it renders this instead. Showing an element tree here was the
 * cause of the empty, flickering pane: it was searching for something that does
 * not exist on this surface.
 *
 * Cards are ordered by the definition's **wiring**, not by log position: a
 * `broadcast` runs branches in parallel, so log order would present the flow
 * wrongly. A node appears once however many times it ran, with its executions
 * listed inside — ten log rows for `Upsert Asset Collections` is one node that
 * ran ten times, not ten nodes.
 */
const STATUS_GLYPH: Record<string, string> = {
  succeeded: '●', running: '◐', queued: '○', failed: '✕', aborted: '⊘',
};

function ms(n: number | undefined): string {
  if (n === undefined) return '';
  return n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(2)}s`;
}

/**
 * Copy a payload as JSON.
 *
 * Objects are stringified rather than pasted as `[object Object]`, and the
 * console's own elided text (`Array(10)`) is copied verbatim when that is all we
 * have — with no pretence that it is the whole value.
 */
async function copyPayload(value: unknown): Promise<boolean> {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API can be refused; a textarea + execCommand still works in an
    // extension page and is better than silently doing nothing.
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

/** Flatten a node definition to editable leaf rows, skipping the noise. */
function propRows(node: unknown, prefix = '', out: { path: string; value: unknown }[] = [], depth = 0): { path: string; value: unknown }[] {
  if (depth > 4 || node === null || typeof node !== 'object') {
    if (prefix) out.push({ path: prefix, value: node });
    return out;
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    // Wiring and position are the designer's business, not properties to edit.
    if (!prefix && /^(nextNodes|position|ports|links|__|_)/.test(k)) continue;
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) propRows(v, path, out, depth + 1);
    else out.push({ path, value: v });
  }
  return out;
}

/**
 * An expandable value.
 *
 * The pane was rendering the flow console's *rendered text* — `Array(10)`, `{…}` —
 * which has nothing to expand because it is a string. The real objects come from
 * the engine events, fetched per node, and this is what makes them explorable to
 * any depth rather than one summarised line.
 */
function Json({ label, value, depth, path, expr, onCopy }: {
  label?: string;
  value: unknown;
  depth: number;
  path: string;
  /**
   * The expression a developer would paste, built as we descend.
   *
   * A bare dotted path is not usable in a flow node — it reads state through
   * `$state` — so the prefix is carried down rather than reconstructed from a
   * React key, which contains synthetic roots like `rp0i`.
   */
  expr: string;
  onCopy: (label: string, value: unknown, id: string) => React.ReactNode;
}) {
  const container = value !== null && typeof value === 'object';
  const [open, setOpen] = useState(depth < 1);
  if (!container) {
    return (
      <div className="jsonrow" style={{ paddingLeft: 8 + depth * 13 }}>
        {label !== undefined && <span className="ename">{label}: </span>}
        <span className="estate">{typeof value === 'string' ? JSON.stringify(value) : String(value)}</span>
        {/* Both halves are useful: the path to write an expression against, and
            the value to paste into a fixture or a ticket. */}
        {onCopy('path', expr, `jp-${path}`)}
        {onCopy('value', value, `jv-${path}`)}
      </div>
    );
  }
  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, unknown>);
  return (
    <>
      <div className="jsonrow" style={{ paddingLeft: 8 + depth * 13, cursor: 'pointer' }}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}>
        <span className="elabel">{open ? '▾ ' : '▸ '}</span>
        {label !== undefined && <span className="ename">{label}: </span>}
        <span className="elabel">
          {Array.isArray(value) ? `[ ${entries.length} item${entries.length === 1 ? '' : 's'} ]` : `{ ${entries.length} key${entries.length === 1 ? '' : 's'} }`}
        </span>
        {onCopy('path', expr, `jp-${path}`)}
        {onCopy('value', value, `jv-${path}`)}
      </div>
      {open && entries.map(([k, v]) => (
        <Json key={`${path}.${k}`} label={k} value={v} depth={depth + 1} path={`${path}.${k}`}
          /* Array indices are bracketed; a dotted index is not valid JSONata. */
          expr={Array.isArray(value) ? `${expr}[${k}]` : `${expr}.${k}`}
          onCopy={onCopy} />
      ))}
    </>
  );
}

/** Show a value without pretending a long expression fits on one line. */
function preview(value: unknown): string {
  if (typeof value === 'string') return value.length > 400 ? `${value.slice(0, 400)}…` : value;
  if (value === null || value === undefined) return String(value);
  const text = JSON.stringify(value);
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

export function FlowPane({ snapshot, host, environment }: {
  snapshot: Snapshot;
  host: Host;
  environment: Snapshot['environment'];
}) {
  const [selected, setSelected] = useState<string | undefined>();
  const [copied, setCopied] = useState<string | undefined>();
  const listRef = useRef<HTMLDivElement | null>(null);
  const [detail, setDetail] = useState<{ found: boolean; node?: unknown; error?: string } | undefined>();
  const [editing, setEditing] = useState<string | undefined>();
  const [draft, setDraft] = useState('');
  const [writeNote, setWriteNote] = useState<string | undefined>();
  const [globalStates, setGlobalStates] = useState<{ node: string; input: unknown }[] | undefined>();
  const [runPayloads, setRunPayloads] = useState<{ key: string; status: string; durationMs?: number; input?: unknown; output?: unknown; state?: unknown; outputState?: unknown }[] | undefined>();
  const appConfig = snapshot.appConfig;
  const [query, setQuery] = useState('');
  const [showGlobals, setShowGlobals] = useState(false);

  const defs = snapshot.designHunt?.flow?.nodes ?? [];
  const rows = snapshot.flowLog?.rows ?? [];
  const events: FlowEventReply | undefined = snapshot.flowEvents;

  const cards = useMemo(() => buildFlowCards(defs, rows), [defs, rows]);
  const summary = useMemo(() => flowSummary(cards), [cards]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return cards;
    return cards.filter((c) => `${c.name} ${c.type ?? ''}`.toLowerCase().includes(q));
  }, [cards, query]);

  const timingByNode = useMemo(() => {
    const map = new Map<string, { runs: number; totalMs: number; slowestMs: number; failed: number }>();
    for (const s of events?.summary ?? []) map.set(s.node, s);
    return map;
  }, [events]);

  /**
   * Shared context, hoisted out of the cards.
   *
   * Built from the runs' own input states plus the app config, so it reflects the
   * flow that actually ran rather than a fixture. `metadata` and `claims` are
   * byte-identical on every node, so repeating them on 23 cards is 23 copies of
   * one paragraph that buries the two fields which differ.
   */
  const partition = useMemo(() => {
    const states = (globalStates ?? []).map((g) => ({ name: g.node, state: g.input }));
    const shared = appConfig ? [{ root: 'appConfig', value: appConfig, prefix: '$appConfig' }] : [];
    return partitionNodeState(states, shared);
  }, [globalStates, appConfig]);

  const current: FlowNodeCard | undefined = cards.find((c) => c.name === selected);

  /**
   * Paint the purple outline on the flow canvas.
   *
   * The same overlay the Screen tab uses — one implementation in the relay, so a flow
   * node and a screen element are highlighted identically and neither can drift.
   */
  const outline = (card: FlowNodeCard, reveal: boolean) => {
    host.highlight?.({ name: card.name, nodeId: card.def?.id, type: card.type }, reveal);
  };

  /**
   * Canvas colour by node name.
   *
   * Keyed on name because that is what the card list has; a node absent from the canvas — log
   * only, or a definition that never rendered — simply has no swatch, which is itself worth
   * seeing.
   */
  const colourOf = (name: string) =>
    (snapshot.canvasNodes ?? []).find((n) => n.name === name || n.id === name)?.colour;

  /** The selected node as a highlight target, re-painted when a hover ends. */
  const pinnedNode = current
    ? { name: current.name, nodeId: current.def?.id, type: current.type }
    : undefined;

  /**
   * Arrow through the nodes.
   *
   * Indexed against the **filtered** list, so arrowing follows what is on screen
   * rather than jumping to a hidden node. Home/End included because a 23-node
   * flow is long enough that holding a key to reach the end is tedious.
   */
  const move = (delta: number | 'first' | 'last') => {
    if (!visible.length) return;
    const at = visible.findIndex((c) => c.name === selected);
    const next = delta === 'first' ? 0
      : delta === 'last' ? visible.length - 1
        // From no selection, Down starts at the top and Up at the bottom.
        : at < 0 ? (delta > 0 ? 0 : visible.length - 1)
          : Math.max(0, Math.min(visible.length - 1, at + delta));
    setSelected(visible[next].name);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const handled: Record<string, () => void> = {
      ArrowDown: () => move(1),
      ArrowUp: () => move(-1),
      Home: () => move('first'),
      End: () => move('last'),
      PageDown: () => move(8),
      PageUp: () => move(-8),
    };
    const fn = handled[e.key];
    if (!fn) return;
    // Stop the pane scrolling underneath the selection as well as moving it.
    e.preventDefault();
    fn();
  };

  /**
   * Fetch the selected node's whole definition.
   *
   * Per node rather than for all 23: the card summaries carry the list, and only
   * the open node needs its expressions and config. Fetching all of them on every
   * poll would push most of a flow across the bridge unread.
   */
  useEffect(() => {
    setDetail(undefined);
    setEditing(undefined);
    setWriteNote(undefined);
    const id = current?.def?.id ?? current?.name;
    if (!id || !host.flow) return;
    let live = true;
    void host.flow.node(id).then((d) => { if (live) setDetail(d); });
    return () => { live = false; };
  }, [current?.def?.id, current?.name, host]);

  /**
   * Establish the shared context from a few nodes, not all of them.
   *
   * Two is the minimum a comparison needs and three is enough to be confident;
   * fetching every node's payload to compute what they share would reintroduce
   * exactly the traffic that made the panel hang.
   */
  useEffect(() => {
    if (globalStates || !host.flow) return;
    const names = cards.filter((c) => c.executions.length > 0).slice(0, 3).map((c) => c.name);
    if (names.length < 2) return;
    let live = true;
    void Promise.all(names.map((n) => host.flow!.payloads(n))).then((results) => {
      if (!live) return;
      setGlobalStates(results
        .map((r) => ({ node: r.node, input: r.runs.find((x) => x.input !== undefined)?.input }))
        .filter((g) => g.input !== undefined));
    });
    return () => { live = false; };
  }, [cards, globalStates, host]);

  // Payloads for the open node, fetched on demand — they are far too large to push.
  useEffect(() => {
    setRunPayloads(undefined);
    if (!current || !host.flow) return;
    let live = true;
    void host.flow.payloads(current.name).then((r) => { if (live) setRunPayloads(r.runs); });
    return () => { live = false; };
  }, [current?.name, host]);

  /**
   * Real payloads for the open node.
   *
   * Not pushed with the snapshot — they were 460 KB of a 755 KB push and made the
   * panel unusable — so they are fetched when a node is opened. This fetch was
   * missing entirely, which is why only the console's elided text was ever shown.
   */
  useEffect(() => {
    setRunPayloads(undefined);
    if (!current || !host.flow) return;
    let live = true;
    void host.flow.payloads(current.name).then((r) => { if (live) setRunPayloads(r.runs); });
    return () => { live = false; };
  }, [current?.name, host]);

  // Keep the selected row visible when arrowing past the fold.
  useEffect(() => {
    if (!selected) return;
    listRef.current
      ?.querySelector(`[data-node-row="${CSS.escape ? CSS.escape(selected) : selected}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const canWrite = environment.tier === 'permitted' && !!host.flow;

  /**
   * Write one property back to the live node.
   *
   * Typed as the original was: an expression stays a string, everything else is
   * parsed as JSON — so editing `true` to `false` commits a boolean rather than
   * the string `"false"`, which is truthy and would look like nothing happened.
   */
  /** Booleans write straight through — no text round trip to get wrong. */
  const commitBoolean = async (row: { path: string; value: unknown }, next: boolean) => {
    const id = current?.def?.id ?? current?.name;
    if (!id || !host.flow) return;
    const result = await host.flow.setValue(id, row.path, next);
    setWriteNote(result.ok ? (result.note ?? 'Applied.') : (result.error ?? 'The write failed.'));
    if (result.ok) void host.flow.node(id).then(setDetail);
  };

  const commitProp = async (row: { path: string; value: unknown }) => {
    const id = current?.def?.id ?? current?.name;
    if (!id || !host.flow) return;
    let value: unknown = draft;
    if (typeof row.value !== 'string') {
      try { value = JSON.parse(draft); }
      catch (e) { setWriteNote(`Not valid JSON: ${e instanceof Error ? e.message : String(e)}`); return; }
    }
    const result = await host.flow.setValue(id, row.path, value);
    setWriteNote(result.ok ? (result.note ?? 'Applied.') : (result.error ?? 'The write failed.'));
    if (result.ok) {
      setEditing(undefined);
      void host.flow.node(id).then(setDetail);
    }
  };

  const copyButton = (label: string, value: unknown, id: string) => (
    <button className="csslink" title={`Copy ${label} as JSON`}
      onClick={(ev) => {
        ev.stopPropagation();
        void copyPayload(value).then((ok) => {
          setCopied(ok ? id : undefined);
          setTimeout(() => setCopied(undefined), 1200);
        });
      }}>
      {copied === id ? 'copied' : `copy ${label}`}
    </button>
  );

  return (
    <div className="pane issues" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
      {/*
        * An explicit way out.
        *
        * The highlight recolours the canvas — node, wires and joints — and until now the only way to
        * undo it was to click the same row again. That is not discoverable, and if anything ever fails
        * to restore, there was no button to reach for. Always visible when something is selected.
        */}
      {selected && (
        <div className="legend design" style={{ gap: 8, alignItems: 'center' }}>
          <span className="hint">
            <b>{selected}</b> is outlined on the canvas, with its wires coloured
          </span>
          <button className="btn tiny" onClick={() => { setSelected(undefined); host.highlight?.(null); }}>
            Clear selection
          </button>
        </div>
      )}

      <div className="panehead">
        <span className="label">Flow</span>
        <input className="filter" value={query} placeholder="Filter nodes"
          onChange={(e) => setQuery(e.target.value)} />
        <span className="count">
          <span className="elabel" title="Click the list, then arrow up and down">↑↓ to move</span>{' '}
          {summary.nodes} nodes · {summary.ran} ran
          {summary.neverRan ? ` · ${summary.neverRan} never ran` : ''}
          {summary.executions ? ` · ${summary.executions} executions` : ''}
        </span>
      </div>

      {defs.length === 0 && (
        <div className="legend design">
          <span className="warn">
            No flow definition read yet. It comes from the designer&rsquo;s own memory — give the
            page a moment after load, or reload the tab.
          </span>
        </div>
      )}

      {/* Timings: say which kind these are. Engine events are the platform's own
          measurement; the DOM proxy is not, and conflating them would be the most
          misleading thing this pane could do. */}
      {events?.attached && (events.runs?.length ?? 0) === 0 && (
        <div className="legend design">
          <span className="warn">
            Subscribed to the engine&rsquo;s {events.events.length} execution events, but none have
            been recorded{events.unidentified ? ` — ${events.unidentified} arrived in an unexpected shape` : ''}.
            {events.unidentified
              ? ' The payload parser needs correcting; the shapes are captured for that.'
              : ' Trigger the flow again — a run that finished before the panel attached is not seen.'}
          </span>
        </div>
      )}
      {snapshot.flowLog?.timings?.proxy && !(events?.runs?.length) && (
        <div className="legend design">
          <span className="warn">
            Times shown are <b>log-arrival</b>, a proxy — they include network return and render, so
            they are not node execution time. Real durations come from the engine&rsquo;s events.
          </span>
        </div>
      )}

      {/* Shared context, once. Repeating metadata and claims on every card is 23
          copies of one paragraph and buries what differs. */}
      {partition.global.length > 0 && (
        <>
          <div className="treerow group" style={{ cursor: 'pointer' }} onClick={() => setShowGlobals((v) => !v)}>
            <span className="caret">{showGlobals ? '▾' : '▸'}</span>
            <span className="icon" />
            <span className="label">Globally available</span>
            <span className="value dim">{partition.global.length} paths shared by every node</span>
          </div>
          {showGlobals && (
            /* Hundreds of paths are normal, so this scrolls rather than pushing
               the node list off the pane. */
            <div style={{ maxHeight: '32vh', overflowY: 'auto', borderBottom: '1px solid var(--line-strong)' }}>
              {groupByRoot(partition.global).map((g) => (
                <div key={g.root} style={{ paddingLeft: 22 }}>
                  <div className="ename">{g.root}</div>
                  {g.entries.map((e) => {
                    /* `appConfig` is read through its own binding, not `$state`. */
                    const expr = e.path.startsWith('appConfig.')
                      ? `$appConfig.${e.path.slice('appConfig.'.length)}`
                      : toStateExpression(e.path);
                    return (
                      <div key={e.path} className="structrow">
                        <span className="ename" title={expr}>{e.path}</span>
                        <span className="estate">{preview(e.value)}</span>
                        {copyButton('path', expr, `g-path-${e.path}`)}
                        {copyButton('value', e.value, `g-val-${e.path}`)}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* Left: the node list, in wiring order. */}
        <div
          className="scroll"
          ref={listRef}
          tabIndex={0}
          role="listbox"
          aria-activedescendant={selected}
          /* Restores the selected node's outline instead of clearing it — the same
             reasoning as the Screen tab: a click means "this is the node I am on". */
          onMouseLeave={() => host.highlight?.(pinnedNode ?? null)}
          onKeyDown={onKeyDown}
          style={{ flex: '0 0 46%', borderRight: '1px solid var(--line-strong)', outline: 'none' }}
        >
          {visible.map((card) => {
            const t = timingByNode.get(card.name);
            const last = card.executions[card.executions.length - 1];
            return (
              <div
                key={card.name}
                id={card.name}
                data-node-row={card.name}
                role="option"
                aria-selected={selected === card.name}
                className={`structrow ${selected === card.name ? 'sel' : ''} ${card.defOnly ? 'anon' : ''}`}
                style={{ paddingLeft: 8 + card.depth * 12, cursor: 'pointer' }}
                /*
                 * Outline the node on the flow canvas, exactly as the Screen tab does for
                 * a screen element.
                 *
                 * The id is sent alongside the name because the two sides can disagree:
                 * the canvas may wrap or truncate a long node title, while `data-nodeid`
                 * is the same string in the definition and on the canvas.
                 */
                onMouseEnter={() => outline(card, false)}
                onClick={() => {
                  const next = selected === card.name ? undefined : card.name;
                  setSelected(next);
                  // Reveal on select, not on hover: scrolling the canvas under a moving
                  // pointer would fight the developer. Deselecting clears the outline,
                  // since nothing is being worked on any more.
                  if (next) outline(card, true);
                  else host.highlight?.(null);
                }}
              >
                {/*
                  * The node's own colour from the canvas.
                  *
                  * Fuuz colours a node by what it does — source, query, branch — and the list was
                  * throwing that away, so scanning it meant reading every label. A swatch makes the
                  * list read the same way the canvas does, which is what lets you use both together.
                  */}
                <span className="nodedot"
                  style={{ background: colourOf(card.name) ?? 'transparent' }}
                  title={colourOf(card.name) ? 'The colour this node has on the canvas' : 'Not on the canvas'} />
                <span style={{ width: 14 }} title={last ? 'ran' : 'never ran'}>
                  {STATUS_GLYPH[t?.failed ? 'failed' : card.executions.length ? 'succeeded' : 'queued']}
                </span>
                <span className="ename">{card.name}</span>
                <span className="elabel"> {card.type ?? '?'}</span>
                <span className="estate">
                  {card.executions.length > 1 ? `×${card.executions.length} ` : ''}
                  {t ? ms(t.totalMs) : ''}
                  {/* A node that never ran is the most useful fact in a flow
                      diagnosis: a branch was not taken, or the flow stopped. */}
                  {card.defOnly ? 'never ran' : ''}
                  {card.logOnly ? 'not in definition' : ''}
                </span>
              </div>
            );
          })}
        </div>

        {/* Right: the selected node. */}
        <div className="scroll" style={{ flex: 1, minWidth: 0 }}>
          {!current && (
            <div className="empty">
              <h2>Pick a node</h2>
              Its transforms and queries, and what actually went in and came out of each run.
            </div>
          )}
          {current && (
            <div style={{ padding: '6px 10px' }}>
              <div className="ename" style={{ fontSize: 13 }}>{current.name}</div>
              <div className="elabel">
                {current.type ?? 'type unknown'}{current.def?.id ? ` · ${current.def.id}` : ''}
                {current.executions.length > 0 && copyButton('all runs', current.executions, `${current.name}-all`)}
              </div>

              <div className="panehead" style={{ marginTop: 8 }}>
                <span className="label">Properties</span>
                {detail?.found && <span className="count">{propRows(detail.node).length}</span>}
              </div>

              {/* An edit here is not the same as a screen-side edit, and saying so
                  is the difference between a preview and an unintended change. */}
              {canWrite ? (
                <div className="legend design">
                  <span className="warn">
                    Editing changes the designer&rsquo;s <b>in-memory flow</b>, not runtime state — it
                    becomes permanent if you then save in the designer. Reload the tab to discard.
                  </span>
                </div>
              ) : (
                <div className="elabel">Read-only here — {environment.reason}</div>
              )}
              {writeNote && <div className="legend design"><span>{writeNote}</span></div>}

              {!detail && <div className="elabel" style={{ paddingLeft: 8 }}>Reading the node…</div>}
              {detail && !detail.found && (
                <div className="elabel" style={{ paddingLeft: 8 }}>{detail.error ?? 'Not found.'}</div>
              )}
              {detail?.found && propRows(detail.node).map((row) => {
                const isEditing = editing === row.path;
                return (
                  <div key={row.path} className="structrow" style={{ alignItems: 'flex-start' }}>
                    <span className="ename" style={{ minWidth: 150 }}>{row.path}</span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      {typeof row.value === 'boolean' ? (
                        /* A boolean is a switch, not text. Typing `false` into a
                           text box and committing the string `"false"` — which is
                           truthy — is the exact mistake this avoids. */
                        <label style={{ cursor: canWrite ? 'pointer' : 'default' }}>
                          <input type="checkbox" checked={row.value} disabled={!canWrite}
                            onChange={(ev) => void commitBoolean(row, ev.target.checked)} />
                          <span className="estate"> {String(row.value)}</span>
                        </label>
                      ) : isEditing ? (
                        <>
                          <textarea className="filter" style={{ width: '100%', minHeight: 54 }} autoFocus
                            value={draft} onChange={(ev) => setDraft(ev.target.value)}
                            onKeyDown={(ev) => { if (ev.key === 'Escape') setEditing(undefined); }} />
                          <button className="csslink" onClick={() => void commitProp(row)}>Apply</button>
                          <button className="csslink" onClick={() => setEditing(undefined)}>Cancel</button>
                        </>
                      ) : (
                        <span
                          title={canWrite ? 'Double-click to edit' : 'Read-only in this environment'}
                          style={{ cursor: canWrite ? 'text' : 'default', whiteSpace: 'pre-wrap' }}
                          onDoubleClick={() => {
                            if (!canWrite) return;
                            setDraft(typeof row.value === 'string' ? row.value : JSON.stringify(row.value, null, 2));
                            setEditing(row.path);
                            setWriteNote(undefined);
                          }}
                        >{preview(row.value)}</span>
                      )}
                    </span>
                    {copyButton('value', row.value, `prop-${row.path}`)}
                  </div>
                );
              })}

              <div className="panehead" style={{ marginTop: 8 }}>
                <span className="label">Executions</span>
                <span className="count">{current.executions.length}</span>
              </div>
              {current.executions.length === 0 && (
                <div className="elabel" style={{ paddingLeft: 8 }}>
                  Never ran in this capture — the branch was not taken, or the flow stopped earlier.
                </div>
              )}
              {/* Engine payloads first: real objects, explorable to any depth. The
                  scraped text below is the fallback when no event was recorded. */}
              {runPayloads?.map((r, i) => (
                <div key={`p${i}`} style={{ padding: '4px 8px', borderTop: '1px solid var(--line-strong)', maxHeight: '40vh', overflowY: 'auto' }}>
                  <div className="elabel">
                    run {i + 1} · {r.status}
                    {r.durationMs !== undefined ? ` · ${ms(r.durationMs)}` : ''}
                    {copyButton('input', r.input, `rp-${i}-in`)}
                    {copyButton('output', r.output, `rp-${i}-out`)}
                  </div>
                  {/* A flow node reads its state through `$state`, so that is the
                      prefix a copied path needs to actually evaluate. */}
                  {/* This node's own payload, first and open. */}
                  {r.input !== undefined && <Json label="input" value={r.input} depth={0} path={`rp${i}i`} expr="$payload" onCopy={copyButton} />}
                  {r.output !== undefined && <Json label="output" value={r.output} depth={0} path={`rp${i}o`} expr="$output" onCopy={copyButton} />}
                  {/* The accumulated flow state — everything stashed by earlier
                      nodes. It repeats on every node from that point on, so it is
                      a collapsed sibling rather than mixed into the input. */}
                  {r.state !== undefined && (
                    <Json label="state (all nodes)" value={r.state} depth={1} path={`rp${i}s`} expr="$state" onCopy={copyButton} />
                  )}
                </div>
              ))}
              {runPayloads === undefined && current.executions.length > 0 && (
                <div className="elabel" style={{ paddingLeft: 8 }}>Reading payloads…</div>
              )}
              {runPayloads?.length === 0 && current.executions.map((e, i) => (
                <div key={i} style={{
                  padding: '4px 8px', borderTop: '1px solid var(--line-strong)',
                  // A payload can be thousands of characters; one long run must not
                  // push every other run out of reach.
                  maxHeight: '40vh', overflowY: 'auto',
                }}>
                  <div className="elabel">run {i + 1}{e.level ? ` · ${e.level}` : ''}</div>
                  {e.input !== undefined && (
                    <div>
                      <span className="ename">input</span> <span className="estate">{e.input}</span>
                      {copyButton('input', e.input, `${current.name}-${i}-in`)}
                    </div>
                  )}
                  {e.output !== undefined && (
                    <div>
                      <span className="ename">output</span> <span className="estate">{e.output}</span>
                      {copyButton('output', e.output, `${current.name}-${i}-out`)}
                    </div>
                  )}
                  {e.response !== undefined && (
                    <div>
                      <span className="ename">response</span> <span className="estate">{e.response}</span>
                      {copyButton('response', e.response, `${current.name}-${i}-res`)}
                    </div>
                  )}
                  {/* The console elides what it prints; the full value is behind
                      its own collapsed expander, not in the DOM text. */}
                  {e.elided && (
                    <div className="elabel">
                      Values are truncated by Fuuz&rsquo;s own console — expand <code>▶more</code> there for the rest.
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
