import { useMemo, useState } from 'react';
import { cellText, tabulate, toTsv } from '../core/tabulate';
import { isMutation } from '../core/graphqlText';
import type { EnvironmentInfo } from '../core/environment';
import type { ServiceName } from '../core/services';
import type { Host } from './host';
import { ACCEPTED, parseWorkspaceFile, serializeWorkspace, suggestedName } from '../core/workspaceFile';
import { openText, saveText } from './fileIo';

/**
 * Query the Fuuz APIs from the extension, with the user's own session.
 *
 * The token is the signed-in user's, read from the page — so this can see exactly
 * what they can see and nothing more. Two views of the answer, because they serve
 * different questions: JSON when you are checking the *shape* a screen will bind to,
 * a table when you are reading the *data*.
 *
 * Writes are refused outside build and QA. A query is a read and is allowed
 * everywhere; a mutation changes a tenant's records, which is the line the whole
 * environment gate exists to draw.
 */
const SERVICES: { name: ServiceName; label: string; note: string }[] = [
  { name: 'application', label: 'application', note: 'screens, versions, designs, flows — verified' },
  { name: 'system', label: 'system', note: 'data models and records' },
  { name: 'transformation', label: 'transformation', note: 'saved transforms' },
];

export function GraphqlPane({ host, environment, seedQuery }: {
  host: Host;
  environment: EnvironmentInfo;
  /** A starter query handed over from the schema browser. */
  seedQuery?: string;
}) {
  // The system service, when arriving from a model: that is where models are served.
  const [service, setService] = useState<ServiceName>(seedQuery ? 'system' : 'application');
  const [query, setQuery] = useState(seedQuery ?? '');
  const [variablesText, setVariablesText] = useState('{}');
  const [view, setView] = useState<'json' | 'table'>('table');
  const [pick, setPick] = useState<string | undefined>();
  const [running, setRunning] = useState(false);
  const [reply, setReply] = useState<{ ok: boolean; data?: unknown; errors?: unknown[]; status?: number; error?: string } | undefined>();
  const [copied, setCopied] = useState(false);
  const [file, setFile] = useState<{ name?: string; handle?: unknown }>({});
  const [fileNote, setFileNote] = useState('');

  /*
   * A newly-handed-over query replaces the box, but editing is never clobbered:
   * the seed only applies while it differs from the last one applied, so the poll
   * re-rendering this pane cannot undo what you have typed.
   */
  const [appliedSeed, setAppliedSeed] = useState(seedQuery);
  if (seedQuery && seedQuery !== appliedSeed) {
    setAppliedSeed(seedQuery);
    setQuery(seedQuery);
    setService('system');
  }

  const writes = isMutation(query);
  const canWrite = environment.tier === 'permitted';
  const refused = writes && !canWrite;

  const run = async () => {
    if (!query.trim()) return;
    let variables: Record<string, unknown> = {};
    if (variablesText.trim()) {
      try {
        const parsed = JSON.parse(variablesText);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          setReply({ ok: false, error: 'Variables must be a JSON object.' });
          return;
        }
        variables = parsed as Record<string, unknown>;
      } catch (e) {
        setReply({ ok: false, error: `Variables are not valid JSON — ${e instanceof Error ? e.message : String(e)}` });
        return;
      }
    }
    /*
     * The gate is enforced here *and* by the environment classifier the rest of the
     * extension shares. A mutation typed into this box is a write to a live tenant,
     * so it is refused before the request is built rather than after.
     */
    if (refused) {
      setReply({
        ok: false,
        error: `This is a ${environment.tier} environment (${environment.host}). Mutations are only allowed in build and QA — the query itself is untouched, so you can move to a build tenant and run it there.`,
      });
      return;
    }
    setRunning(true);
    setPick(undefined);
    try {
      setReply(await host.query?.run(query, variables, service));
    } finally {
      setRunning(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void run(); }
  };

  /* ── Open and save ─────────────────────────────────────────────────────── */

  const workspace = () => ({ kind: 'graphql' as const, service, query, variables: variablesText });

  const save = async (saveAs = false) => {
    const w = workspace();
    const outcome = await saveText(
      serializeWorkspace(w), file.name ?? suggestedName(w), ACCEPTED.graphql,
      saveAs ? undefined : file.handle
    );
    if (!outcome.ok) { setFileNote(outcome.error ?? 'Could not save.'); return; }
    setFile({ name: outcome.name, handle: outcome.handle });
    setFileNote(outcome.how === 'download' ? `downloaded ${outcome.name}` : `saved ${outcome.name}`);
  };

  const open = async () => {
    const outcome = await openText(ACCEPTED.graphql);
    if (!outcome.ok) { setFileNote(outcome.error ?? 'Could not open.'); return; }
    const parsed = parseWorkspaceFile(outcome.text ?? '', 'graphql');
    if (parsed.kind === 'error') { setFileNote(parsed.error); return; }
    if (parsed.kind === 'workspace' && parsed.workspace.kind === 'graphql') {
      const w = parsed.workspace;
      setQuery(w.query);
      setVariablesText(w.variables);
      if (SERVICES.some((s) => s.name === w.service)) setService(w.service as ServiceName);
    } else if (parsed.kind === 'text') {
      // A plain `.graphql` file: the query, with the variables left as they are.
      setQuery(parsed.text);
    }
    setFile({ name: outcome.name, handle: outcome.handle });
    setFileNote(`opened ${outcome.name}`);
    setReply(undefined);
  };

  // The whole body, so `data` and `errors` are both visible — a Fuuz 200 routinely
  // carries errors alongside partial data, and showing only one half hides the bug.
  const body = useMemo(() => (reply
    ? { ...(reply.data !== undefined ? { data: reply.data } : {}), ...(reply.errors ? { errors: reply.errors } : {}) }
    : undefined), [reply]);

  const table = useMemo(() => (reply?.data !== undefined ? tabulate(reply.data, pick) : undefined), [reply, pick]);

  const copyTsv = () => {
    if (!table) return;
    void navigator.clipboard.writeText(toTsv(table)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="pane graphql" style={{ flex: 1 }}>
      <div className="panehead">
        <span className="label">GraphQL</span>
        <span className="seg">
          {SERVICES.map((s) => (
            <button key={s.name} className={`btn ${service === s.name ? 'on' : ''}`} title={s.note}
              onClick={() => setService(s.name)}>{s.label}</button>
          ))}
        </span>
        <button className="btn primary" onClick={() => void run()} disabled={running || refused}>
          {running ? 'Running…' : 'Run  ⌘⏎'}
        </button>
        <span className="seg">
          <button className="btn tiny" onClick={() => void open()}>Open</button>
          <button className="btn tiny" onClick={() => void save()}
            title="Saves the query with its variables">Save</button>
          {!!file.handle && <button className="btn tiny" onClick={() => void save(true)}>Save as</button>}
        </span>
        <span className="count">{fileNote || environment.host}</span>
      </div>

      {/* Said before the request, not after it fails: the refusal is the design, and
          a disabled button with no reason is indistinguishable from a broken one. */}
      {refused && (
        <div className="legend design">
          <span className="warn">
            That is a mutation, and this is a <b>{environment.tier}</b> environment. Reads run
            anywhere; writes only in build and QA.
          </span>
        </div>
      )}

      <div className="scriptgrid">
        <div className="scriptio">
          <div className="iohead">
            <span className="label">Variables</span>
            <span className="hint">JSON object</span>
          </div>
          <textarea className="code" value={variablesText} spellCheck={false}
            onChange={(e) => setVariablesText(e.target.value)} onKeyDown={onKeyDown} />

          <div className="iohead"><span className="label">Query</span></div>
          <textarea className="code editor" value={query} spellCheck={false}
            placeholder={'query($first: Int) {\n  # …\n}'}
            onChange={(e) => setQuery(e.target.value)} onKeyDown={onKeyDown} />
        </div>

        <div className="scriptmain">
          <div className="iohead">
            <span className="label">Result</span>
            <span className="seg">
              <button className={`btn tiny ${view === 'table' ? 'on' : ''}`} onClick={() => setView('table')}>Table</button>
              <button className={`btn tiny ${view === 'json' ? 'on' : ''}`} onClick={() => setView('json')}>JSON</button>
            </span>
            {reply?.status !== undefined && <span className="hint">HTTP {reply.status}</span>}
            {table && view === 'table' && (
              <>
                <span className="hint">{table.rows.length} row{table.rows.length === 1 ? '' : 's'} · {table.path}</span>
                <button className="btn tiny" onClick={copyTsv}>{copied ? 'copied' : 'copy TSV'}</button>
              </>
            )}
          </div>

          <div className="output">
            {!reply && <div className="elabel">Run a query to see its result.</div>}
            {reply?.error && <pre className="err">{reply.error}</pre>}

            {/* Errors inside a 200 are the Fuuz norm, so they are shown as errors
                rather than left for the developer to notice in the JSON. */}
            {reply?.errors?.length ? (
              <div className="logs">
                {reply.errors.map((e, i) => (
                  <div className="logline err" key={i}>
                    {typeof e === 'string' ? e : (e as { message?: string })?.message ?? JSON.stringify(e)}
                  </div>
                ))}
              </div>
            ) : null}

            {body !== undefined && view === 'json' && <pre>{JSON.stringify(body, null, 2)}</pre>}

            {view === 'table' && reply?.data !== undefined && (
              table ? (
                <>
                  {/* More than one array in the response means the choice was a guess;
                      offering the others is more honest than picking silently. */}
                  {table.alternatives.length > 1 && (
                    <div className="iohead">
                      <span className="hint">rows from</span>
                      <select className="code tiny" value={table.path} onChange={(e) => setPick(e.target.value)}>
                        {table.alternatives.map((a) => (
                          <option key={a.path} value={a.path}>{`${a.path} (${a.count})`}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div className="tablewrap">
                    <table className="grid">
                      <thead>
                        <tr>
                          <th className="rownum" />
                          {table.columns.map((c) => <th key={c}>{c}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {table.rows.map((row, i) => (
                          <tr key={i}>
                            <td className="rownum">{i + 1}</td>
                            {row.map((cell, j) => (
                              // An absent key and a null are different answers, and the
                              // difference is usually the thing being diagnosed.
                              <td key={j} className={cell === undefined ? 'absent' : cell === null ? 'nul' : ''}
                                title={cellText(cell)}>
                                {cell === undefined ? '—' : cellText(cell)}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : (
                <div className="elabel">
                  Nothing tabular in this response — it returned no array of records. The JSON
                  view has the whole answer.
                </div>
              )
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
