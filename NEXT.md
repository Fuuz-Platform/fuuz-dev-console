# Fuuz Dev Console — where to pick up

Written at the end of a long session, for whoever continues. Read
[`TELEMETRY-FINDINGS.md`](./TELEMETRY-FINDINGS.md) first: it reframes most of this list, and
several items below exist *because* of it.

## The one insight that reorders everything

The console currently reconstructs execution data by **scraping Fuuz's own rendered console
drawer** (`src/core/consoleDom.ts` — reading value types from span colours, detecting collapsed
rows, rejecting `[object Object]`). Every bit of that is a workaround for not having the
structured source.

Both sources exist in the page:

| Surface | Structured source | Now |
|---|---|---|
| Flow | redux **`dataFlowEditor[tab].logs`** — `{id, level, nodeId, message, data}`, per tab, **uncapped** | **read from the store** (`src/extension/storeTap.ts`) |
| Screen | the **console stream** — `console[level](message, data)`, emitted *before* the redux push | already correct; unchanged |

**The screen half of this item was wrong, and the correction is the interesting part.** The
platform prints every screen transform log to the console at the action creator and only then
pushes it into the 50-capped, navigation-cleared `transformDebuggingLogs`. So the console stream
is a *superset* of that store, and "read the store instead of scraping" would have been a
downgrade for screens. The flow designer is the mirror image — it prints nothing at all, which is
why *it* was the surface being scraped. See §A″ of
[`TELEMETRY-FINDINGS.md`](./TELEMETRY-FINDINGS.md); three probe assertions defend it.

Reading these is **net code deletion** and a large correctness gain. `data` is the full workflow
state at every step; `trace.runtime` is per-binding timing the server never sees.

Do it as a *replacement* for `consoleDom.ts`, not a parallel path — two readers of the same data
will drift within a week.

### Caveats that must be encoded, not discovered

1. **The transform log is not a complete record.** Results are memoised in a `resultCache` keyed by
   `cacheKey` and invalidated by `dynamicFieldsChanged`; **a cache hit returns before the logging
   call**. So a debugger sees *fewer* evaluations than there are bindings. Anything counting
   evaluations — including `diagnose.ts`'s `transform-loop` / `transform-no-cache-key` rules — must
   say so rather than implying completeness.
2. **`transformDebuggingEnabled` is the gate.** Nothing is logged unless it is on. We already enable
   it (and hide the drawer it opens); keep that coupling explicit.
3. `[VALIDATE]` **It is bounded twice.** The reducer keeps `take(50, …)` and
   `SET_HISTORY_STATE_FIELD` (navigation) resets it to `[]`. Poll faster than 50 evaluations or
   hook `ADD_TRANSFORM_DEBUGGING_LOGS`; never present the array as a session record.
4. `[VALIDATE]` **Error entries have a different shape.** `"Transform Error: "` carries `error`
   but **no `result` and no `trace`** — so the failing evaluations are exactly the ones with no
   timing. Any code reading `entry.trace.runtime` must tolerate its absence.
5. `[VALIDATE]` **Flow entries are JSON round-tripped.** The `dataFlowEditor` HOC stores
   `JSON.parse(JSON.stringify(entry))`, so non-serializable state collapses to
   `{message: "Unable to serialize log data", error}` — which looks like a missing log rather than
   a lossy one. Surface that distinction instead of showing a gap.

## Landed since this list was written

- **Retention is adjustable.** `Host.retention` (`max()` / `setMax()`), persisted as
  `logRetention` in `chrome.storage.local`, `0` = unlimited, with a **Keep** control in the log
  footer and the limit reported on the payload so the footer can explain `· n dropped`. The
  platform's own `take(50)` is upstream and stays where it is — the point is that our tap must not
  inherit it.
- **Entries are tied to what produced them.** `src/core/eventScope.ts` groups the flat log into
  screen events (`eventId`, `eventSeq`, `eventLabel`, `eventVia`), `applyDesign` now stamps
  `nodeId` / `elementName` / `property`, and the log row shows `#seq` plus a clickable event chip
  that filters to one interaction's work. 15 tests in `test/eventScope.test.ts` and
  `test/designJoin.test.ts`.
  `[VALIDATE]` The event grouping is **inferred** — the runtime supplies no event id and no causal
  link, only a component-type `trace.origin` (see §A′ of
  [`TELEMETRY-FINDINGS.md`](./TELEMETRY-FINDINGS.md)). Roots are stated; followers are order-based
  and close on a 1.5 s idle gap. `eventVia` carries that distinction — keep it visible in any new
  surface rather than presenting a scope as fact.

