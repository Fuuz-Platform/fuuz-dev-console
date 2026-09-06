/**
 * Network activity, normalized.
 *
 * DevTools hands requests over as HAR entries. This flattens them to what
 * actually matters when a screen misbehaves — status, timing, size, and
 * crucially the **GraphQL errors hidden inside HTTP 200 responses**, which the
 * browser's own Network tab shows as green and successful.
 *
 * Pure: no chrome APIs, so the rules and the report stay testable.
 */

export interface NetworkEntry {
  /** Which designer surface was open when this request was captured. */
  surface?: string;

  id: string;
  seq: number;
  epoch: number;
  /** `HH:MM:SS.mmm`, local. */
  ts: string;
  method: string;
  url: string;
  /** Path (and query) only — full URLs make the table unreadable. */
  path: string;
  status: number;
  durationMs: number;
  sizeBytes: number;
  mimeType?: string;
  /** GraphQL operation name, when the request body names one. */
  operation?: string;
  /** Messages from a GraphQL `errors[]`, even on a 200. */
  graphqlErrors?: string[];
  /** Transport failure or status ≥ 400. */
  failed: boolean;
  /** Stable key for "the same call again" — method + path + body. */
  fingerprint: string;
}

/** The slice of a HAR entry we read. */
export interface HarEntry {
  startedDateTime?: string;
  time?: number;
  request?: {
    method?: string;
    url?: string;
    postData?: { text?: string };
  };
  response?: {
    status?: number;
    content?: { size?: number; mimeType?: string };
    _transferSize?: number | null;
  };
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function stamp(epoch: number): string {
  const d = new Date(epoch);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** A short, stable hash — enough to spot the identical call repeating. */
function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * Pull the operation name and any errors out of a GraphQL exchange.
 *
 * A Fuuz screen talks to `/application` and `/system` almost exclusively, and a
 * failed query there still returns 200 — so this is where most real breakage
 * hides.
 */
export function readGraphql(requestBody: string | undefined, responseBody: string | undefined): {
  operation?: string;
  errors?: string[];
} {
  let operation: string | undefined;
  if (requestBody) {
    try {
      const parsed = JSON.parse(requestBody) as { operationName?: string; query?: string };
      operation = parsed.operationName || undefined;
      if (!operation && typeof parsed.query === 'string') {
        // `query Foo(...)`, or the first selected field of an anonymous query.
        const named = parsed.query.match(/^\s*(?:query|mutation)\s+([A-Za-z_]\w*)/);
        const field = parsed.query.match(/\{\s*([A-Za-z_]\w*)/);
        operation = named?.[1] ?? field?.[1];
      }
    } catch { /* not JSON — not a GraphQL call */ }
  }

  let errors: string[] | undefined;
  if (responseBody) {
    try {
      const parsed = JSON.parse(responseBody) as { errors?: { message?: string }[] };
      if (Array.isArray(parsed.errors) && parsed.errors.length) {
        errors = parsed.errors.map((e) => e?.message ?? 'unknown GraphQL error').slice(0, 10);
      }
    } catch { /* not JSON */ }
  }
  return { operation, errors };
}

export function normalizeRequest(
  har: HarEntry,
  seq: number,
  responseBody?: string
): NetworkEntry {
  const method = har.request?.method ?? 'GET';
  const url = har.request?.url ?? '';
  const status = har.response?.status ?? 0;
  const requestBody = har.request?.postData?.text;
  const { operation, errors } = readGraphql(requestBody, responseBody);

  let path = url;
  try { const u = new URL(url); path = u.pathname + (u.search || ''); } catch { /* keep the raw url */ }

  const epoch = har.startedDateTime ? Date.parse(har.startedDateTime) : Date.now();

  return {
    id: `n${seq}`,
    seq,
    epoch: Number.isFinite(epoch) ? epoch : Date.now(),
    ts: stamp(Number.isFinite(epoch) ? epoch : Date.now()),
    method,
    url,
    path,
    status,
    durationMs: Math.max(0, Math.round(har.time ?? 0)),
    sizeBytes: har.response?._transferSize ?? har.response?.content?.size ?? 0,
    mimeType: har.response?.content?.mimeType,
    operation,
    graphqlErrors: errors,
    // status 0 is a transport failure (blocked, aborted, DNS) — not a success.
    failed: status === 0 || status >= 400,
    fingerprint: hash(`${method} ${path} ${requestBody ?? ''}`),
  };
}

/** Human-readable size, for the table and the report. */
export function formatSize(bytes: number): string {
  if (bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
