/**
 * The Fuuz services reachable from a page the extension is watching.
 *
 * Every endpoint derives from the environment slug in the host:
 * `admin.fuuz.app` → `https://api.admin.fuuz.app/...`, the same derivation the
 * VS Code extension does from an enterprise's `environment`.
 *
 * ## Why the extension can call these at all
 *
 * Three things line up, and all three are already true:
 *
 *  1. `host_permissions: ["https://*.fuuz.app/*"]` lets extension pages (the
 *     panel, the service worker) issue cross-origin requests to any Fuuz
 *     service without CORS applying — extension pages are not web origins.
 *  2. Fuuz authenticates with a **bearer JWT in `localStorage.token`**, not a
 *     cookie. So a request carries the user's identity only if we attach it
 *     deliberately; nothing is sent ambiently, and nothing is sent from a
 *     page context we do not control.
 *  3. The isolated-world content script shares the page's `localStorage`, so it
 *     can read that token and hand it to the panel — which is exactly how the
 *     design fetch already works.
 *
 * The consequence worth stating plainly: **the token is the user's own session**,
 * with the user's own permissions, and it must never leave the machine. It is
 * why `apiBaseFor` refuses any host that is not `*.fuuz.app`, and why raw dumps
 * run through `redactTokens`.
 *
 * ## Verified vs inferred
 *
 * `/application` is verified — it is what fetches screen designs today, against
 * the live API. The rest are derived from the platform's documented behaviour
 * and from measurements recorded in this repo; their request *shapes* are noted
 * per endpoint, and anything unverified says so rather than pretending.
 *
 * Pure.
 */

export type ServiceName =
  | 'application'
  | 'system'
  | 'transformation'
  | 'executeFlow'
  | 'mcp'
  | 'resource'
  | 'webhook';

export interface ServiceInfo {
  name: ServiceName;
  url: string;
  /** Whether this extension has actually exercised it against a live tenant. */
  verified: boolean;
  purpose: string;
}

/** The API host serving a given app host — `admin.fuuz.app` → `api.admin.fuuz.app`. */
export function apiBase(pageUrl: string): string | undefined {
  try {
    const { protocol, host } = new URL(pageUrl);
    if (!/\.fuuz\.app$/.test(host)) return undefined;
    return `${protocol}//${host.startsWith('api.') ? host : `api.${host}`}`;
  } catch {
    return undefined;
  }
}

/** The environment slug — `admin`, `build.mfgx` — or undefined off-platform. */
export function environmentSlug(pageUrl: string): string | undefined {
  const base = apiBase(pageUrl);
  if (!base) return undefined;
  return new URL(base).host.replace(/^api\./, '').replace(/\.fuuz\.app$/, '') || undefined;
}

export function services(pageUrl: string): ServiceInfo[] {
  const base = apiBase(pageUrl);
  if (!base) return [];
  return [
    {
      name: 'application', url: `${base}/application`, verified: true,
      purpose: 'GraphQL for application records — screens, screen versions, designs, flows.',
    },
    {
      name: 'system', url: `${base}/system`, verified: false,
      purpose: 'GraphQL for system/tenant records, alongside /application.',
    },
    {
      name: 'transformation', url: `${base}/transformation`, verified: false,
      purpose: 'Evaluates a JSONata transform server-side — the path a transform with remote:true takes.',
    },
    {
      name: 'executeFlow', url: `${base}/orchestration/executeFlow`, verified: false,
      purpose: 'Runs an Integration or System flow. Screen ("web") flows do not use this — they run in the browser.',
    },
    { name: 'mcp', url: `${base}/mcp`, verified: false, purpose: 'The tenant MCP server.' },
    { name: 'resource', url: `${base}/resource`, verified: false, purpose: 'Resource/file service.' },
    { name: 'webhook', url: `${base}/webhook/post/{topic}`, verified: false, purpose: 'Publishes to a topic.' },
  ];
}

export function serviceUrl(pageUrl: string, name: ServiceName): string | undefined {
  return services(pageUrl).find((s) => s.name === name)?.url;
}

/* ── Arbitrary GraphQL, and schema discovery ─────────────────────────────── */

/**
 * Run any GraphQL query against a Fuuz service, as the signed-in user.
 *
 * The design fetch proved this path works; restricting it to one hard-coded query
 * was the limitation. Backend logs — `DataFlowDeploymentLog` and the integration
 * equivalent — are models like any other, so the console can read them with the
 * identifiers it already has from each execution: `flowId`, `versionId`,
 * `deploymentId`, `tenantId`.
 *
 * That closes a real gap. A Screen flow runs in the browser and is fully visible;
 * an **Integration flow runs server-side and is invisible here**, because nothing
 * executes locally to capture. Its log only exists in the backend.
 */
export async function graphql(opts: {
  pageUrl: string;
  token: string;
  service?: ServiceName;
  query: string;
  variables?: Record<string, unknown>;
  fetchFn: FetchLike;
}): Promise<{ ok: boolean; data?: unknown; errors?: unknown[]; status?: number; error?: string }> {
  const url = serviceUrl(opts.pageUrl, opts.service ?? 'application');
  if (!url) return { ok: false, error: 'Not a Fuuz page, so there is no service to query.' };
  try {
    const res = await opts.fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.token}` },
      body: JSON.stringify({ query: opts.query, variables: opts.variables ?? {} }),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* keep the text for diagnosis */ }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: res.status, error: 'The session token was rejected — it expires after about 15 minutes. Reload the Fuuz tab.' };
    }
    const body = parsed as { data?: unknown; errors?: unknown[] };
    // Errors inside a 200 are the Fuuz norm, so they are surfaced rather than
    // being read as success with missing data.
    if (body?.errors?.length) return { ok: false, status: res.status, data: body.data, errors: body.errors };
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}`, data: parsed };
    return { ok: true, status: res.status, data: body?.data ?? parsed };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Ask the schema what a model is called and what fields it has.
 *
 * Guessing a model name and field list is how the last two rounds went wrong.
 * Introspection makes the schema answer instead — so a log query is written
 * against what exists rather than what seems likely.
 */
