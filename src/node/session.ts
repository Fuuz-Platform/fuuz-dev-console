/**
 * The capture session: attach to a page, turn its console into classified
 * entries and a derived state tree, and push snapshots to the panel.
 *
 * Everything VS Code-specific stays out of here — the session takes plain
 * options and reports through callbacks, so the panel owns the UI and this owns
 * the browser.
 */
import { classify, formatTs } from '../core/classify';
import { applyDesign, designCoverage, type ScreenDesignIndex } from '../core/designJoin';
import { CdpError, CdpSession, isPortLive, listTargets, resolveArg, type CdpTarget, type RemoteObject } from './cdp';
import { findChrome, launchChrome, waitForPort } from './chrome';
import { buildStateTree } from '../core/stateTree';
import type { ClassifyRule, LogEntry, RawConsoleEvent, ScreenRunnerPayload } from '../core/types';

export interface SessionOptions {
  /** DevTools port to attach to (or open, when we launch the browser). */
  port: number;
  /** Substring/regex the page URL must match. Falls back to the first page. */
  urlFilter: string;
  /** Opened when we launch the browser ourselves. */
  targetUrl?: string;
  /** Overrides the auto-detected Chrome binary. */
  chromePath?: string;
  /** Persistent profile directory, so the tenant login survives runs. */
  userDataDir: string;
  /** Effective rule set (defaults merged with the user's settings). */
  rules: ClassifyRule[];
  /** Ring-buffer cap; oldest entries are dropped past this. */
  maxEntries: number;
  /** Launch Chrome when nothing is listening on `port`. */
  autoLaunch: boolean;
  /**
   * The screen's design, when one was found. Supplies the element ownership the
   * runtime omits, plus element types and dynamic-prop coverage.
   */
  design?: ScreenDesignIndex;
}

type Listener = (payload: ScreenRunnerPayload) => void;

/** How many times to chase a dropped socket before declaring the page gone. */
const MAX_REATTACHES = 5;

/** Read the page's own URL — `Page.navigate` follows redirects silently. */
async function currentUrl(cdp: CdpSession): Promise<string | undefined> {
  try {
    const res = await cdp.send<{ result?: { value?: string } }>('Runtime.evaluate', {
      expression: 'location.href',
      returnByValue: true,
    });
    return res.result?.value;
  } catch {
    return undefined;
  }
}

/**
 * Same page, ignoring query and hash — the platform rewrites query params on
 * load, so comparing whole URLs would loop forever.
 */
export function sameRoute(a: string, b: string): boolean {
  const part = (u: string) => {
    try { const p = new URL(u); return `${p.origin}${p.pathname.replace(/\/+$/, '')}`; }
    catch { return u; }
  };
  return part(a) === part(b);
}

export class ScreenRunnerSession {
  private cdp: CdpSession | null = null;
  private entries: LogEntry[] = [];
  private raw: RawConsoleEvent[] = [];
  private seq = 0;
  private dropped = 0;
  private status: ScreenRunnerPayload['status'] = 'idle';
  private statusDetail = 'Not attached.';
  private target: { title: string; url: string } = { title: '', url: '' };
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private design: ScreenDesignIndex | undefined;
  private reattachAttempts = 0;
  private reattaching = false;

  constructor(private readonly opts: SessionOptions, private readonly onChange: Listener) {}

