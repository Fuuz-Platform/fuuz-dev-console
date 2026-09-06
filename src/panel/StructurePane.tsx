import { useMemo, useState } from 'react';
import { flattenStructure, type StructureNode } from '../core/structure';
import { transformsFor } from '../core/transformInputs';
import type { LogEntry } from '../core/types';

/**
 * The screen as authored, not as rendered.
 *
 * Hovering a row highlights the element in the page — the affordance Chrome's
 * Elements tab has, but keyed on Fuuz element names. Selecting one shows the
 * transforms behind its dynamic props, each with the values it actually read.
 */
/**
 * Icon family per element type, mirroring how the designer groups them —
 * containers, data-bound elements, inputs, actions and columns each read
 * differently at a glance.
 */
function kindOf(type: string): string {
  if (/^(Container|Screen|Card|Tabs?|Grid|Stack)$/i.test(type)) return 'container';
  if (/^(Form|Table|DataGrid|List|Chart)$/i.test(type)) return 'data';
  if (/Input$|^Switch$|^Select|^Upload|^FileUpload$/i.test(type)) return 'input';
  if (/Button$|^Action/i.test(type)) return 'action';
  if (/^TableColumn$/i.test(type)) return 'column';
  if (/Webpage|Embedded|Iframe|Document/i.test(type)) return 'embed';
  return 'other';
}

