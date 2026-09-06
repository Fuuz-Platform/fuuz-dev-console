/**
 * How the panel reaches its capture source.
 *
 * The console UI is shell-agnostic: it posts commands and receives payloads.
 * Only this module knows whether that's a DevTools port, a VS Code webview, or
 * an SSE stream — so the same React tree runs everywhere.
 */
import { classify, mergeRules } from '../core/classify';
import { buildStateTree } from '../core/stateTree';
import { applyDesign, designCoverage, indexScreenDesign, type ScreenDesignIndex } from '../core/designJoin';
import { assignEventScopes } from '../core/eventScope';
import type { ApplyOutcome } from '../core/designWrite';
import { apiBaseFor, fetchScreenDesign, redactTokens, screenVersionIdFrom } from '../core/screenApi';
import { normalizeRequest, type HarEntry, type NetworkEntry } from '../core/network';
import { diagnose, type Issue } from '../core/diagnose';
import { lintDesign } from '../core/designLint';
import { buildStructure, type StructureNode } from '../core/structure';
import { readPath } from '../core/propertyModel';
import { completeness, toStructureNodes } from '../core/domStructure';
import type { CanvasScrape } from '../core/canvasScrape';
import { surfaceChanged, surfaceIdentity } from '../core/surface';
import { accumulate, type CanvasSelection, type NodeDescriptor } from '../core/canvasSelection';
import { toModelShape, type IntrospectedType, type ModelShape } from '../core/modelTree';
import type { RuntimeScrape } from '../core/runtimeScrape';
import { mergeWithComponents } from '../core/runtimeElements';
import { API_ACCESS, API_DISABLED_REASON, apiDisabled } from '../core/apiAccess';
import { classifyEnvironment, mutationsAllowed, refusalFor, type EnvironmentInfo } from '../core/environment';
/*
 * Only the types remain in use.
 *
 * `graphql`, the introspection queries, the log-type finder and the transform-service call
 * all went dead when API access was switched off. They are left in `services.ts` — pure,
 * tested, and exactly what gets wired back up when the token read is solved — but importing
 * them here would leave references that read as live code.
 */
import {
  findLogTypes, TYPE_INTROSPECTION, TYPE_SEARCH,
  type RemoteEvalResult, type ServiceName,
} from '../core/services';
import type { FiberProbe } from '../extension/fiber';
import type { LogEntry, RawConsoleEvent, ScreenRunnerPayload } from '../core/types';

export type Inbound =
  | { type: 'ready' }
  | { type: 'clear' }
  | { type: 'reattach' }
  | { type: 'dumpRaw' }
  | { type: 'openSettings' }
  | { type: 'copy'; text: string };

/** What the panel renders: the capture plus everything derived from it. */
export interface Snapshot {
  payload: ScreenRunnerPayload;
  network: NetworkEntry[];
  issues: Issue[];
  pageUrl: string;
  /** Static findings over the design — available before anything runs. */
  designFindings: Issue[];
  /** Element name → type, for the picker and the design tab. */
  designElements: { name: string; type: string }[];
  /** The screen's element tree, as authored. */
  structure: StructureNode[];
  /** The newest runtime context, for the scratchpad. */
  context?: unknown;
  /** Who the capture is running as — a whole bug class hides here. */
  role?: { roleId?: string; tenantId?: string; email?: string };
  /**
   * Which designer surface the page is showing, if any. In a designer the screen
   * is inert, so an empty log is expected rather than a fault.
   */
  designer?: {
    kind: string; id?: string; tabName?: string; nodes?: number;
    /** How complete the scraped structure is — collapsed rows, active filters. */
    structureNote?: string;
  };
  /**
   * Why Structure is empty, when it is empty.
   *
   * "No design loaded" is true of half a dozen different failures, and telling
   * them apart by eye is impossible — so the panel records what it looked for,
   * what it found, and what the design fetch did.
   */
  /**
   * Which designer tab the rest of this snapshot describes.
   *
   * The panel resets its own view state when this changes — an open element, a
   * selected node and a chosen tab all belong to one surface.
   */
  surfaceKey?: string;
  /** Increments on every switch, so the panel can remount on it. */
  surfaceEpoch?: number;
  /** What the flow or schema canvas currently has selected. */
  canvasSelection?: CanvasSelection;
  /** Every diagram node, with the colour the canvas paints it — for the node list. */
  canvasNodes?: NodeDescriptor[];
  /**
   * What the canvas nodes carry, when nothing looked selected.
   *
   * The difference between "nothing is selected" and "the marker is one we do not
   * recognise" is invisible without this, and only the second is a bug we can fix.
   */
  canvasProbe?: { attributes?: string[]; classes?: string[]; sample?: string; nodes?: number };
  /** Where the session token came from, or which keys were searched in vain. */
  tokenDiag?: { from?: string; searchedKeys?: string[]; found: boolean };
  /**
   * The schema browser's contents: models clicked on the canvas, and their shapes
   * from introspection. A name present with no shape is still loading, or names a
   * model that is not deployed in this environment.
   */
  schema?: { models: string[]; shapes: Record<string, ModelShape | undefined> };
  /** Where the design already sits in the page, if anywhere. */
  designHunt?: DesignHuntReply;
  /** The element the designer has selected — mirrored so both stay in step. */
  designerSelected?: string;
  /**
   * Which Fuuz console drawers this page actually has.
   *
   * The frontend console exists on every screen; the flow log only on a data flow
   * tab. Offering a switch for a drawer that is not there would be a control that
   * does nothing, which is the thing this tool keeps trying not to do.
   */
  consoles?: { flowLog: boolean; frontend: boolean };
  /**
   * Platform-measured per-node timings, when this is a flow tab.
   *
   * Real durations from the engine's own `nodeExecutionStarted`/`Finished`
   * events — unlike `flowLog.timings`, which is a DOM-arrival proxy and says so.
   */
  flowEvents?: FlowEventReply;
  /** `$appConfig` — one object for the whole flow, shown once globally. */
  /**
   * The engine's real method names, prototype chain included.
   *
   * Pushed because node edits are not appearing, and the likeliest cause is the
   * publish call guessing at method names. Cheap — a list of strings.
   */
  engineApi?: { engine: string[]; node: string[]; nodesKeys: string[] };
  appConfig?: unknown;
  /** Every open App Designer tab: screens, schemas and flows. */
  designerTabs?: { id: string; name?: string; kind?: string; icon?: string; active?: boolean }[];
  /** Log-shaped model names found by introspecting the schema. */
  logTypes?: string[];
  /** Whether the markup tools are armed — actions that need them are disabled otherwise. */
  markup?: { active: boolean; tool: string; colour: string; shapes: number; selected?: boolean };
  /** A bounded sample of the data flow log console's output. */
  flowLog?: {
    found: boolean; count: number;
    rows: { text: string; value?: unknown; level?: string; node?: string }[];
    /** Arrival timings — a proxy for node duration, labelled as such. */
    timings?: { proxy: true; measures: string; arrivals: { node: string; at: number; sinceMs?: number }[] };
    sampleHtml?: string; truncated: boolean;
  };
  structureDiag?: {
    canvasFound: boolean;
    treeFound: boolean;
    treeRows: number;
    filtered: boolean;
    tabId?: string;
    /**
     * Every mounted designer canvas, and which is visible.
     *
     * The designer keeps inactive tabs mounted, so several canvases exist at once —
     * reading the wrong one is what made a flow unreadable while a screen tab was open.
     */
    canvases?: { kind: string; visible: boolean; area: number }[];
    designAttempted: boolean;
    designError?: string;
  };
  /**
   * Which Fuuz environment this page is, and therefore whether the tool may
   * change or capture it. The worker and content script enforce this
   * independently; this copy exists so the UI can explain itself rather than
   * presenting controls that will be refused.
   */
  environment: EnvironmentInfo;
  /**
   * Why nothing is arriving, when nothing is arriving. An empty panel is
   * indistinguishable from a quiet screen unless we say which it is.
   */
  health: {
    hookInstalled: boolean;
    /** Kept for the payload shape; no longer used to gate anything. */
    onRunRoute: boolean;
    eventsSeen: number;
  };
}

/** What the page reports about the designer surface it is showing. */
interface DesignerReply {
  designer: string | null;
  designerId?: string;
  tabId?: string;
  tabName?: string;
  /** A running screen's elements, scraped from its rendered DOM. */
  runtimeStructure?: RuntimeScrape;
  /** Diagram-canvas nodes, which are selected, and what markers they carry. */
  canvasNodes?: {
    nodes: NodeDescriptor[];
    selection: CanvasSelection;
    probe?: { attributes: string[]; classes: string[]; sample?: string };
  };
  nodes?: number;
  domStructure?: { roots: Parameters<typeof toStructureNodes>[0]; collapsed: number; filteredEmpty: boolean; count: number };
  canvasStructure?: CanvasScrape;
  probe?: {
    canvas: boolean; tree: boolean; rows: number; filtered: boolean; tabId: boolean; canvasRows?: number;
    /** Every mounted designer canvas and whether it is the visible one. */
    canvases?: { kind: string; visible: boolean; area: number }[];
  };
  tabs?: { id: string; name?: string; kind?: string; icon?: string; active?: boolean }[];
  markup?: { active: boolean; tool: string; colour: string; shapes: number; selected?: boolean };
  consoles?: { flowLog: boolean; frontend: boolean };
  flowLog?: {
    found: boolean; count: number;
    rows: { text: string; value?: unknown; level?: string; node?: string }[];
    /** Arrival timings — a proxy for node duration, labelled as such. */
    timings?: { proxy: true; measures: string; arrivals: { node: string; at: number; sinceMs?: number }[] };
    sampleHtml?: string; truncated: boolean;
  };
}

