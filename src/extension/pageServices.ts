/**
 * Calling the Fuuz services **as the page does**, not as an outsider.
 *
 * The previous approach read a session token out of storage and issued our own authenticated
 * request. That never worked on a live tenant: whatever key the token lives under, the search did
 * not find it — and every API-backed feature failed at a distance because of it.
 *
 * It was also the wrong shape. A normal Fuuz screen calling `$query` does not hunt for a token; the
 * app already holds an authenticated client, and the request goes through it. Running in the page's
 * own context inherits that automatically — whether the credential is a cookie, an in-memory bearer
 * held by Apollo's link chain, or a fetch interceptor installed at boot. We never see the
 * credential, never store it, and cannot leak it, which is a better security posture than the token
 * copy we were attempting.
 *
 * Three routes, in order of how much of the app's own machinery they reuse:
 *
 *   1. **Apollo** — `__APOLLO_CLIENT__.query`. The app's exact link chain: auth, headers, error
 *      handling, tenant routing. What a screen actually uses.
 *   2. **A page fetch to the same endpoint**, with `credentials: 'include'`. Works when auth is a
 *      cookie or an interceptor patched `window.fetch`.
 *   3. Nothing — reported honestly, with what was tried.
 *
 * MAIN world: none of this is reachable from an isolated content script, which is the whole point.
 */

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

export interface PageQueryResult {
  ok: boolean;
  data?: unknown;
  errors?: unknown[];
  /** Which route answered, so a failure is attributable rather than mysterious. */
  via?: string;
  status?: number;
  error?: string;
  /** Every route attempted, for when none worked. */
  tried?: { route: string; ok: boolean; note?: string }[];
}

/** The service endpoint for this page — `admin.fuuz.app` → `https://api.admin.fuuz.app/system`. */
function endpoint(service: string): string | undefined {
  try {
    const { protocol, host } = window.location;
    if (!/\.fuuz\.app$/.test(host)) return undefined;
    const api = host.startsWith('api.') ? host : `api.${host}`;
    return `${protocol}//${api}/${service}`;
  } catch {
    return undefined;
  }
}

/**
 * Run a GraphQL document through the app's own client.
 *
 * `gql` is not available to us, so the query is passed as a parsed document only if Apollo exposes
 * its parser; otherwise this route is skipped rather than guessed at. Apollo requires a parsed
 * `DocumentNode` — handing it a string throws, and catching that to fall through is exactly the
 * silent-failure pattern worth avoiding, so the capability is checked first.
 */
async function viaApollo(
  query: string,
  variables: Record<string, unknown>
): Promise<PageQueryResult | undefined> {
  const client = (window as unknown as {
    __APOLLO_CLIENT__?: {
      query?: (o: unknown) => Promise<unknown>;
      mutate?: (o: unknown) => Promise<unknown>;
    };
  }).__APOLLO_CLIENT__;
  if (!client?.query) return undefined;

  // Apollo ships its parser on the global in most builds; without it we cannot build a document.
  const gql = (window as unknown as { gql?: (s: TemplateStringsArray | string) => unknown }).gql
    ?? (window as unknown as { graphql?: { parse?: (s: string) => unknown } }).graphql?.parse;
  if (typeof gql !== 'function') return undefined;

  try {
    const document = (gql as (s: string) => unknown)(query);
    const writes = /(^|[\s{}()])mutation\b/i.test(query);
    const run = writes ? client.mutate : client.query;
    if (typeof run !== 'function') return undefined;
    const reply = await run.call(client, {
      [writes ? 'mutation' : 'query']: document,
      variables,
      // The cache would answer from stale data, which is the opposite of what a diagnostic wants.
      fetchPolicy: 'no-cache',
      errorPolicy: 'all',
    }) as { data?: unknown; errors?: unknown[] };
    return {
      ok: !reply?.errors?.length,
      data: reply?.data,
      errors: reply?.errors,
      via: 'the app’s Apollo client',
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), via: 'the app’s Apollo client' };
  }
}

/**
 * Post to the service from the page.
 *
 * `credentials: 'include'` because the page's own requests carry whatever the session uses; if an
 * interceptor has wrapped `window.fetch` to attach a bearer, this inherits that too — which is the
 * common case and the reason this works where an extension-context request did not.
 */
async function viaFetch(
  service: string,
  query: string,
  variables: Record<string, unknown>
): Promise<PageQueryResult> {
  const url = endpoint(service);
  if (!url) return { ok: false, error: 'Not a Fuuz page, so there is no service to call.' };

  const res = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* keep the text, which is the diagnosis */ }

  if (res.status === 401 || res.status === 403) {
    return {
      ok: false, status: res.status, via: 'a page fetch',
      error: 'The service rejected the request even from the page — the session may have expired. Reload the Fuuz tab.',
    };
  }
  const body = isRecord(parsed) ? parsed as { data?: unknown; errors?: unknown[] } : undefined;
  // Errors inside a 200 are the Fuuz norm, so they surface rather than reading as success.
  if (body?.errors?.length) return { ok: false, status: res.status, data: body.data, errors: body.errors, via: 'a page fetch' };
  if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}`, data: parsed, via: 'a page fetch' };
  return { ok: true, status: res.status, data: body?.data ?? parsed, via: 'a page fetch' };
}

/**
 * Query a Fuuz service using whatever the page already has.
 *
 * Apollo first because it is the app's real path — same link chain, same auth, same tenant routing
 * as a screen's own `$query`. The direct fetch is the fallback for services Apollo is not wired to,
 * which includes `system` on some builds.
 */
export async function pageQuery(
  service: string,
  query: string,
  variables: Record<string, unknown> = {}
): Promise<PageQueryResult> {
  const tried: { route: string; ok: boolean; note?: string }[] = [];

  /*
   * Apollo is only used for the application service.
   *
   * Its client is configured against one endpoint; routing a `system` query through it would send it
   * to the wrong service and return errors that look like the query being wrong.
   */
  if (service === 'application') {
    const apollo = await viaApollo(query, variables);
    if (apollo?.ok) return { ...apollo, tried };
    tried.push({ route: 'apollo', ok: false, note: apollo?.error ?? 'no client, or no parser to build a document' });
  }

  try {
    const direct = await viaFetch(service, query, variables);
    tried.push({ route: 'page fetch', ok: direct.ok, note: direct.error });
    return { ...direct, tried };
  } catch (e) {
    tried.push({ route: 'page fetch', ok: false, note: e instanceof Error ? e.message : String(e) });
    return { ok: false, error: 'No route to the service worked from this page.', tried };
  }
}
