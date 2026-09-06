import { useMemo, useState } from 'react';
import {
  filterMerged, flattenMerged, mergeScreen, stateSummary,
  type ElementStateNode,
} from '../core/elementState';
import { ElementDetail } from './ElementDetail';
import { BulkStylePane } from './BulkStylePane';
import type { StructureNode } from '../core/structure';
import type { EnvironmentInfo } from '../core/environment';
import type { LogEntry, StateNode } from '../core/types';
import type { Host } from './host';

/**
 * The screen as one tree: every element, holding its own live state.
 *
 * Structure and State were two answers to the same question, and neither worked
 * alone — one told you `AssetIntakeForm` sits inside `IntakeFormSlot`, the other
 * that something called `AssetIntakeForm` has `data.title`, and joining them was
 * left to memory. Here the element tree is the spine and state hangs off it.
 *
 * Three distinctions the merged view exists to keep visible, because they look
 * identical in a naive listing and mean completely different things:
 *
 *   no state      the element never rendered, or never ran its query
 *   empty         the runtime holds state for it, and there is nothing in it
 *   orphaned      state whose element is missing from the tree entirely
 */
function kindOf(type: string): string {
  if (/^(Container|Screen|Card|Tabs?|Grid|Stack|Layout)$/i.test(type)) return 'container';
  if (/^(Form|Table|DataGrid|List|Chart|Data)$/i.test(type)) return 'data';
  if (/Input$|^Switch$|^Select|^Upload|^FileUpload$/i.test(type)) return 'input';
  if (/Button$|^Action|^Buttons$/i.test(type)) return 'action';
  if (/^TableColumn$/i.test(type)) return 'column';
  if (/Webpage|Embedded|Iframe|Document/i.test(type)) return 'embed';
  return 'other';
}

