import { useMemo, useState } from 'react';
import { formatSize, type NetworkEntry } from '../core/network';

/**
 * The requests behind the screen.
 *
 * Deliberately not a clone of the browser's Network tab — it adds the two
 * things that matter here: the GraphQL operation name (so `/application`
 * doesn't appear 40 times identically) and a warning on 200 responses that
 * carry a GraphQL `errors[]`, which the browser reports as success.
 */
export function NetworkPane({ network }: { network: NetworkEntry[] }) {
  const [query, setQuery] = useState('');
  const [failuresOnly, setFailuresOnly] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return network.filter((r) => {
      if (failuresOnly && !r.failed && !r.graphqlErrors?.length) return false;
      if (!q) return true;
      return `${r.method} ${r.path} ${r.operation ?? ''} ${r.status}`.toLowerCase().includes(q);
    });
  }, [network, query, failuresOnly]);

  const bad = network.filter((r) => r.failed || r.graphqlErrors?.length).length;
  const slowest = network.reduce((m, r) => Math.max(m, r.durationMs), 0);

  return (
    <div className="pane network" style={{ flex: 1 }}>
      <div className="panehead">
        <span className="label">Network</span>
        <input className="filter" value={query} placeholder="Filter by path, operation or status"
          onChange={(e) => setQuery(e.target.value)} />
        <button className={`btn ${failuresOnly ? 'on' : ''}`} onClick={() => setFailuresOnly((v) => !v)}>
          Problems only
        </button>
        <span className="count">
          {visible.length} of {network.length}{bad > 0 ? ` · ${bad} failing` : ''}
        </span>
      </div>

      <div className="legend">
        <span>{network.length} requests</span>
        {slowest > 0 && <span>slowest {slowest}ms</span>}
        <span><code>200 ⚠</code>GraphQL error inside a success</span>
      </div>

      <div className="scroll">
        {visible.length === 0 && (
          <div className="empty">
            {network.length === 0
              ? 'No requests captured yet. Network capture starts when the panel opens — reload the screen to see its initial calls.'
              : 'No requests match this filter.'}
          </div>
        )}

        {visible.map((r) => {
          const warn = !!r.graphqlErrors?.length;
          return (
            <div key={r.id}>
              <div
                className={`netrow ${r.failed ? 'failed' : ''} ${warn ? 'warn' : ''} ${selected === r.id ? 'sel' : ''}`}
                onClick={() => setSelected(selected === r.id ? null : r.id)}
              >
                <span className="ts">{r.ts}</span>
                <span className={`status ${r.failed ? 'bad' : warn ? 'warn' : 'ok'}`}>
                  {r.status || 'ERR'}{warn ? ' ⚠' : ''}
                </span>
                <span className="method">{r.method}</span>
                <span className="path">{r.operation ? <b>{r.operation}</b> : r.path}</span>
                <span className="dur">{r.durationMs}ms</span>
                <span className="size">{formatSize(r.sizeBytes)}</span>
              </div>
              {selected === r.id && (
                <div className="netdetail">
                  <div className="ln"><span className="tok-key">url</span>: {r.url}</div>
                  {r.mimeType && <div className="ln"><span className="tok-key">type</span>: {r.mimeType}</div>}
                  {r.graphqlErrors?.map((g, i) => (
                    <div className="ln tok-err" key={i}>graphql: {g}</div>
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
