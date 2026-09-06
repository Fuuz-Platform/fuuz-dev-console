# Property inspector & live editing — plan

> **Status (2026-08-16): steps 0–4 built.** Step 4 ships **off by default**, as
> planned — its toggle appears only on a permitted environment, and its `ƒx`
> editor only on props that actually accept a transform. "Apply result" is
> disabled with the reason whenever the property is not runtime-settable, so the
> question of whether it should exist is now answerable from use rather than
> argument. What
> changed the shape of the work: the skill turned out to document each element's
> **`resolvedName`, every prop with a description, and the runtime `fn` bag** —
> so `scripts/extract-elements.mjs` now generates the whole registry (41
> elements, 484 props, 73 functions) instead of the 37 transformable props the
> plan assumed, and editability is decided from documented functions rather than
> guessed. A production gate was added on top: mutation and capture are confined
> to build/QA environments, enforced in the service worker and content script.

Turning the Structure tab into the place a developer actually works: see every
property of an element, know which accept transforms, write one against live
state with autocomplete, and change values to see the real impact.

## What this rests on (already built and verified)

| Piece | Status |
| --- | --- |
| Transformable-prop registry — 22 element types, 37 props, from the `fuuz-screen-elements` skill | extracted, validated against Asset Intake |
| Structure tree from the craft design, with element names and types | working |
| Live `context` snapshot per transform | working |
| Design fetched from the API using the page's own session | working |
| Element → DOM locator — now **exact** via `data-system-name` | working, tested against real designer markup |
| Designer surface detection (screen / schema) | working |
| Live DOM mutation (CSS pane) | working |

### The designer exposes what we were approximating

The screen designer canvas labels every element precisely:

```html
<div id="mfgx-screen-designer-canvas">
  <div data-screen-element="SelectInput" data-system-name="IntakeTarget">
  <div id="IntakeFormSlot">            <!-- containers use the name as a DOM id -->
```

`data-system-name` **is** the element name, so locating is now exact rather than
inferred from `formelement` / `data-data-path`. Locator order:

1. `[data-system-name="X"]` — exact
2. `#X` — containers
3. `[formelement="X"]` — fields by owning form
4. `[data-data-path]`, `[data-screen-element]`, `[element]` — narrowing fallbacks

Each designer is identified by a stable canvas id, which is how the panel knows
which surface the developer is on:

| Surface | Marker |
| --- | --- |
| Screen designer | `#mfgx-screen-designer-canvas` |
| Schema designer | `#mfgx-data-model-diagram` (nodes: `data-nodeid`, `#mfgx-node-<Model>`) |
| Flow designer | `[id$="-mfgx-data-flow-diagram"]` — **the flow id is the prefix**, so it comes free |

The open tab is `[data-tab-id]` with its name in a child `<p>`. Flow and schema
canvases label their nodes `data-nodeid` (`#mfgx-node-<name>`), which both
identifies them and confirms a populated canvas rather than an empty shell.

### The designer publishes the structure itself

The "Screen Structure" panel renders a `ul[role="tree"]` whose every row carries
**the craft node id** — `data-node-id="ROOT"`, `data-node-id="IntakePage00"` —
the same keys as `design.components[].props.design`. So Structure works the
moment the designer is open, with no screen version to resolve and no API call
to fail. `core/domStructure.ts` reads it; `core/screenApi.ts` upgrades it.

Two properties of that tree matter more than the tree:

- **It is lazy.** A collapsed row renders no children at all. The row's own
  "N app components" label is the only evidence they exist, so a scrape must
  distinguish *childless* from *not shown* — otherwise the panel invents leaves.
- **It is filtered.** The designer's chips hide rows, and hiding everything
  prints "Nothing matches the selected filters."

Both are reported, and the pane says which source it is showing. Rows also carry
`Mui-selected`, so the panel knows which element the developer has selected —
something the design alone can never tell it.

Three corrections already applied:

- **The designer canvas is not inert.** Transforms *do* execute while designing;
  what is empty is their *context* (`urlParameters: {}`, `screen: null`,
  `components: []`). The conclusion — resolve by screen id — survived, but the
  stated reason was wrong.

- **`/run` is not special.** The screen version comes from
  `metadata.urlParameters.screenVersionId`, which works on any route. URL parsing
  is a pre-context fallback covering four shapes, with a length guard so
  `/screens/new` isn't mistaken for an id.