export function ElementsPane({
  structure, stateTree, entries, context, host, environment, onHighlight, designerSelected, highlightMiss, structureNote, diag,
}: {
  structure: StructureNode[];
  stateTree: StateNode[];
  entries: LogEntry[];
  context: unknown;
  host: Host;
  environment: EnvironmentInfo;
  onHighlight: (target: { name?: string; type?: string; dataPath?: string; label?: string } | null, reveal?: boolean) => void;
  /** Which element the designer itself has selected, mirrored into this tree. */
  designerSelected?: string;
  highlightMiss?: string;
  structureNote?: string;
  diag?: {
    canvasFound: boolean; treeFound: boolean; treeRows: number; filtered: boolean;
    tabId?: string; designAttempted: boolean; designError?: string;
  };
}) {
  const [query, setQuery] = useState('');
  /**
   * The element whose detail the right pane shows.
   *
   * One selection, not a set of expanded rows. Inlining each element's properties, CSS,
   * transforms and state *into* the tree meant a single expansion pushed everything else
   * off screen, and comparing two elements was impossible — you could only ever see one
   * in context. A persistent side panel keeps the tree readable and the detail put.
   */
  const [selected, setSelected] = useState<string | undefined>();
  /** Width of the detail pane, dragged by the divider. */
  const [detailWidth, setDetailWidth] = useState(46);
  /** Which view the detail pane shows for a container — itself, or its contents by type. */
  const [detailTab, setDetailTab] = useState<'element' | 'bulk'>('element');

  const merged = useMemo(() => mergeScreen(structure, stateTree), [structure, stateTree]);
  const rows = useMemo(
    () => flattenMerged(filterMerged(merged.elements, query)),
    [merged, query]
  );

  const withState = merged.elements.length ? rows.filter((r) => r.node.hasState).length : 0;

  /*
   * The selected row survives a filter change and a poll.
   *
   * The tree is rebuilt from a fresh snapshot several times a second, so holding the node
   * object would lose the selection constantly; the craft node id is stable.
   */
  const chosen = selected ? rows.find((r) => r.node.element.nodeId === selected) : undefined;

  /** The selected element as a highlight target, re-paintable after a hover ends. */
  const pinned = chosen
    ? {
      name: chosen.node.element.name,
      type: chosen.node.element.type,
      dataPath: chosen.node.element.dataPath,
      label: chosen.node.element.label,
    }
    : undefined;

  /** Drag the divider. Pointer capture, so a fast drag does not lose the gesture. */
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const host = (e.currentTarget as HTMLElement).parentElement;
    if (!host) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const box = host.getBoundingClientRect();
      // Floors on both sides: neither pane is useful once it is a sliver.
      const pct = ((box.right - ev.clientX) / box.width) * 100;
      setDetailWidth(Math.max(24, Math.min(72, pct)));
    };
    const up = () => {
      (e.currentTarget as HTMLElement).removeEventListener('pointermove', move);
    };
    (e.currentTarget as HTMLElement).addEventListener('pointermove', move);
    (e.currentTarget as HTMLElement).addEventListener('pointerup', up, { once: true });
  };

  return (
    <div className="pane issues" style={{ flex: 1 }}>
      <div className="panehead">
        <span className="label">Screen</span>
        <input className="filter" value={query} placeholder="Filter elements or state keys"
          onChange={(e) => setQuery(e.target.value)} />
        <span className="count">
          {rows.length} element{rows.length === 1 ? '' : 's'}
          {withState ? ` · ${withState} with state` : ''}
        </span>
      </div>

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
          <span className="warn">
            Couldn't locate <code>{highlightMiss}</code> in the page — not every element type
            exposes a locatable attribute.
          </span>
        </div>
      )}

      <div className="elementsplit">
      {/*
        * Leaving the tree restores the *selected* element's outline rather than clearing.
        *
        * A click is a statement that this is the element you are working on, so its
        * outline should survive the pointer wandering off — otherwise the highlight is
        * gone exactly when you go to look at the thing it was pointing to.
        */}
      <div className="scroll elementtree" style={{ paddingBottom: 16 }}
        onMouseLeave={() => onHighlight(pinned ?? null)}>
        {/*
          * Screen-level context and orphaned state used to be listed here.
          *
          * Both were the *same StateNodes* the Split and State panes already render, so the
          * Screen tab was two thirds a second copy of the state tree with an element tree
          * wedged in the middle. This tab is now what its name says: the screen's elements,
          * as the designer lists them — with everything about the selected one in the pane
          * beside it. State lives in one place.
          */}
        {rows.length === 0 && (
          <div className="empty">
            <h2>No elements yet</h2>
            {diag ? (
              <>
                <div className="elabel">Designer canvas found: <b>{diag.canvasFound ? 'yes' : 'no'}</b></div>
                <div className="elabel">
                  Structure tree in the page:{' '}
                  <b>{diag.treeFound ? `yes — ${diag.treeRows} row${diag.treeRows === 1 ? '' : 's'}` : 'no'}</b>
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
                    Neither was found, so this is probably not a screen designer — or the extension
                    needs reloading in chrome://extensions to pick up the current build.
                  </div>
                )}
              </>
            ) : (
              <>Elements come from the screen's design, or from the designer's own structure tree.</>
            )}
          </div>
        )}

        {rows.map(({ node, depth }) => {
          const id = node.element.nodeId;
          const open = selected === id;
          const el = node.element;
          return (
            <div key={id}>
              <div
                className={`structrow ${el.named ? '' : 'anon'} ${open ? 'picked' : ''} ${designerSelected === el.name ? 'sel' : ''}`}
                title={designerSelected === el.name ? 'Selected in the designer' : undefined}
                style={{ paddingLeft: 8 + depth * 15 }}
                onMouseEnter={() => onHighlight({ name: el.name, type: el.type, dataPath: el.dataPath, label: el.label })}
                onClick={() => {
                  setSelected(id);
                  // Reveal as well as outline — this is what the designer's own
                  // tree does, and an outline off-screen is no feedback at all.
                  onHighlight({ name: el.name, type: el.type, dataPath: el.dataPath, label: el.label }, true);
                }}
              >
                <span className="caret" style={{ width: 12 }}>{open ? '▸' : ''}</span>
                <span className={`eicon k-${kindOf(el.type)}`} title={el.type} />
                <span className="ename">
                  {el.name}
                  {el.label && <span className="elabel"> ({el.label})</span>}
                </span>

                {/* The state summary sits on the element row itself — that join
                    is the whole reason these two views were merged. */}
                <span className={`estate ${node.hasState ? '' : 'none'}`}>{stateSummary(node)}</span>

                {el.props.length > 0 && (
                  <span className="eprops" title={`Dynamic props: ${el.props.join(', ')}`}>ƒ {el.props.length}</span>
                )}
                <span className="ecount"
                  title={el.unrendered ? 'Collapsed in the designer — expand it there to read these' : undefined}>
                  {node.children.length || (el.unrendered ? `+${el.unrendered}` : '')}
                </span>
              </div>

            </div>
          );
        })}

      </div>

      {/* Draggable, because how much room the detail needs depends entirely on the
          element — a container has three properties, a table has forty. */}
      <div className="splitgrip" onPointerDown={startResize} title="Drag to resize" />

      <div className="elementdetail" style={{ width: `${detailWidth}%` }}>
        {chosen ? (
          <>
            <div className="panehead">
              <span className="label">{chosen.node.element.name}</span>
              <span className="count">{chosen.node.element.type}</span>
              <button className="btn tiny" title="Close the detail pane"
                onClick={() => { setSelected(undefined); onHighlight(null); }}>✕</button>
            </div>
            {/*
              * A container gets a bulk-style tab.
              *
              * "All the action buttons are too tall" is a page-level edit, and doing it one
              * element at a time is where the mistakes come from — so it is offered on the thing
              * you would click to mean "this page", not buried per element.
              */}
            {kindOf(chosen.node.element.type) === 'container' && (
              <div className="detailtabs">
                <button className={`btn tiny ${detailTab === 'element' ? 'on' : ''}`}
                  onClick={() => setDetailTab('element')}>This element</button>
                <button className={`btn tiny ${detailTab === 'bulk' ? 'on' : ''}`}
                  onClick={() => setDetailTab('bulk')}>Bulk style by type</button>
              </div>
            )}
            <div className="scroll" style={{ paddingBottom: 16 }}>
              {detailTab === 'bulk' && kindOf(chosen.node.element.type) === 'container' ? (
                <BulkStylePane
                  structure={[chosen.node.element as unknown as StructureNode]}
                  host={host}
                  environment={environment}
                  onHighlight={(t) => onHighlight(t)}
                />
              ) : (
              <ElementDetail
                key={chosen.node.element.nodeId}
                element={chosen.node.element}
                state={chosen.node.state}
                entries={entries}
                context={context}
                host={host}
                environment={environment}
                indent={0}
              />
              )}
            </div>
          </>
        ) : (
          <div className="empty">
            <h2>Pick an element</h2>
            Its properties, transforms, live state and CSS appear here and stay put —
            hovering a row still outlines it in the page.
            {selected && (
              <div className="warn" style={{ marginTop: 8 }}>
                The element that was selected is no longer in the tree — a filter is hiding it,
                or the screen re-rendered without it.
              </div>
            )}
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