export const TYPE_INTROSPECTION =
  'query($name:String!){ __type(name:$name){ name kind ' +
  'fields { name type { name kind ofType { name kind ofType { name } } } } } }';

/** Every type whose name matches, for finding what the log model is actually called. */
export const TYPE_SEARCH =
  'query{ __schema { types { name kind } } }';

/** Filter an introspected schema to plausible log models. */
export function findLogTypes(schema: unknown): string[] {
  const types = (schema as { __schema?: { types?: { name?: string; kind?: string }[] } } | undefined)?.__schema?.types;
  if (!Array.isArray(types)) return [];
  return types
    .map((t) => t.name ?? '')
    .filter((n) => /log/i.test(n) && !/^__/.test(n))
    .sort();
}

/* ── Remote transform evaluation ─────────────────────────────────────────── */

export interface RemoteEvalResult {
  ok: boolean;
  /** The evaluated value, when the service returned one. */
  value?: unknown;
  /** HTTP status, for diagnosing an auth or routing failure. */
  status?: number;
  error?: string;
  /** Exactly what came back, so an unexpected shape is visible not swallowed. */
  raw?: unknown;
  /** Which request shape produced this — see `REMOTE_BODY_SHAPES`. */
  shape?: string;
}

/**
 * Candidate request bodies for `/transformation`.
 *
 * The endpoint is real — a `remote: true` transform posts to it, measured in
 * this repo — but its request body is **not** documented anywhere we control,
 * and guessing silently would be the worst outcome: a wrong shape returns an
 * error that looks like the user's expression is broken.
 *
 * So we try the plausible shapes in order and report which one worked. The first
 * live run settles it permanently; until then the panel labels remote results as
 * unverified and the local JSONata engine stays the default.
 */
export const REMOTE_BODY_SHAPES: { id: string; body: (expr: string, context: unknown) => unknown }[] = [
  { id: 'transformation+context', body: (transformation, context) => ({ transformation, context }) },
  { id: 'transform+context', body: (transform, context) => ({ transform, context }) },
  { id: 'expression+context', body: (expression, context) => ({ expression, context }) },
  { id: 'transformation+payload', body: (transformation, payload) => ({ transformation, payload }) },
];

type FetchLike = (url: string, init: {
  method: string; headers: Record<string, string>; body: string;
}) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** Pull a value out of whatever envelope the service uses. */
function unwrap(body: unknown): { found: boolean; value?: unknown } {
  if (body === null || typeof body !== 'object') return { found: true, value: body };
  const rec = body as Record<string, unknown>;
  if ('errors' in rec && Array.isArray(rec.errors) && rec.errors.length) return { found: false };
  for (const key of ['result', 'value', 'data', 'output']) {
    if (key in rec) return { found: true, value: rec[key] };
  }
  return { found: true, value: body };
}

/**
 * Evaluate an expression the way the platform would.
 *
 * Worth the round trip because the local `jsonata` package is only *the language*
 * — the platform adds its own function library ($base64encode, $executeFlow, the
 * `$components.X.fn.*` bags), so an expression can evaluate here and fail there,
 * or the reverse. Never throws.
 */
export async function evaluateRemote(opts: {
  pageUrl: string;
  token: string;
  expression: string;
  context: unknown;
  fetchFn: FetchLike;
  /** Restrict to one known-good shape once we have learned it. */
  shape?: string;
}): Promise<RemoteEvalResult> {
  const url = serviceUrl(opts.pageUrl, 'transformation');
  if (!url) return { ok: false, error: 'Not a Fuuz page, so no transformation service to call.' };

  const shapes = opts.shape
    ? REMOTE_BODY_SHAPES.filter((s) => s.id === opts.shape)
    : REMOTE_BODY_SHAPES;
  let last: RemoteEvalResult = { ok: false, error: 'No request shape was accepted.' };

  for (const shape of shapes) {
    try {
      const res = await opts.fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.token}` },
        body: JSON.stringify(shape.body(opts.expression, opts.context)),
      });
      const text = await res.text();
      let parsed: unknown = text;
      try { parsed = JSON.parse(text); } catch { /* not JSON; keep the text */ }

      // 401/403 is about the token, not the shape — retrying other shapes would
      // just repeat the same rejection, so stop and say so.
      if (res.status === 401 || res.status === 403) {
        return { ok: false, status: res.status, raw: parsed, shape: shape.id,
          error: 'The session token was rejected. It expires after about 15 minutes — reload the Fuuz tab.' };
      }
      if (!res.ok) { last = { ok: false, status: res.status, raw: parsed, shape: shape.id, error: `HTTP ${res.status}` }; continue; }

      const { found, value } = unwrap(parsed);
      if (!found) { last = { ok: false, status: res.status, raw: parsed, shape: shape.id, error: 'The service returned errors.' }; continue; }
      return { ok: true, value, status: res.status, raw: parsed, shape: shape.id };
    } catch (e) {
      last = { ok: false, shape: shape.id, error: e instanceof Error ? e.message : String(e) };
    }
  }
  return last;
}
