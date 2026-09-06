/**
 * Subscription socket messages, and which of them are actually faults.
 *
 * The platform logs these at `console.error`:
 *
 *     Subscription service socket error (cmsxgqfvz00033b6zz0ofgob2): io client disconnect
 *
 * Level `error` made every one an error entry, which made the Issues pane group them
 * under `transform-error` — a transform had nothing to do with it, and dozens of them
 * buried the real findings.
 *
 * The reason string is socket.io's own, and it distinguishes cases the Fuuz message
 * flattens together:
 *
 *   io client disconnect   **the client closed it deliberately.** A screen unmounting,
 *                          a tab switch, a subscription being torn down. Routine.
 *   transport close        the connection dropped — usually a backgrounded tab or a
 *                          sleeping laptop. Routine in isolation.
 *   io server disconnect   the server ended it. Worth knowing about.
 *   transport error        the connection failed. A real fault.
 *   ping timeout           the server stopped answering heartbeats. A real fault.
 *
 * The volume is the other half of the diagnosis. One `io client disconnect` is
 * nothing; forty of the same subscription id in a minute is a **resubscribe loop** —
 * a component re-subscribing on every render — and that is a genuine bug the log was
 * previously hiding under its own noise.
 *
 * Pure.
 */

export interface SocketMessage {
  /** The subscription id the platform prints in parentheses. */
  id?: string;
  /** socket.io's reason string, lower-cased. */
  reason?: string;
  /** True when this is a normal lifecycle event rather than a failure. */
  benign: boolean;
}

/** Reasons that mean "this closed the way it was supposed to". */
const BENIGN = new Set(['io client disconnect', 'transport close', 'client namespace disconnect']);

const PATTERN = /subscription\s+service\s+socket\s+(?:error|disconnect)\s*(?:\(([^)]*)\))?\s*:?\s*(.*)$/i;

/**
 * Parse a subscription socket line, or return undefined if it is not one.
 *
 * Undefined matters: anything not recognised must fall through to the normal error
 * handling rather than being quietly reclassified as benign. Under-matching costs
 * some noise; over-matching would hide real errors.
 */
export function parseSocketMessage(text: string): SocketMessage | undefined {
  const m = PATTERN.exec(String(text ?? '').trim());
  if (!m) return undefined;
  const reason = (m[2] ?? '').trim().replace(/[.\s]+$/, '').toLowerCase() || undefined;
  return {
    id: (m[1] ?? '').trim() || undefined,
    reason,
    // Unknown reasons are treated as **not** benign: a reason we have never seen is
    // exactly the case where silence would be wrong.
    benign: !!reason && BENIGN.has(reason),
  };
}

/** Whether an entry is a subscription socket message at all. */
export const isSocketMessage = (text: string) => parseSocketMessage(text) !== undefined;

export interface ChurnVerdict {
  /** Distinct subscription ids involved. */
  ids: string[];
  total: number;
  /** The worst reason seen, preferring a real fault over a benign close. */
  worstReason?: string;
  /** True when one id disconnected often enough to indicate a resubscribe loop. */
  loop: boolean;
  /** How many times the busiest id churned. */
  worstCount: number;
}

/**
 * Summarise a run of socket messages.
 *
 * Grouped by id, because that is what separates "several subscriptions each closed
 * once" — normal — from "one subscription closed thirty times", which is the loop.
 */
export function churn(messages: SocketMessage[], loopThreshold = 5): ChurnVerdict {
  const byId = new Map<string, number>();
  for (const m of messages) {
    const key = m.id ?? '(no id)';
    byId.set(key, (byId.get(key) ?? 0) + 1);
  }
  const worstCount = Math.max(0, ...byId.values());
  const fault = messages.find((m) => !m.benign);
  return {
    ids: [...byId.keys()],
    total: messages.length,
    worstReason: fault?.reason ?? messages[0]?.reason,
    loop: worstCount >= loopThreshold,
    worstCount,
  };
}
