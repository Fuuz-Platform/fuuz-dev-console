import { useEffect, useMemo, useState } from 'react';
import jsonata from 'jsonata';
import { formatValue } from '../core/classify';
import { elementDoc, fieldTypeMeaning } from '../core/elementRegistry';
import { copyablePropPaths } from '../core/transformableProps';
import {
  buildPanel, isLarge, provenanceOf, summarise,
  PROVENANCE_LABEL, PROVENANCE_TITLE,
} from '../core/propertyPanel';
import {
  applyCall, commitValue, controlFor, editorFor, propertyRows, type PropertyRow,
} from '../core/propertyModel';
import { transformsFor } from '../core/transformInputs';
import type { StructureNode } from '../core/structure';
import type { EnvironmentInfo } from '../core/environment';
import type { FiberProbe } from '../extension/fiber';
import type { LogEntry, StateNode } from '../core/types';
import type { Host } from './host';
import { CopyBits } from './CopyBits';
import { parseDisplayValue, toComponentPath, toTransformPath, toValueJson } from '../core/copyPaths';

/**
 * Everything about one element, in the place you found it.
 *
 * These were four separate tabs — Structure, State, Props, CSS — and keeping
 * them apart made the developer the join: you looked up an element in one, its
 * values in another, its transforms in a third. Each section here answers a
 * different question about the *same* element, so the answers sit together:
 *
 *   State        what the runtime is holding right now
 *   Transforms   the expressions computing its props, with the values they read
 *   Properties   every property it accepts, with live values and inline editing
 *   CSS          computed and inline styles, previewable on the page
 *
 * Nothing here is ever saved. Every change is runtime-only and a reload discards
 * it; the design changes when you copy a value into the designer.
 */
const MARKER: Record<PropertyRow['state'], { glyph: string; title: string }> = {
  dynamic: { glyph: '●', title: 'Computed by a transform' },
  static: { glyph: '○', title: 'Accepts a transform — currently a literal' },
  fixed: { glyph: '·', title: 'Does not accept a transform' },
  unknown: { glyph: '?', title: 'Undocumented for this element type — unknown, not none' },
};

/** CSS properties worth showing first; the rest are behind "all". */
const CSS_KEYS = [
  'display', 'position', 'width', 'height', 'margin', 'padding',
  'color', 'background-color', 'border', 'border-radius',
  'font-size', 'font-weight', 'text-align', 'flex-direction', 'gap',
  'align-items', 'justify-content', 'overflow', 'opacity', 'visibility', 'z-index',
];

function Section({ title, count, children, defaultOpen = false }: {
  title: string;
  count?: number | string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <>
      <div className="treerow group" style={{ cursor: 'pointer' }} onClick={() => setOpen((v) => !v)}>
        <span className="caret">{open ? '▾' : '▸'}</span>
        <span className="icon" />
        <span className="label">{title}</span>
        {count !== undefined && <span className="value dim">{count}</span>}
      </div>
      {open && children}
    </>
  );
}

function StateRows({ node, depth }: { node: StateNode; depth: number }) {
  const [open, setOpen] = useState(depth < 3);
  const kids = node.children ?? [];
  return (
    <>
      <div className={`treerow ${kids.length ? 'group' : ''}`} style={{ paddingLeft: 8 + depth * 14 }}>
        <span className="caret" onClick={() => setOpen((v) => !v)}>{kids.length ? (open ? '▾' : '▸') : ''}</span>
        <span className="icon" />
        <span className="label">{node.label}</span>
        {node.value !== undefined && <span className="value">{node.value}</span>}
        <CopyBits
          path={toTransformPath(node.id)}
          value={node.value !== undefined ? toValueJson(node.id, parseDisplayValue(node.value)) : undefined}
          dense
        />
      </div>
      {open && kids.map((c) => <StateRows key={`${node.id}.${c.label}`} node={c} depth={depth + 1} />)}
    </>
  );
}