- **The runtime exposes a supported mutation API** — the `fn` bags — so editing
  state need not be a DOM poke.

---

## Step 0 — Fiber probe (de-risk before building anything)

Everything in steps 3–4 depends on reaching a live component from the page. The
app exposes no global handle (`window.__fuuz*`, `window.fuuz*`: zero hits), so
the only route is walking React fibers (`__reactFiber$*`) from a located DOM
node up to the component whose props hold the `fn` bag.

**Build:** a MAIN-world probe that, given an element name, reports whether it
found a component, and which `fn` keys it can see.

**Decide:** if it can't find components reliably across element types, steps 3–4
are cut to the DOM-preview tier and we say so. Ten minutes of work that decides
whether a week of UI is worth building.

**Risk if skipped:** we build a beautiful editor over an API we can't call.

---

## Step 1 — Property inspector (read-only)

Structure stays a tree. Selecting an element fills the detail pane below with
**every** property, not just the ones carrying transforms.

Four states, distinguishable at a glance:

```
● disabled       $not($exists($components.AssetIntakeForm.data.assetCollection.id))  → true
○ defaultValue   —                                                    [add transform]
· variant        "outlined"
? padding        (element type not documented)
```

- **●** has a transform — expression and current value
- **○** transformable per the registry, currently static
- **·** static only
- **?** the skill documents no table for this type (e.g. `Container`) — *unknown*,
  which is not the same as *none*, and must not be shown as none

Each row carries the skill's **description** ("Whether the input is disabled").
That column needs extracting — the current registry keeps only prop and type.

Nested props (`query.parameters`, `validation.transform`) flatten to dotted rows,
matching how the skill names them and how you'd type them.

**Ships value immediately. No risk.**

---

## Step 2 — Scoped scratchpad + autocomplete

Clicking a property opens the scratchpad **bound to it**:

- Header: `IntakePrepare.disabled` · ActionButton · *"Whether the input is disabled"*
- Existing expression preloaded, or empty
- Live current value beside the result, so you see `true → false` as you edit
- `__cacheKey` and `remote` shown, since both change behaviour

**Autocomplete is where this succeeds or fails.** Trigger on `$`, and show the
current value in the suggestion:

```
$components.AssetIntakeForm.data.title             "Screen Runner capture"
$components.AssetIntakeForm.data.assetCollection   (not found)
$components.TicketTable.data                       [ 0 items ]
$metadata.user.id                                  "clblbguru000901stclxdf3d3"
```

You are not completing a path, you are seeing what is in it. That `(not found)`
is the actual Asset Intake bug, visible *before* writing the expression.

Corpus: design elements and their props, unioned with the live context snapshot,
plus locals bound earlier in the expression (`$me := …`).

**Still read-only. No risk.**

---

## Step 3 — Editing state values

Two honest tiers, decided by Step 0.

**Tier A — real, via the runtime's own API.** Values reachable through an `fn`
call. This is what a flow does; transforms depending on the value re-fire and the
panel captures them, so the impact is real *and* traced.

| Path | Call |
| --- | --- |
| `AssetIntakeForm.data.<field>` | `fn.setValue(field, value)` |
| `TicketTable.data` | `fn.setData(rows)` |
| any container's visibility | `fn.show()` / `fn.hide()` |
| `Screen.context.<key>` | `fn.setContextValue(key, value)` |

**Tier B — preview only.** Computed props with no setter (`IntakePrepare.disabled`).
Set on the DOM, and **the runtime overwrites on its next render**. Labelled as a
preview, never as a change.

### Editing interaction

**Double-click the value to edit it in place.** Not a separate form, not a modal —
the value becomes editable where it sits, and Enter commits, Escape cancels.

**Edit the value, never its punctuation.** The tree displays `"Screen Runner
capture"`; double-clicking puts the caret in `Screen Runner capture` with the
quotes stripped. The developer types the value, not the JSON around it. Same for
transforms: you edit the expression body, not a quoted string containing it.

This forces one thing to be right: **the editor must read the real value, not the
displayed one.** The tree stores values through `formatValue`, which is lossy by
design — `[ 12 items ]` and `{ a: 1, … }` are summaries, and round-tripping them
as text would silently destroy data. So the inline editor resolves the actual
value from the context snapshot by path, and only falls back to the display
string for scalars where the two agree.

