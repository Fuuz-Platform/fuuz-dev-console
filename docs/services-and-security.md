# Fuuz services, and what the tool is allowed to do

## The services a page exposes

Every endpoint derives from the environment slug in the hostname —
`admin.fuuz.app` → `https://api.admin.fuuz.app/…`, the same rule the VS Code
extension applies to an enterprise's `environment` setting.

| Service | Path | Verified | What it is |
| --- | --- | --- | --- |
| Application | `/application` | **yes** | GraphQL for screens, screen versions, designs, flows. This is what fetches a design. |
| System | `/system` | no | GraphQL for system/tenant records. |
| Transformation | `/transformation` | no | Evaluates a JSONata transform server-side — the path a transform with `remote: true` takes. |
| Flow execution | `/orchestration/executeFlow` | no | Runs an Integration or System flow. Screen ("web") flows never use it; they run in the browser. |
| MCP | `/mcp` | no | The tenant MCP server. |
| Resource | `/resource` | no | Files. |
| Webhook | `/webhook/post/{topic}` | no | Publishes to a topic. |

"Verified" means this extension has exercised it against a live tenant. The rest
are derived from documented platform behaviour and from measurements recorded
elsewhere in this repo — real endpoints, unconfirmed request shapes.

### Why `/transformation` is worth the round trip

The bundled `jsonata` package is only *the language*. The platform adds its own
function library — `$base64encode`, `$executeFlow`, the `$components.X.fn.*`
bags — so an expression can evaluate locally and fail on the platform, or the
reverse. Evaluating remotely gives exact semantics.

Its **request body is not documented anywhere we control**, so `evaluateRemote`
tries the plausible shapes in order and reports which one the service accepted,
rather than guessing silently and reporting a wrong shape as a broken
expression. A `401` stops the loop immediately — that is about the token, not
the shape. The first live run settles it permanently.

## How the extension can call these at all

Three things line up:

1. **`host_permissions: ["https://*.fuuz.app/*"]`.** Extension pages — the panel,
   the service worker — are not web origins, so CORS does not apply to them.
2. **Fuuz authenticates with a bearer JWT in `localStorage.token`, not a cookie.**
   Nothing is sent ambiently; a request carries the user's identity only if we
   attach it deliberately.
3. **The isolated-world content script shares the page's `localStorage`**, so it
   can read that token and hand it to the panel. This is already how the design
   fetch works.

The consequence to keep in view: that token **is the user's own session**, with
the user's own permissions. It must never leave the machine. `apiBase` refuses
any host that is not `*.fuuz.app` — including lookalikes like
`fuuz.app.evil.com` — and every raw dump passes through `redactTokens`.

## The production gate

The tool has two halves with very different risk.

**Reading** — console log, live state, network, diagnosed issues, structure —
changes nothing, and is exactly what you want when a production screen is
misbehaving. It works everywhere.

**Writing and capturing** — calling an element's `fn` bag, setting a style or a
value, evaluating a transform server-side, taking a screenshot — either alters
the page a real user is looking at, or copies its contents somewhere else. These
are confined to build/QA environments:

| Capability | Gated |
| --- | --- |
| `applyElementStyle` | yes |
| `callElementFn` | yes |
| `captureTab` | yes |
| `evaluateRemote` | yes |
| everything read-only | no |

### What counts as permitted

An environment slug whose **dot-separated segments** include one of
`build qa dev develop development test testing sandbox staging stage uat`, plus
`admin` by explicit decision — it is the surface this tool is developed against.

Segments are matched exactly, so `build.mfgx` qualifies and `buildx.mfgx` does
not. A substring test would let a lookalike through. Anything else, including a
URL that will not parse and any host outside `*.fuuz.app`, is refused: failing
open on an unrecognised page is how a gate becomes decorative.

### Where it is enforced

Two independent checks, on two different sources of truth:

- **The service worker**, against the URL **Chrome** reports for the tab
  (`chrome.tabs.get`) — never a URL supplied by the caller.
- **The content script**, against its own `location`, which page script cannot
  change without a real navigation.

The panel also hides these controls, but that is a courtesy, not a control.
Neither a worker bug nor a spoofed message alone is enough to get through.

`test/environment.test.ts` is the specification: lookalike slugs, lookalike
domains, and unparseable URLs all have named assertions.

## Screenshots

`chrome.tabs.captureVisibleTab` in the service worker, cropped with
`getBoundingClientRect` from the page and downscaled in an `OffscreenCanvas`
before it leaves.

Three limits are inherent, and reported rather than worked around:

- **visible viewport only** — no full-page scroll-stitch;
- **never DevTools itself**;
- **the tab must be active in its window** — a background tab renders nothing.

Downscaling to a 1200px longest edge is not cosmetic. These images are routinely
read by an LLM through the MCP bridge, and a raw retina PNG is several megabytes
of base64 — the difference between a usable tool and one that costs a large
slice of a conversation per call.

Because a screenshot is a *moment* rather than state, it cannot ride the
snapshot push. `fuuz_screen_screenshot` parks a request on the bridge, the panel
polls `GET /capture` and answers with `POST /capture`. The queue is one deep: a
second pending request would only ever produce a near-identical image.
