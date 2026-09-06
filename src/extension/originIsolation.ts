/**
 * Add `Origin-Agent-Cluster: ?1` to Fuuz document responses, so WebMCP can run.
 *
 * WebMCP is only available in origin-isolated documents, and `admin.fuuz.app`
 * does not send that header (verified 2026-08-17). Rather than requiring a server
 * change to try the API at all, `declarativeNetRequest` can add it on the way in —
 * scoped to `*.fuuz.app` and to top-level documents only.
 *
 * ## Why this is off by default, and stays off
 *
 * Origin isolation is not a no-op. It puts the origin in its own agent cluster,
 * which **opts it out of synchronous scripting with other same-site origins** —
 * so an app that reaches into a frame on a sibling subdomain, or is reached into
 * from one, can break. That is a real change to how the page behaves, made by an
 * extension, invisibly. It has to be a deliberate act with a stated consequence,
 * not a default.
 *
 * ## The reload nobody expects
 *
 * The header only takes effect for a document loaded *after* the rule exists, and
 * Chrome decides an origin's cluster **once per browsing context group**. An
 * origin already loaded site-keyed in the current group stays that way and the
 * header is ignored. So enabling this needs a **new tab**, not a refresh — and
 * the panel says so, because a silent no-op here looks exactly like the API being
 * unavailable.
 */

/** Fixed ids so enabling twice replaces a rule instead of stacking copies. */
const RULE_ID = 8801;
const TRIAL_RULE_ID = 8802;

/**
 * Origin-trial token injection.
 *
 * The flag (`chrome://flags/#enable-webmcp-testing`) turns the API on for *this*
 * browser, which is right for one developer testing. A trial token turns it on
 * for *anyone* who loads the origin, which is what a platform rollout needs —
 * and Chrome accepts it as an `Origin-Trial` response header, so the same
 * mechanism that adds the isolation header can add this too.
 *
 * The token is issued per origin by Chrome's origin-trial registration and is not
 * a secret, but it is also not ours to invent: without one this does nothing, and
 * says so rather than appearing to work.
 */
export function trialRule(token: string) {
  return {
    id: TRIAL_RULE_ID,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      // `append`, not `set`: an origin may already be running other trials, and
      // replacing that header would silently switch them off.
      responseHeaders: [{ header: 'Origin-Trial', operation: 'append', value: token }],
    },
    condition: { requestDomains: ['fuuz.app'], resourceTypes: ['main_frame'] },
  } as const;
}

/** The rule, kept as data so the same shape is asserted in tests. */
export const ORIGIN_ISOLATION_RULE = {
  id: RULE_ID,
  priority: 1,
  action: {
    type: 'modifyHeaders',
    responseHeaders: [
      // `set` rather than `append`: a second, conflicting value would make the
      // header a list, which is not a valid structured boolean.
      { header: 'Origin-Agent-Cluster', operation: 'set', value: '?1' },
    ],
  },
  condition: {
    // Host permissions already restrict us to Fuuz; this restricts the *rule*
    // as well, so a future permission widening cannot silently widen this too.
    requestDomains: ['fuuz.app'],
    // Documents only. Adding it to scripts or XHR would be meaningless, and
    // adding it to subframes could isolate frames the app expects to reach.
    resourceTypes: ['main_frame'],
  },
} as const;

export interface IsolationState {
  enabled: boolean;
  /** Whether an origin-trial token is being injected as well. */
  trial?: boolean;
  /** Whether the browser exposes the API needed to do this at all. */
  supported: boolean;
  error?: string;
}

type Dnr = {
  updateDynamicRules(o: { addRules?: unknown[]; removeRuleIds?: number[] }): Promise<void>;
  getDynamicRules(): Promise<{ id: number }[]>;
};

function dnr(): Dnr | undefined {
  const api = (chrome as unknown as { declarativeNetRequest?: Dnr }).declarativeNetRequest;
  return api && typeof api.updateDynamicRules === 'function' ? api : undefined;
}

export async function isolationState(): Promise<IsolationState> {
  const api = dnr();
  if (!api) return { enabled: false, supported: false, error: 'declarativeNetRequest is unavailable.' };
  try {
    const rules = await api.getDynamicRules();
    return {
      enabled: rules.some((r) => r.id === RULE_ID),
      trial: rules.some((r) => r.id === TRIAL_RULE_ID),
      supported: true,
    };
  } catch (e) {
    return { enabled: false, supported: true, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Turn the header on or off.
 *
 * Idempotent: `removeRuleIds` runs on both paths, so enabling twice replaces the
 * rule rather than failing on a duplicate id.
 */
export async function setOriginIsolation(enabled: boolean, token?: string): Promise<IsolationState> {
  const api = dnr();
  if (!api) return { enabled: false, supported: false, error: 'declarativeNetRequest is unavailable.' };
  try {
    const add: Record<string, unknown>[] = [];
    if (enabled) add.push(ORIGIN_ISOLATION_RULE as unknown as Record<string, unknown>);
    // A blank token is not an error, it just means "flag path" — adding an empty
    // Origin-Trial header would be worse than adding none.
    if (enabled && token && token.trim()) add.push(trialRule(token.trim()) as unknown as Record<string, unknown>);
    await api.updateDynamicRules({ removeRuleIds: [RULE_ID, TRIAL_RULE_ID], addRules: add });
    return { enabled, trial: enabled && !!token?.trim(), supported: true };
  } catch (e) {
    return { enabled: false, supported: true, error: e instanceof Error ? e.message : String(e) };
  }
}
