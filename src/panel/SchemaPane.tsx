import { useMemo, useState } from 'react';
import { filterModel, starterQuery, type ModelField, type ModelShape } from '../core/modelTree';
import { API_ACCESS, API_DISABLED_REASON } from '../core/apiAccess';

/**
 * The models you have clicked on the schema canvas, as browsable trees.
 *
 * The canvas draws boxes and lines; it does not show you a model's whole shape at
 * once, and it shows the schema *as drawn* rather than as deployed. These come from
 * the API's own introspection, so a field that failed to deploy is visibly absent
 * here while still being drawn on the canvas — which is the only way to see that
 * particular bug.
 *
 * Clicking a second model **adds** it rather than replacing it: comparing two models
 * is most of why anyone opens this, and a browser that forgets the last thing you
 * looked at is not a browser.
 */
export function SchemaPane({ models, shapes, selection, onSeedQuery, onHighlight }: {
  /** Model names the developer has clicked, newest first. */
  models: string[];
  /** Introspected shape per name; absent means still loading or not deployed. */
  shapes: Record<string, ModelShape | undefined>;
  /** How canvas selection was detected, so a failure to detect is diagnosable. */
  selection?: { ids: string[]; names: string[]; via?: string };
  /** Hand a starter query to the GraphQL tab. */
  onSeedQuery?: (query: string) => void;
  /** Outline the model's node on the canvas. */
  onHighlight?: (target: { name?: string } | null) => void;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});

  /*
   * Filtering keeps a model whose *name* matches whole.
   *
   * Searching "Order" and seeing the Order model with every field hidden — because no
   * field is called "order" — reads as an empty model, which is a different and much
   * more alarming answer than "no fields matched".
   */
  const visible = useMemo(() => models
    .map((name) => ({ name, shape: shapes[name] }))
    .map(({ name, shape }) => ({
      name,
      shape: shape ? filterModel(shape, query) : undefined,
      loading: !shape,
      // A model still in the browser but filtered out entirely is dropped from the
      // list rather than shown as empty.
      hidden: !!shape && !filterModel(shape, query),
    }))
    .filter((m) => !m.hidden), [models, shapes, query]);

  const totalFields = visible.reduce((n, m) => n + (m.shape?.fields.length ?? 0), 0);

  return (
    <div className="pane issues" style={{ flex: 1 }}>
      <div className="panehead">
        <span className="label">Models</span>
        <input className="filter" value={query} placeholder="Filter models, fields or types"
          onChange={(e) => setQuery(e.target.value)} />
        <span className="count">
          {models.length
            ? `${visible.length} model${visible.length === 1 ? '' : 's'}${totalFields ? ` · ${totalFields} fields` : ''}`
            : 'none open'}
        </span>
      </div>

      {models.length === 0 && (
        <div className="empty">
          <h2>Click a model on the canvas</h2>
          Each model you click opens here and stays open, so you can scroll between them
          and compare. Fields come from the API&rsquo;s introspection — the schema as
          <b> deployed</b>, not as drawn, so a field missing here that is on the canvas
          never made it out of the designer.
          {selection && !selection.via && (
            <div className="warn" style={{ marginTop: 8 }}>
              The canvas has {selection.ids.length} node{selection.ids.length === 1 ? '' : 's'} but none
              look selected — this build recognises <code>aria-selected</code>,
              <code> data-selected</code> and a <code>selected</code> class. If Fuuz marks it
              another way, selection detection needs that marker adding.
            </div>
          )}
        </div>
      )}

      <div className="scroll" style={{ paddingBottom: 16 }} onMouseLeave={() => onHighlight?.(null)}>
        {visible.map(({ name, shape, loading }) => {
          const isOpen = open[name] ?? true;
          return (
            <div key={name} className="modelcard">
              <div className="structrow group" onMouseEnter={() => onHighlight?.({ name })}
                onClick={() => setOpen((p) => ({ ...p, [name]: !isOpen }))} style={{ cursor: 'pointer' }}>
                <span className="caret" style={{ width: 12 }}>{isOpen ? '▾' : '▸'}</span>
                <span className="ename">{name}</span>
                {shape && (
                  <span className="estate">
                    {shape.summary.fields} fields · {shape.summary.relations} relations · {shape.summary.required} required
                  </span>
                )}
                {loading && <span className="estate none">loading…</span>}
                {shape && onSeedQuery && API_ACCESS && (
                  <button className="btn tiny" title="Open a starter query for this model in the GraphQL tab"
                    onClick={(ev) => { ev.stopPropagation(); onSeedQuery(starterQuery(shape)); }}>
                    query
                  </button>
                )}
              </div>

              {/* A name with no shape is not an empty model — it is either in flight or
                  not deployed here, and those are worth distinguishing. */}
              {isOpen && !shape && !loading && (
                <div className="elabel" style={{ padding: '4px 22px' }}>
                  <span className="warn">
                    {/* Two very different reasons for an empty field list, and saying
                        "not deployed" when we simply cannot ask would be a false claim. */}
                    {API_ACCESS
                      ? 'Not in this environment’s schema. It is drawn on the canvas but the API does not serve it — most often a model that has not been deployed.'
                      : `Fields come from schema introspection. ${API_DISABLED_REASON}`}
                  </span>
                </div>
              )}

              {isOpen && shape?.description && (
                <div className="elabel" style={{ padding: '2px 22px' }}>{shape.description}</div>
              )}

              {isOpen && shape?.fields.map((f) => <FieldRow key={f.name} field={f} model={name} />)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * One field: what it is called, what it holds, and what that means.
 *
 * `required`, `list` and `relation` are shown as marks rather than left in the type
 * string, because those three are what you scan a model for — and `[Order!]!` is
 * precise but not scannable.
 */
function FieldRow({ field, model }: { field: ModelField; model: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(`${model}.${field.name}`).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <div className="structrow" style={{ paddingLeft: 26 }} title={field.description}>
      <span style={{ width: 14, opacity: 0.75 }} title={field.relation ? 'Relation to another model' : 'Scalar'}>
        {field.relation ? '⇢' : '·'}
      </span>
      <span className="ename" style={{ minWidth: 150 }}>{field.name}</span>
      <span className="elabel" style={{ flex: 1, minWidth: 0 }}>
        {field.type}
        {field.required && <em className="etype" title="Non-null — the API rejects a write without it">required</em>}
        {field.list && <em className="etype" title="A list, so expect an array">list</em>}
      </span>
      {field.description && <span className="estate">{field.description}</span>}
      <span className="copybits">
        <button className={`copybit ${copied ? 'ok' : ''}`} title={`Copy ${model}.${field.name}`} onClick={copy}>
          {copied ? '✓' : '$'}
        </button>
      </span>
    </div>
  );
}