## Writing definitions back — built, not yet wired to a click

The console can now write a screen or flow definition back to where the native Fuuz UI
reads it. `core/designPatch.ts` computes the patch and refuses ambiguous targets;
`core/designWrite.ts` holds the two mutations (`updateScreenVersion.design`,
`updateDataFlowVersion.flow` — the latter captured verbatim from a real designer save);
`extension/relay.ts` gates it as `writeDefinition`, reads the target back to check nobody
saved underneath us, and only then sends. Reachable as `host.design.apply({...})`,
**dry by default**. 17 tests in `test/designPatch.test.ts`.

Three things to know before relying on it:

1. `[VALIDATE]` **No write has been executed against a live tenant yet.** The mutations are
   the platform's own and the shapes are verified, but the round trip — patch, read-back,
   send, designer shows the change — has not been run end to end. Do that on a throwaway
   screen before anything that matters.
2. **There is no button.** The capability exists at the host API; nothing in the panel
   calls it. The natural home is the Structure tab's property inspector, whose "Apply
   result" today previews at runtime only — it would gain a second, explicit action that
   says it writes the design.
3. **Deploying is still a separate act.** A write updates the version the designer reads;
   what a deployed runtime serves is whatever was deployed. This path does not deploy, and
   should not learn to without a much louder confirmation.

## Ranked work

1. **Wire the flow store tap into the panel, then delete `consoleDom.ts`.** *Half done.*

   Built and tested: `src/core/flowLogs.ts` (pure — extraction, conversion, an id-keyed cursor;
   12 unit tests) and `src/extension/storeTap.ts` (store discovery + the `flowLogs` /
   `resetFlowLogs` hook requests; 16 assertions in `test/storeTap.smoke.mjs` against real React 18
   through the shipped `dist/hook.js`). It never dispatches — the smoke store throws if it does.

   Still to do: have `host.ts` call `flowLogs` on the flow-events poll and use its entries instead
   of `flowEntriesFromLog()`, then remove the drawer scrape (`readExpandedRow` in `relay.ts`,
   `consoleDom.ts`, and `FLOW_LOG_SAMPLE`). Two things to get right when wiring:
   - Pass the diagram's node names in — the store carries `nodeId` only, so untitled entries read
     as uuids. `flowLinks()` already has the node model.
   - The store carries **no timestamp**. Time comes from when we observed the entry; that is an
     arrival stamp and `dur` is left empty rather than fabricated. Do not let the wiring invent one.

   **Live verification — the structural half is now proved.**
   `ace/parity/tools/verify-store-tap.cjs` (`npm run verify:store-tap`) loads the shipped
   `dist/hook.js` into a real `build.proveit.fuuz.app` page and asks it the same question the
   extension asks. Against the live app:

   - ✓ **the tap finds the app's redux store** — the Provider is where the walk looks, on the real
     tree, not just in jsdom;
   - ✓ **`dataFlowEditor` is a real slice**, confirmed from the live store's own slice list
     (`authentication, header, drawer, messageManager, metadata, graphQLEditor, documentDesigner,
     screenEditor, dataFlowEditor, dataModelEditor, …`) rather than inferred from the bundle.

   `[VALIDATE]` **Still unproved: the log itself.** That a running designer writes
   `{id, level, nodeId, message, data}` into `dataFlowEditor[<tab>].logs` under a real tab key is
   still read off the bundle. The shared browser profile's SSO session has expired, so the probe
   skips that check rather than guessing — re-establish it with `npm run login` in
   `ace/parity` (headed, one-time), open a flow, run a node, and re-run. Wire `host.ts` after
   that, not before: the entry shape is what the wiring depends on.

2. **Capture WebSocket frames.** `src/extension/hook.ts` runs at `document_start` in the MAIN
   world, which is the right place to patch `WebSocket`. Today the Network pane is CDP/HTTP-only,
   so the entire socket.io channel is invisible — `flowPublishEvent`, `modelMapRegenerated`,
   `refreshToken`/`reauthenticate`, and the subscription errors the user has already hit.
   `ace/parity/tools/instrument.cjs` records `ws-open`/`ws-sent`/`ws-recv`/`ws-close` and is
   reusable.