export function StructurePane({ structure, entries, onHighlight, highlightMiss, onEditCss, onInspect, structureNote, diag }: {
  structure: StructureNode[];
  entries: LogEntry[];
  onHighlight: (target: { name?: string; type?: string; dataPath?: string; label?: string } | null) => void;
  /** Set when the last highlight couldn't find a DOM node. */
  highlightMiss?: string;
  /** Open the CSS scratchpad for one element. */
  onEditCss?: (node: StructureNode) => void;
  /** Open the property inspector for one element. */
  onInspect?: (node: StructureNode) => void;
  /** How complete a designer-scraped tree is, when that is where this came from. */
  structureNote?: string;
  /** What the panel looked for and found, for the empty state. */
  diag?: {
    canvasFound: boolean; treeFound: boolean; treeRows: number; filtered: boolean;
    tabId?: string; designAttempted: boolean; designError?: string;
  };
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<StructureNode | null>(null);

  const rows = useMemo(() => {
    const all = flattenStructure(structure);
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter(({ node }) =>
      `${node.name} ${node.type} ${node.dataPath ?? ''} ${node.label ?? ''}`.toLowerCase().includes(q));
  }, [structure, query]);

  // Every transform that wrote this element's props, with resolved inputs.
  const details = useMemo(() => {
    if (!selected) return [];
    return selected.props.flatMap((prop) => transformsFor(entries, `components.${selected.name}.${prop}`));
  }, [selected, entries]);

  return (
    <div className="pane issues" style={{ flex: 1 }}>
      <div className="panehead">
        <span className="label">Structure</span>
        <input className="filter" value={query} placeholder="Filter elements"
          onChange={(e) => setQuery(e.target.value)} />
        <span className="count">{rows.length} element{rows.length === 1 ? '' : 's'}</span>
      </div>

      {/* Scraped from the designer's tree: usable, but not the design. Saying so
          is the difference between "this element has no transforms" and "we have
          not read its transforms" — which look identical and mean opposite things. */}
      {structure.some((n) => n.origin === 'designer-dom') && (
        <div className="legend design">
          <span className="warn">
            From the designer's structure tree{structureNote ? ` — ${structureNote}` : ''}. Element
            types and transforms load once the screen's design is fetched.
          </span>
        </div>
      )}

      {highlightMiss && (
        <div className="legend design">
          <span className="warn">Couldn't locate <code>{highlightMiss}</code> in the page — not every element type exposes a locatable attribute.</span>
        </div>
      )}

      <div className="scroll" style={{ paddingBottom: 16 }} onMouseLeave={() => onHighlight(null)}>
        {structure.length === 0 && (
          <div className="empty">
            <h2>Nothing to show yet</h2>
            {diag ? (
              <>
                {/* Each line is a fact the panel established, so "not working"
                    becomes a specific thing to fix rather than a guess. */}
                <div className="elabel">Designer canvas found: <b>{diag.canvasFound ? 'yes' : 'no'}</b></div>
                <div className="elabel">
                  Structure tree in the page: <b>{diag.treeFound ? `yes — ${diag.treeRows} row${diag.treeRows === 1 ? '' : 's'}` : 'no'}</b>
                </div>
                {diag.filtered && (
                  <div className="warn">
                    The designer's own filters are hiding every element. Clear them in the
                    Screen Structure panel and this fills in.
                  </div>
                )}
                <div className="elabel">Open designer tab id: <b>{diag.tabId ?? 'none'}</b></div>
                <div className="elabel">Design fetch attempted: <b>{diag.designAttempted ? 'yes' : 'no'}</b></div>
                {diag.designError && <div className="warn">{diag.designError}</div>}
                {!diag.treeFound && !diag.canvasFound && (
                  <div className="warn">
                    Neither was found, so this page is probably not a screen designer — or the
                    extension needs reloading in chrome://extensions to pick up the current build.
                  </div>
                )}
              </>
            ) : (
              <>
                The element tree comes from the screen's design, or from the designer's own
                structure tree. Neither has reported yet — if you are on a running screen,
                interact with it so a transform fires.
              </>
            )}
          </div>
        )}

        {rows.map(({ node, depth }) => (
          <div
            key={node.nodeId}
            className={`structrow ${selected?.nodeId === node.nodeId ? 'sel' : ''} ${node.named ? '' : 'anon'}`}
            style={{ paddingLeft: 8 + depth * 15 }}
            onMouseEnter={() => onHighlight({ name: node.name, type: node.type, dataPath: node.dataPath, label: node.label })}
            onClick={() => setSelected(selected?.nodeId === node.nodeId ? null : node)}
          >
            <span className={`eicon k-${kindOf(node.type)}`} title={node.type} />
            <span className="ename">
              {node.name}
              {node.label && <span className="elabel"> ({node.label})</span>}
            </span>
            {node.props.length > 0 && <span className="eprops" title={`Dynamic props: ${node.props.join(', ')}`}>ƒ {node.props.length}</span>}
            {onInspect && (
              <button className="csslink" title="Every property of this element, with live values"
                onClick={(ev) => { ev.stopPropagation(); onInspect(node); }}>Props</button>
            )}
            {onEditCss && (
              <button className="csslink" title="Open the CSS scratchpad for this element"
                onClick={(ev) => { ev.stopPropagation(); onEditCss(node); }}>CSS</button>
            )}
            {/* A collapsed designer row hides its children entirely; show the count
                it claims so an empty row never reads as a leaf. */}
            <span className="ecount" title={node.unrendered ? 'Collapsed in the designer — expand it there to read these' : undefined}>
              {node.children.length || (node.unrendered ? `+${node.unrendered}` : '')}
            </span>
          </div>
        ))}
      </div>

      {selected && (
        <div className="trace" style={{ maxHeight: '52%' }}>
          <div className="head">
            <span className="label">Transforms</span>
            <span className="path">{selected.name} · {selected.type}</span>
          </div>
          <div style={{ padding: '4px 12px 14px' }}>
            {details.length === 0 ? (
              <div className="idetail" style={{ padding: '8px 0' }}>
                {selected.props.length === 0
                  ? 'This element has no dynamic props — nothing computes for it.'
                  : `Declares ƒ ${selected.props.join(', ')}, but none evaluated in this capture. Reload to see it run from cold.`}
              </div>
            ) : details.map((d, i) => (
              <div className="tdetail" key={`${d.entryId}-${i}`}>
                <div className="trow">
                  <span className="tprop">{d.property}</span>
                  <span className="tresult">= {d.result ?? '—'}</span>
                  {d.durationMs !== undefined && <span className="meta">{Math.round(d.durationMs)}ms</span>}
                  {d.remote && <em className="etype remote">remote</em>}
                </div>
                {d.expression && <pre className="texpr">{d.expression}</pre>}
                <div className="tinputs">
                  {d.inputs.length === 0
                    ? <div className="tinput"><span className="tpath">(reads nothing — constant)</span></div>
                    : d.inputs.map((input) => (
                        <div className={`tinput ${input.resolved ? '' : 'missing'}`} key={input.path}>
                          <span className="tpath">{input.path}</span>
                          <span className="tval">{input.value}</span>
                        </div>
                      ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
