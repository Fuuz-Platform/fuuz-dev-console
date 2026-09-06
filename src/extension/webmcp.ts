/**
 * Register the console's diagnostics as WebMCP tools on the Fuuz page.
 *
 * Why this exists alongside the stdio MCP server: the bridge needs a local Node
 * process, `claude mcp add`, and a loopback port, so it only ever serves Claude
 * Code. WebMCP needs none of that — any in-browser agent on the page can call
 * these — which is the one requirement the bridge structurally cannot meet.
 *
 * ## Deliberately read-only
 *
 * Only tools that *read* are registered. Nothing here calls an element's `fn`
 * bag, sets a style, or evaluates server-side. Those stay behind the panel's own
 * production gate, where the environment is checked in two privileged places; a
 * page-registered tool is reachable by any agent that lands on the tab, which is
 * a much wider door than a developer clicking a button in a panel.
 *
 * ## Where the answers come from
 *
 * The analysis — classification, the state tree, diagnosed issues, the element
 * tree — lives in the panel, not here. So each tool's `execute` asks the panel
 * and returns its answer:
 *
 *     page (this) → relay → service worker → panel → back
 *
 * That keeps one implementation of the pipeline instead of a second, divergent
 * copy in the page. With no panel open the tools say so rather than returning
 * an empty result that reads like a healthy screen.
 *
 * ## Two honest limits of WebMCP today
 *
 * `execute` returns a **string**, and binary/multimodal output plus output
 * schemas are open questions in the spec. So the screenshot tool is not
 * registered here at all — it returns a PNG, which has no representation — and
 * structured results are JSON-stringified, losing the schema contract the stdio
 * tools keep.
 */

/** Only ever on Fuuz hosts, whatever else the page might be. */
const FUUZ_HOST = /\.fuuz\.app$/;

interface ToolSpec {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  /** What the panel is asked for, and how its reply becomes a string. */
  query: string;
  /**
   * Whether the result can contain values the *page* authored.
   *
   * Console output and screen state are whatever the app put there, so an agent
   * must treat them as data rather than instructions. The spec has a word for
   * this and it would be careless not to use it.
   */
  untrusted?: boolean;
}

const TOOLS: ToolSpec[] = [
  {
    name: 'fuuz_screen_status',
    description:
      'Whether the Fuuz Dev Console is capturing this screen, which screen it is, and how much has been captured. Call this first if another tool reports nothing.',
    inputSchema: { type: 'object', properties: {} },
    query: 'status',
  },
  {
    name: 'fuuz_screen_elements',
    description:
      "The screen's element tree as authored — every container, form, input and button with its type, bound field, applied CSS, and the live state the runtime holds for it.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Restrict to one element by name, e.g. "AssetIntakeForm".' },
      },
    },
    query: 'elements',
    untrusted: true,
  },
  {
    name: 'fuuz_screen_state',
    description:
      "The screen's current state, read from the context snapshot the runtime logs. Pass a dot path such as components.TicketTable.data for one subtree.",
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Dot path, e.g. components.AssetIntakeForm.data' },
        depth: { type: 'number', description: 'Max depth to return (default 4).' },
      },
    },
    query: 'state',
    untrusted: true,
  },
  {
    name: 'fuuz_screen_issues',
    description:
      'Problems diagnosed in the captured run, ranked — transform errors, values read from paths that do not exist, repeated queries, GraphQL errors returned inside a 200, and static findings over the design.',
    inputSchema: { type: 'object', properties: {} },
    query: 'issues',
    untrusted: true,
  },
  {
    name: 'fuuz_screen_log',
    description:
      'The classified execution log — each transform with the expression it ran, what it wrote, and what it produced. Filter by substring.',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string' },
        limit: { type: 'number', description: 'Default 50, newest last.' },
      },
    },
    query: 'log',
    untrusted: true,
  },
  {
    name: 'fuuz_screen_eval',
    description:
      "Evaluate a JSONata expression against the screen's live context, with $metadata and $components bound as the runtime binds them. Read-only: evaluating never changes the screen. Use it to check a transform before putting it in the designer.",
    inputSchema: {
      type: 'object',
      properties: { expression: { type: 'string' } },
      required: ['expression'],
    },
    query: 'eval',
    untrusted: true,
  },
];

/* ── The channel back to the panel ───────────────────────────────────────── */

const REQ = 'fuuz-devtool-panel-request';
const RES = 'fuuz-devtool-panel-response';

let seq = 0;
const waiters = new Map<number, (result: unknown) => void>();

function installPanelReplyListener(): void {
  window.addEventListener('message', (e: MessageEvent) => {
    // Same guard as everywhere else: origin is what actually keeps a
    // cross-origin frame out, and `null`/`''` is jsdom's same-window shape.
    const sourceOk = e.source === window || e.source === null;
    const originOk = e.origin === '' || e.origin === location.origin;
    if (!sourceOk || !originOk) return;
    const msg = e.data as { source?: string; id?: number; result?: unknown } | null;
    if (!msg || msg.source !== RES || typeof msg.id !== 'number') return;
    const waiter = waiters.get(msg.id);
    if (!waiter) return;
    waiters.delete(msg.id);
    waiter(msg.result);
  });
}

