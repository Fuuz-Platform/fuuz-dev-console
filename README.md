# Fuuz Dev Console

> **Beta concept — not an accelerator.** Published as a working concept to read, run
> and take the pattern from. It is not a supported deliverable, it carries no service
> level agreement, and it may change or be withdrawn without notice.

Read a Fuuz screen's console as an **execution log** and the **state it
produced**, with trace links between the two.

The platform's screen runner already shows a console. What this adds is the
state beside it, and the ability to ask of any value: *which writes produced
this?*

## Why a browser extension

The Fuuz screen runtime announces every transform through `console.debug`, so
capturing it needs nothing more than wrapping `console` in the page's own world.
That means **no debug port, no second browser, no logging in again** — it runs in
the browser you're already using, already signed in.

## Install

```bash
npm install
npm run build
```

Then `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
select `platform/dev-console/dist`.

Open a Fuuz screen, open DevTools, and pick the **Fuuz Dev Console** tab.
**Reload the page after installing** — content scripts only inject on load.

## What you see

**Execution log** — each console call classified into a query, transform, flow
call or error, with its duration and the state path it wrote. Objects are
captured whole, so the runtime's `expression` / `result` / `trace` payloads stay
structured rather than collapsing to `{…}`.

Every row carries `#seq` — capture order, which is the only *total* order, since
the runtime flushes its own logs through a debounce — and, where one applies, the
screen event it belongs to: `Save · 3` is the third piece of work that click
produced. Clicking the event chip shows that interaction alone. Roots are drawn
solid and followers dashed, because the runtime states the interaction but not
what followed from it: the grouping is capture order plus a quiet gap, and the
panel says so rather than implying a causal record it doesn't have.

**Keep** in the log footer sets how many entries are retained (up to *All*), and
the setting persists. Fuuz's own console keeps 50 — long enough to lose the thing
you are looking for on a busy screen, which is the reason this one is yours to
set.

**Current state** — the runtime logs a complete `context` snapshot
(`{ metadata, components, … }`) with every transform, so the tree is the
platform's own state, not a reconstruction: components no transform touched
still appear, with their form state, data and current view. Computed props
(`disabled`, `url`) are layered on from the transforms that produced them,
because the snapshot doesn't carry those.

The two panes are linked, which is the point:

- `→ components.Foo.url` on a log entry **reveals** that path in the state tree.
- `⌁ n` on a state value **traces** it: the log filters to the *n* writes behind
  it, and a numbered timeline shows each step's expression and its
  `before → after`.

The chain is real, not just direct writes. Each entry's expression is parsed for
the paths it reads and those edges are walked backwards — so a `url` built from
a base64 document built from a filtered row set resolves back to the query and
the signed-in user.

## Network, Issues, and the report

**Network** captures every request the screen makes, and adds the two things the
browser's own tab won't tell you: the **GraphQL operation name** (so
`/application` doesn't appear forty times identically) and a `200 ⚠` marker on
responses that carry a GraphQL `errors[]` — a failed query returns HTTP 200, so
the browser shows it green.

**Issues** ranks what is probably wrong, each with the trace that proves it:

| rule | what it catches |
| --- | --- |
| `transform-error` | a transform threw, with its write chain and expression |
| `transform-loop` | one path recomputed ≥5× in 3s — high when the value never changes |
| `slow-transform` | transforms run on the UI thread, so these are visible jank |
| `request-failed` | 4xx/5xx, and transport failures the status column shows as 0 |
| `graphql-error` | errors returned inside an HTTP 200 |
| `duplicate-request` | the identical body sent ≥3× in 5s — a query firing per row |
| `slow-request` / `large-response` | the screen waiting, or parsing, too long |
| `unattributed-transform` | props the runtime wouldn't tie to an element |

Detection is windowed, not cumulative: eight evaluations over eight minutes is a
person using the screen, and doesn't fire. A rule that cries wolf is worse than
no rule.

**Copy MD** puts the whole run on the clipboard as markdown for pasting into an
LLM — issues first with their traces, then the state outline, the log, the
network table, and the expressions that failed. It's bounded (60 entries, 40
requests) so it stays pasteable, and session tokens are redacted.

## Design tab — findings before anything runs

The console can only report a defect after it fires. Once the deployed design is
fetched, these are detectable statically:

| rule | what it catches |
| --- | --- |
| `base64-non-latin1` | `$base64encode` over `—`, `•`, `…` — `btoa` is Latin1-only, so the transform can never succeed |
| `unknown-component-ref` | `$components.X` where `X` isn't on the screen (usually a rename that didn't propagate) |
| `column-width-string` | `width: "110"` — AG Grid ignores it and falls back to the default |
| `unknown-column-type` | a `colDef.type` AG Grid doesn't define |
| `duplicate-cache-key` | two elements sharing a `__cacheKey`, which is what defeats attribution |
| `remote-transform` | a transform paying a round trip on every re-evaluation |

Run against the deployed Asset Intake screen, this finds the `btoa` bug — and
two string column widths — without executing anything.

## Scratchpad (ƒx) — develop, don't just debug

Every entry carries the screen's live `context`, so the scratchpad evaluates
**JSONata against the state the screen is actually holding**. Write
`$components.TicketTable.data[state = "issued"]`, see the answer immediately,
then paste the finished expression into the designer once — instead of the
edit → save → deploy → reload loop.

The bundled JSONata is **2.1.1**, the same version the platform evaluates with,
so what works here works there. `$metadata`, `$components` and the rest are
bound exactly as the runtime binds them.

## Pick — DOM to Fuuz element

Select an element in **Elements**, then hit **Pick**. The panel walks up from
`$0` reading `element` (the element type), `formelement` (the owning form) and
`data-data-path` (the bound field) to name what you clicked, and seeds the
scratchpad with it.

