/**
 * The mutations that put a patched definition back where the native Fuuz UI reads it.
 *
 * Both are the platform's own, not invented here:
 *
 *  - the **flow** mutation is captured verbatim from a real designer save
 *    (`ace/parity/evidence/nq-door-designer-mutation/0006.json`) — the designer
 *    sends the whole `flow` object back on every save, so a patched flow document is
 *    exactly what it would have sent;
 *  - the **screen** mutation follows `ScreenVersionUpdateInput`, whose `design` field is
 *    a `JSONObject`. The design is stored as one blob, so a write replaces it wholesale
 *    — which is why `designPatch` patches a clone of what was read rather than
 *    composing a new document.
 *
 * Building the request and sending it are separate on purpose: a dry run is this module
 * with no send, so what gets reviewed is the literal payload that would go.
 *
 * Pure: builds documents and variables, performs no I/O.
 */

export interface GraphQLRequest {
  /** Which service the request belongs to — both of these are the application API. */
  service: 'application';
  query: string;
  variables: Record<string, unknown>;
  /** Human summary for a confirmation prompt or an audit line. */
  summary: string;
}

/**
 * Write a screen version's design.
 *
 * `screenVersionId`, not the screen id: a screen has many versions and the designer
 * edits one of them. Writing to the wrong level is how an edit lands in a version
 * nobody is looking at.
 */
export function screenDesignUpdate(screenVersionId: string, design: unknown, summary: string): GraphQLRequest {
  return {
    service: 'application',
    query: 'mutation UpdateScreenDesign($p:[ScreenVersionUpdatePayloadInput!]!)'
      + '{ updateScreenVersion(payload:$p){ id number } }',
    variables: { p: [{ where: { id: screenVersionId }, update: { design } }] },
    summary,
  };
}

/**
 * Write a data flow version's flow document.
 *
 * The shape mirrors the designer's own save down to the field order it sends, so a
 * flow written from here is indistinguishable from one saved by hand.
 */
export function flowVersionUpdate(dataFlowVersionId: string, flow: unknown, summary: string): GraphQLRequest {
  return {
    service: 'application',
    query: 'mutation UpdateFlowVersion($p:[DataFlowVersionUpdatePayloadInput!]!)'
      + '{ updateDataFlowVersion(payload:$p){ id number } }',
    variables: { p: [{ where: { id: dataFlowVersionId }, update: { flow } }] },
    summary,
  };
}

/**
 * Read back the version we are about to overwrite, to check it has not moved.
 *
 * The platform offers no compare-and-swap on these mutations, so the guard is a read
 * immediately before the write: if the stored document differs from the one the patch
 * was computed against, somebody saved in the designer meanwhile and the write is
 * refused rather than silently discarding their work.
 */
export function screenVersionRead(screenVersionId: string): GraphQLRequest {
  return {
    service: 'application',
    query: 'query ScreenVersionDesign($id: String!)'
      + '{ screenVersion(where: { id: { _eq: $id } }, first: 1) { edges { node { id number design } } } }',
    variables: { id: screenVersionId },
    summary: `read screen version ${screenVersionId}`,
  };
}

export function flowVersionRead(dataFlowVersionId: string): GraphQLRequest {
  return {
    service: 'application',
    query: 'query FlowVersionDocument($id: String!)'
      + '{ dataFlowVersion(where: { id: { _eq: $id } }, first: 1) { edges { node { id number flow } } } }',
    variables: { id: dataFlowVersionId },
    summary: `read flow version ${dataFlowVersionId}`,
  };
}

/**
 * Has the stored document changed since the patch was computed?
 *
 * Compared by value rather than by a version number, because the platform bumps
 * `number` on publish rather than on every save — a save that changed the design
 * without changing the number would slip past a number check.
 */
export function hasMoved(readAtPatchTime: unknown, storedNow: unknown): boolean {
  return JSON.stringify(readAtPatchTime) !== JSON.stringify(storedNow);
}

/** What a caller gets back from an apply attempt, whether or not it sent anything. */
export interface ApplyOutcome {
  ok: boolean;
  /** True when nothing was sent — either a dry run, or a refusal. */
  dryRun: boolean;
  /** The single-line diff, for the confirmation prompt or the log. */
  change?: string;
  /** The literal request that was (or would be) sent. */
  request?: GraphQLRequest;
  error?: string;
}
