import { useMemo, useState } from 'react';
import { buildEdit, editSize, groupByType, pageRoots, type StyleField } from '../core/bulkStyle';
import type { StructureNode } from '../core/structure';
import type { EnvironmentInfo } from '../core/environment';
import type { Host } from './host';

/**
 * Restyle every element of one kind at once.
 *
 * Setting the corner radius on seven action buttons means opening seven property panels and
 * making the same edit seven times. Here the elements are grouped by type, each group offers the
 * properties that make sense for its kind, and one Apply reaches all of them.
 *
 * **This previews; it does not save.** The edit goes to the DOM, so the next render discards it —
 * reaching the saved screen definition needs the application service, which is off in this build.
 * That is stated in the pane rather than left to be discovered when a reload loses the work,
 * because a bulk edit is exactly where that would sting.
 */
export function BulkStylePane({ structure, host, environment, onHighlight }: {
  structure: StructureNode[];
  host: Host;
  environment: EnvironmentInfo;
  onHighlight?: (target: { name?: string; type?: string } | null) => void;
}) {
  const roots = useMemo(() => pageRoots(structure), [structure]);
  const [rootName, setRootName] = useState<string>('');
  const [openGroup, setOpenGroup] = useState<string | undefined>();
  const [values, setValues] = useState<Record<string, Record<string, string>>>({});
  const [applied, setApplied] = useState<string>('');

  const root = roots.find((r) => r.name === rootName);
  const groups = useMemo(() => groupByType(root, structure), [root, structure]);
  const canApply = environment.tier === 'permitted';

  const setValue = (type: string, css: string, value: string) =>
    setValues((prev) => ({ ...prev, [type]: { ...(prev[type] ?? {}), [css]: value } }));

  const apply = (type: string, fields: StyleField[], elements: { name: string; type: string }[]) => {
    const edit = buildEdit(fields, values[type] ?? {});
    const count = editSize(edit);
    if (!count) { setApplied('Nothing to apply — fill in at least one property.'); return; }

    for (const element of elements) {
      if (Object.keys(edit.own).length) host.styles?.apply(element, edit.own);
      /*
       * Descendant edits go through the same call with a selector-qualified property.
       *
       * Icon size is set on the icon, not the button: `font-size` on a button changes its label.
       * Encoding the selector in the property name keeps one transport for both rather than a
       * second message type for one field.
       */
      for (const d of edit.descendant) {
        host.styles?.apply(element, Object.fromEntries(
          Object.entries(d.css).map(([prop, v]) => [`${d.selector}:${prop}`, v])
        ));
      }
    }
    setApplied(
      `Previewed ${count} propert${count === 1 ? 'y' : 'ies'} on ${elements.length} ${type}`
      + `${elements.length === 1 ? '' : 's'} — the next render discards it.`
    );
  };

  return (
    <div className="bulkstyle">
      <div className="iohead">
        <span className="label">Bulk style</span>
        <select className="code tiny" value={rootName} onChange={(e) => { setRootName(e.target.value); setOpenGroup(undefined); }}>
          <option value="">Whole screen</option>
          {roots.map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}
        </select>
        <span className="hint">{groups.length} element type{groups.length === 1 ? '' : 's'}</span>
      </div>

      {/* Said up front, because a bulk edit is exactly where losing the work would sting. */}
      <div className="legend design">
        <span className="warn">
          Previews on the page only — the next render discards it. Writing to the screen
          definition needs the application service, which is off in this build.
        </span>
      </div>

      {groups.length === 0 && (
        <div className="elabel" style={{ padding: '6px 10px' }}>
          No typed elements under this root. Element types come from the designer canvas or the
          screen&rsquo;s design.
        </div>
      )}

      {groups.map((group) => {
        const open = openGroup === group.type;
        const pending = editSize(buildEdit(group.fields, values[group.type] ?? {}));
        return (
          <div key={group.type} className="bulkgroup">
            <div className="structrow group" style={{ cursor: 'pointer', paddingLeft: 8 }}
              onMouseEnter={() => onHighlight?.({ type: group.type })}
              onClick={() => setOpenGroup(open ? undefined : group.type)}>
              <span className="caret" style={{ width: 12 }}>{open ? '▾' : '▸'}</span>
              <span className="ename">{group.type}</span>
              <span className="estate">×{group.elements.length}</span>
              {pending > 0 && <span className="chip on">{pending} to apply</span>}
            </div>

            {open && (
              <>
                {/* Which elements this would touch — a count alone leaves you guessing whether
                    it caught the ones you meant. */}
                <div className="elabel bulkmembers">
                  {group.elements.slice(0, 12).map((el) => (
                    <span key={el.name} className="bulkmember"
                      onMouseEnter={() => onHighlight?.({ name: el.name, type: el.type })}>{el.name}</span>
                  ))}
                  {group.elements.length > 12 && <span>+{group.elements.length - 12} more</span>}
                </div>

                <div className="bulkfields">
                  {group.fields.map((field) => (
                    <label key={field.css} className="bulkfield">
                      <span className="bulklabel" title={field.css}>{field.label}</span>
                      {field.kind === 'choice' ? (
                        <select className="code tiny" value={values[group.type]?.[field.css] ?? ''}
                          onChange={(e) => setValue(group.type, field.css, e.target.value)}>
                          <option value="">—</option>
                          {field.options?.map((o) => <option key={o} value={o}>{o}</option>)}
                        </select>
                      ) : field.kind === 'colour' ? (
                        <span className="bulkcolour">
                          <input type="color" value={values[group.type]?.[field.css] || '#4E25E2'}
                            onChange={(e) => setValue(group.type, field.css, e.target.value)} />
                          {/* The text box stays: a design system uses tokens and named colours,
                              and a picker can only produce hex. */}
                          <input className="code tiny" placeholder="or a token"
                            value={values[group.type]?.[field.css] ?? ''}
                            onChange={(e) => setValue(group.type, field.css, e.target.value)} />
                        </span>
                      ) : (
                        <input className="code tiny" placeholder={field.placeholder ?? ''}
                          value={values[group.type]?.[field.css] ?? ''}
                          onChange={(e) => setValue(group.type, field.css, e.target.value)} />
                      )}
                    </label>
                  ))}
                </div>

                <div className="bulkactions">
                  <button className="btn primary" disabled={!canApply || pending === 0}
                    title={canApply
                      ? `Preview on all ${group.elements.length} ${group.type} elements`
                      : `Blocked: ${environment.host} is not a build or QA environment`}
                    onClick={() => apply(group.type, group.fields, group.elements)}>
                    Preview on {group.elements.length} {group.type}
                  </button>
                  <button className="btn tiny" disabled={pending === 0}
                    onClick={() => setValues((p) => ({ ...p, [group.type]: {} }))}>Clear</button>
                  {/* Empty fields are never applied — an empty string clears a CSS property, so
                      sending every untouched field would wipe the element's own styling. */}
                  <span className="hint">only the fields you fill in are applied</span>
                </div>
              </>
            )}
          </div>
        );
      })}

      {applied && <div className="elabel" style={{ padding: '4px 10px' }}>{applied}</div>}
    </div>
  );
}