/** What the MAIN world found when asked where the design lives. */
/** Platform-measured node timings, from the engine's own events. */
export interface FlowEventReply {
  attached: boolean;
  /** `$appConfig` for this flow — one value, shown in the globals section. */
  appConfig?: unknown;
  /** Events whose payload yielded no node — the tell for a wrong assumption. */
  unidentified?: number;
  /** Real payload shape, recorded when the assumed one did not match. */
  shapes?: { event: string; keys: Record<string, string>; nested: Record<string, string[]> }[];
  events: string[];
  runs: { node: string; key: string; startedAt?: number; finishedAt?: number; durationMs?: number; status: string; error?: string }[];
  /** Recent runs carrying real payloads, so log entries are expandable. */
  recent?: { node: string; key: string; status: string; durationMs?: number; input?: unknown; output?: unknown; state?: unknown }[];
  recentOmitted?: number;
  summary: { node: string; runs: number; totalMs: number; slowestMs: number; failed: number }[];
  source: string;
  error?: string;
}

export interface DesignHuntReply {
  found?: { source: string; where: string; nodeCount: number; screenName?: string; version?: string; graph?: unknown };
  /**
   * The engine's real method names, prototype chain included.
   *
   * Pushed because node edits are not appearing, and the cause is almost certainly
   * that the publish call is guessing at names. Small — a list of strings.
   */
  engineApi?: { engine: string[]; node: string[]; nodesKeys: string[] };
  /** The flow engine's shape, for locating execution hooks. */
  engine?: { where: string; keys: Record<string, string>; nested: Record<string, Record<string, string>> };
  /** The flow definition, when the page is a data flow designer tab. */
  flow?: {
    where: string;
    nodeCount: number;
    nodes: { id?: string; name?: string; type?: string; logic: string[]; nextNodes?: string[] }[];
  };
  tried?: { source: string; ok: boolean; note?: string }[];
  fibersVisible?: boolean;
  apolloPresent?: boolean;
  error?: string;
}

export interface Host {
  post(msg: Inbound): void;
  subscribe(fn: (snapshot: Snapshot) => void): () => void;
  /** Present only in the DevTools shell. */
  pickElement?(): Promise<({ name: string; type: string; field?: string; label?: string }) | undefined>;
  /** Reload the watched tab — the panel survives it. */
  reloadTab?(): void;
  /**
   * Hide Fuuz's own Console drawer. We need its debug flag on, but not its UI —
   * this panel replaces it, and two consoles is one too many.
   */
  /**
   * Fuuz's own console drawers — there are two, and they are different tools.
   *
   * `frontend` is the screen dev console this panel replaces, hidden by default.
   * `flowLog` is the data flow designer's per-node execution log, which nothing
   * here reproduces, so it is **shown** by default: hiding it removed the only
   * view of a running flow and gave nothing back.
   */
  nativeConsole?: {
    hidden(kind?: 'frontend' | 'flowLog'): boolean;
    setHidden(hidden: boolean, kind?: 'frontend' | 'flowLog'): void;
  };
  /**
   * Write a screen or flow definition back to the platform.
   *
   * The only thing this console does that survives a reload, so it is deliberately
   * awkward: `apply` defaults to false, the caller must supply the document the patch
   * was computed from (`expect`), and the write is refused if the stored definition
   * moved in between. A dry run returns the literal request that *would* be sent, so
   * an approval step has something concrete to show rather than a promise.
   *
   * Build the patch with `core/designPatch.ts`; it refuses ambiguous targets rather
   * than guessing which element you meant.
   */
  design?: {
    apply(edit: {
      kind: 'screen' | 'flow';
      versionId: string;
      document: unknown;
      expect: unknown;
      change?: string;
      apply?: boolean;
    }): Promise<ApplyOutcome>;
  };
  /**
   * How many entries to keep before the oldest are dropped; `0` is unlimited.
   *
   * Adjustable because no single number is right: a busy screen under a long soak
   * outruns any default, and the platform's own console solves this by capping at
   * 50 — which is precisely the behaviour this console exists to avoid inheriting.
   * The choice is persisted, so a capture set up once stays set up.
   */
  retention?: {
    max(): number;
    setMax(entries: number): void;
  };
  /**
   * Which tab this panel watches, and the Fuuz tabs it could watch instead.
   * Only meaningful in the standalone window: a DevTools panel is bound to its
   * inspected tab by construction and cannot retarget.
   */
  targeting?: {
    canSwitch: boolean;
    current(): number | undefined;
    list(): Promise<{ id: number; title: string; url: string; active: boolean }[]>;
    watch(tabId: number): void;
  };
  /**
   * Read and preview CSS on a live element.
   *
   * Applying writes inline styles to the DOM only — nothing is saved, and a
   * reload discards it. The design is changed by copying the result into the
   * element's `style` prop in the designer.
   */
  styles?: {
    read(target: { name?: string; type?: string; dataPath?: string; label?: string }):
      Promise<{ found: boolean; computed?: Record<string, string>; inline?: Record<string, string>; tag?: string }>;
    apply(target: { name?: string; type?: string; dataPath?: string; label?: string }, css: Record<string, string>): void;
  };
  /**
   * Reach the live component behind an element, and drive its own API.
   *
   * `probe` is read-only and decides what the inspector may offer: without an
   * `fn` bag in reach, every edit is a preview the next render will overwrite,
   * and the panel says so rather than showing a control that does nothing.
   *
   * `call` goes through the runtime's supported API, so dependent transforms
   * re-fire and the console captures them — real *and* traced. Still nothing is
   * saved; a reload discards it.
   */
  element?: {
    /**
     * Preview a property by writing it to the DOM.
     *
     * The second tier, for props with no runtime setter: visible immediately and
     * overwritten by the next render. Reported as a preview, never as a change.
     */
    preview(
      target: { name?: string; type?: string; dataPath?: string; label?: string },
      prop: string,
      value: unknown
    ): Promise<{ ok: boolean; how?: string; note?: string; error?: string }>;
    probe(target: { name?: string; type?: string; dataPath?: string; label?: string }): Promise<FiberProbe>;
    call(
      target: { name?: string; type?: string; dataPath?: string; label?: string },
      fn: string,
      args: unknown[]
    ): Promise<{ ok: boolean; result?: unknown; error?: string }>;
  };
  /**
   * Capture the watched tab, optionally cropped to one element.
   *
   * Visible viewport only, and never DevTools itself. Downscaled before it
   * leaves the worker, because these images are routinely read by an LLM through
   * the bridge and a full retina PNG would cost a large slice of its context.
   */
  screenshot?(opts?: {
    target?: { name?: string; type?: string; dataPath?: string; label?: string };
    maxEdge?: number;
  }): Promise<{ ok: boolean; dataUrl?: string; width?: number; height?: number; bytes?: number; cropped?: boolean; error?: string }>;
  /**
   * Evaluate an expression the way the *platform* would, not the way the
   * bundled JSONata does.
   *
   * The local engine is only the language; the platform adds its own function
   * library, so an expression can pass here and fail there. Gated with the other
   * mutations because it runs server-side under the user's own session.
   */
  evaluateRemote?(expression: string, context: unknown): Promise<RemoteEvalResult>;
  /**
   * Query any Fuuz model as the signed-in user.
   *
   * This is what makes backend logs reachable: `DataFlowDeploymentLog` and its
   * integration equivalent are models, and every execution already gives us
   * `flowId`, `versionId` and `deploymentId` to filter on. `describe` and
   * `logTypes` exist so a query is written against the real schema rather than a
   * guessed model name — the mistake that cost two rounds already.
   */
  query?: {
    run(query: string, variables?: Record<string, unknown>, service?: ServiceName):
      Promise<{ ok: boolean; data?: unknown; errors?: unknown[]; status?: number; error?: string }>;
    describe(typeName: string): Promise<{ ok: boolean; data?: unknown; error?: string }>;
    logTypes(): Promise<{ ok: boolean; types?: string[]; error?: string }>;
    /** Model names this environment serves, for the script tab's model picker. */
    models(): Promise<{ ok: boolean; error?: string; names: string[] }>;
    /** One model's shape, so its fields can autocomplete. */
    describeModel(name: string): Promise<ModelShape | undefined>;
  };
  /**
   * Ask the page where the design already is.
   *
   * The designer cannot render without the craft graph, so it is in memory —
   * cheaper and more reliable than re-fetching it keyed on a tab id.
   */
  huntDesign?(includeGraph?: boolean): Promise<DesignHuntReply>;
  /**
   * WebMCP: register the read-only diagnostics as tools on the page itself.
   *
   * POC. Two deliberate steps because both change something: the header rule
   * alters how Chrome isolates the origin, and registering tools makes them
   * callable by any agent that lands on the tab.
   */
  webmcp?: {
    status(): Promise<{ available: boolean; originIsolated: boolean; registered: string[]; reason?: string }>;
    register(): Promise<{ available: boolean; originIsolated: boolean; registered: string[]; reason?: string }>;
    unregister(): Promise<unknown>;
    /** The `Origin-Agent-Cluster` response-header rule. Needs a NEW tab to apply. */
    isolation(enabled?: boolean, token?: string): Promise<{ enabled: boolean; trial?: boolean; supported: boolean; error?: string }>;
  };
  /**
   * A data flow's live nodes: read one in full, and change a value on it.
   *
   * `setValue` is sharper than the screen-side edits and the UI must say so —
   * those touch runtime state and a reload discards them, whereas this edits the
   * **designer's in-memory flow** and becomes permanent if the developer saves.
   */
  flow?: {
    node(id: string): Promise<{ found: boolean; node?: unknown; error?: string }>;
    /** Payloads for one node's runs. Fetched on demand — never pushed. */
    /** What the engine exposes for writing, prototype methods included. */
    api(): Promise<{ engine: string[]; node: string[]; nodesKeys: string[] }>;
    payloads(node: string): Promise<{ node: string; runs: { key: string; status: string; durationMs?: number; input?: unknown; output?: unknown; state?: unknown; outputState?: unknown }[] }>;
    setValue(id: string, path: string, value: unknown): Promise<{ ok: boolean; error?: string; note?: string }>;
  };
  /**
   * Dock the console inside the page, or float it.
   *
   * A separate window is right for a second monitor and wrong for one screen,
   * where you end up alt-tabbing between the screen you are debugging and the
   * tool describing it.
   */
  overlay?(mode: 'right' | 'bottom' | 'float' | 'off' | 'window'): void;
  /**
   * Draw on the page before capturing it.
   *
   * Per tab by construction: the layer is DOM in that document, so clearing here
   * can never reach another tab's annotations.
   */
  markup?(
    action: 'on' | 'off' | 'undo' | 'clear' | 'clearAndClose' | 'state'
      | 'deleteSelected' | 'editText' | 'deselect',
    tool?: string
  ): void;
  /** Paint (or clear) the hover highlight in the page. */
  highlight?(
    target: { name?: string; type?: string; dataPath?: string; label?: string; nodeId?: string } | null,
    reveal?: boolean
  ): void;
  /** How the last highlight resolved — undefined when it found nothing. */
  onHighlightVia?(fn: (info: { via?: string; approximate: boolean } | undefined) => void): void;
  /** Called back when a highlight couldn't find its element. */
  onHighlightMiss?(fn: (name: string, why?: string) => void): void;
  /** Push captures to the local MCP bridge so Claude can read them. */
  bridge?: {
    /** Probe the bridge without changing anything. */
    check(port: number): Promise<{
      ok: boolean; connected?: boolean; error?: string;
      setupCommand?: string; desktopConfig?: string;
    }>;
    /** Start/stop streaming snapshots to it. */
    setEnabled(enabled: boolean, port: number): void;
    state(): { enabled: boolean; port: number; lastPushAt?: number; lastError?: string };
  };
}