function askPanel(query: string, args: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    const id = ++seq;
    waiters.set(id, resolve);
    window.postMessage({ source: REQ, id, query, args }, '*');
    setTimeout(() => {
      if (!waiters.delete(id)) return;
      resolve({
        error:
          'The Fuuz Dev Console panel did not answer. Open it on this tab (click the extension icon) ' +
          'and interact with the screen so a transform fires.',
      });
    }, 5000);
  });
}

/* ── Registration ────────────────────────────────────────────────────────── */

interface ModelContext {
  registerTool(
    tool: {
      name: string;
      description: string;
      inputSchema: unknown;
      execute: (params: Record<string, unknown>) => Promise<string>;
      annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
    },
    options?: { signal?: AbortSignal }
  ): Promise<void>;
}

/**
 * Why the API is not there, and what to do about it.
 *
 * Origin isolation and the API being *enabled* are separate gates with separate
 * fixes, and the message has to name whichever is actually blocking — otherwise
 * "document.modelContext is missing" sends you back to a header you already set.
 * Shared by `status()` and `registerWebMcpTools()` so the two cannot disagree,
 * which they did: one reported the symptom, the other the fix.
 */
function unavailable(isolated: boolean): string {
  if (!isolated) {
    return 'This document is not origin-isolated, which WebMCP requires. Enable the header rule '
      + 'above, then open Fuuz in a NEW tab — a refresh will not do it.';
  }
  return 'Origin isolation is set, so the remaining gate is the API itself: it ships behind a flag '
    + 'or an origin trial. Open chrome://flags/#enable-webmcp-testing, set Enabled, relaunch Chrome, '
    + 'then reload this page. For a rollout rather than a test, register the origin for the WebMCP '
    + 'trial and paste the token below instead — no flag needed then.';
}

export interface WebMcpStatus {
  /** Whether the API exists at all — needs Chrome 149+ and origin isolation. */
  available: boolean;
  /** Whether this page is origin-isolated, which the API requires. */
  originIsolated: boolean;
  registered: string[];
  reason?: string;
}

let controller: AbortController | undefined;

/**
 * Register the read-only tools, replacing any previous registration.
 *
 * Returns a status rather than throwing: the API is behind an origin trial and a
 * flag, so "not available" is the normal case and has to be reportable.
 */
export async function registerWebMcpTools(): Promise<WebMcpStatus> {
  const isolated = (window as unknown as { originAgentCluster?: boolean }).originAgentCluster === true;
  const ctx = (document as unknown as { modelContext?: ModelContext }).modelContext;

  if (!FUUZ_HOST.test(location.host)) {
    return { available: false, originIsolated: isolated, registered: [], reason: `${location.host} is not a Fuuz host.` };
  }
  if (!ctx || typeof ctx.registerTool !== 'function') {
    return {
      available: false,
      originIsolated: isolated,
      registered: [],
      reason: unavailable(isolated),
    };
  }

  // Replace rather than accumulate: re-running would otherwise register a second
  // copy of every tool under the same name.
  controller?.abort();
  controller = new AbortController();
  installPanelReplyListener();

  const registered: string[] = [];
  for (const tool of TOOLS) {
    try {
      await ctx.registerTool({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          // Every tool here reads. Nothing mutates, by design.
          readOnlyHint: true,
          untrustedContentHint: tool.untrusted === true,
        },
        execute: async (params) => {
          const result = await askPanel(tool.query, params ?? {});
          // WebMCP's execute returns a string today, so structured results are
          // stringified and lose their schema. Stated here rather than hidden.
          return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        },
      }, { signal: controller.signal });
      registered.push(tool.name);
    } catch (e) {
      return {
        available: true, originIsolated: isolated, registered,
        reason: `registerTool failed on ${tool.name}: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }
  return { available: true, originIsolated: isolated, registered };
}

/** Remove every tool this extension registered. */
export function unregisterWebMcpTools(): void {
  controller?.abort();
  controller = undefined;
}

/** For the panel's status display, without registering anything. */
export function webMcpStatus(): WebMcpStatus {
  const isolated = (window as unknown as { originAgentCluster?: boolean }).originAgentCluster === true;
  const ctx = (document as unknown as { modelContext?: unknown }).modelContext;
  return {
    available: !!ctx,
    originIsolated: isolated,
    registered: controller ? TOOLS.map((t) => t.name) : [],
    reason: ctx ? undefined : unavailable(isolated),
  };
}

/** The tool set, for tests and for the panel to display. */
export const WEBMCP_TOOL_NAMES = TOOLS.map((t) => t.name);