3. **Flag nodes that cannot emit.** `debug.publishSubscribeClient` and `debug.publishToMFGx`
   default `false`, and **MCP-written nodes carry no `debug{}`/`logging{}` block at all** (0 of 90
   measured). A screen or flow tapping topics looks silent until it is switched on. This belongs in
   `src/core/diagnose.ts` — it is exactly the "I see nothing and don't know why" case the console
   exists to answer, and today we show an empty log and let the developer assume the node never ran.
   Note also `idleQueueTtl: 1 minute` — an idle screen's queue is dropped, so a capture gap has a
   known cause (`[VALIDATE]` 1 minute is the default at two of three subscribe sites; the third
   takes a configurable `queueTimeout`).

   `[VALIDATE]` **This can be a fact, not an inference.** The flag is read *inside* the
   `flowPublishEvent` handler, after the frame arrives — `n && (dispatch(i), t(r))`. So once item 2
   lands, the console can distinguish **"nothing was published"** from **"published, and this node
   is gated"** by matching captured frames against the node's binding keys. That is the difference
   between a warning we print speculatively and a diagnosis we can prove, so sequence it after the
   WebSocket capture rather than shipping the guess first.

4. **Session save / load / diff.** A designer run leaves **no server record**: no
   `DataFlowExecutionMetric`, no `DataFlowDeploymentLog`, no `ApplicationSpanEventLog`. The data
   never exists outside the tab, so saving is the only way a run survives, can be handed to someone,
   or compared against another. This is not a convenience feature.

5. **Two runtimes, two records — say which, and join them.** Server telemetry
   (`ApplicationSpanEventLog` with `traceId`/`spanId`/`dataFlowElementId`,
   `DataFlowExecutionMetric` with per-node `executionTimeMs`) is newly reachable now that API access
   works. A designer run is client-only; a deployed run is server-only. The console should state
   which it is showing and join them on `dataFlowElementId` where both exist.

   `[VALIDATE]` Two constraints found on 2026-08-18, both in
   [`TELEMETRY-FINDINGS.md`](./TELEMETRY-FINDINGS.md): `applicationSpanEventLog` is **empty** and
   `_trace` **null** in both enterprises (even with `x-mfgx-trace-*` set explicitly), so that half
   of the join does not exist yet; and every metric row is attributed to the `DataFlows` service
   principal, so a screen-triggered execution **cannot** be narrowed by user. Correlating a
   screen's `executeFlow` to its node rows is a time-window heuristic today — label it as one in
   the UI rather than implying an exact join.

6. ~~**Write the replay probe.**~~ **Done** — `ace/parity/tools/validate-telemetry.cjs`
   (`npm run validate:telemetry`). 22 assertions over the `[VALIDATE]` claims, PASS / FAIL / SKIP
   with a non-zero exit on any FAIL. It earned its keep on the first run: it caught a bad origin
   extractor of its own (a brace-stopping regex that reported four live origins as removed), and a
   vacuous pass where "the response carries no messageId" was confirmed against a 500 error body.

   Two things to know before relying on it:
   - **The execution trio needs a flow.** `--execute --flow <id>` preflights that the flow returns
     2xx and skips rather than guesses. The lab's demo flows were deleted mid-session, so point it
     at one you own. Teaching it to create and delete its own flow is the obvious next step, and is
     deliberately not the default — it would mutate a shared build tenant on every run.
   - **A FAIL can be good news.** `span-log-empty` or `no-request-id-field` failing means the
     platform shipped the correlation fix; the probe's job is to notice, not to judge.

Below these, from the earlier design review: watch expressions, a timeline/state scrubber (every
`entry.context` is already a *complete* snapshot, so scrubbing is mostly wiring), a causality chain
from `reads`/`write`, global search, and folding Network into the log as a filter. All of them add
reach to data we are currently mis-capturing — fix capture first.

## How API access works now (do not re-add a token hunt)

`src/extension/pageServices.ts` runs GraphQL **in the page**, using `__APOLLO_CLIENT__` where it is
wired and a `credentials: 'include'` fetch otherwise. There is no token to read, store or leak — the
app already holds the session. `API_ACCESS` in `src/core/apiAccess.ts` is the single switch.
Mutations still pass the production gate.

## Known-failing tests, deliberately left

Six element-registry tests fail. The registry data and its extractor changed outside the work of
that session — 41 elements / 484 props became **77 elements / 1633 props** with a new
own/shared/referenced split and a `category` field:

```
✖ props carry their type and description
✖ a documented default is separated from the description
✖ transformable props are those the designer gives a JSONata editor
✖ elements expose the functions the skill documents
✖ a prop that never accepts a transform is fixed
✖ rows carry the skill description and section
```

They were **not** rewritten to match the new data. Doing so would make the suite green while hiding
whether the new extractor is correct, which is the question worth answering. Decide that first.

Everything else is green: 518 unit tests, 10 smoke suites, both drift checks
(`npm run check`), and the build.