/* ── DevTools panel ─────────────────────────────────────────────────────── */

/**
 * In the browser shell the panel *is* the pipeline: raw console events arrive
 * from the page and are classified here, so there is no extension host to talk
 * to. That keeps the whole capture path in one process and one language.
 */
/**
 * Which tab are we watching, and can we use the DevTools APIs?
 *
 * In the DevTools panel both come from `chrome.devtools`. In the standalone
 * window the tab id rides in the URL and there is no DevTools API at all — so
 * network capture and `$0` picking are unavailable there, and the panel says so
 * rather than showing an empty tab.
 */
/** Whether this panel is framed inside a page rather than in its own window. */
function isEmbedded(): boolean {
  try { return new URLSearchParams(location.search).get('embedded') === '1'; }
  catch { return false; }
}

function shell(): { tabId: number | undefined; hasDevtools: boolean } {
  const hasDevtools = typeof chrome !== 'undefined' && !!chrome.devtools?.inspectedWindow;
  if (hasDevtools) return { tabId: chrome.devtools.inspectedWindow.tabId, hasDevtools: true };
  const fromUrl = Number(new URLSearchParams(location.search).get('tabId'));
  return { tabId: Number.isFinite(fromUrl) && fromUrl > 0 ? fromUrl : undefined, hasDevtools: false };
}

