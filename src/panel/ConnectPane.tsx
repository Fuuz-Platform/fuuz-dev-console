import { useEffect, useState } from 'react';
import type { Host } from './host';

/**
 * Fallback for before the server has ever been reached.
 *
 * It resolves its own path via `$(pwd)` rather than asking you to substitute a
 * placeholder — you only have to be in the right directory, which the first
 * line handles.
 */
const SELF_RESOLVING_COMMAND = [
  '# from your fuuz checkout:',
  'cd platform/dev-console',
  'claude mcp add fuuz-ui --scope user -- node "$(pwd)/src/mcp/server.cjs"',
].join('\n');

/**
 * Getting this screen's diagnostics to Claude.
 *
 * There are two genuinely different situations, and pretending otherwise is how
 * you strand people: a **local** Claude (Code or Desktop) can run an MCP server
 * on this machine and read captures live; **claude.ai and Cowork run in the
 * cloud** and cannot reach localhost at all, so for them the answer is a report
 * you paste or attach. Both are first class here.
 */
export function ConnectPane({ host, screenName, entries, requests, onCopyReport, onDownloadReport }: {
  host: Host;
  screenName: string;
  entries: number;
  requests: number;
  onCopyReport: () => void;
  onDownloadReport: () => void;
}) {
  const [iso, setIso] = useState<{ enabled: boolean; trial?: boolean; supported: boolean; error?: string } | undefined>();
  const [trial, setTrial] = useState('');
  const [web, setWeb] = useState<{ available: boolean; originIsolated: boolean; registered: string[]; reason?: string } | undefined>();
  const supported = !!host.bridge;
  const [port] = useState(host.bridge?.state().port ?? 8788);
  const [enabled, setEnabled] = useState(host.bridge?.state().enabled ?? false);
  const [probe, setProbe] = useState<Awaited<ReturnType<NonNullable<Host['bridge']>['check']>> | null>(null);
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState('');
  const [known, setKnown] = useState<{ setupCommand?: string; desktopConfig?: string }>({});

  useEffect(() => {
    try { chrome.storage?.local.get(['setupCommand', 'desktopConfig'], (s) => setKnown(s ?? {})); }
    catch { /* optional */ }
  }, []);

  const check = async () => {
    if (!host.bridge) return;
    setChecking(true);
    const result = await host.bridge.check(port);
    setProbe(result);
    if (result.setupCommand) setKnown({ setupCommand: result.setupCommand, desktopConfig: result.desktopConfig });
    setChecking(false);
  };
  useEffect(() => { void check(); /* eslint-disable-next-line */ }, []);

  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);

  const copy = async (text: string, what: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(what); setTimeout(() => setCopied(''), 2000); }
    catch { /* clipboard can be blocked */ }
  };

  const command = probe?.setupCommand ?? known.setupCommand ?? SELF_RESOLVING_COMMAND;
  const desktopConfig = probe?.desktopConfig ?? known.desktopConfig;
  const exact = command !== SELF_RESOLVING_COMMAND;
  const state = host.bridge?.state();
  const lastPush = state?.lastPushAt ? Math.round((Date.now() - state.lastPushAt) / 1000) : null;

  const toggle = () => {
    if (!host.bridge) return;
    const next = !enabled;
    setEnabled(next);
    host.bridge.setEnabled(next, port);
    if (next) void check();
  };

  return (
    <div className="pane issues" style={{ flex: 1 }}>
      <div className="panehead">
        <span className="label">Send to Claude</span>
        <span className="count">{enabled && probe?.ok ? 'streaming to a local Claude' : 'choose how you use Claude'}</span>
      </div>

      <div className="scroll" style={{ padding: '14px 16px 28px' }}>
        <div className="connect-lead" style={{ marginBottom: 18 }}>
          Claude gets the <b>analysis</b> — the ranked issues with their traces, the state tree, the
          write chain behind any value — not raw logs it has to re-derive. How it reaches Claude
          depends on which one you use.
        </div>

        {/* ── Anyone, any Claude ─────────────────────────────────────── */}
        <div className="connect-card">
          <div className="cc-head">
            <span className="cc-badge any">Works everywhere</span>
            <b>claude.ai · Cowork · Claude Desktop · any model</b>
          </div>
          <div className="cc-body">
            Take the whole capture as a markdown report and paste or attach it into any chat.
            Nothing to install, nothing to configure — and it's the only option that works with
            <b> claude.ai and Cowork</b>, which run in the cloud and cannot reach a server on your
            machine.
          </div>
          <div className="cc-actions">
            <button className="btn primary" onClick={onCopyReport}>Copy report</button>
            <button className="btn" onClick={onDownloadReport}>Download .md</button>
            <span className="cc-note">
              {screenName || 'current screen'} · {entries} entries · {requests} requests · tokens redacted
            </span>
          </div>
        </div>

        {/* ── Local Claude, live ─────────────────────────────────────── */}
        <div className="connect-card">
          <div className="cc-head">
            <span className="cc-badge live">Live</span>
            <b>Claude Code · Claude Desktop</b>
          </div>
          <div className="cc-body">
            These run on this machine, so they can read captures <b>as you work</b> — no copying.
            Claude can ask follow-up questions of the screen itself: trace a value, query the state,
            evaluate a JSONata expression against the live context.
          </div>

          <div className="connect-status">
            <span className={`dot ${enabled && probe?.ok ? 'on' : enabled ? 'warn' : 'off'}`} />
            <span>
              {!supported ? 'Not available in this shell.'
                : !enabled ? 'Not connected.'
                : probe?.ok ? `Connected on port ${port}.` + (lastPush !== null ? ` Last push ${lastPush}s ago.` : ' Waiting for a capture…')
                : `Enabled, but nothing is listening on port ${port}${probe?.error ? ` — ${probe.error}` : ''}. Start a Claude session.`}
            </span>
            <button className="btn" onClick={check} disabled={checking || !supported}>
              {checking ? 'Checking…' : 'Re-check'}
            </button>
            <button className={`btn ${enabled ? 'on' : 'primary'}`} onClick={toggle} disabled={!supported}>
              {enabled ? 'Disconnect' : 'Connect'}
            </button>
          </div>
          {state?.lastError && <div className="connect-err">Last push failed: {state.lastError}</div>}

          <details className="cc-setup" open={!enabled}>
            <summary>One-time setup</summary>

            <div className="cc-sub">Claude Code — run once in a terminal:</div>
            <div className="connect-code">
              <code style={{ whiteSpace: 'pre-wrap' }}>{command}</code>
              <button className={`btn ${copied === 'cmd' ? 'on' : ''}`} onClick={() => copy(command, 'cmd')}>
                {copied === 'cmd' ? '✓' : 'Copy'}
              </button>
            </div>
            {!exact && (
              <div className="connect-hint">
                Already registered? <code>claude mcp list</code> shows it. Once a Claude session has
                started the server once, this box shows the fully-resolved command instead.
              </div>
            )}

            <div className="cc-sub">
              Claude Desktop — add to <code>claude_desktop_config.json</code>
              {' '}(Settings → Developer → Edit Config):
            </div>
            <div className="connect-code">
              <code>{desktopConfig ?? '{ "mcpServers": { "fuuz-ui": { "command": "node", "args": ["<path>/src/mcp/server.cjs"] } } }'}</code>
              <button className={`btn ${copied === 'cfg' ? 'on' : ''}`}
                onClick={() => copy(desktopConfig ?? '', 'cfg')} disabled={!desktopConfig}>
                {copied === 'cfg' ? '✓' : 'Copy'}
              </button>
            </div>

            <div className="connect-hint">
              Then start Claude, press <b>Connect</b> above, and ask something like
              <i> “what's wrong with the screen I have open?”</i>
            </div>
          </details>
        </div>

        <div className="connect-note">
          <b>What leaves the panel.</b> Only what it already shows: the classified log, the state
          tree, network metadata, issues and design findings. The live path posts to
          <code> 127.0.0.1</code> and nowhere else. Session tokens are redacted from both the report
          and the push. Disconnecting stops it immediately.
        </div>
      {/* ── WebMCP ───────────────────────────────────────────────────────
          Structured as a card like the two above, and as two numbered steps,
          because that is what it is: a thing you enable and a thing you then
          register. The earlier version buried both in prose. */}
      {host.webmcp && (
        <div className="connect-card">
          <div className="cc-head">
            <span className="cc-badge any">Proof of concept</span>
            <b>Any in-browser agent · no server, no setup</b>
          </div>
          <div className="cc-body">
            Registers the read-only diagnostics as tools on the Fuuz page itself, so an agent in
            the browser can call them with no bridge and no <code>claude mcp add</code>. Nothing
            that changes the screen is exposed — a page tool is reachable by anything that lands
            on the tab.

            <div className="cc-sub">
              <b>1 · Origin isolation</b>{' '}
              <span className="elabel">
                {iso === undefined ? '' : iso.error ? iso.error
                  : iso.enabled ? (iso.trial ? 'on · with trial token' : 'on') : 'off'}
              </span>
              <div>
                WebMCP needs an origin-isolated document and Fuuz sends no{' '}
                <code>Origin-Agent-Cluster</code> header. This adds it.
              </div>
              <div className="warn">
                Changes how Chrome isolates the origin: it opts out of synchronous scripting with
                other <code>*.fuuz.app</code> subdomains. Then open Fuuz in a <b>new tab</b> — a
                refresh is not enough, because Chrome decides an origin&rsquo;s cluster once per
                browsing-context group.
              </div>
              {/* Optional: a trial token turns the API on for everyone who loads
                  the origin, where the flag only covers this browser. */}
              <input className="filter" style={{ width: '100%', marginTop: 4 }} value={trial}
                placeholder="Origin-trial token (optional — leave blank to use the Chrome flag)"
                onChange={(e) => setTrial(e.target.value)} />
              <div>
                <button className="btn" onClick={() => void host.webmcp!.isolation(true, trial).then(setIso)}>
                  Enable
                </button>
                <button className="btn" onClick={() => void host.webmcp!.isolation(false).then(setIso)}>
                  Disable
                </button>
              </div>
            </div>

            <div className="cc-sub">
              <b>2 · Register tools</b>{' '}
              <span className="elabel">
                {web ? `${web.registered.length} registered` : ''}
              </span>
              <div>
                Needs Chrome 149+ with the WebMCP origin trial, or{' '}
                <code>chrome://flags/#enable-webmcp-testing</code> locally.
              </div>
              <div>
                <button className="btn" onClick={() => void host.webmcp!.register().then(setWeb)}>
                  Register
                </button>
                <button className="btn"
                  onClick={() => void host.webmcp!.unregister().then(() => void host.webmcp!.status().then(setWeb))}>
                  Unregister
                </button>
                <button className="btn" onClick={() => void host.webmcp!.status().then(setWeb)}>
                  Check
                </button>
              </div>
            </div>

            {/* Availability and isolation fail for different reasons and have
                different fixes, so they are reported separately. */}
            {web && (
              <div className="connect-hint">
                <code>document.modelContext</code>: <b>{web.available ? 'present' : 'absent'}</b>
                {' · '}origin-isolated: <b>{web.originIsolated ? 'yes' : 'no'}</b>
                {web.registered.length > 0 && (
                  <div className="connect-code">{web.registered.join('\n')}</div>
                )}
                {web.reason && <div className="warn">{web.reason}</div>}
              </div>
            )}
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