Type is preserved from the original, not guessed from the input:

| Was | Shown | Edits as | Commits as |
| --- | --- | --- | --- |
| string | `"Screen Runner capture"` | `Screen Runner capture` | string |
| boolean | `true` | `true` | boolean — typing `false` gives `false`, not `"false"` |
| number | `640` | `640` | number |
| null | `null` | `null` | null, unless replaced |
| object / array | `[ 12 items ]` | full JSON in a multi-line editor | parsed, rejected if invalid |
| transform | expression | expression body, multi-line | expression |

Booleans get a click-to-toggle as well as the text path — flipping `true`/`false`
is the common case and shouldn't need typing.

Multi-line values (transforms, scripts, objects) open a sized textarea rather
than a single-line input, with the same double-click entry.

Invalid input is rejected at commit with the reason inline, and the original
value is left untouched — never partially applied.

The tier (A: real, B: preview) is stated per property. A disabled control with a
reason beats a control that silently does nothing.

---

## Step 4 — Transform preview

Evaluate a candidate transform and apply its result to the property, so you see
the screen react before committing anything to the designer.

Inherits Step 3's tiers exactly: Tier A applies for real, Tier B previews until
the next render. Props whose effect requires the runtime to re-run a query or
flow (`query.parameters`, `optionQuery`, `validation.transform`, `flowInput`)
**cannot** be applied at all — the button is disabled with that reason.

Default this step **off**. It is the only part that mutates, and the honest
alternative — evaluate, read the value, paste into the designer — is always
available.

---

## Nothing is ever saved — *superseded 2026-08-19*

> **The original rule, kept because the reasoning still governs what replaced it:**
> Every mutation in steps 3–4 is runtime-only: no design write, no API call, and a
> reload discards it. The design changes when the developer copies the expression
> into the designer. This is deliberate — a tool that silently altered the thing it
> is diagnosing would undermine everything else it reports.

Steps 3–4 are still runtime-only, and that has not changed. What changed is that the
console now has a **separate, explicit** path for writing a screen or flow definition
back to the platform, because copying an expression into the designer by hand is a poor
way to apply a change you have already proved correct against live state.

The operative word in the old rule is **silently**. That is what the new path is built
to prevent:

| Guard | Why |
| --- | --- |
| `apply` defaults to **false** | a call with no explicit intent returns the request it *would* send and sends nothing |
| every patch returns `before` → `after` for the exact path it touched | a caller that cannot show a diff cannot apply one |
| an ambiguous target is **refused**, with its candidates | writing to the wrong element is invisible to the user and cannot be undone from here |
| a read-back immediately before the write | these mutations replace the document wholesale and the platform has no compare-and-swap, so a designer who saved in between would be silently overwritten — this refuses instead |
| gated as `writeDefinition` | build/QA only, enforced in the worker and content script like every other gated capability, *not* by hiding a button |
| the patch is a clone of what was read | everything in the screen we do not understand survives untouched |

Where writes land, and where they do not:

- **Screen** → `updateScreenVersion(payload.update.design)` — the version, never the
  parent screen. Writing at the wrong level lands an edit in a version nobody is looking at.
- **Flow** → `updateDataFlowVersion(payload.update.flow)` — the same mutation and the same
  document shape the designer itself sends on save, captured from a real save in
  `ace/parity/evidence/nq-door-designer-mutation/0006.json`.
- **Deployment is not touched.** A write updates the version the *designer* reads. What a
  deployed runtime serves is whatever version was deployed, so making a change live is
  still a deliberate deploy — this path will not do it for you.

Code: `core/designPatch.ts` (pure patching and refusals), `core/designWrite.ts` (the
mutations and the moved check), `extension/relay.ts` (`writeDefinition` — gate, read-back,
send), reachable as `host.design.apply(...)`.

## Open questions

1. ~~The flow designer's canvas id.~~ **Resolved** — all three surfaces detect,
   and the flow canvas carries its flow id as a prefix.
2. **Undocumented element types.** `Container` and other layout elements have no
   skill table. Treat as unknown, or infer from observed transforms across
   designs?
3. **Should Step 4 exist**, given it previews something the runtime overwrites?

## Order and why

Step 0 first because it decides the shape of 3–4. Then 1 → 2, which are pure
gain and carry no risk. Then 3, then 4 behind a flag. Value lands at Step 1;
everything with a real limit comes last and is optional.
