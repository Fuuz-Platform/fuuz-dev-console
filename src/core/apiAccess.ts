/**
 * Whether the extension may call the Fuuz APIs at all.
 *
 * Every API-backed feature needs the signed-in user's session token, read from the page.
 * That read never worked reliably on a live tenant, and the failure was uniquely bad
 * because it was *distant*: the design fetch came back empty, schema introspection found
 * nothing, the model picker had no models, the GraphQL console rejected every query — four
 * features apparently broken for four unrelated reasons, all of them one missing string.
 *
 * So it is switched off deliberately, in one place, and the features that depend on it say
 * they are unavailable rather than failing in their own idiom. That is a better state than
 * machinery that half-works: nothing pretends, and nothing has to be diagnosed twice.
 *
 * **To turn it back on**, set `API_ACCESS` to true and restore the token read in
 * `relay.ts` (`getSessionToken`). Nothing else needs changing — every call site already
 * routes through here.
 *
 * Pure.
 */

/**
 * The one switch — now **on**.
 *
 * The token read is not solved and never needs to be: the requests are made by the *page*, through
 * the client the app already has. See `pageServices.ts`. Kept as a switch because a single place to
 * turn this off is worth having if a tenant ever behaves differently.
 */
export const API_ACCESS = true;

/**
 * Why an API-backed feature is unavailable, in the words the UI should use.
 *
 * A single sentence, and honest about it being our limitation rather than the tenant's or
 * the user's — "no session token, reload the tab" sent people to reload a tab that was
 * fine.
 */
export const API_DISABLED_REASON =
  'API access is switched off in this build, so anything that needs the Fuuz APIs is unavailable.';

/** The uniform shape a disabled API call returns, so no caller special-cases it. */
export function apiDisabled<T extends object = Record<string, never>>(extra?: T) {
  return { ok: false as const, disabled: true as const, error: API_DISABLED_REASON, ...(extra ?? {} as T) };
}