  /** Attach — launching the browser first when nothing is listening. */
  async start(): Promise<void> {
    this.setStatus('connecting', `Looking for a browser on port ${this.opts.port}…`);
    let launched = false;
    try {
      if (!(await isPortLive(this.opts.port))) {
        if (!this.opts.autoLaunch) throw new CdpError(`Nothing is listening on port ${this.opts.port}.`);
        const exe = this.opts.chromePath || findChrome();
        if (!exe) {
          throw new CdpError(
            'Could not find Chrome. Set `fuuz.devConsole.chromePath`, or start Chrome yourself with ' +
            `--remote-debugging-port=${this.opts.port}.`
          );
        }
        this.setStatus('connecting', 'Launching Chrome…');
        launchChrome({ executable: exe, port: this.opts.port, userDataDir: this.opts.userDataDir, url: this.opts.targetUrl });
        const up = await waitForPort(() => isPortLive(this.opts.port));
        if (!up) throw new CdpError('Chrome started but never opened the DevTools port.');
        launched = true;
      }
      // The DevTools port answers before the first page has loaded, and a target's
      // title is empty until it does — so a title-based filter can never match a
      // browser we just started. Keep retrying while the page comes up.
      await this.attachWithRetry(launched ? 30_000 : 0);
    } catch (err) {
      this.setStatus('error', err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Attach, retrying until `graceMs` has elapsed.
   *
   * Only a "no page matches" outcome is retried — an auth or transport failure
   * is reported immediately rather than hidden behind a 30-second wait.
   */
  private async attachWithRetry(graceMs: number): Promise<void> {
    const deadline = Date.now() + graceMs;
    for (;;) {
      try {
        await this.attachToPage();
        return;
      } catch (err) {
        const retryable = err instanceof CdpError && /no (open page|debuggable page)/i.test(err.message);
        if (!retryable || Date.now() > deadline) throw err;
        this.setStatus('connecting', 'Waiting for the page to load…');
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  /** Pick the page matching the filter and subscribe to it. */
  private async attachToPage(): Promise<void> {
    const targets = await listTargets(this.opts.port);
    if (!targets.length) throw new CdpError('No debuggable page is open in that browser.');

    const match = pickTarget(targets, this.opts.urlFilter);
    if (!match) {
      throw new CdpError(
        `No open page matches "${this.opts.urlFilter}". Navigate to the screen under test, then re-attach.`
      );
    }

    const cdp = await CdpSession.attach(match);
    this.cdp = cdp;
    this.target = { title: match.title, url: match.url };

    cdp.on('Runtime.consoleAPICalled', (p) => void this.onConsole(p));
    cdp.on('Runtime.exceptionThrown', (p) => void this.onException(p));
    cdp.on('Page.frameNavigated', (p) => this.onNavigated(p));
    // A cross-process navigation tears the socket down. That is routine, not a
    // failure, so recover rather than sitting there detached.
    cdp.on('__closed', () => {
      if (this.disposed || cdp !== this.cdp) return;
      void this.autoReattach();
    });

    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    this.reattachAttempts = 0;
    this.setStatus('attached', `Attached to ${match.title || match.url}`);

    await this.ensureOnTarget(cdp);
  }

  /**
   * Make sure we ended up on the page we were asked for.
   *
   * The platform's screen-runner route (`/…/screens/<id>/run`) bounces a cold
   * load to the deployed app route, and only sticks on a second navigation —
   * and it is the *only* route that emits transform logs, so landing on the app
   * route means capturing nothing useful. Re-navigate a bounded number of
   * times, then leave the page alone (the user may have navigated deliberately).
   */
  private async ensureOnTarget(cdp: CdpSession, attempts = 2): Promise<void> {
    if (!this.opts.targetUrl) return;
    for (let i = 0; i < attempts; i++) {
      const here = await currentUrl(cdp);
      if (!here || sameRoute(here, this.opts.targetUrl)) return;
      this.setStatus('connecting', `Redirected to ${here} — reopening the target route…`);
      await cdp.send('Page.navigate', { url: this.opts.targetUrl }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 2500));
    }
    const here = await currentUrl(cdp);
    if (here && !sameRoute(here, this.opts.targetUrl)) {
      this.setStatus('attached', `Attached, but the page redirected to ${here}`);
    }
  }

  /** Re-attach after the socket drops, backing off and eventually giving up. */
  private async autoReattach(): Promise<void> {
    if (this.disposed || this.reattaching) return;
    this.reattaching = true;
    try {
      while (!this.disposed && this.reattachAttempts < MAX_REATTACHES) {
        this.reattachAttempts++;
        const wait = Math.min(4000, 500 * this.reattachAttempts);
        this.setStatus('connecting', `Page navigated — re-attaching (${this.reattachAttempts}/${MAX_REATTACHES})…`);
        await new Promise((r) => setTimeout(r, wait));
        if (this.disposed) return;
        try {
          await this.attachToPage();
          return;
        } catch {
          /* try again until the attempt budget runs out */
        }
      }
      if (!this.disposed) {
        this.setStatus('detached', 'The page closed. Re-attach to keep capturing.');
      }
    } finally {
      this.reattaching = false;
    }
  }

  private async onConsole(params: Record<string, unknown>): Promise<void> {
    // Sequence is assigned synchronously: argument resolution is async and can
    // finish out of order, but the log must stay in call order.
    const seq = ++this.seq;
    const args = (params.args as RemoteObject[] | undefined) ?? [];
    const timestamp = typeof params.timestamp === 'number' ? params.timestamp : Date.now();
    const stack = params.stackTrace as { callFrames?: { url?: string; lineNumber?: number }[] } | undefined;
    const frame = stack?.callFrames?.[0];

    const resolved: unknown[] = [];
    for (const arg of args) {
      if (!this.cdp || this.cdp.isClosed) break;
      resolved.push(await resolveArg(this.cdp, arg));
    }

    this.record({
      seq,
      level: String(params.type ?? 'log'),
      timestamp,
      args: resolved,
      origin: frame?.url ? `${frame.url}:${(frame.lineNumber ?? 0) + 1}` : undefined,
    });
  }

  private async onException(params: Record<string, unknown>): Promise<void> {
    const seq = ++this.seq;
    const details = params.exceptionDetails as
      | { text?: string; exception?: RemoteObject; url?: string; lineNumber?: number }
      | undefined;
    const thrown = details?.exception && this.cdp ? await resolveArg(this.cdp, details.exception) : undefined;
    this.record({
      seq,
      level: 'error',
      timestamp: typeof params.timestamp === 'number' ? params.timestamp : Date.now(),
      args: [details?.text ?? 'Uncaught exception', thrown ?? {}],
      origin: details?.url ? `${details.url}:${(details.lineNumber ?? 0) + 1}` : undefined,
    });
  }

  /** A main-frame navigation is a new run: the old state no longer describes the page. */
  private onNavigated(params: Record<string, unknown>): void {
    const frame = params.frame as { parentId?: string; url?: string } | undefined;
    if (!frame || frame.parentId) return;
    this.target = { ...this.target, url: frame.url ?? this.target.url };
    this.clear();
  }

  private record(ev: RawConsoleEvent): void {
    this.raw.push(ev);
    const entry = classify(ev, this.opts.rules);
    // Usually an append; the guard covers arguments that resolved out of order.
    const at = this.entries.findIndex((e) => e.seq > entry.seq);
    if (at < 0) this.entries.push(entry); else this.entries.splice(at, 0, entry);

    const overflow = this.entries.length - this.opts.maxEntries;
    if (overflow > 0) {
      this.entries.splice(0, overflow);
      this.raw.splice(0, overflow);
      this.dropped += overflow;
    }
    this.scheduleFlush();
  }

  /** Coalesce bursts — a screen load can log hundreds of lines in a few ms. */
  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => { this.flushTimer = null; this.emit(); }, 120);
  }

  private setStatus(status: ScreenRunnerPayload['status'], detail: string): void {
    this.status = status;
    this.statusDetail = detail;
    this.emit();
  }

  private emit(): void {
    if (this.disposed) return;
    this.onChange(this.snapshot());
  }

  /** Attach the design index once it has been located (discovery is async). */
  setDesign(design: ScreenDesignIndex | undefined): void {
    this.design = design;
    this.emit();
  }

  /** The current payload. Also what the panel asks for on `ready`. */
  snapshot(): ScreenRunnerPayload {
    const newest = this.entries[this.entries.length - 1];
    // The join re-points entries at their real owners, so it must run before
    // the tree (and its provenance) is built from those writes.
    const design = this.design ?? this.opts.design;
    const entries = design ? applyDesign(this.entries, design) : this.entries;
    return {
      status: this.status,
      statusDetail: this.statusDetail,
      target: this.target,
      screenName: screenNameFrom(this.target.url, this.target.title),
      entries,
      tree: buildStateTree(entries, screenNameFrom(this.target.url, this.target.title)),
      snapshotAt: newest ? newest.ts : formatTs(Date.now()),
      dropped: this.dropped,
      design: design
        ? { screenName: design.screenName, version: design.version, coverage: designCoverage(entries, design) }
        : undefined,
    };
  }

  /** Raw captures, for authoring classification rules against a real build. */
  rawEvents(): RawConsoleEvent[] { return this.raw; }

  clear(): void {
    this.entries = [];
    this.raw = [];
    this.dropped = 0;
    this.emit();
  }

  /** Drop the socket and attach again — used after navigating to a new screen. */
  async reattach(): Promise<void> {
    this.cdp?.dispose();
    this.cdp = null;
    this.reattachAttempts = 0;
    this.setStatus('connecting', 'Re-attaching…');
    try { await this.attachWithRetry(5_000); }
    catch (err) { this.setStatus('error', err instanceof Error ? err.message : String(err)); }
  }

  dispose(): void {
    this.disposed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.cdp?.dispose();
    this.cdp = null;
  }
}

/**
 * Choose the page to watch. An exact-ish URL match wins; otherwise the filter is
 * tried as a regex, then as a plain substring; failing everything, the first page.
 */
export function pickTarget(targets: CdpTarget[], filter: string): CdpTarget | undefined {
  if (!filter.trim()) return targets[0];
  const needle = filter.trim();
  const exact = targets.find((t) => t.url === needle);
  if (exact) return exact;
  try {
    const re = new RegExp(needle, 'i');
    const hit = targets.find((t) => re.test(t.url) || re.test(t.title));
    if (hit) return hit;
  } catch { /* not a regex — fall through to substring */ }
  const lower = needle.toLowerCase();
  return targets.find((t) => t.url.toLowerCase().includes(lower) || t.title.toLowerCase().includes(lower));
}

/**
 * Name the screen for the tree root. Fuuz screen URLs carry the screen in the
 * path (`…/app/<app>/<screen>`), which beats the tab title once a screen sets
 * its own document title.
 */
export function screenNameFrom(url: string, title = ''): string {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    if (last && !/^\d+$/.test(last) && last.length < 48) return decodeURIComponent(last);
  } catch { /* not a URL yet */ }
  return title || 'Screen';
}