## Role

The status bar shows the `roleId` and tenant the capture is running as. "Works
for admin, breaks for operator" is a whole bug family, and nothing else tells
you which one you're testing.

## How transform logging gets turned on

The runtime gates every `Transform Debugging:` emission on a session setting:

```js
transformDebuggingEnabled: "true" === sessionStorage.getItem("transformDebuggingEnabled")
```

Normally you'd flip it from the avatar menu, or with `?developerMode=true`. The
content script sets it at `document_start` — before the app bundle evaluates —
so the runtime comes up with logging already on, **on any route**, with no user
action.

Two things still cause silence, and neither is a route:

- **The result cache.** `executeTransform` returns a cached value *before* the
  logging line, so an unchanged transform logs nothing. Reload to see a cold
  evaluation.
- **A tab open before install.** Content scripts only inject on page load.


## The design join

The runtime names the owning component only for action-driven transforms
(`trace.origin === 'Action'` gives `trace.actionName`); every other transform
logs a bare `trace.property`. The screen design knows the rest — and the two join
*exactly*, because both carry the same object: the design stores
`props[prop] = { __transform, __cacheKey, __remote }` and the runtime echoes it
at `trace.dynamicProps[prop].info`.

**The design is fetched live, from the deployed version.** The panel reads the
running screen's `screenVersionId` out of the runtime context, reads the page's
own session token from `localStorage`, and queries `screenVersion { design }` —
so it joins against what is actually deployed. That matters: joining against a
checked-in design file doesn't merely fail, it can attribute *wrongly*. The
Asset Intake seed at v0.0.7 named `IntakeSubmit`, while the deployed v0.0.15
computes that property on `IntakePrepare` and puts `url` on a `TusUploader`
element the seed had never heard of.

The token is the signed-in user's, so the panel can only ever see what they can
see, and it is never cached — the JWT rotates roughly every 15 minutes, so it is
re-read per request. **Dump raw** redacts anything JWT-shaped before writing.

With a design loaded, the console attributes each transform to its real element,
labels it with the element type, and reports **coverage** — which declared
dynamic props never evaluated. A `disabled` transform that never fired is a
branch the run never reached.

Where the design is genuinely ambiguous (two table columns sharing one
`__cacheKey` *and* one transform) it declines to attribute rather than pick one.
Anything unattributed stays in a `(computed)` bucket.

## Connect to Claude

The **Connect to Claude** tab wires this panel to a local MCP server so Claude
Code can read the diagnostics directly — the issues with their traces, the state
tree, the provenance behind any value, and a JSONata evaluator bound to the live
context. Claude gets the *analysis*, not raw logs it has to re-derive.

One-time setup, then a button:

```bash
claude mcp add fuuz-ui --scope user -- node "$(pwd)/src/mcp/server.cjs"   # from platform/dev-console
```

The **Connect to Claude** tab shows this command with the path already filled
in — the server reports its own location over `/health`, so there is no
placeholder to substitute.

Start a Claude session, press **Connect to Claude** in the panel, and each
capture is pushed to a loopback bridge on `127.0.0.1:8788`. Then ask *"what's
wrong with the screen I have open?"*

| tool | what it answers |
| --- | --- |
| `fuuz_screen_status` | where the data is coming from |
| `fuuz_screen_issues` | ranked problems, each with its trace |
| `fuuz_screen_trace` | the write chain behind any value |
| `fuuz_screen_state` | the state tree, or one subtree |
| `fuuz_screen_log` | the classified execution log |
| `fuuz_screen_eval` | JSONata against the live context |
| `fuuz_screen_report` | the full markdown diagnostic |
| `fuuz_screen_attach` | drive a browser from the agent, when no panel is open |

Nothing leaves the machine: the bridge binds to loopback only, session tokens are
redacted before anything is pushed, and disconnecting stops it immediately. No
Claude Code? **Copy MD** gives the same data for any model.

Why not `chrome-devtools-mcp`? It hands an agent raw console lines and requests,
which is the cheap part — the expensive part is deriving meaning from them.
They're complementary: Chrome's for generic browser control, this for Fuuz
semantics.

## CLI

The same core runs headless, over the DevTools protocol, for CI or for capturing
a run without a browser extension installed:

```bash
npm run dev-console -- --open '<screen /run url>' --url admin.fuuz.app
#   --design <file>  join a screen design      --for <seconds>  capture, report, exit
#   --dump <file>    write the payload as JSON --serve [port]   live console at localhost
#   --json           NDJSON per entry          --no-launch      attach to your own browser
```

`--serve` hosts the same React panel at `http://127.0.0.1:8777`, streaming over
SSE — useful when you want the full UI without installing the extension.

## Layout

```
src/core/       pure: classify, provenance, stateTree, designJoin, screenApi,
                network, diagnose, designLint, stateDiff, report  (no Node deps)
src/extension/  MV3 — MAIN-world console hook, relay, service worker, devtools page
src/panel/      the React console + the host abstraction it talks through
src/node/       DevTools-protocol capture, used only by the CLI
src/cli/        headless runner and its served preview
```

`src/core` is deliberately dependency-free: it's what lets the same pipeline run
in a DevTools panel, in Node, and under jsdom in the tests.

## Tests

```bash
npm test         # 96 unit tests over the core, against real captured fixtures
npm run test:panel   # headless render of the built panel in jsdom
```

Fixtures in `test/fixtures/` are real captures — the console output of a live
Asset Intake screen and two pushed screen designs — not hand-written shapes.

## Service levels

No service level agreement applies to anything published here. It becomes a supported
deliverable only once it has been implemented by a Fuuz services professional or an
approved Fuuz partner.
