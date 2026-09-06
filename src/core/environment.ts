/**
 * Which Fuuz environment a page belongs to, and what may be done there.
 *
 * The tool has two halves with very different risk. Reading — console log, live
 * state, network, diagnosed issues, structure — changes nothing and is exactly
 * what you want when a production screen is misbehaving. Writing and capturing —
 * calling an element's `fn` bag, setting styles or values, evaluating a transform
 * server-side, taking a screenshot — either alter the page a real user is looking
 * at, or copy its contents somewhere else.
 *
 * So the second half is confined to build/QA environments. Reading stays
 * available everywhere, because losing production triage would cost more than it
 * protects.
 *
 * ## Why the host, and why not the page
 *
 * The environment slug is part of the hostname (`api.build.mfgx.fuuz.app`), and
 * the URL the extension checks comes from Chrome — `chrome.tabs.get`, or the
 * content script's own `location` — never from anything the page can set. A
 * compromised or hostile page therefore cannot talk its way into a higher tier.
 *
 * The decision is enforced in the service worker and the content script, not in
 * the panel. UI that merely hides a button is not a control.
 *
 * Pure.
 */

export type EnvironmentTier = 'permitted' | 'production' | 'off-platform';

/**
 * Slug segments that mark a non-production environment.
 *
 * Matched per dot-separated segment, exactly — so `build.mfgx` qualifies and
 * `buildx.mfgx` does not. A substring test would let a lookalike host through.
 */
const NON_PRODUCTION = new Set([
  'build', 'qa', 'dev', 'develop', 'development',
  'test', 'testing', 'sandbox', 'staging', 'stage', 'uat',
]);

/**
 * The administration tenant is where Fuuz builds Fuuz.
 *
 * Classified as permitted by explicit decision, not by the naming convention —
 * it is the surface this tool is developed against, and gating it would disable
 * the tool for its own authors.
 */
const PERMITTED_SLUGS = new Set(['admin']);

export interface EnvironmentInfo {
  tier: EnvironmentTier;
  /** Hostname of the page, or undefined if the URL did not parse. */
  host?: string;
  /** Environment slug — `admin`, `build.mfgx`, `mfgx`. */
  slug?: string;
  /** One sentence, shown to the developer when something is refused. */
  reason: string;
}

export function classifyEnvironment(pageUrl: string): EnvironmentInfo {
  let host: string;
  try {
    host = new URL(pageUrl).host;
  } catch {
    return { tier: 'off-platform', reason: 'Not a URL this tool recognises.' };
  }

  if (!/\.fuuz\.app$/.test(host)) {
    return { tier: 'off-platform', host, reason: `${host} is not a Fuuz host.` };
  }

  const slug = host.replace(/^api\./, '').replace(/\.fuuz\.app$/, '');
  const segments = slug.split('.').filter(Boolean);

  if (PERMITTED_SLUGS.has(slug) || segments.some((s) => NON_PRODUCTION.has(s))) {
    return { tier: 'permitted', host, slug, reason: `${slug} is a build/QA environment.` };
  }
  return {
    tier: 'production',
    host,
    slug,
    reason:
      `${slug} looks like a production environment. Reading is allowed; changing the page and ` +
      'capturing it are not.',
  };
}

/** The capabilities that alter a page or copy it elsewhere. */
export const GATED_CAPABILITIES = [
  'applyElementStyle',
  'callElementFn',
  'captureTab',
  'evaluateRemote',
  /*
   * Writing a screen or flow *definition* back to the platform.
   *
   * The most consequential capability here by a distance: everything else above is
   * undone by a reload, and this one is what the native designer reads afterwards.
   * It is gated on the same tier rather than a looser one — a definition write on a
   * production tenant is precisely the thing this gate exists to prevent.
   */
  'writeDefinition',
] as const;

export type GatedCapability = (typeof GATED_CAPABILITIES)[number];

export function isGated(type: string): type is GatedCapability {
  return (GATED_CAPABILITIES as readonly string[]).includes(type);
}

/**
 * May this page be changed or captured?
 *
 * Off-platform is refused as firmly as production: if the URL is not a Fuuz host
 * we do not know what we are looking at, and defaulting to permissive on an
 * unrecognised page is how a gate becomes decorative.
 */
export function mutationsAllowed(pageUrl: string): boolean {
  return classifyEnvironment(pageUrl).tier === 'permitted';
}

/** The refusal message for a specific capability, ready to show. */
export function refusalFor(pageUrl: string, capability: GatedCapability): string {
  const env = classifyEnvironment(pageUrl);
  const what: Record<GatedCapability, string> = {
    applyElementStyle: 'Style previews are',
    writeDefinition: 'Writing a screen or flow definition is',
    callElementFn: 'Calling an element function is',
    captureTab: 'Screenshots are',
    evaluateRemote: 'Server-side transform evaluation is',
  };
  return `${what[capability]} disabled here — ${env.reason}`;
}