export function ElementDetail({ element, state, entries, context, host, environment, indent }: {
  element: StructureNode;
  state?: StateNode;
  entries: LogEntry[];
  context: unknown;
  host: Host;
  environment: EnvironmentInfo;
  indent: number;
}) {
  const [probe, setProbe] = useState<FiberProbe | undefined>();
  const [editing, setEditing] = useState<string | undefined>();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [applied, setApplied] = useState<Record<string, string>>({});
  const [css, setCss] = useState<{ found: boolean; computed?: Record<string, string>; inline?: Record<string, string> }>();
  const [allCss, setAllCss] = useState(false);

  // Try an expression against live state before committing it to the designer.
  // Opened per property, and only on props that accept a transform.
  const [tryFor, setTryFor] = useState<string | undefined>();
  const [expr, setExpr] = useState('');
  const [evalOut, setEvalOut] = useState<{ ok: boolean; text: string; remote?: boolean } | undefined>();

  const target = useMemo(
    () => ({ name: element.name, type: element.type, dataPath: element.dataPath, label: element.label }),
    [element]
  );
  const doc = elementDoc(element.type);
  const rows = useMemo(() => propertyRows(element, context), [element, context]);


  /*
   * Which property rows offer a copyable transform path.
   *
   * Two conditions, both from the registry rather than from this screen: the property
   * must be one the designer accepts a transform on, and the element must expose
   * functions — meaning the path leads somewhere you can read *and* act on. Props the
   * screen already sets a transform on are included regardless, because the authored
   * design is evidence that outranks the documentation.
   */
  const copyablePaths = useMemo(
    () => copyablePropPaths(element.type, element.props),
    [element.type, element.props]
  );
  const canMutate = environment.tier === 'permitted';

  // Only for props the design says carry a transform, with the values each read.
  const transforms = useMemo(
    () => element.props.flatMap((prop) => transformsFor(entries, `components.${element.name}.${prop}`)),
    [element, entries]
  );

  /*
   * Scope and filter.
   *
   * `set` by default: of ~60 documented properties a real element sets a dozen, and the rest
   * are empty rows burying the ones that matter. The `all` chip says how many it is hiding,
   * so nothing is hidden by surprise.
   */
  const [scope, setScope] = useState<'set' | 'all' | 'problems'>('set');
  const [propQuery, setPropQuery] = useState('');
  const panel = useMemo(
    () => buildPanel(rows, transforms, { scope, query: propQuery }),
    [rows, transforms, scope, propQuery]
  );
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  /** Which large values are opened — a field list is a count until you ask for it. */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // The probe decides whether editing is real or a preview, so it runs before
  // any control is shown — not after.
  useEffect(() => {
    let live = true;
    setProbe(undefined);
    if (!host.element) return undefined;
    void host.element.probe(target).then((p) => { if (live) setProbe(p); });
    return () => { live = false; };
  }, [target, host]);

  const loadCss = () => {
    if (css || !host.styles) return;
    void host.styles.read(target).then(setCss);
  };

  /**
   * Evaluate a candidate expression.
   *
   * Local uses the bundled JSONata — the language, but not the platform's
   * function library. `remote` posts to the transformation service, which is the
   * only way to be sure about `$base64encode` and the `fn` bags.
   */
  const evaluate = async (remote: boolean) => {
    if (!expr.trim()) { setEvalOut(undefined); return; }
    if (remote) {
      const out = await host.evaluateRemote?.(expr, context);
      setEvalOut(!out
        ? { ok: false, text: 'Remote evaluation is unavailable in this shell.' }
        : out.ok
          ? { ok: true, text: JSON.stringify(out.value, null, 2), remote: true }
          : { ok: false, text: out.error ?? 'The transformation service rejected it.', remote: true });
      return;
    }
    try {
      const value = await jsonata(expr).evaluate(context ?? {}, (context ?? {}) as Record<string, unknown>);
      setEvalOut({ ok: true, text: value === undefined ? '(no match)' : JSON.stringify(value, null, 2) });
    } catch (e) {
      setEvalOut({ ok: false, text: e instanceof Error ? e.message : String(e) });
    }
  };

  /** Push an evaluated result onto the property, reusing the same edit tiers. */
  const applyEvaluated = async (row: PropertyRow) => {
    if (!evalOut?.ok) return;
    let value: unknown;
    try { value = JSON.parse(evalOut.text); } catch { value = evalOut.text; }
    const call = applyCall(row, element, value, probe?.fnKeys ?? []);
    if (!call) { setError(row.edit.reason); return; }
    const result = await host.element?.call(target, call.fn, call.args);
    if (result?.ok) setApplied((p) => ({ ...p, [row.name]: `previewed via ${call.fn}()` }));
    else setError(result?.error ?? 'The call did not complete.');
  };

  const commit = async (row: PropertyRow) => {
    const e = editorFor(row.value, row.hasValue);
    const parsed = commitValue(e.kind, draft);
    if (!parsed.ok) { setError(parsed.error); return; }
    const call = applyCall(row, element, parsed.value, probe?.fnKeys ?? []);
    if (!call) {
      /*
       * No runtime setter, so write it to the DOM instead.
       *
       * This used to stop here with a reason — correct but useless. A DOM preview
       * shows the effect now and is overwritten by the next render, which is a
       * weaker promise than an `fn` call and is labelled as exactly that.
       */
      const preview = await host.element?.preview(target, row.name, parsed.value);
      if (preview?.ok) {
        setApplied((p) => ({ ...p, [row.name]: preview.note ?? 'previewed on the DOM' }));
        setEditing(undefined);
        setError(undefined);
      } else {
        setError(preview?.error ?? preview?.note ?? row.edit.reason);
      }
      return;
    }
    const result = await host.element?.call(target, call.fn, call.args);
    if (result?.ok) {
      setApplied((p) => ({ ...p, [row.name]: `applied via ${call.fn}()` }));
      setEditing(undefined);
      setError(undefined);
    } else {
      setError(result?.error ?? 'The call did not complete.');
    }
  };

  const pad = { paddingLeft: 8 + indent * 15 };
  const cssPairs = Object.entries({ ...(css?.computed ?? {}) })
    .filter(([k]) => allCss || CSS_KEYS.includes(k));


  /**
   * One property row.
   *
   * A function rather than an inline map, because the rows are now rendered per section and
   * the same row markup has to serve every group.
   */
  const renderRow = (row: PropertyRow) => {
    const marker = MARKER[row.state];
    const isEditing = editing === row.name;
    const prov = provenanceOf(row);
    const big = row.hasValue && isLarge(row.value);
    return (

            <div key={row.name} className="structrow" style={{ paddingLeft: 22, alignItems: 'flex-start' }}>
              <span title={marker.title} style={{ width: 14, opacity: 0.8 }}>{marker.glyph}</span>
              {/* The name and its copy button are one unit and must stay on one line:
                  inside the fixed-width `.ename` the button wrapped underneath. */}
              <span className="namecell">
                <span className="ename">
                  {row.name}
                  <span className="elabel" title={fieldTypeMeaning(row.type) ?? 'Undocumented field type'}> {row.type}</span>
                </span>
                {/*
                  * Only where a path is worth pasting.
                  *
                  * A transformable prop on an element that exposes functions is one you
                  * can actually reference and drive; every other row would hand over a
                  * path that resolves to nothing useful, and a button per row made the
                  * ones that matter impossible to spot.
                  */}
                {copyablePaths.has(row.name) && (
                  <CopyBits path={toComponentPath(element.name, row.name)} dense />
                )}
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                {/* The control the designer itself uses for this field type: a
                    switch is a checkbox, not a text box you can type "false" into
                    and commit a truthy string. */}
                {controlFor(row.type, row.value) === 'boolean' ? (
                  <label style={{ cursor: canMutate ? 'pointer' : 'default' }}>
                    <input type="checkbox" checked={row.value === true} disabled={!canMutate}
                      onChange={(ev) => {
                        setDraft(String(ev.target.checked));
                        void commit({ ...row, value: row.value === true });
                      }} />
                    <span className="estate"> {String(row.value)}</span>
                  </label>
                ) : isEditing ? (
                  <>
                    <input className="filter" style={{ width: '100%' }} autoFocus value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void commit(row);
                        if (e.key === 'Escape') setEditing(undefined);
                      }} />
                    {error && <span className="warn"> {error}</span>}
                  </>
                ) : (
                  <span
                    title={canMutate ? 'Double-click to edit' : 'Editing is disabled in this environment'}
                    style={{ cursor: canMutate ? 'text' : 'default' }}
                    onDoubleClick={() => {
                      if (!canMutate) return;
                      setDraft(editorFor(row.value, row.hasValue).text);
                      setEditing(row.name);
                      setError(undefined);
                    }}
                  >
                    {!row.hasValue
                      ? <span className="elabel">—</span>
                      : big
                        ? (
                          /* The platform renders a nine-field picker as ~800px of inline
                             checkboxes. A count you can open says the same thing and leaves
                             the rest of the element visible. */
                          <span onClick={(ev) => {
                            ev.stopPropagation();
                            setExpanded((p) => ({ ...p, [row.name]: !p[row.name] }));
                          }}>
                            {expanded[row.name] ? '▾ ' : '▸ '}{summarise(row.value)}
                          </span>
                        )
                        : formatValue(row.value)}
                  </span>
                )}
                {big && expanded[row.name] && (
                  <pre className="propvalue">{JSON.stringify(row.value, null, 2)}</pre>
                )}
                {/* The description is reference material, so it appears on the row you have
                    opened rather than on all sixty at once. */}
                {row.description && (expanded[row.name] || row.state === 'dynamic') && (
                  <div className="elabel">{row.description}</div>
                )}
                {applied[row.name] && <div className="elabel">{applied[row.name]}</div>}
              </span>
              {canMutate && (row.type === 'transform' || row.type === 'jsonata') && (
                <button className="csslink" title="Try an expression against live state"
                  onClick={() => {
                    setTryFor(tryFor === row.name ? undefined : row.name);
                    setExpr(row.state === 'dynamic' ? '' : '');
                    setEvalOut(undefined);
                  }}>fx</button>
              )}
              {/*
                * Where the value came from — the one column the authoring panel cannot show,
                * and usually the answer. Editability is secondary and moves to the title.
                */}
              <span className={`eprops prov-${prov}`} title={`${PROVENANCE_TITLE[prov]} · ${row.edit.reason}`}>
                {PROVENANCE_LABEL[prov]}
              </span>
            </div>
    );
  };
  return (
    <div style={pad}>
      {doc?.summary && <div className="elabel" style={{ padding: '2px 8px' }}>{doc.summary}</div>}

      {/* What can actually be done, before any control is offered. */}
      {!canMutate ? (
        <div className="elabel" style={{ padding: '2px 8px' }}>
          Read-only here — {environment.reason}
        </div>
      ) : probe && !probe.reached ? (
        <div className="elabel" style={{ padding: '2px 8px' }}>
          {probe.note ?? 'No live component in reach.'} Values shown; nothing can be set.
        </div>
      ) : probe?.reached ? (
        <div className="elabel" style={{ padding: '2px 8px' }}>
          Live component reached — exposes <code>{probe.fnKeys.join(', ')}</code>
        </div>
      ) : null}

      <Section title="State" count={state ? (state.children?.length ?? 0) : 'none'} defaultOpen>
        {state && (state.children ?? []).length
          ? (state.children ?? []).map((c) => <StateRows key={c.label} node={c} depth={1} />)
          : (
            <div className="elabel" style={{ padding: '2px 22px' }}>
              {state
                ? 'The runtime holds state for this element, and it is empty.'
                : 'The runtime holds no state for this element — it never rendered, or never ran its query.'}
            </div>
          )}
      </Section>

      <Section title="Transforms" count={transforms.length || element.props.length || 0}>
        {transforms.length === 0 && (
          <div className="elabel" style={{ padding: '2px 22px' }}>
            {element.props.length
              ? `Declares ${element.props.join(', ')}, but nothing was captured running — interact with the screen.`
              : 'No transforms on this element.'}
          </div>
        )}
        {transforms.map((t, i) => (
          <div key={`${t.entryId}-${i}`} style={{ padding: '3px 22px' }}>
            <div className="ename">
              {t.writes}
              <CopyBits path={toTransformPath(t.writes) ?? toComponentPath(element.name, t.writes.split('.').pop())} dense />
              {t.remote && <span className="eprops" title="Evaluated server-side">remote</span>}
              {t.durationMs !== undefined && <span className="elabel"> {t.durationMs.toFixed(1)}ms</span>}
            </div>
            {t.expression && <pre style={{ margin: '2px 0', whiteSpace: 'pre-wrap' }}>{t.expression}</pre>}
            {t.inputs.length > 0 && (
              <div className="elabel">
                reads:{' '}
                {t.inputs.map((r) => (
                  /* An unresolved read is usually the bug — mark it, do not just
                     print `undefined` next to the ones that worked. */
                  <span key={r.path} className={r.resolved ? '' : 'warn'}>
                    {r.path} = {r.resolved ? r.value : '(not found)'}{' '}
                  </span>
                ))}
              </div>
            )}
            {t.result !== undefined && <div className="elabel">&rarr; {t.result}</div>}
          </div>
        ))}
      </Section>

      {/*
        * The panel header: what is true about this element, at a glance.
        *
        * The platform's own panel gives you sixty rows and no way to tell which twelve
        * matter. These counts are that answer, and each is a filter — so "1 problem" is not
        * just a number, it is the way to see it.
        */}
      <div className="propchips" style={{ paddingLeft: 22 }}>
        <button className={`chip ${scope === 'set' ? 'on' : ''}`} onClick={() => setScope('set')}
          title="Properties with a value or a transform — what is actually configured">
          {panel.counts.set} set
        </button>
        {panel.counts.transforms > 0 && (
          <span className="chip flat" title="Properties computed by a transform">
            {panel.counts.transforms} ƒx
          </span>
        )}
        {panel.counts.problems > 0 && (
          <button className={`chip alert ${scope === 'problems' ? 'on' : ''}`}
            onClick={() => setScope('problems')}
            title="Transforms reading paths that do not resolve, or producing nothing">
            {panel.counts.problems} problem{panel.counts.problems === 1 ? '' : 's'}
          </button>
        )}
        <button className={`chip ${scope === 'all' ? 'on' : ''}`} onClick={() => setScope('all')}
          title={`Every documented property, including the ${panel.counts.hidden} with nothing set`}>
          all {panel.counts.total}
        </button>
        <input className="filter" value={propQuery} placeholder="Filter properties, values, expressions"
          onChange={(e) => setPropQuery(e.target.value)} style={{ flex: 1, minWidth: 90 }} />
      </div>

      {/*
        * Problems above properties, and only when there are some.
        *
        * An unresolved read is why you opened the panel — the symptom is a null, which points
        * nowhere near the cause. An empty "Issues" heading would be pure noise, so there
        * isn't one.
        */}
      {panel.problems.length > 0 && (
        <div className="propproblems">
          {panel.problems.map((p) => (
            <div key={`${p.property}-${p.summary}`} className={`propproblem ${p.severity}`}>
              <span className="ename">{p.property}</span>
              <span className="elabel">{p.summary}</span>
            </div>
          ))}
        </div>
      )}

      <Section title="Properties" count={rows.length}>
        {rows.length === 0 && (
          <div className="elabel" style={{ padding: '2px 22px' }}>
            The skill documents nothing for <b>{element.type}</b>, and this screen sets no
            transforms on it. Unknown, not none.
          </div>
        )}
        {/* Grouped by the platform's own section names, in the platform's own order — so a
            developer cross-referencing the two panels finds the same properties in the same
            places. A section holding a transform, or any section during a search, arrives
            open; the rest stay shut. */}
        {panel.groups.map((group) => {
          const open = closed[group.title] === undefined ? group.open : !closed[group.title];
          return (
            <div key={group.title}>
              <div className="structrow group" style={{ paddingLeft: 22, cursor: 'pointer' }}
                onClick={() => setClosed((p) => ({ ...p, [group.title]: open }))}>
                <span className="caret" style={{ width: 12 }}>{open ? '▾' : '▸'}</span>
                <span className="ename">{group.title}</span>
                <span className="estate">
                  {group.rows.length}
                  {group.set && group.set !== group.rows.length ? ` · ${group.set} set` : ''}
                </span>
              </div>
              {open && group.rows.map((row) => renderRow(row))}
            </div>
          );
        })}

        {panel.groups.length === 0 && rows.length > 0 && (
          <div className="elabel" style={{ padding: '4px 22px' }}>
            {propQuery
              ? `Nothing matches “${propQuery}”.`
              : scope === 'problems'
                ? 'No problems found in this element’s properties.'
                : `Nothing is set on this element. ${panel.counts.total} documented properties are behind “all”.`}
          </div>
        )}

        {/* The expression editor, for whichever property asked for it. */}
        {tryFor && (() => {
          const row = rows.find((r) => r.name === tryFor);
          if (!row) return null;
          return (
            <div style={{ padding: '4px 22px' }}>
              <div className="elabel">{element.name}.{row.name} — try an expression</div>
              <textarea className="filter" style={{ width: '100%', minHeight: 60 }} value={expr}
                spellCheck={false}
                placeholder={`$not($exists($components.${element.name}.data.id))`}
                onChange={(e) => setExpr(e.target.value)} />
              <div>
                <button className="csslink" onClick={() => void evaluate(false)}>Evaluate</button>
                {host.evaluateRemote && (
                  <button className="csslink"
                    title="Evaluate on the platform's own transformation service — exact function library"
                    onClick={() => void evaluate(true)}>Evaluate on server</button>
                )}
                <button className="csslink" disabled={!evalOut?.ok || row.edit.tier !== 'runtime'}
                  title={row.edit.tier === 'runtime' ? 'Push this result onto the property' : row.edit.reason}
                  onClick={() => void applyEvaluated(row)}>Apply result</button>
              </div>
              {evalOut && (
                <pre className={evalOut.ok ? '' : 'tok-err'} style={{ maxHeight: 140, overflow: 'auto' }}>
                  {evalOut.remote ? '(server) ' : ''}{evalOut.text}
                </pre>
              )}
              {row.edit.tier !== 'runtime' && <div className="warn">{row.edit.reason}</div>}
            </div>
          );
        })()}
      </Section>

      {host.styles && (
        <div onClick={loadCss}>
          <Section title="CSS" count={css ? (css.found ? cssPairs.length : 'not in page') : '…'}>
            {!css && <div className="elabel" style={{ padding: '2px 22px' }}>Reading styles…</div>}
            {css && !css.found && (
              <div className="elabel" style={{ padding: '2px 22px' }}>
                This element could not be located in the page, so its styles cannot be read.
              </div>
            )}
            {css?.found && (
              <>
                <div style={{ padding: '2px 22px' }}>
                  <button className="csslink" onClick={(e) => { e.stopPropagation(); setAllCss((v) => !v); }}>
                    {allCss ? 'common only' : 'show all'}
                  </button>
                </div>
                {cssPairs.map(([prop, value]) => (
                  <div key={prop} className="structrow" style={{ paddingLeft: 22 }}>
                    <span className="ename" style={{ minWidth: 150 }}>{prop}</span>
                    <span style={{ flex: 1 }}>
                      {canMutate ? (
                        <input className="filter" style={{ width: '100%' }} defaultValue={css.inline?.[prop] ?? value}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => {
                            if (e.key !== 'Enter') return;
                            host.styles?.apply(target, { [prop]: (e.target as HTMLInputElement).value });
                          }} />
                      ) : <span>{value}</span>}
                    </span>
                    {css.inline?.[prop] && <span className="eprops" title="Set inline on the page">inline</span>}
                  </div>
                ))}
                {canMutate && (
                  <div className="elabel" style={{ padding: '2px 22px' }}>
                    Enter applies to the page only. Nothing is saved — copy a value into the
                    element's <code>style</code> prop in the designer to keep it.
                  </div>
                )}
              </>
            )}
          </Section>
        </div>
      )}
    </div>
  );
}
