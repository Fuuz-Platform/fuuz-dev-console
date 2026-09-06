/**
 * Fetch a screen's *deployed* design from the Fuuz API, using the signed-in
 * user's own session.
 *
 * This matters more than it sounds. Joining against a design file checked into
 * a repo doesn't merely fail to attribute — it can attribute *wrongly*: the
 * Asset Intake seed at v0.0.7 named `IntakeSubmit`, while the screen actually
 * running (v0.0.15) computes that property on `IntakePrepare`, and its `url`
 * belongs to a `TusUploader` element the seed has never heard of. Reading the
 * deployed version removes the whole class of error.
 *
 * Pure aside from an injected `fetch`, so it is testable without a network.
 */

/** The API host that serves a given app host — `admin.fuuz.app` → `api.admin.fuuz.app`. */
export function apiBaseFor(pageUrl: string): string | undefined {
  try {
    const { protocol, host } = new URL(pageUrl);
    if (!/\.fuuz\.app$/.test(host)) return undefined;
    return `${protocol}//${host.startsWith('api.') ? host : `api.${host}`}`;
  } catch {
    return undefined;
  }
}

/**
 * The screen version being run.
 *
 * `metadata.urlParameters.screenVersionId` is the authoritative source and works
 * on every route — the designer's preview, the deployed app route, anywhere. The
 * URL patterns below are only a fallback for the window before any context
 * snapshot has arrived, and deliberately cover more than one shape: `/run` is
 * how a *deployed* screen is opened, not how one under development is.
 */
export function screenVersionIdFrom(context: unknown, pageUrl = ''): string | undefined {
  const fromContext = (context as { metadata?: { urlParameters?: { screenVersionId?: unknown } } } | null)
    ?.metadata?.urlParameters?.screenVersionId;
  if (typeof fromContext === 'string' && fromContext) return fromContext;
  const patterns = [
    /\/screens\/([A-Za-z0-9_-]{16,})(?:\/|\?|$)/,        // …/screens/<id>[/run]
    /[?&]screenVersionId=([A-Za-z0-9_-]{16,})/,           // an explicit query param
    /[?&]screenId=([A-Za-z0-9_-]{16,})/,
  ];
  for (const pattern of patterns) {
    const m = pageUrl.match(pattern);
    if (m) return m[1];
  }
  return undefined;
}

/** `id` is a String in this schema, not an ID — an `ID!` variable is rejected. */
export const SCREEN_VERSION_QUERY =
  'query($id:String!){ screenVersion(where:{id:{_eq:$id}}, first:1){ edges { node { ' +
  'id number deployed design screen { name } } } } }';

/**
 * Resolve by *screen* id instead of version id.
 *
 * The App Designer identifies an open tab by screen, not by version. Transforms
 * *do* run on its canvas — an earlier note here claiming otherwise was wrong —
 * but the context they carry is a shell: `urlParameters` is `{}`, `screen` is
 * null and `components` is empty. So a version id never arrives that way, and
 * the open tab's screen id is the only handle on which screen is being edited.
 *
 * Structure no longer depends on this succeeding: the designer renders its own
 * tree keyed by craft node id, which `core/domStructure` reads directly. This
 * query is what upgrades that tree to types, transforms and bound fields.
 *
 * Ordered newest-first so the tab shows the version being edited.
 */
export const SCREEN_LATEST_VERSION_QUERY =
  'query($id:String!){ screenVersion(where:{screenId:{_eq:$id}}, orderBy:{number:desc}, first:1){ ' +
  'edges { node { id number deployed design screen { name } } } } }';

export interface ScreenDesignDoc {
  name: string;
  version?: string;
  design: unknown;
  deployed?: boolean;
}

type FetchLike = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface FetchDesignOptions {
  apiBase: string;
  token: string;
  /** A screenVersion id, or — with `byScreenId` — a screen id. */
  screenVersionId: string;
  /** Resolve the newest version of a screen rather than one exact version. */
  byScreenId?: boolean;
  fetchFn: FetchLike;
}

/**
 * Returns a document shaped for {@link indexScreenDesign}, or undefined when the
 * design can't be read. Never throws: the console must keep working without it.
 */
export async function fetchScreenDesign(opts: FetchDesignOptions): Promise<ScreenDesignDoc | undefined> {
  try {
    const res = await opts.fetchFn(`${opts.apiBase}/application`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.token}` },
      body: JSON.stringify({
        query: opts.byScreenId ? SCREEN_LATEST_VERSION_QUERY : SCREEN_VERSION_QUERY,
        variables: { id: opts.screenVersionId },
      }),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as {
      errors?: unknown[];
      data?: { screenVersion?: { edges?: { node?: Record<string, unknown> }[] } };
    };
    if (body.errors?.length) return undefined;

    const node = body.data?.screenVersion?.edges?.[0]?.node;
    if (!node?.design) return undefined;
    return {
      name: (node.screen as { name?: string } | undefined)?.name ?? 'Screen',
      version: node.number === undefined || node.number === null ? undefined : String(node.number),
      design: node.design,
      deployed: node.deployed === true,
    };
  } catch {
    return undefined;
  }
}

/**
 * Blank anything that looks like a JWT.
 *
 * The console hook captures whatever the page logs, and the page holds a live
 * session token — so a raw dump must never carry one off the machine.
 */
export function redactTokens<T>(value: T): T {
  const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g;
  if (typeof value === 'string') return value.replace(JWT, '[redacted-jwt]') as unknown as T;
  return JSON.parse(
    JSON.stringify(value, (_k, v) => (typeof v === 'string' ? v.replace(JWT, '[redacted-jwt]') : v))
  ) as T;
}