export function devtoolsHost(maxEntries = 5000): Host {
  const { tabId: initialTabId, hasDevtools } = shell();
  let tabId = initialTabId;
  /**
   * How many entries to keep. Adjustable at runtime and persisted, because the
   * right number is workload-dependent: a five-minute soak against a busy screen
   * outruns any default we could pick, and a long capture on a slow machine wants
   * a smaller one. `0` means keep everything — the panel says so, so nobody is
   * surprised by the memory.
   *
   * This is *our* retention, deliberately independent of the platform's own
   * `take(50)` on `transformDebuggingLogs`: that cap is upstream and not ours to
   * change, which is exactly why the capture path must not inherit it.
   */
  let retention = Math.max(0, Math.floor(maxEntries));
  const listeners = new Set<(s: Snapshot) => void>();
  let entries: LogEntry[] = [];
  let raw: RawConsoleEvent[] = [];
  let network: NetworkEntry[] = [];
  let requestSeq = 0;
  let design: ScreenDesignIndex | undefined;
  let screenName = 'Screen';
  let url = '';
  let dropped = 0;
  /**
   * Drop the oldest entries once the buffer passes `retention`, counting what went
   * so the panel can say `· n dropped` rather than quietly showing a partial run.
   * `retention === 0` keeps everything.
   */
  const trim = () => {
    if (retention <= 0) return;
    const overflow = entries.length - retention;
    if (overflow > 0) { entries.splice(0, overflow); raw.splice(0, overflow); dropped += overflow; }
    if (network.length > retention) network.splice(0, network.length - retention);
    // The store's log is unbounded on the platform's side, so the console's own
    // retention is the only thing keeping a long designer session in memory.
    if (storeFlowEntries.length > retention) {
      dropped += storeFlowEntries.length - retention;
      storeFlowEntries.splice(0, storeFlowEntries.length - retention);
    }
  };
  let designFor: string | undefined;   // screenVersionId the current design belongs to
  let designDoc: unknown;              // raw, for the static lint
  let designFindings: Issue[] = [];
  let structure: StructureNode[] = [];
  let missFn: ((name: string, why?: string) => void) | undefined;
  let viaFn: ((info: { via?: string; approximate: boolean } | undefined) => void) | undefined;
  let lastHighlighted: string | undefined;
  let bridgeEnabled = false;
  let bridgePort = 8788;
  let bridgeLastPush: number | undefined;
  let bridgeError: string | undefined;
  // Default on: the flag we set to get logs also opens Fuuz's Console drawer,
  // and this panel already shows everything it does.
  let hideNativeConsole = true;
  // Shown by default: this panel does not reproduce per-node flow execution, so
  // hiding the flow log took information away for nothing.
  let hideFlowLogConsole = false;

  const pushNativeConsole = () => {
    try {
      port.postMessage({ type: 'hideNativeConsole', hide: hideFlowLogConsole, kind: 'flowLog' });
      port.postMessage({ type: 'hideNativeConsole', hide: hideNativeConsole, kind: 'frontend' });
    }
    catch { /* worker asleep; re-sent on reconnect */ }
  };

  /**
   * Push the current capture to the MCP bridge.
   *
   * Fire-and-forget and rate-limited: the panel re-renders on every burst, and
   * Claude only ever needs the newest snapshot.
   */
  let pushTimer: ReturnType<typeof setTimeout> | null = null;
  const pushToBridge = (snap: Snapshot) => {
    if (!bridgeEnabled || pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      fetch(`http://127.0.0.1:${bridgePort}/snapshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        /*
         * Send the whole snapshot minus the heavy field, not an allowlist.
         *
         * The allowlist that used to be here had to be extended by hand for every
         * new field, and four were missed — `designerTabs`, `appConfig`, `markup`,
         * `logTypes` — so they were absent from every bridge read while being
         * present in the panel. That made them look broken when they were only
         * unshipped, and it cost several rounds of diagnosis.
         *
         * `context` is the one exclusion: it is the full runtime state snapshot and
         * the largest thing here, and the tools read state from `payload.tree`.
         */
        body: JSON.stringify({ ...snap, context: undefined }),
      })
        .then(() => { bridgeLastPush = Date.now(); bridgeError = undefined; })
        .catch((e) => { bridgeError = e instanceof Error ? e.message : String(e); });
    }, 750);
  };

  /**
   * Serve screenshot requests coming from an MCP tool call.
   *
   * A screenshot is a moment, not state, so it cannot ride the snapshot push —
   * it has to be asked for. The bridge parks a request, this polls for it, and
   * the image goes back on a separate POST.
   *
   * Polling rather than a socket because the bridge is a plain HTTP server with
   * no upgrade path, and a two-second miss on a manual request costs nothing.
   */
  let capturePoll: ReturnType<typeof setInterval> | null = null;
  const pollForCaptureRequests = () => {
    if (capturePoll) return;
    capturePoll = setInterval(() => {
      if (!bridgeEnabled) return;
      fetch(`http://127.0.0.1:${bridgePort}/capture`)
        .then((r) => (r.status === 200 ? r.json() : undefined))
        .then((req?: { target?: { name?: string } | null; maxEdge?: number }) => {
          if (!req) return;
          return capture({ target: req.target ?? undefined, maxEdge: req.maxEdge })
            .then((shot) =>
              fetch(`http://127.0.0.1:${bridgePort}/capture`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(shot),
              }));
        })
        .catch(() => { /* the bridge went away; the next tick retries */ });
    }, 2000);
  };
  let hookInstalled = false;
  let eventsSeen = 0;
  // Resolved by the `sessionToken` port reply; declared here so the port handler
  // (defined above `sessionToken`) can see it.
  let tokenWaiters: ((token: string | undefined) => void)[] = [];
  let designer: { kind: string; id?: string; tabName?: string; nodes?: number; structureNote?: string } | undefined;
  /**
   * Structure scraped from the designer's own tree.
   *
   * Kept apart from the design-derived tree so the design always wins when it
   * loads: it knows types, transforms and bound fields, and the scrape knows
   * none of those. This is the floor, not the ceiling.
   */
  let domStructure: StructureNode[] = [];
  let structureDiag: Snapshot['structureDiag'];
  /** Which element the designer itself has selected, so the panel can mirror it. */
  let designerSelected: string | undefined;
  let consoles: { flowLog: boolean; frontend: boolean } | undefined;
  const embedded = isEmbedded();
  let designerTabs: { id: string; name?: string; kind?: string; icon?: string; active?: boolean }[] | undefined;
  let markup: { active: boolean; tool: string; colour: string; shapes: number } | undefined;
  let flowLog: Snapshot['flowLog'];
  /**
   * The designer's log as read from the app's store, and what happened when we asked.
   *
   * Kept separately from the scraped `flowLog` because the two are not interchangeable:
   * the store holds the whole log with the platform's own ids and full workflow state,
   * the scrape holds the last few rendered rows with a row-index id. Once the store
   * answers, it wins; the scrape stays as the fallback for a page where the tap cannot
   * reach a store, so a designer without one still shows something.
   */
  let storeFlowEntries: LogEntry[] = [];
  let flowTap: { attached: boolean; reported: number; tabs: string[]; error?: string } | undefined;
  let flowEvents: FlowEventReply | undefined;
  let engineApi: { engine: string[]; node: string[]; nodesKeys: string[] } | undefined;
  let appConfig: unknown;
  /** Log-shaped model names from the schema. `null` while the query is in flight. */
  let logTypes: string[] | null | undefined;
  /** The most recent snapshot, so page tool calls can be answered from it. */
  let current: Snapshot | undefined;
  let designHunt: DesignHuntReply | undefined;
  /**
   * Which designer tab the caches belong to.
   *
   * The Application Designer keeps several tabs open — a screen, a schema, a flow —
   * and switching between them changes everything the panel is showing while the
   * *browser* tab, the port and the poll all stay exactly the same. Without this,
   * clicking from a screen to a flow left the screen's structure, design, coverage
   * and element selection on display, attributed to a flow. Stale state that looks
   * live is the worst kind: it reads as a bug in the flow.
   */
  let surfaceKey: string | undefined;
  /**
   * Models the developer has clicked on the schema canvas, newest first.
   *
   * Accumulated rather than replaced: clicking a fourth model must not lose the first
   * three, because comparing two models side by side is most of why you would open
   * this. Cleared when the surface changes — they belong to one schema.
   */
  let schemaModels: string[] = [];
  /** Introspected shapes by model name, so a re-click costs nothing. */
  let modelShapes = new Map<string, ModelShape | null>();
  /** Which node the diagram canvas has selected, and how we know. */
  let canvasSelection: CanvasSelection | undefined;
  let canvasNodeList: NodeDescriptor[] | undefined;
  let canvasProbe: { attributes?: string[]; classes?: string[]; sample?: string; nodes?: number } | undefined;
  /**
   * What the token search found, and where it looked.
   *
   * Without a token the design fetch, introspection, the model browser and the GraphQL
   * console all fail together — so when it fails, which keys were searched is the whole
   * diagnosis.
   */
  let tokenDiag: { from?: string; searchedKeys?: string[]; found: boolean } | undefined;
  /** Bumped on every switch, so the panel can remount rather than reconcile. */
  let surfaceEpoch = 0;

  /**
   * Drop everything that belonged to the tab we just left.
   *
   * Design-derived caches only. The captured log is deliberately kept: it is
   * evidence of what ran, and discarding it because someone clicked a tab would
   * throw away the run they are trying to diagnose. What it must not do is stay
   * *attributed* to the old design — which is why `design` and `designFor` go, so
   * the join re-runs against whatever this tab turns out to be.
   */
  const resetSurface = (key: string | undefined) => {
    surfaceKey = key;
    surfaceEpoch += 1;
    design = undefined;
    designFor = undefined;
    designDoc = undefined;
    designFindings = [];
    domStructure = [];
    structure = [];
    designerSelected = undefined;
    designHunt = undefined;
    flowEvents = undefined;
    engineApi = undefined;
    flowLog = undefined;
    // Re-discovered per surface: the log types come from the flow engine, which
    // only exists on a flow tab.
    logTypes = undefined;
    schemaModels = [];
    modelShapes = new Map();
    canvasSelection = undefined;
    canvasNodeList = undefined;
    canvasProbe = undefined;
  };

  /**
   * Introspect one model and cache its shape.
   *
   * `null` in the cache means the request is in flight or the model does not exist in
   * this environment — a real answer, since the canvas can show a model that was
   * never deployed, and one worth telling the developer rather than showing an empty
   * field list that looks like a model with no fields.
   */
  const describeModel = async (name: string) => {
    const reply = await askPage<{ data?: unknown }>(
      'pageQuery', { service: 'system', query: TYPE_INTROSPECTION, variables: { name } }
    );
    modelShapes.set(name, toModelShape((reply?.data as { __type?: IntrospectedType } | undefined)?.__type) ?? null);
    emit();
  };

  /**
   * Ask the page which designer it is showing.
   *
   * This is what lets the panel load a design while you are *editing* a screen,
   * not only while one is running — and lets it say "the designer does not
   * execute transforms" instead of showing an empty log that looks broken.
   */
  const probeDesigner = () => {
    try {
      // Through the port, not `chrome.runtime.sendMessage`: that reaches
      // extension contexts only and never the content script, so it returned
      // undefined every time and Design/Structure stayed empty in the designer.
      void ask<DesignerReply>(
        () => port.postMessage({ type: 'getDesignerSurface' }),
        designerWaiters,
        { designer: null }
      ).then((reply) => {
        consoles = reply?.consoles;
        designerTabs = reply?.tabs;
        markup = reply?.markup;
        flowLog = reply?.flowLog;
        structureDiag = {
          canvasFound: reply?.probe?.canvas ?? false,
          treeFound: reply?.probe?.tree ?? false,
          treeRows: reply?.probe?.rows ?? 0,
          filtered: reply?.probe?.filtered ?? false,
          tabId: reply?.tabId,
          canvases: reply?.probe?.canvases,
          designAttempted: false,
        };
        /*
         * The switch check happens before any cache is written, so the new tab is
         * never briefly described by the old tab's data.
         *
         * Keyed on kind *and* id: two screens open in two tabs are different
         * surfaces, and so are a screen and a flow.
         */
        const key = surfaceIdentity(reply);
        if (surfaceChanged(surfaceKey, key)) resetSurface(key);

        if (!reply?.designer) { designer = undefined; domStructure = []; emit(); return; }
        designer = { kind: reply.designer, id: reply.designerId, tabName: reply.tabName, nodes: reply.nodes };
        // Read the designer's own tree. It is lazy and filterable, so carry the
        // completeness note with it — a tree that quietly omitted collapsed rows
        // would send a developer hunting for an element that is right there.
        // Preference order matters. The canvas renders the whole screen with
        // types and applied CSS; the tree widget is lazy and filterable and only
        // knows names. Using the widget when the canvas is available would throw
        // away most of what we need.
        /*
         * Diagram selection, and the schema browser's accumulation.
         *
         * The poll is the only signal available — a canvas click fires no event we can
         * subscribe to from an isolated content script — so a model appears in the
         * browser within one poll of being clicked.
         */
        canvasSelection = reply.canvasNodes?.selection;
        canvasNodeList = reply.canvasNodes?.nodes;
        // Kept so a selection convention we do not yet recognise is diagnosable from
        // the snapshot rather than only from the live DOM.
        canvasProbe = reply.canvasNodes
          ? { ...reply.canvasNodes.probe, nodes: reply.canvasNodes.nodes.length }
          : undefined;
        if (reply.designer === 'schema' && canvasSelection?.names.length) {
          const before = schemaModels;
          schemaModels = accumulate(schemaModels, canvasSelection.names);
          // Only fetch what is new: introspection is a network round trip and the
          // poll runs every few seconds.
          for (const name of schemaModels) {
            if (before.includes(name) || modelShapes.has(name)) continue;
            modelShapes.set(name, null);   // in-flight, so the next poll does not re-ask
            void describeModel(name);
          }
        }

        /*
         * Source preference: canvas, then the running DOM, then the designer's tree.
         *
         * The canvas is richest where it exists. The runtime scrape comes next because
         * its names are guaranteed locatable — they came out of the page — while the tree
         * widget is lazy, filterable and knows only names.
         */
        if (reply.runtimeStructure?.roots?.length && !reply.canvasStructure?.roots?.length) {
          /*
           * `$components` is the list; the DOM enriches it.
           *
           * The scrape only finds elements the renderer marks, which on a live screen was the form
           * fields and little else. The runtime's own `$components` holds every element, keyed by
           * the name a transform would use — so it decides what exists, and the DOM supplies types,
           * bound paths and containment where it can.
           */
          const captured = [...entries].reverse().find((e) => e.context)?.context;
          const components = (captured as { components?: unknown } | undefined)?.components;
          const merged = mergeWithComponents(reply.runtimeStructure.roots, components);
          domStructure = merged.roots as unknown as StructureNode[];
          const probe = reply.runtimeStructure.probe;
          designer.structureNote =
            `${merged.fromDom} from the page (via ${probe.attributes.join(', ') || 'no markers'})`
            + (merged.fromContext ? `, ${merged.fromContext} more from $components` : '')
            + ' — only what is currently rendered';
          emit();
          return;
        }

        if (reply.canvasStructure?.roots?.length) {
          domStructure = reply.canvasStructure.roots as unknown as StructureNode[];
          designer.structureNote =
            `${reply.canvasStructure.count} elements from the canvas — complete, but transforms load with the design`;
          designerSelected = reply.canvasStructure.selected;
        } else if (reply.domStructure) {
          domStructure = toStructureNodes(reply.domStructure.roots);
          designer.structureNote = completeness(reply.domStructure);
        } else {
          domStructure = [];
        }
        emit();
        // The designer's context has empty `urlParameters` and no components, so
        // the open tab's id is the only thing identifying the screen.
        void hunt(false).then((h) => { designHunt = h; emit(); });
        // Only on a flow tab: there is no engine anywhere else.
        if (reply.designer === 'flow' && logTypes === undefined) {
          logTypes = null;   // in-flight, so the poll does not re-ask every 4s
          void discoverLogTypes().then((r) => { logTypes = r.types ?? []; emit(); });
        }
        if (reply.designer === 'flow') {
          void askFlowEvents().then((f) => { flowEvents = f; appConfig = f.appConfig ?? appConfig; emit(); });
          void askFlowLogs();
          void askPage<{ engine: string[]; node: string[]; nodesKeys: string[] }>('engineApi')
            .then((a) => { engineApi = a; emit(); });
        }
        if (reply.tabId) {
          if (structureDiag) structureDiag.designAttempted = true;
          void loadDesign(undefined, reply.tabId);
        }
      });
    } catch { /* worker asleep */ }
  };
  let styleWaiters: ((reply: { found: boolean; computed?: Record<string, string>; inline?: Record<string, string>; tag?: string }) => void)[] = [];
  let probeWaiters: ((reply: FiberProbe) => void)[] = [];
  let designerWaiters: ((reply: DesignerReply) => void)[] = [];
  let huntWaiters: ((reply: DesignHuntReply) => void)[] = [];
  let flowEventWaiters: ((reply: FlowEventReply) => void)[] = [];
  let fnWaiters: ((reply: { ok: boolean; result?: unknown; error?: string }) => void)[] = [];
  let previewWaiters: ((reply: { ok: boolean; how?: string; note?: string; error?: string }) => void)[] = [];
  let shotWaiters: ((reply: {
    ok: boolean; dataUrl?: string; width?: number; height?: number; bytes?: number; cropped?: boolean; error?: string;
  }) => void)[] = [];

  /**
   * Ask the page something and wait for its reply, with a deadline.
   *
   * Every one of these round trips can go unanswered — the content script may
   * not be injected yet, the worker may have been killed mid-flight. A promise
   * that never settles would hang the pane with no explanation, so each resolves
   * to a stated failure instead.
   */
  const ask = <T>(send: () => void, queue: ((r: T) => void)[], onTimeout: T, ms = 4000): Promise<T> =>
    new Promise<T>((resolve) => {
      queue.push(resolve);
      try { send(); } catch { /* worker asleep; the timeout below covers it */ }
      setTimeout(() => {
        const at = queue.indexOf(resolve);
        if (at >= 0) { queue.splice(at, 1); resolve(onTimeout); }
      }, ms);
    });

  /**
   * A one-shot question to the page, answered through the worker.
   *
   * These have no waiter queue of their own: they are user-initiated, one at a
   * time, and a stale reply landing on the wrong caller would be worse than a
   * timeout.
   */
  const askPage = <T>(type: string, args: Record<string, unknown> = {}): Promise<T> => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type, tabId, ...args }, (reply) => {
        void chrome.runtime.lastError;
        resolve((reply ?? { error: 'The page did not answer.' }) as T);
      });
    } catch { resolve({ error: 'The extension is unreachable.' } as T); }
  });

  /**
   * The designer's own node log, from the store.
   *
   * Only what is new since the last ask — the tap keeps an id-keyed cursor — so this
   * runs on the same poll as the flow events and costs a state read. The seq base
   * continues the console's serial, so a flow entry and a screen transform sort into
   * one order rather than two.
   */
  const askFlowLogs = async () => {
    const reply = await askPage<{
      attached: boolean; entries?: LogEntry[]; tabs?: string[]; reported: number; error?: string;
    }>('flowLogs', { seqBase: entries.length + storeFlowEntries.length + 1 });
    flowTap = {
      attached: reply?.attached === true,
      reported: reply?.reported ?? 0,
      tabs: reply?.tabs ?? [],
      error: reply?.error,
    };
    if (reply?.entries?.length) {
      storeFlowEntries.push(...reply.entries);
      trim();
    }
    emit();
  };

  /** Engine-measured node timings. Idempotent: attaches on first call. */
  const askFlowEvents = () => ask<FlowEventReply>(
    () => port.postMessage({ type: 'flowEvents' }),
    flowEventWaiters,
    { attached: false, events: [], runs: [], summary: [], source: 'engine-events',
      error: 'The page did not answer within four seconds.' },
    4000
  );

  /**
   * Which models in this schema look like logs.
   *
   * Asked once per flow tab. Introspection rather than a guessed model name,
   * because guessing the shape is exactly what went wrong twice before.
   */
  /** Backend log-type discovery — an API call, so disabled with the rest. */
  const discoverLogTypes = async (): Promise<{ ok: boolean; types?: string[]; error?: string }> => {
    const reply = await askPage<{ ok?: boolean; data?: unknown; error?: string }>(
      'pageQuery', { service: 'application', query: TYPE_SEARCH, variables: {} }
    );
    if (reply?.ok === false) return { ok: false, error: reply.error };
    return { ok: true, types: findLogTypes(reply?.data) };
  };

  /** Where the design already is in the page. Read-only; the graph is opt-in. */
  const hunt = (includeGraph?: boolean) => ask<DesignHuntReply>(
    () => port.postMessage({ type: 'huntDesign', includeGraph: includeGraph === true }),
    huntWaiters,
    { error: 'The page did not answer within eight seconds.' },
    8000
  );

  /**
   * Capture the watched tab. Ten seconds because the worker has to wake, take
   * the shot, decode it and resize it — a four-second budget times out on a
   * cold worker and reports a failure that was only slowness.
   */
  const capture = (opts?: {
    target?: { name?: string; type?: string; dataPath?: string; label?: string };
    maxEdge?: number;
  }) => ask<{
    ok: boolean; dataUrl?: string; width?: number; height?: number; bytes?: number; cropped?: boolean; error?: string;
  }>(
    () => port.postMessage({ type: 'captureTab', target: opts?.target, maxEdge: opts?.maxEdge }),
    shotWaiters,
    { ok: false, error: 'The capture did not complete within ten seconds.' },
    10000
  );

  /**
   * Is the MAIN-world hook actually in the page?
   *
   * Content scripts only inject on load, so installing the extension with a tab
   * already open leaves that tab unhooked — the single most likely reason the
   * panel stays empty.
   */
  const checkHook = () => {
    if (!hasDevtools) return;
    chrome.devtools.inspectedWindow.eval(
      'window.__fuuzScreenRunnerHooked === true',
      (value: unknown) => { hookInstalled = value === true; emit(); }
    );
  };
  const rules = mergeRules([]);

  /** Read the page's live session token. Never cached — it rotates every ~15 min. */
  /**
   * The session token — **always undefined in this build**.
   *
   * Kept as one function rather than deleted at every call site, so the API-backed
   * features stay wired and turning them back on is a one-line change in `apiAccess.ts`
   * rather than an archaeology exercise. See the reasoning there.
   */
  const sessionToken = async (): Promise<string | undefined> => undefined;

  /**
   * Loading the screen's design — **disabled with the rest of the API access**.
   *
   * This fetched the design document from the application service and ran the static lint
   * over it, which is what filled the design-derived element types, transform attribution
   * and `designFindings`. All of it needed the session token, so all of it has been
   * returning nothing regardless; the stub makes that explicit instead of leaving a fetch
   * that always fails.
   *
   * Restoring it means restoring the token read and re-fetching here — the shape the rest
   * of the host expects (`design`, `designDoc`, `designFindings`) has not changed.
   */
  const loadDesign = async (_context?: unknown, _tabId?: string): Promise<void> => {
    if (structureDiag) structureDiag.designError = API_DISABLED_REASON;
    emit();
  };

  /**
   * Answer a WebMCP tool call from the page.
   *
   * Read-only by construction: there is no branch here that changes the screen.
   * A page-registered tool is reachable by any agent that lands on the tab, which
   * is a far wider door than a developer pressing a button in this panel, so the
   * mutating capabilities are deliberately absent rather than gated.
   */
  const answerToolQuery = (query: string, args: Record<string, unknown>): unknown => {
    const snap = current;
    if (!snap) return { error: 'Nothing captured yet.' };
    const payload = snap.payload;

    switch (query) {
      case 'status':
        return {
          screen: payload.screenName,
          url: snap.pageUrl,
          entries: payload.entries.length,
          requests: snap.network.length,
          elements: snap.structure.length,
          design: payload.design ? `${payload.design.screenName} v${payload.design.version ?? '?'}` : null,
          environment: `${snap.environment.slug ?? 'unknown'} (${snap.environment.tier})`,
          designer: snap.designer?.kind ?? null,
        };
      case 'elements': {
        const wanted = typeof args.name === 'string' ? args.name : undefined;
        const flat = (function walk(ns: StructureNode[], depth = 0): unknown[] {
          return ns.flatMap((n) => [
            {
              name: n.name, type: n.type, depth,
              dataPath: n.dataPath, label: n.label,
              transforms: n.props,
              css: n.style && Object.keys(n.style).length ? n.style : undefined,
            },
            ...walk(n.children, depth + 1),
          ]);
        })(snap.structure);
        const rows = wanted
          ? flat.filter((r) => (r as { name: string }).name === wanted)
          : flat;
        return { count: rows.length, elements: rows, source: snap.designer?.structureNote };
      }
      case 'state': {
        const path = typeof args.path === 'string' ? args.path : undefined;
        if (!path) return { tree: payload.tree };
        const hit = readPath(snap.context, path);
        return hit.found ? { path, value: hit.value } : { path, error: 'No such path in the captured context.' };
      }
      case 'issues':
        return { runtime: snap.issues, design: snap.designFindings };
      case 'log': {
        const filter = typeof args.filter === 'string' ? args.filter.toLowerCase() : undefined;
        const limit = typeof args.limit === 'number' ? args.limit : 50;
        const rows = payload.entries
          .filter((e) => !filter || `${e.title} ${e.write ?? ''} ${e.expr ?? ''}`.toLowerCase().includes(filter))
          .slice(-limit)
          .map((e) => ({ kind: e.kind, title: e.title, writes: e.write, expression: e.expr, ms: e.durMs }));
        return { count: rows.length, entries: rows };
      }
      case 'eval':
        // Deliberately not implemented here. Evaluation needs the JSONata engine
        // the scratchpad uses, and wiring an evaluator reachable by any agent on
        // the tab is a bigger decision than this POC should make quietly.
        return {
          error: 'Not available as a page tool. Use the ƒx tab in the panel, or the stdio MCP fuuz_screen_eval.',
        };
      default:
        return { error: `Unknown query: ${query}` };
    }
  };

  /**
   * Flow executions as log entries.
   *
   * The Log tab renders `payload.entries`, so a flow run appeared nowhere: its
   * output lives in Fuuz's flow console, which we scrape separately. Converting
   * those rows into entries means the Log tab, its filter, the trace view and the
   * markdown report all work on a flow run without any of them knowing it came
   * from a different source.
   *
   * `kind: 'flow'` rather than 'debug' so they colour distinctly, and each row's
   * segments become the expandable body — click one and every property it carried
   * is there, rather than a single truncated line.
   */
  const flowEntriesFromLog = (): LogEntry[] => {
    const rows = flowLog?.rows ?? [];
    if (!rows.length) return [];
    return rows.map((row, i) => {
      const parts = row.text.split('▶').map((t) => t.trim()).filter(Boolean);
      const node = parts[0] ?? 'flow';
      const segments: Record<string, string> = {};
      for (const part of parts.slice(1)) {
        const at = part.indexOf(':');
        if (at > 0) segments[part.slice(0, at).trim()] = part.slice(at + 1).trim();
      }
      // Arrival stamps line up with rows newest-last, so the tail matches.
      const arrivals = flowLog?.timings?.arrivals ?? [];
      const arrival = arrivals[arrivals.length - rows.length + i];
      const epoch = arrival?.at ?? Date.now();
      return {
        id: `flow-${i}`,
        seq: 100000 + i,
        ts: new Date(epoch).toTimeString().slice(0, 8) + '.' + String(epoch % 1000).padStart(3, '0'),
        epoch,
        kind: 'flow' as const,
        title: `Flow node · ${node}`,
        // Labelled as arrival, not duration — it is a proxy and must not read as one.
        dur: arrival?.sinceMs !== undefined ? `+${arrival.sinceMs}ms` : '',
        write: `flow.${node}`,
        reads: [],
        level: row.level ?? 'result',
        after: segments.output,
        /*
         * Real objects from the engine event, matched by node name.
         *
         * The console's DOM only holds a value once the developer has expanded that
         * row, so scraping it gave high-level keys and nothing to open. The event
         * carries the whole object regardless of what the UI is showing, which is
         * why it is the primary source and the DOM read is only a fallback.
         */
        payload: (() => {
          const run = [...(flowEvents?.recent ?? [])].reverse().find((r) => r.node === node);
          if (run && (run.input !== undefined || run.output !== undefined)) {
            return [{
              node,
              input: run.input,
              output: run.output,
              // Collapsed context rather than mixed in: it repeats on every node
              // from the point it was stashed.
              state: run.state,
              durationMs: run.durationMs,
              status: run.status,
            }];
          }
          if (row.value !== undefined && row.value !== null && typeof row.value === 'object') return [row.value];
          return [{ node, ...segments, raw: row.text }];
        })(),
      } as LogEntry;
    });
  };

  const emit = () => {
    // Flow entries sit alongside the console ones rather than replacing them: a
    // screen flow can produce both, and dropping either would hide half the run.
    /*
     * The store wins where it answers.
     *
     * Not both: the same node execution read twice — once with the platform's id and
     * full state, once as a parsed drawer row — would double every flow entry in the
     * log and in the report. The scrape stays for pages where the tap finds no store.
     */
    const flowFromStore = flowTap?.attached === true && storeFlowEntries.length > 0;
    const withFlow = [...entries, ...(flowFromStore ? storeFlowEntries : flowEntriesFromLog())];
    const joined = design ? applyDesign(withFlow, design) : withFlow;
    /*
     * Only this tab's log and network.
     *
     * Everything captured is kept — switching back to a tab shows its history again — but a
     * flow tab must not display a screen's transforms, which is what pooling them did. An
     * entry captured before any surface was known is shown everywhere: it belongs to no tab,
     * and hiding it would lose it entirely.
     */
    const mine = <T extends { surface?: string }>(list: T[]) =>
      surfaceKey === undefined ? list : list.filter((x) => x.surface === undefined || x.surface === surfaceKey);
    // Scope *after* filtering to this tab, so an event's serial numbering counts the
    // entries actually shown rather than ones withheld under another designer tab.
    const scoped = assignEventScopes(mine(joined));
    const visibleEntries = scoped.entries;
    const visibleNetwork = mine(network);
    const withheld = (joined.length - visibleEntries.length) + (network.length - visibleNetwork.length);

    const payload: ScreenRunnerPayload = {
      status: 'attached',
      statusDetail: url || 'Watching this tab',
      target: { title: screenName, url },
      screenName,
      entries: visibleEntries,
      tree: buildStateTree(visibleEntries, screenName),
      snapshotAt: visibleEntries[visibleEntries.length - 1]?.ts ?? '',
      dropped,
      /** Captured under a different designer tab — kept, not shown here. */
      withheld: withheld || undefined,
      events: scoped.scopes,
      retention,
      flowLogSource: flowTap
        ? (flowFromStore ? 'redux-store' : (flowTap.attached ? 'store-empty' : 'drawer-scrape'))
        : undefined,
      design: design
        ? { screenName: design.screenName, version: design.version, coverage: designCoverage(visibleEntries, design) }
        : undefined,
    };
    const context = [...entries].reverse().find((e) => e.context)?.context;
    const meta = (context as { metadata?: Record<string, unknown> } | undefined)?.metadata;
    const snap: Snapshot = {
      payload, network: visibleNetwork, issues: diagnose(visibleEntries, visibleNetwork), pageUrl: url,
      designFindings,
      designElements: design ? [...design.elementTypes].map(([name, type]) => ({ name, type })) : [],
      // The design's tree is richer wherever it exists; the scrape only stands in
      // for it, so that Structure is never empty while the designer is open.
      structure: structure.length ? structure : domStructure,
      context,
      designer,
      structureDiag,
      designHunt,
      designerSelected,
      consoles,
      designerTabs,
      markup,
      flowLog,
      flowEvents,
      engineApi,
      appConfig,
      logTypes: logTypes ?? undefined,
      surfaceKey, surfaceEpoch,
      canvasSelection,
      canvasNodes: canvasNodeList,
      canvasProbe,
      tokenDiag,
      schema: {
        models: schemaModels,
        shapes: Object.fromEntries([...modelShapes].map(([k, v]) => [k, v ?? undefined])),
      },
      environment: classifyEnvironment(url),
      health: { hookInstalled, onRunRoute: /\/screens\/[^/]+\/run\b/.test(url), eventsSeen },
      role: meta ? {
        roleId: (meta.role as { id?: string } | undefined)?.id ?? (meta.roleId as string | undefined),
        tenantId: (meta.tenant as { id?: string } | undefined)?.id,
        email: (meta.user as { email?: string } | undefined)?.email,
      } : undefined,
    };
    current = snap;
    pushToBridge(snap);
    listeners.forEach((fn) => fn(snap));
  };

  let flush: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (flush) return;
    flush = setTimeout(() => { flush = null; emit(); }, 120);
  };

  try {
    chrome.storage?.local.get(['bridgeEnabled', 'bridgePort', 'hideNativeConsole', 'hideFlowLogConsole', 'logRetention'], (stored) => {
      bridgeEnabled = stored?.bridgeEnabled === true;
      bridgePort = Number(stored?.bridgePort) || 8788;
      // Absent means "never set" → keep the constructor default. 0 is a real value
      // (unlimited), so it cannot be folded into the falsy branch.
      const stashed = Number(stored?.logRetention);
      if (Number.isFinite(stashed) && stashed >= 0) retention = Math.floor(stashed);
      hideNativeConsole = stored?.hideNativeConsole !== false;   // default: hidden
      hideFlowLogConsole = stored?.hideFlowLogConsole === true;  // default: SHOWN
      // The bridge preference survives a panel reopen, so the capture poller has
      // to start here too — not only when the toggle is pressed.
      if (bridgeEnabled) pollForCaptureRequests();
      pushNativeConsole();
      emit();
    });
  } catch { /* storage is optional */ }

  /**
   * Keep a live port to the service worker.
   *
   * MV3 kills the worker on idle, which severs the port — the panel then looks
   * alive but silently stops receiving. Reconnect on disconnect so a page
   * refresh (or just a quiet minute) doesn't require reopening the window.
   */
  let port: chrome.runtime.Port;
  const onPortMessage = (msg: { type: string; event?: RawConsoleEvent; found?: boolean; token?: string; via?: string; approximate?: boolean; from?: string; searchedKeys?: string[] }) => {
    if (msg.type === 'elementStyles') {
      const waiting = styleWaiters;
      styleWaiters = [];
      waiting.forEach((fn) => fn(msg as never));
      return;
    }
    if (msg.type === 'sessionToken') {
      tokenDiag = { from: msg.from, searchedKeys: msg.searchedKeys, found: !!msg.token };
      const waiting = tokenWaiters;
      tokenWaiters = [];
      waiting.forEach((fn) => fn(msg.token));
      return;
    }
    if (msg.type === 'webmcpQuery') {
      const q = msg as unknown as { id: number; query: string; args?: Record<string, unknown> };
      let result: unknown;
      try { result = answerToolQuery(q.query, q.args ?? {}); }
      catch (e) { result = { error: e instanceof Error ? e.message : String(e) }; }
      try { port.postMessage({ type: 'webmcpAnswer', id: q.id, result }); } catch { /* gone */ }
      return;
    }
    if (msg.type === 'designerSurface') {
      const waiting = designerWaiters;
      designerWaiters = [];
      waiting.forEach((fn) => fn(msg as unknown as DesignerReply));
      return;
    }
    if (msg.type === 'flowEvents') {
      const waiting = flowEventWaiters;
      flowEventWaiters = [];
      waiting.forEach((fn) => fn(msg as unknown as FlowEventReply));
      return;
    }
    if (msg.type === 'designHunt') {
      const waiting = huntWaiters;
      huntWaiters = [];
      waiting.forEach((fn) => fn(msg as unknown as DesignHuntReply));
      return;
    }
    if (msg.type === 'elementProbe') {
      const waiting = probeWaiters;
      probeWaiters = [];
      waiting.forEach((fn) => fn(msg as unknown as FiberProbe));
      return;
    }
    if (msg.type === 'previewResult') {
      const waiting = previewWaiters;
      previewWaiters = [];
      waiting.forEach((fn) => fn(msg as never));
      return;
    }
    if (msg.type === 'fnResult') {
      const waiting = fnWaiters;
      fnWaiters = [];
      waiting.forEach((fn) => fn(msg as unknown as { ok: boolean; result?: unknown; error?: string }));
      return;
    }
    if (msg.type === 'screenshot') {
      const waiting = shotWaiters;
      shotWaiters = [];
      waiting.forEach((fn) => fn(msg as never));
      return;
    }
    if (msg.type === 'highlightResult') {
      if (msg.found === false && lastHighlighted) missFn?.(lastHighlighted, msg.via);
      // How it was found, so an approximate hit ("first Chart on the screen") is
      // not presented as though it were exact.
      viaFn?.(msg.found === true ? { via: msg.via, approximate: msg.approximate === true } : undefined);
      return;
    }
    if (msg.type !== 'console' || !msg.event) return;
    eventsSeen++;
    hookInstalled = true;   // events arriving is proof, whatever the probe said
    raw.push(msg.event);
    const entry = classify(msg.event, rules);
    // Stamped with whichever designer tab was open, so the log can be shown per tab without
    // any of it being thrown away.
    entry.surface = surfaceKey;
    entries.push(entry);
    // The first entry carrying a context snapshot tells us which screen version
    // is running, which is what the design lookup keys on.
    if (entry.context && !design) void loadDesign(entry.context);
    trim();
    schedule();
  };

  const connect = () => {
    port = chrome.runtime.connect({ name: 'fuuz-dev-console-panel' });
    port.postMessage({ type: 'init', tabId });
    port.onMessage.addListener(onPortMessage);
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;      // expected when the worker idles out
      setTimeout(connect, 250);           // the next message wakes it again
    });
    // Re-assert on every (re)connect: the page may have reloaded meanwhile.
    pushNativeConsole();
    setTimeout(probeDesigner, 300);
  };
  connect();

  if (hasDevtools) chrome.devtools.network.onRequestFinished.addListener((har: HarEntry & {
    getContent(cb: (content: string, encoding: string) => void): void;
  }) => {
    const index = network.length;
    network.push({ ...normalizeRequest(har, ++requestSeq), surface: surfaceKey });
    trim();
    schedule();
    // A GraphQL failure hides in a 200 body, so the body is worth the round trip.
    try {
      har.getContent?.((content) => {
        if (!content) return;
        const at = network[index];
        if (!at) return;
        network[index] = normalizeRequest(har, at.seq, content);
        schedule();
      });
    } catch { /* some entries expose no content */ }
  });

  // A reload replaces the page's state, so the old log no longer describes it.
  if (hasDevtools) chrome.devtools.network.onNavigated.addListener((to: string) => {
    entries = []; raw = []; dropped = 0; storeFlowEntries = [];
    void askPage('resetFlowLogs');
    network = [];
    url = to;
    screenName = nameFromUrl(to);
    // A different screen needs a different design.
    design = undefined;
    designFor = undefined;
    designDoc = undefined;
    designFindings = [];
    structure = [];
    domStructure = [];
    eventsSeen = 0;
    emit();
    // A fresh load re-injects the content script; confirm rather than assume.
    setTimeout(checkHook, 600);
  });

  if (hasDevtools) {
    chrome.devtools.inspectedWindow.eval('location.href', (href: string) => {
      url = href || '';
      screenName = nameFromUrl(url);
      emit();
      checkHook();
      probeDesigner();
      setInterval(probeDesigner, 4000);
    });
  } else {
    // No DevTools API in a plain window: ask the worker what this tab is.
    const refreshTarget = () => {
      try {
        chrome.runtime.sendMessage({ type: 'listTabs' }, (reply) => {
          void chrome.runtime.lastError;
          const mine = (reply?.tabs ?? []).find((t: { id: number }) => t.id === tabId);
          if (mine) { url = mine.url; screenName = nameFromUrl(mine.url); emit(); }
        });
      } catch { /* worker asleep */ }
    };
    refreshTarget();
    setInterval(refreshTarget, 3000);   // the tab can navigate under us
    probeDesigner();
    // The developer switches designer tabs without a navigation.
    setInterval(probeDesigner, 4000);
    hookInstalled = true;
    emit();
  }

  return {
    /**
     * Resolve DevTools' selected element ($0) to a Fuuz element.
     *
     * The DOM carries `element` (the element type), `formelement` (the owning
     * form's name) and `data-data-path` (the bound field) — enough, combined
     * with the design, to name what you clicked.
     */
    pickElement: !hasDevtools ? undefined : function () {
      return new Promise<Snapshot['designElements'][number] & { field?: string; label?: string } | undefined>((resolve) => {
        chrome.devtools.inspectedWindow.eval(
          `(() => { let el = $0; while (el && el.nodeType === 1) {
             const type = el.getAttribute('element'), form = el.getAttribute('formelement');
             const path = el.getAttribute('data-data-path'), label = el.getAttribute('data-label');
             if (type || form || path) return JSON.stringify({ type, form, path, label });
             el = el.parentElement;
           } return null; })()`,
          (raw: unknown) => {
            try {
              const hit = raw ? JSON.parse(String(raw)) as { type?: string; form?: string; path?: string; label?: string } : null;
              resolve(hit ? { name: hit.form ?? hit.type ?? '?', type: hit.type ?? 'unknown', field: hit.path ?? undefined, label: hit.label ?? undefined } : undefined);
            } catch { resolve(undefined); }
          }
        );
      });
    },
    bridge: {
      async check(port) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/health`);
          if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
          const body = await res.json() as { connected?: boolean; setupCommand?: string; desktopConfig?: string };
          if (body.setupCommand) {
            try {
              chrome.storage?.local.set({ setupCommand: body.setupCommand, desktopConfig: body.desktopConfig });
            } catch { /* optional */ }
          }
          return {
            ok: true, connected: body.connected,
            setupCommand: body.setupCommand, desktopConfig: body.desktopConfig,
          };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
      setEnabled(enabled, port) {
        bridgeEnabled = enabled;
        bridgePort = port;
        bridgeError = undefined;
        try { chrome.storage?.local.set({ bridgeEnabled: enabled, bridgePort: port }); } catch { /* optional */ }
        if (enabled) { pollForCaptureRequests(); emit(); }   // push immediately so Claude isn't waiting
      },
      state() {
        return { enabled: bridgeEnabled, port: bridgePort, lastPushAt: bridgeLastPush, lastError: bridgeError };
      },
    },
    targeting: {
      /*
       * Switching tabs only makes sense from a window that is not tied to a page.
       *
       * A **docked** console lives inside one tab, so letting it target a different
       * one is how it ended up reading the designer while sitting on a running
       * screen — the panel and the page it is embedded in disagreed about what was
       * being inspected, which is incoherent rather than merely confusing.
       *
       * The App Designer is the exception: one tab genuinely holds several things
       * worth inspecting, so switching stays available there.
       */
      canSwitch: !hasDevtools && (!embedded || /applicationDesigner/i.test(url)),
      current: () => tabId,
      list: () => new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage({ type: 'listTabs' }, (reply) => {
            void chrome.runtime.lastError;
            resolve(reply?.tabs ?? []);
          });
        } catch { resolve([]); }
      }),
      watch(next) {
        if (next === tabId) return;
        tabId = next;
        // A different tab is a different screen: nothing carries over.
        entries = []; raw = []; network = []; dropped = 0; eventsSeen = 0;
      storeFlowEntries = []; flowTap = undefined;
      void askPage('resetFlowLogs');
        design = undefined; designFor = undefined; designDoc = undefined;
        designFindings = []; structure = []; domStructure = [];
        hookInstalled = false;
        url = ''; screenName = 'Screen';
        try { port.disconnect(); } catch { /* already gone */ }
        connect();
        emit();
        setTimeout(checkHook, 400);
      },
    },
    design: {
      apply: (edit) => askPage<ApplyOutcome>('writeDefinition', edit as unknown as Record<string, unknown>),
    },
    retention: {
      max: () => retention,
      setMax(next) {
        retention = Math.max(0, Math.floor(Number(next) || 0));
        // Raising it cannot bring back what was already dropped; lowering it takes
        // effect immediately rather than at the next entry, so the panel reflects
        // the choice at once.
        trim();
        try { chrome.storage?.local.set({ logRetention: retention }); } catch { /* optional */ }
        emit();
      },
    },
    nativeConsole: {
      hidden: (kind) => (kind === 'flowLog' ? hideFlowLogConsole : hideNativeConsole),
      setHidden(hidden, kind) {
        if (kind === 'flowLog') {
          hideFlowLogConsole = hidden;
          try { chrome.storage?.local.set({ hideFlowLogConsole: hidden }); } catch { /* optional */ }
        } else {
          hideNativeConsole = hidden;
          try { chrome.storage?.local.set({ hideNativeConsole: hidden }); } catch { /* optional */ }
        }
        pushNativeConsole();
        emit();
      },
    },
    reloadTab() {
      if (tabId === undefined) return;
      try { chrome.runtime.sendMessage({ type: 'reloadTab', tabId }); } catch { /* worker asleep */ }
    },
    styles: {
      read(target) {
        return new Promise((resolve) => {
          styleWaiters.push(resolve);
          try { port.postMessage({ type: 'getElementStyles', target }); }
          catch { resolve({ found: false }); }
          setTimeout(() => {
            const at = styleWaiters.indexOf(resolve);
            if (at >= 0) { styleWaiters.splice(at, 1); resolve({ found: false }); }
          }, 3000);
        });
      },
      apply(target, css) {
        try { port.postMessage({ type: 'applyElementStyle', target, css }); } catch { /* gone */ }
      },
    },
    element: {
      preview: (target, prop, value) => ask<{ ok: boolean; how?: string; note?: string; error?: string }>(
        () => port.postMessage({ type: 'previewProp', target, prop, value }),
        previewWaiters,
        { ok: false, error: 'The page did not answer.' }
      ),
      probe: (target) => ask<FiberProbe>(
        () => port.postMessage({ type: 'probeElement', target }),
        probeWaiters,
        {
          located: false, reached: false, path: [], fnKeys: [], propKeys: [], depth: 0,
          note: 'The page did not answer the probe — the content script may not be injected on this tab yet.',
        }
      ),
      call: (target, fn, args) => ask<{ ok: boolean; result?: unknown; error?: string }>(
        () => port.postMessage({ type: 'callElementFn', target, fn, args }),
        fnWaiters,
        { ok: false, error: 'The page did not answer within four seconds.' }
      ),
    },
    huntDesign: hunt,
    webmcp: {
      status: () => askPage('webmcpStatus'),
      register: () => askPage('webmcpRegister'),
      unregister: () => askPage('webmcpUnregister'),
      isolation: (enabled, token) => new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage({ type: 'originIsolation', enabled, token }, (reply) => {
            void chrome.runtime.lastError;
            resolve(reply ?? { enabled: false, supported: false, error: 'The service worker did not answer.' });
          });
        } catch { resolve({ enabled: false, supported: false, error: 'The service worker is unreachable.' }); }
      }),
    },
    flow: {
      node: (id) => askPage<{ found: boolean; node?: unknown; error?: string }>('flowNodeDetail', { id }),
      payloads: (node) => askPage('flowRunPayloads', { node }),
      api: () => askPage('engineApi'),
      setValue: (id, path, value) =>
        askPage<{ ok: boolean; error?: string; note?: string }>('setFlowNodeValue', { id, path, value }),
    },
    markup(action, tool) {
      try { port.postMessage({ type: 'markup', action, tool }); } catch { /* worker asleep */ }
    },
    overlay(mode) {
      try { port.postMessage({ type: 'overlay', mode, tabId }); } catch { /* worker asleep */ }
    },
    query: {
      /*
       * Every service call goes through the page.
       *
       * No token is read, stored or transmitted by us — the request is made by the app's own client,
       * which already holds whatever the session uses. See `pageServices.ts`.
       */
      async run(q, variables, service) {
        return askPage('pageQuery', { service: service ?? 'application', query: q, variables });
      },
      async describe(typeName) {
        return askPage('pageQuery', { service: 'system', query: TYPE_INTROSPECTION, variables: { name: typeName } });
      },
      logTypes: discoverLogTypes,
      /**
       * Every model the environment serves, for the script tab's model picker.
       *
       * Read from the schema itself rather than from a models query: introspection is
       * the same source the model browser uses, so the two can never disagree about
       * what exists. Input and payload types are filtered out — they are not models
       * and a picker full of `OrderCreateInput` is unusable.
       */
      async models() {
        const reply = await askPage<{ ok?: boolean; data?: unknown; error?: string }>(
          'pageQuery', { service: 'system', query: TYPE_SEARCH, variables: {} }
        );
        const types = (reply?.data as { __schema?: { types?: { name?: string; kind?: string }[] } } | undefined)
          ?.__schema?.types ?? [];
        const names = types
          .filter((t) => t.kind === 'OBJECT' && t.name && !t.name.startsWith('__'))
          .map((t) => t.name as string)
          // Input and payload types are not models, and a picker full of `OrderCreateInput` is unusable.
          .filter((n) => !/(Input|Payload|Connection|Edge|Aggregate|Response|Result)$/.test(n))
          .sort();
        return { ok: reply?.ok !== false, error: reply?.error, names };
      },
      async describeModel(name: string) {
        const reply = await askPage<{ data?: unknown }>(
          'pageQuery', { service: 'system', query: TYPE_INTROSPECTION, variables: { name } }
        );
        return toModelShape((reply?.data as { __type?: IntrospectedType } | undefined)?.__type);
      },
    },
    screenshot: capture,
    async evaluateRemote(expression, evalContext) {
      // Gated here because this request leaves from the panel rather than
      // through the worker — the other two enforcement points never see it.
      if (!mutationsAllowed(url)) {
        return { ok: false, error: refusalFor(url, 'evaluateRemote') };
      }
      /*
       * Server-side evaluation is an API call, so it is off too.
       *
       * The gate above still runs first, deliberately: a developer reading this should not
       * come away thinking the production check was removed along with the token.
       */
      void expression; void evalContext;
      return apiDisabled();
    },
    highlight(target, reveal) {
      lastHighlighted = target?.name;
      try { port.postMessage(target ? { type: 'highlight', target, reveal } : { type: 'clearHighlight' }); }
      catch { /* the page or worker went away */ }
    },
    onHighlightMiss(fn) { missFn = fn; },
    onHighlightVia(fn) { viaFn = fn; },
    post(msg) {
      if (msg.type === 'ready') emit();
      if (msg.type === 'clear') {
        entries = []; raw = []; network = []; dropped = 0;
        storeFlowEntries = []; void askPage('resetFlowLogs');
        emit();
      }
      if (msg.type === 'copy') void navigator.clipboard?.writeText(msg.text);
      // Redacted: the page holds a live session token and the hook captures
      // whatever it logs.
      if (msg.type === 'dumpRaw') {
        download(`dev-console-${Date.now()}.json`, JSON.stringify(redactTokens(raw), null, 2));
      }
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

/** Name the screen from its route — `/app/<app>/<screen>`. */
function nameFromUrl(href: string): string {
  try {
    const parts = new URL(href).pathname.split('/').filter(Boolean);
    const last = parts[parts.length - 1];
    if (last && !/^\d+$/.test(last) && last.length < 48) return decodeURIComponent(last);
  } catch { /* not a URL yet */ }
  return 'Screen';
}

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ── SSE (the CLI's `--serve` mode) ─────────────────────────────────────── */

export function sseHost(): Host {
  const listeners = new Set<(s: Snapshot) => void>();
  let latest: Snapshot | null = null;
  const events = new EventSource('./events');
  events.onmessage = (ev) => {
    try {
      const payload = JSON.parse(ev.data) as ScreenRunnerPayload;
      // The CLI captures over the DevTools protocol, which gives it no network
      // view, so the served console shows the log and state only.
      latest = {
        payload, network: [], issues: diagnose(payload.entries, []),
        pageUrl: payload.target?.url ?? '',
        designFindings: [], designElements: [], structure: [], designer: undefined,
        environment: classifyEnvironment(payload.target?.url ?? ''),
        context: [...payload.entries].reverse().find((e) => e.context)?.context,
        health: { hookInstalled: true, onRunRoute: true, eventsSeen: payload.entries.length },
      };
    } catch { return; }
    listeners.forEach((fn) => fn(latest!));
  };
  return {
    post(msg) {
      if (msg.type === 'ready' && latest) listeners.forEach((fn) => fn(latest!));
      if (msg.type === 'clear' || msg.type === 'reattach' || msg.type === 'dumpRaw') {
        void fetch('./command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msg) });
      }
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

/** Pick the host this build is running under. */
/**
 * Pick the shell this build is running under: the DevTools panel, our own
 * window (both extension contexts), or the CLI's served console.
 */
export function resolveHost(): Host {
  const inExtension = typeof chrome !== 'undefined' && !!chrome.runtime?.id;
  return inExtension ? devtoolsHost() : sseHost();
}
