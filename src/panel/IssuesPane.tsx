import { issueTrace, type Issue } from '../core/diagnose';
import type { NetworkEntry } from '../core/network';
import type { LogEntry } from '../core/types';

/**
 * What's probably wrong, ranked.
 *
 * Every issue shows its evidence inline — the write chain for a transform, the
 * exchange for a request — because "your screen has a loop" is only actionable
 * with the trace that proves it.
 */
export function IssuesPane({ issues, entries, network, onReveal, onHighlight }: {
  issues: Issue[];
  entries: LogEntry[];
  network: NetworkEntry[];
  /** Jump to the state path an issue implicates. */
  onReveal: (path: string) => void;
  /**
   * Outline the offending element in the page.
   *
   * "AssetIntakeForm.disabled ran 40 times" is a name; the outline is which thing
   * on the screen that name refers to. Hovering an issue paints it, selecting it
   * scrolls to it — the same affordance the element tree has, on the pane where you
   * are actually looking for the culprit.
   */
  onHighlight?: (target: { name?: string } | null, reveal?: boolean) => void;
}) {
  const counts = { high: 0, medium: 0, low: 0 };
  issues.forEach((i) => { counts[i.severity]++; });

  return (
    <div className="pane issues" style={{ flex: 1 }}>
      <div className="panehead">
        <span className="label">Issues</span>
        <span className="count">
          {issues.length === 0 ? 'none detected' : (
            <>
              {counts.high > 0 && <em className="sev high">{counts.high} high</em>}
              {counts.medium > 0 && <em className="sev medium">{counts.medium} medium</em>}
              {counts.low > 0 && <em className="sev low">{counts.low} low</em>}
            </>
          )}
        </span>
      </div>

      <div className="scroll" style={{ padding: '8px 0 24px' }} onMouseLeave={() => onHighlight?.(null)}>
        {issues.length === 0 && (
          <div className="empty">
            <h2>Nothing matched</h2>
            No built-in rule fired for this capture. That isn't proof the screen is healthy —
            it means none of the known failure shapes (loops, failed or duplicated requests,
            GraphQL errors inside a 200, slow transforms) were present.
          </div>
        )}

        {issues.map((issue) => {
          const trace = issueTrace(issue, entries);
          const requests = network.filter((r) => issue.requestIds.includes(r.id));
          return (
            <div key={issue.id} className={`issue sev-${issue.severity}`}
              onMouseEnter={() => onHighlight?.(issue.element ? { name: issue.element } : null)}
              onClick={() => { if (issue.element) onHighlight?.({ name: issue.element }, true); }}
              style={{ cursor: issue.element ? 'pointer' : undefined }}
              title={issue.element ? `Click to outline ${issue.element} in the page` : undefined}>
              <div className="ihead">
                <span className={`sevtag ${issue.severity}`}>{issue.severity}</span>
                <span className="ititle">{issue.title}</span>
                {issue.count > 1 && <span className="icount">×{issue.count}</span>}
                <span className="irule">{issue.rule}</span>
              </div>
              <div className="idetail">{issue.detail}</div>

              {/* The element and the expression, because the fix is made on one
                  specific transform and the log alone does not say which. */}
              {(issue.element || issue.expression) && (
                <div className="ielement">
                  {issue.element && <span className="ename">{issue.element}</span>}
                  {issue.expression && <code className="expr">{issue.expression}</code>}
                </div>
              )}

              {issue.path && (
                <button className="ipath" onClick={() => onReveal(issue.path!)} title="Reveal in state tree">
                  {issue.path}
                </button>
              )}

              {trace.length > 0 && (
                <div className="itrace">
                  {trace.slice(0, 8).map((id, i) => {
                    const e = entries.find((x) => x.id === id);
                    if (!e) return null;
                    return (
                      <div className="istep" key={id}>
                        <span className="n">{i + 1}</span>
                        <span className="body">
                          <span className="row1">
                            <span className={e.kind === 'error' ? 'err' : ''}>{e.title}</span>
                            <span className="meta">{e.ts}{e.dur ? ` · ${e.dur}` : ''}</span>
                          </span>
                          {e.write && <span className="delta">{e.write} = {e.after ?? '—'}</span>}
                          {e.expr && <span className="expr">{e.expr.replace(/\s+/g, ' ').slice(0, 160)}</span>}
                        </span>
                      </div>
                    );
                  })}
                  {trace.length > 8 && <div className="imore">…{trace.length - 8} more</div>}
                </div>
              )}

              {requests.length > 0 && (
                <div className="itrace">
                  {requests.slice(0, 6).map((r) => (
                    <div className="istep" key={r.id}>
                      <span className={`n ${r.failed ? 'bad' : ''}`}>{r.status || '!'}</span>
                      <span className="body">
                        <span className="row1">
                          <span>{r.method} {r.operation ?? r.path}</span>
                          <span className="meta">{r.ts} · {r.durationMs}ms</span>
                        </span>
                        {r.graphqlErrors?.map((g, i) => <span className="expr err" key={i}>{g}</span>)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
