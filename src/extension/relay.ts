/**
 * Isolated-world relay and element highlighter.
 *
 * Carries console events out of the MAIN world (which can post but can't reach
 * `chrome.runtime`), and paints the hover highlight — the affordance Chrome's
 * Elements tab has and a Fuuz developer wants, but keyed on *Fuuz* element
 * names rather than `div`.
 */
import { parseDomStructure, type DomStructureResult } from '../core/domStructure';
import { scrapeCanvas, type CanvasScrape } from '../core/canvasScrape';
import { scrapeRuntime, type RuntimeScrape } from '../core/runtimeScrape';
import { readExpandedRow } from '../core/consoleDom';
import {
  attributeNames, climbToContainer, isApproximate, locateAttempts, pickAttributeHit,
  type Ancestor, type AttributeHit, type LocateTarget,
} from '../core/locate';
import { selectedNodes, type CanvasSelection, type NodeDescriptor } from '../core/canvasSelection';
import { pickCanvas, tabForCanvas, type CanvasCandidate } from '../core/surface';
import {
  classifyWires, outputColour, WIRE_COLOURS,
  type Point, type Port, type Wire, type WireVerdict,
} from '../core/wires';
import { closeOverlay, overlayState, restoreOverlay, setOverlay, type DockMode } from './overlay';
import {
  clearMarkup, copyImageToClipboard, editSelectedText, hideChromeForCapture, markupState,
  removeShape, selectShape, selectedShape, setMarkup, undoMarkup, type MarkupTool,
} from './markup';
/**
 * Requests that must be answered by the MAIN world.
 *
 * React fibers live on DOM nodes as expando properties, and page globals live on
 * the page's `window` — neither is visible from this isolated world. So the
 * locator stays here (it only needs the DOM) and anything reading the page's own
 * objects is forwarded to the hook.
 */
const MAIN_REQ = 'fuuz-devtool-request';
const MAIN_RES = 'fuuz-devtool-response';
let mainSeq = 0;
const mainWaiters = new Map<number, (result: unknown) => void>();

/**
 * Accept only same-page messages.
 *
 * `e.source === window` is the browser's own signal for a same-window post. The
 * origin check is what actually keeps a cross-origin iframe out — it cannot
 * forge `location.origin` — and it is strictly tighter than the source check
 * alone. The `null`/`''` pair is jsdom's shape for a same-window post, which
 * cannot occur on a real https page, and is what makes this path testable at all.
 */
function fromThisPage(e: MessageEvent): boolean {
  const sourceOk = e.source === window || e.source === null;
  const originOk = e.origin === '' || e.origin === location.origin;
  return sourceOk && originOk;
}

window.addEventListener('message', (e: MessageEvent) => {
  if (!fromThisPage(e)) return;
  const msg = e.data as { source?: string; id?: number; result?: unknown } | null;
  if (!msg || msg.source !== MAIN_RES || typeof msg.id !== 'number') return;
  const waiter = mainWaiters.get(msg.id);
  if (!waiter) return;
  mainWaiters.delete(msg.id);
  waiter(msg.result);
});

function askMainWorld<T>(type: string, payload: Record<string, unknown>, onTimeout: T, ms = 3000): Promise<T> {
  return new Promise<T>((resolve) => {
    const id = ++mainSeq;
    mainWaiters.set(id, (result) => resolve(result as T));
    window.postMessage({ source: MAIN_REQ, id, type, payload }, '*');
    setTimeout(() => {
      if (!mainWaiters.delete(id)) return;
      resolve(onTimeout);
    }, ms);
  });
}

/**
 * A selector that re-finds the element the locator just found.
 *
 * The two worlds cannot pass an element reference to each other, so the MAIN
 * world is told how to look it up. `data-fuuz-probe` is a temporary marker for
 * the cases no stable attribute covers, removed as soon as it is used.
 */
const PROBE_ATTR = 'data-fuuz-probe';
function selectorFor(target: Parameters<typeof locate>[0]): string | undefined {
  const el = locate(target);
  if (!el) return undefined;
  const esc = (v: string) => v.replace(/["\\]/g, '\\$&');
  const name = el.getAttribute('data-system-name');
  if (name) return `[data-system-name="${esc(name)}"]`;
  if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return `#${el.id}`;
  el.setAttribute(PROBE_ATTR, '1');
  return `[${PROBE_ATTR}="1"]`;
}
function clearProbeMarks(): void {
  document.querySelectorAll(`[${PROBE_ATTR}]`).forEach((el) => el.removeAttribute(PROBE_ATTR));
}
import { isGated, mutationsAllowed, refusalFor, type GatedCapability } from '../core/environment';
import {
  screenDesignUpdate, screenVersionRead, flowVersionUpdate, flowVersionRead, hasMoved,
  type ApplyOutcome, type GraphQLRequest,
} from '../core/designWrite';

/**
 * Second enforcement point for the production gate.
 *
 * The service worker already refuses these, and this repeats the check against
 * the content script's **own** `location` — which page script cannot change
 * without a real navigation. Two independent checks on two different sources
 * means neither a worker bug nor a spoofed message alone is enough to get
 * through.
 */
function refuseIfProduction(type: string): string | undefined {
  if (!isGated(type)) return undefined;
  if (mutationsAllowed(location.href)) return undefined;
  return refusalFor(location.href, type as GatedCapability);
}

const CHANNEL = 'fuuz-dev-console';
const OVERLAY_ID = '__fuuz_devtool_overlay';

/**
 * Page-registered WebMCP tools asking the panel for an answer.
 *
 * The analysis lives in the panel, so a tool registered in the page has to reach
 * it: page → here → service worker → panel, and back. One implementation of the
 * pipeline instead of a second copy in the page.
 */
const PANEL_REQ = 'fuuz-devtool-panel-request';
const PANEL_RES = 'fuuz-devtool-panel-response';

window.addEventListener('message', (e: MessageEvent) => {
  if (!fromThisPage(e)) return;
  const msg = e.data as { source?: string; id?: number; query?: string; args?: unknown } | null;
  if (!msg || msg.source !== PANEL_REQ || typeof msg.id !== 'number') return;
  const id = msg.id;
  try {
    chrome.runtime.sendMessage({ type: 'webmcpQuery', query: msg.query, args: msg.args }, (reply) => {
      void chrome.runtime.lastError;
      window.postMessage({ source: PANEL_RES, id, result: reply ?? { error: 'The panel is not open on this tab.' } }, '*');
    });
  } catch {
    window.postMessage({ source: PANEL_RES, id, result: { error: 'The extension is not reachable.' } }, '*');
  }
});

window.addEventListener('message', (e: MessageEvent) => {
  if (!fromThisPage(e)) return;
  const data = e.data as { source?: string; event?: unknown } | null;
  if (!data || data.source !== CHANNEL || !data.event) return;
  try { chrome.runtime.sendMessage({ type: 'console', event: data.event }); }
  catch { /* the panel may not be open; dropping is correct */ }
});

/**
 * Find the DOM node for a Fuuz element.
 *
 * The renderer exposes `formelement` (owning form), `data-data-path` (bound
 * field) and `element` (element type) — verified on a live screen. Not every
 * element type carries one, so this reports failure rather than highlighting
 * something arbitrary.
 */
function locate(target: LocateTarget): Element | null {
  return locateWithReason(target).el;
}

/** Ids of our own overlays, so the scan never highlights the console itself. */
const OURS = ['__fuuz_devtool_overlay', 'fuuz-dev-console-host', '__fuuz_markup_layer'];

const isOurs = (el: Element) => OURS.some((id) => el.id === id || el.closest?.(`#${id}`));

/**
 * Find an element, and say how.
 *
 * Selectors first — exact and cheap. Then, only if they all miss, a scan of every
 * attribute in the document for the element's name. The scan is what makes a
 * **running** screen work: at runtime there is no `data-system-name`, and rather
 * than guess which attribute replaced it we look for the value and report which
 * attribute held it.
 */
function locateWithReason(target: LocateTarget): { el: Element | null; via?: string; scanned?: number } {
  for (const { selector, via } of locateAttempts(target)) {
    try {
      const hit = document.querySelector(selector);
      if (hit && !isOurs(hit)) return { el: hit, via };
    } catch { /* a name with odd characters — skip that selector */ }
  }

  // Nothing named it in a way we knew about. Look for the name itself.
  if (target.name) {
    const scan = scanForName(target.name);
    if (scan.el) return scan;
    /*
     * Diagram nodes name themselves in *text*, not in an attribute.
     *
     * A schema model's name is the heading inside its box and a flow step's is its
     * label, so the attribute scan cannot find either. Matching on text is only safe
     * because it is scoped to `[data-nodeid]` — the diagram's own nodes — and requires
     * the title to match exactly. Doing this across a whole screen would outline
     * whatever paragraph happened to mention the name.
     */
    const node = findCanvasNode(target.name);
    if (node) return { el: node, via: 'diagram node title' };
    return { el: null, scanned: scan.scanned };
  }
  return { el: null };
}

/**
 * Every element carrying this name in any attribute, ranked.
 *
 * Linear in the size of the document, run once per hover — a few thousand elements
 * is well under a frame, and the alternative is a highlight that silently does
 * nothing on every running screen.
 */
function scanForName(name: string): { el: Element | null; via?: string; scanned: number } {
  const all = document.body?.querySelectorAll('*') ?? [];
  const hits: (AttributeHit & { el: Element })[] = [];

  for (const el of Array.from(all)) {
    if (isOurs(el)) continue;
    for (const attr of Array.from(el.attributes)) {
      // `class` and `style` hold many words and would match by coincidence.
      if (attr.name === 'class' || attr.name === 'style') continue;
      if (!attributeNames(attr.value, name)) continue;
      const rect = (el as HTMLElement).getBoundingClientRect();
      hits.push({ el, attr: attr.name, depth: depthOf(el), area: rect.width * rect.height });
      break;
    }
  }

  const best = pickAttributeHit(hits);
  const winner = best && hits.find((h) => h.attr === best.attr && h.depth === best.depth && h.area === best.area);
  return {
    el: winner?.el ?? null,
    via: winner ? `${winner.attr}="${name}" (found by scanning ${all.length} elements)` : undefined,
    scanned: all.length,
  };
}

/**
 * A diagram node whose visible title names this element.
 *
 * Exact first, then normalised — the canvas collapses whitespace and can differ in case
 * from the flow definition, and failing on that would mean a node you can plainly see
 * does not highlight. Still an equality test, not a substring one: `Load` must not match
 * `Load Customers`.
 */
function findCanvasNode(name: string): Element | null {
  const nodes = Array.from(document.querySelectorAll('[data-nodeid]')).filter((el) => !isOurs(el));
  const exact = nodes.find((el) => nodeTitle(el) === name);
  if (exact) return exact;
  const key = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  return nodes.find((el) => key(nodeTitle(el) ?? '') === key(name)) ?? null;
}

/**
 * The element whose box should be outlined.
 *
 * Walks up from the located node while each parent is genuinely bigger and contains no other
 * Fuuz element, so the outline covers the whole field — label, control, helper text — and
 * never two fields at once.
 */
function growToContainer(el: Element): Element {
  /*
   * A diagram node is never grown.
   *
   * Its ancestors contain no *screen* element markers, so the climb found nothing to stop it
   * and walked four levels up — outlining a huge canvas container instead of the node. A node
   * also already has its own border, so there is nothing to grow towards.
   */
  if (el.hasAttribute('data-nodeid')) return el;

  const chain: Element[] = [];
  for (let p = el.parentElement; p && chain.length < 6; p = p.parentElement) chain.push(p);

  const ancestors: Ancestor[] = chain.map((parent) => {
    const rect = parent.getBoundingClientRect();
    // Another marked element under this parent that is not our own subtree.
    const others = Array.from(parent.querySelectorAll(ELEMENT_MARKER))
      .filter((other) => other !== el && !el.contains(other) && !isOurs(other));
    return { area: rect.width * rect.height, containsOther: others.length > 0 };
  });

  const rect = el.getBoundingClientRect();
  const levels = climbToContainer({ area: rect.width * rect.height }, ancestors);
  return levels > 0 ? chain[levels - 1] : el;
}

/**
 * What counts as "another element" when deciding how far to climb.
 *
 * The same markers the runtime scrape looks for — so the outline stops at exactly the
 * boundary the element tree considers a separate element.
 */
const ELEMENT_MARKER = [
  'data-system-name', 'data-element-name', 'data-fuuz-element', 'formelement',
  'data-screen-element', 'element', 'field', 'data-data-path',
  // Diagram nodes count: without this the climb had no boundary on a flow canvas.
  'data-nodeid',
].map((a) => `[${a}]`).join(',');

function depthOf(el: Element): number {
  let d = 0;
  for (let p = el.parentElement; p; p = p.parentElement) d += 1;
  return d;
}

/**
 * Which designer surface, if any, the page is showing.
 *
 * The screen designer mounts a canvas with a stable id, and each open tab is a
 * button carrying `data-tab-id` plus an icon naming its kind. That is enough to
 * know whether the developer is looking at a screen, and which one — without
 * which the panel cannot tell a designer session from a running screen.
 */
/**
 * Each designer mounts a canvas with a recognisable id.
 *
 * Screen and schema use a fixed id; the flow canvas is **prefixed with the flow's
 * own id** (`<flowId>-mfgx-data-flow-diagram`), so it needs a suffix match — and
 * that prefix hands us the flow id for free.
 */
/**
 * A tab's kind, from the icon the platform draws on it.
 *
 * `desktop` and `chart-network` are what a live session actually uses — they were
 * missing, so every screen and schema tab came back with `kind: undefined`, which is
 * why the tab strip could not name a tab and the active-tab match had nothing to
 * match on.
 */
const TAB_KIND: Record<string, string> = {
  // Verified against a live Application Designer session.
  desktop: 'screen', 'chart-network': 'schema', 'diagram-project': 'flow',
  // Retained: other builds of the platform have used these.
  'vector-square': 'screen', 'table-columns': 'schema', sitemap: 'flow',
  database: 'schema', browser: 'screen',
};

const tabIcon = (el: Element) => el.querySelector('svg[data-icon]')?.getAttribute('data-icon') ?? undefined;

function tabKind(el: Element): string | undefined {
  const icon = tabIcon(el);
  return icon ? TAB_KIND[icon] : undefined;
}

const DESIGNER_CANVASES: { suffix: string; kind: string; carriesId: boolean }[] = [
  { suffix: 'mfgx-screen-designer-canvas', kind: 'screen', carriesId: false },
  { suffix: 'mfgx-data-model-diagram', kind: 'schema', carriesId: false },
  { suffix: '-mfgx-data-flow-diagram', kind: 'flow', carriesId: true },
];

function designerSurface(): {
  designer: string | null; designerId?: string; tabId?: string; tabName?: string; nodes?: number;
  domStructure?: DomStructureResult;
  /**
   * The canvas scrape — the preferred structure source. Unlike the tree widget
   * it is neither lazy nor filterable, and it carries types and applied CSS.
   */
  canvasStructure?: CanvasScrape;
  probe: {
    canvas: boolean; tree: boolean; rows: number; filtered: boolean; tabId: boolean; canvasRows: number;
    /** Every mounted designer canvas and whether it is the visible one. */
    canvases?: { kind: string; visible: boolean; area: number }[];
  };
  /**
   * Which of Fuuz's console drawers exist on this page right now.
   *
   * The flow log drawer only mounts on a data flow tab, so its presence is the
   * honest condition for offering a switch — better than inferring it from the
   * designer kind, which can be right while the drawer has not mounted yet.
   */
  consoles: { flowLog: boolean; frontend: boolean };
  /** Whether markup is armed, so the panel can disable actions that do nothing. */
  markup: { active: boolean; tool: string; colour: string; shapes: number };
  /** Every open designer tab — screens, schemas and flows alike. */
  tabs: { id: string; name?: string; kind?: string; icon?: string; active?: boolean }[];
  /** A bounded sample of the flow log, when that console is present. */
  flowLog?: FlowLogScrape;
  /**
   * A running screen's own elements.
   *
   * The only source that works off a run route, and the only one whose names are
   * guaranteed locatable — they came out of this DOM.
   */
  runtimeStructure?: RuntimeScrape;
  /** Diagram-canvas nodes, which are selected, and what they carry. */
  canvasNodes?: {
    nodes: NodeDescriptor[];
    selection: CanvasSelection;
    probe: { attributes: string[]; classes: string[]; sample?: string };
  };
} {
  let designer: string | null = null;
  let designerId: string | undefined;
  let canvas: Element | null = null;

  /*
   * Every mounted canvas, then the one that is *visible*.
   *
   * Taking the first match in a fixed order made a flow unreadable whenever a screen tab
   * was also open, because the designer keeps inactive tabs mounted and hidden.
   */
  const found: (CanvasCandidate & { el: Element })[] = [];
  for (const { suffix, kind, carriesId } of DESIGNER_CANVASES) {
    const hits: Element[] = carriesId
      ? Array.from(document.querySelectorAll(`[id$="${suffix}"]`))
      : ([document.getElementById(suffix)].filter(Boolean) as Element[]);
    for (const hit of hits) {
      const rect = (hit as HTMLElement).getBoundingClientRect();
      found.push({
        el: hit,
        kind,
        designerId: carriesId ? hit.id.slice(0, -suffix.length) || undefined : undefined,
        // `offsetParent` is null for anything inside a `display: none` subtree, which is
        // how the designer hides an inactive tab. Paired with a layout box, since a
        // zero-size visible canvas is no more use than a hidden one.
        visible: !!(hit as HTMLElement).offsetParent && hit.getClientRects().length > 0,
        area: rect.width * rect.height,
      });
    }
  }
  const chosenCanvas = pickCanvas(found);
  if (chosenCanvas) {
    designer = chosenCanvas.kind;
    designerId = chosenCanvas.designerId;
    canvas = found.find((f) => f === chosenCanvas)?.el ?? null;
  }

  /*
   * Which tab is in front.
   *
   * `querySelector('[data-tab-id]')` took the first in DOM order, which on a live
   * three-tab session reported the *screen* tab's id and name while the schema canvas
   * was the one open — so the surface key and the tab label both named the wrong tab.
   *
   * The platform does not set `aria-selected` on these buttons, so the reliable signal
   * is the canvas itself: exactly one designer canvas is mounted at a time, and the
   * tab whose icon matches its kind is the one in front. DOM order is the last resort,
   * and only when no tab matches.
   */
  const tabButtons = Array.from(document.querySelectorAll('[data-tab-id]'));
  const tabDescriptors = tabButtons.map((el) => ({
    id: el.getAttribute('data-tab-id') ?? '', kind: tabKind(el), el,
  }));
  const owning = tabForCanvas(tabDescriptors, chosenCanvas);
  const activeTab = tabButtons.find((el) => el.getAttribute('aria-selected') === 'true')
    ?? owning?.el
    ?? tabButtons[0];

  /*
   * Every open designer tab, not just one.
   *
   * `document.querySelector('[data-tab-id]')` returned whichever came first, so a
   * three-tab session looked like a one-tab session. The kind comes from each
   * button's own icon; the platform marks the active one with `aria-selected`, and
   * where it does not we say so rather than guessing which is in front.
   */
  const tabs = tabButtons.map((el) => {
    const icon = tabIcon(el);
    const selected = el.getAttribute('aria-selected');
    return {
      id: el.getAttribute('data-tab-id') ?? '',
      name: el.querySelector('p')?.textContent?.trim() || undefined,
      kind: tabKind(el),
      icon,
      // `null` means the platform does not mark it, which is different from false.
      active: selected === null ? undefined : selected === 'true',
    };
  }).filter((t) => t.id);
  const structure = parseDomStructure(document);
  const fromCanvas = scrapeCanvas(document);
  /*
   * Only when there is no designer canvas.
   *
   * In the designer both would match — the canvas renders the same elements — and the
   * canvas scrape is richer (types, applied CSS). At runtime the canvas is absent and
   * this is the only source there is.
   */
  const drawers = findConsoleDrawers();
  // Warmed here so a click on a node has the model already, rather than falling back once.
  if (designer === 'flow') refreshLinkModel();
  const fromRuntime = fromCanvas ? undefined : scrapeRuntime(document, {
    /*
     * Fuuz's own console drawers are excluded.
     *
     * We *open* them by enabling transform debugging, and their controls are built from the
     * same components a screen is — so `defaultLogFilters` turned up in the element list as
     * though it were part of the screen, and then could not be highlighted. Our own
     * diagnostics must not appear as the thing being diagnosed.
     */
    exclude: [drawers.flowLog, drawers.frontend].filter((el): el is HTMLElement => !!el),
  });
  return {
    designer: designer
      ?? (fromCanvas || fromRuntime || (structure && structure.count > 0) ? 'screen' : null),
    designerId,
    tabId: activeTab?.getAttribute('data-tab-id') ?? undefined,
    tabName: activeTab?.querySelector('p')?.textContent?.trim() || undefined,
    // Flow and schema canvases label their nodes; a count confirms we found a
    // populated canvas rather than an empty shell.
    nodes: canvas ? canvas.querySelectorAll('[data-nodeid]').length || undefined : undefined,
    // The screen designer renders its own structure tree, keyed by craft node
    // id. Reading it means Structure works the moment the designer is open,
    // with no screen version to resolve and no API call to fail.
    // Not gated on detecting the canvas. The tree's own presence is the
    // evidence that there is a tree — requiring `#mfgx-screen-designer-canvas`
    // first meant any change to that id silently cost us the structure that was
    // sitting right there in the DOM.
    domStructure: structure && structure.count > 0 ? structure : undefined,
    canvasStructure: fromCanvas,
    runtimeStructure: fromRuntime,
    probe: {
      canvas: !!canvas,
      tree: !!structure,
      rows: structure?.count ?? 0,
      filtered: structure?.filteredEmpty ?? false,
      tabId: !!activeTab,
      canvasRows: fromCanvas?.count ?? 0,
      /*
       * Every canvas in the document, and whether each is visible.
       *
       * "A screen canvas exists" and "the developer is looking at a screen" are different
       * facts, and conflating them is what made a flow unreadable. Reported so the
       * difference shows up in a snapshot instead of having to be deduced.
       */
      canvases: found.map((f) => ({ kind: f.kind, visible: f.visible, area: Math.round(f.area) })),
    },
    consoles: { flowLog: !!drawers.flowLog, frontend: !!drawers.frontend },
    tabs,
    markup: markupState(),
    flowLog: scrapeFlowLog(),
    /*
     * Diagram-canvas selection — the flow node or schema model being looked at.
     *
     * The screen designer's selection came free from its structure tree's
     * `aria-selected`. A diagram has no tree, so the nodes are read directly and
     * every known selection convention is tried (see `canvasSelection.ts`).
     */
    canvasNodes: canvas ? readCanvasNodes(canvas) : undefined,
  };
}

/**
 * Every node on a diagram canvas, with enough to tell whether it is selected.
 *
 * `data-nodeid` is what both the flow and schema canvases put on their nodes — the
 * same attribute the node count already uses, so this adds no new assumption.
 */
function readCanvasNodes(canvas: Element): {
  nodes: NodeDescriptor[];
  selection: CanvasSelection;
  /**
   * What the nodes actually carry, so an unrecognised selection marker is
   * identifiable instead of merely absent.
   *
   * Selection detection guessed at three conventions and found none of them on the
   * live schema canvas. Reporting the attributes present is what turns "nothing is
   * selected" into "here is the marker to add".
   */
  probe: { attributes: string[]; classes: string[]; sample?: string };
} {
  const nodes: NodeDescriptor[] = Array.from(canvas.querySelectorAll('[data-nodeid]')).map((el) => ({
    id: el.getAttribute('data-nodeid') ?? '',
    // The visible title. A schema node's heading is its model name, which is what
    // the model browser needs; a flow node's is the step name.
    name: nodeTitle(el),
    ariaSelected: el.getAttribute('aria-selected'),
    dataSelected: el.getAttribute('data-selected'),
    classes: el.className && typeof el.className === 'string' ? el.className : undefined,
    colour: nodeColour(el),
    signature: nodeSignature(el),
  })).filter((n) => n.id);

  const els = Array.from(canvas.querySelectorAll('[data-nodeid]'));
  const attributes = new Set<string>();
  const classes = new Set<string>();
  for (const el of els) {
    for (const a of Array.from(el.attributes)) if (a.name !== 'style') attributes.add(a.name);
    for (const c of Array.from(el.classList)) classes.add(c);
    // A node's own wrapper may carry the selection rather than the node: a diagram
    // commonly marks the parent, which is why the parent is sampled too.
    const parent = el.parentElement;
    if (parent) {
      for (const a of Array.from(parent.attributes)) if (a.name !== 'style') attributes.add(`parent:${a.name}`);
      for (const c of Array.from(parent.classList)) classes.add(`parent:${c}`);
    }
  }
  return {
    nodes,
    selection: selectedNodes(nodes),
    probe: {
      attributes: [...attributes].sort(),
      classes: [...classes].sort().slice(0, 60),
      sample: els[0] ? (els[0] as HTMLElement).outerHTML.slice(0, 700) : undefined,
    },
  };
}

/**
 * A canvas node's visible title.
 *
 * Headings first, then the first non-empty text line. Taking `textContent` whole
 * would return a model's entire field list as its "name".
 */
/**
 * A node's accent colour, as the canvas paints it.
 *
 * Read from the node's own border first, then from whichever descendant carries a solid
 * background — Fuuz draws the accent as a header strip or a left border depending on the node
 * kind, so one selector would find it for some nodes and not others.
 *
 * Transparent and near-white values are rejected: they are the card surface, not the accent,
 * and using them would give every node the same colour and make the whole exercise pointless.
 */
/**
 * What could distinguish a selected node from an unselected one.
 *
 * Generated class names plus the styles a canvas might use instead. Deliberately *not* a
 * specific class or property: the live canvas marks selection only through a changed emotion
 * class, and hard-coding that name would break the next time the platform rebuilds.
 *
 * Positional styles are excluded — `top`/`left` differ per node by definition and would make
 * every signature unique, which would report the whole canvas as selected.
 */
function nodeSignature(el: Element): string | undefined {
  const generated = (el.className && typeof el.className === 'string' ? el.className : '')
    .split(/\s+/)
    .filter((c) => /^(css-|jss)/.test(c))
    .sort()
    .join(' ');
  let painted = '';
  try {
    const own = getComputedStyle(el as HTMLElement);
    // The card inside carries the accent and, on some builds, the selected border.
    const card = el.querySelector('[id^="mfgx-node-"]') as HTMLElement | null;
    const inner = card ? getComputedStyle(card) : undefined;
    painted = [own.outline, own.boxShadow, own.borderColor, inner?.borderColor, inner?.boxShadow]
      .filter(Boolean).join('|');
  } catch { /* detached */ }
  const signature = `${generated}::${painted}`;
  return signature === '::' ? undefined : signature;
}

function nodeColour(el: Element): string | undefined {
  const usable = (value: string | undefined): string | undefined => {
    if (!value) return undefined;
    const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s]+([\d.]+))?/.exec(value);
    if (!m) return undefined;
    const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const alpha = m[4] === undefined ? 1 : Number(m[4]);
    if (alpha < 0.2) return undefined;
    // Near-white and near-black are surface, not accent.
    const min = Math.min(r, g, b); const max = Math.max(r, g, b);
    if (max > 236 && min > 236) return undefined;
    if (max < 26) return undefined;
    return `rgb(${r}, ${g}, ${b})`;
  };

  try {
    const own = getComputedStyle(el as HTMLElement);
    const border = usable(own.borderTopColor) ?? usable(own.borderLeftColor) ?? usable(own.backgroundColor);
    if (border) return border;
    for (const child of Array.from(el.querySelectorAll('*')).slice(0, 12)) {
      const hit = usable(getComputedStyle(child as HTMLElement).backgroundColor);
      if (hit) return hit;
    }
  } catch { /* a detached node has no computed style */ }
  return undefined;
}

function nodeTitle(el: Element): string | undefined {
  const heading = el.querySelector('h1, h2, h3, h4, h5, h6, [data-node-title], .nodeTitle, strong, b');
  const text = (heading?.textContent ?? el.textContent ?? '').trim();
  const first = text.split(/[\n\r]/).map((l) => l.trim()).find(Boolean);
  return first ? first.slice(0, 80) : undefined;
}

/**
 * The flow log console's output region, and a bounded sample of its rows.
 *
 * `jss162` is a generated class and will not survive a style rebuild, so the
 * anchor is structural instead: inside the flow drawer's console panel the
 * header, the filter form and the footer are each a `MuiPaper-root`, and the log
 * region is the one child that is not. That holds as long as the layout does.
 *
 * Bounded deliberately. A running flow can emit thousands of rows and this rides
 * in a snapshot pushed every ~750ms to a local bridge, so an unbounded scrape
 * would be a self-inflicted performance problem. The count is reported in full
 * even when the sample is truncated, so a partial read never looks complete.
 */
/**
 * Arrival timings — a **proxy**, not the platform's own measurement.
 *
 * The flow log carries no durations, so this stamps the moment each row lands in
 * the DOM and reports the gap since the previous one. That is genuinely useful for
 * spotting which node a run stalls on, and it is genuinely *not* node execution
 * time: it includes network return, the platform's own logging latency and React's
 * render. A node that took 5ms server-side can show 200ms here.
 *
 * Labelled `proxy: true` everywhere it surfaces so nobody mistakes it for real
 * telemetry — the fix is for the platform to emit durations, and this exists to
 * make the case for that rather than to substitute for it.
 */
const ARRIVAL_CAP = 200;
let arrivals: { node: string; at: number; sinceMs?: number }[] = [];
let arrivalObserver: MutationObserver | undefined;
let watchedRegion: Element | undefined;

/** The node name a row starts with, before the first `▶` expander. */
function nodeNameOf(el: Element): string {
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  const head = text.split('▶')[0].trim();
  return head.slice(0, 80);
}

/**
 * Watch the log region for new rows.
 *
 * Re-attached when the region remounts — the designer replaces it on tab changes,
 * and an observer bound to a detached node reports nothing while looking healthy.
 */
function watchFlowArrivals(region: Element | undefined): void {
  if (!region || region === watchedRegion) return;
  arrivalObserver?.disconnect();
  watchedRegion = region;
  arrivalObserver = new MutationObserver((records) => {
    for (const record of records) {
      for (const added of Array.from(record.addedNodes)) {
        if (!(added instanceof Element)) continue;
        const node = nodeNameOf(added);
        if (!node) continue;
        const at = Date.now();
        const prev = arrivals[arrivals.length - 1];
        arrivals.push({ node, at, sinceMs: prev ? at - prev.at : undefined });
      }
    }
    if (arrivals.length > ARRIVAL_CAP) arrivals = arrivals.slice(-ARRIVAL_CAP);
  });
  arrivalObserver.observe(region, { childList: true, subtree: true });
}

const FLOW_LOG_SAMPLE = 25;
const FLOW_LOG_CHARS = 600;

export interface FlowLogScrape {
  found: boolean;
  /**
   * When each row landed, and the gap since the previous one.
   *
   * `proxy: true` because this is DOM arrival time, not the platform's node
   * duration — see the note on ARRIVAL_CAP.
   */
  timings?: { proxy: true; measures: string; arrivals: { node: string; at: number; sinceMs?: number }[] };
  /** Rows present in the DOM — may exceed the sample. */
  count: number;
  rows: { text: string; value?: unknown; level?: string; node?: string }[];
  /** Raw markup of the first row, so a parser can be written against it. */
  sampleHtml?: string;
  truncated: boolean;
}

function scrapeFlowLog(): FlowLogScrape {
  const drawer = findConsoleDrawers().flowLog;
  if (!drawer) return { found: false, count: 0, rows: [], truncated: false };

  /*
   * Anchor on the footer, not on "the first non-Paper child".
   *
   * That earlier heuristic failed on the real DOM: the drawer's **resize handle**
   * is itself a `MuiPaper-root`, so walking up from the first Paper landed on the
   * drawer rather than the console panel, and the "log region" came back as the
   * whole console — header, filters and footer as three of its four "rows".
   *
   * The footer is unambiguous: it is the only element containing the "Stick to
   * bottom" control. Its parent is the console panel, and within that panel the
   * log region is the child that is not a Paper.
   */
  const footer = Array.from(drawer.querySelectorAll('.MuiPaper-root'))
    .find((el) => /Stick to bottom/i.test(el.textContent ?? ''));
  const panel = footer?.parentElement;
  const region = panel
    ? Array.from(panel.children).find((c) => !c.classList.contains('MuiPaper-root'))
    : undefined;
  if (!region) return { found: false, count: 0, rows: [], truncated: false };
  watchFlowArrivals(region);

  // The region wraps its rows one or more levels deep; descend through single
  // wrappers until the level that actually holds multiple entries.
  let holder: Element = region;
  while (holder.children.length === 1 && holder.children[0].children.length > 0) {
    holder = holder.children[0];
  }
  const all = Array.from(holder.children);

  const rows = all.slice(-FLOW_LOG_SAMPLE).map((el) => {
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, FLOW_LOG_CHARS);
    /*
     * The real value, read from the DOM rather than from this text.
     *
     * `textContent` flattens the console's coloured spans into `{…}` and
     * `Array(10)`, which is what made the Log tab unexpandable — its entries
     * carried a string, and a string has nothing to open. The values are in the
     * spans, so they are read structurally instead.
     */
    /*
     * Only when the row is actually expanded.
     *
     * A collapsed row's value is not in the DOM — `▶input:` is a glyph and a label
     * and nothing else — so reading it structurally produced expander triangles as
     * array items. Undefined here means the caller uses the row's text, which is
     * honest, instead of a tree built out of the console's own furniture.
     */
    let value: unknown;
    try { value = readExpandedRow(el); } catch { value = undefined; }
    const level = el.getAttribute('data-level')
      ?? el.className.match(/\b(error|warn|info|debug|trace|fatal|result|log)\b/i)?.[1]
      ?? undefined;
    const node = el.getAttribute('data-node-id') ?? el.getAttribute('data-node') ?? undefined;
    return { text, value, level, node };
  }).filter((r) => r.text);

  // The footer states the true total ("21 Logs"), which is the honest count even
  // when the DOM has virtualised some rows away.
  const stated = (footer?.textContent ?? '').match(/(\d+)\s+Logs?/i);
  const count = stated ? Number(stated[1]) : all.length;

  return {
    found: true,
    count,
    rows,
    timings: arrivals.length
      ? {
        proxy: true,
        measures:
          'Time each log row reached the DOM, and the gap since the previous row. This is NOT node '
          + 'execution time: it includes network return, platform logging latency and React render. '
          + 'A proxy until the platform emits real per-node durations.',
        arrivals: arrivals.slice(-FLOW_LOG_SAMPLE),
      }
      : undefined,
    sampleHtml: all.length ? (all[all.length - 1] as HTMLElement).outerHTML.slice(0, 2000) : undefined,
    truncated: count > rows.length,
  };
}

function clearOverlay(): void {
  document.getElementById(OVERLAY_ID)?.remove();
  if (followOff) { followOff(); followOff = undefined; }
  restoreNodeStyle();
}

/**
 * A diagram node we styled directly, and what its style was before.
 *
 * A node has its own rounded border, so styling *it* traces its actual shape — where a
 * rectangular overlay sits slightly wrong around a rounded node and cannot follow the
 * canvas's own zoom or pan transform at all. Restoring the exact prior value matters: the
 * canvas sets these itself, and leaving ours behind would look like a selection that cannot
 * be cleared.
 */
let styledNode: { el: HTMLElement; outline: string; shadow: string; radius: string } | undefined;

/**
 * Wires we recoloured, and what they were.
 *
 * Each path is restored to its exact prior stroke rather than reset to a default: the canvas colours
 * its own links, and a "reset" would repaint the whole diagram in whatever we guessed.
 */
let styledWires: { el: SVGElement; stroke: string; width: string; opacity: string }[] = [];
/** Joint circles are filled, not stroked, so their fill is restored separately. */
let styledFills: { el: SVGElement; fill: string }[] = [];

/** Marks anything we recoloured, so a sweep can find it even if our record is lost. */
const WIRE_MARK = 'data-fuuz-wire';

/**
 * The link model, cached from the MAIN world.
 *
 * Geometry was always a proxy — an endpoint near a node is *evidence* of a connection, and weak
 * evidence on a zoomed-out canvas, which is what recoloured wires that merely passed by. The diagram
 * model records each link's source and target nodes outright, so this turns the question into a
 * lookup.
 *
 * Cached because `highlight` answers synchronously while the MAIN world is reached by message. It is
 * refreshed on every surface probe, so it is warm long before anyone clicks a node; the very first
 * click on a freshly loaded page may still fall back to geometry, and the reply says which was used.
 */
let linkModel: { id: string; sourceNode?: string; targetNode?: string }[] | undefined;

function refreshLinkModel(): void {
  void askMainWorld<{ links?: typeof linkModel }>('flowLinks', {}, { links: undefined }, 3000)
    .then((reply) => { if (reply?.links?.length) linkModel = reply.links; });
}

function restoreNodeStyle(): void {
  for (const { el, stroke, width, opacity } of styledWires) {
    el.style.stroke = stroke;
    el.style.strokeWidth = width;
    el.style.opacity = opacity;
  }
  styledWires = [];
  for (const { el, fill } of styledFills) el.style.fill = fill;
  styledFills = [];

  /*
   * A sweep for anything the record missed.
   *
   * The canvas re-renders — a pan, a zoom, a node moving — and a path we styled can be replaced by a
   * clone that keeps the inline style while our reference points at a detached element. Without this,
   * a stray coloured wire would persist with nothing able to clear it. Marking what we touch means
   * the sweep is exact rather than a guess at which wires were ours.
   */
  for (const el of Array.from(document.querySelectorAll(`[${WIRE_MARK}]`))) {
    const svg = el as SVGElement;
    svg.style.stroke = '';
    svg.style.strokeWidth = '';
    svg.style.opacity = '';
    svg.style.fill = '';
    svg.removeAttribute(WIRE_MARK);
  }

  if (!styledNode) return;
  const { el, outline, shadow, radius } = styledNode;
  el.style.outline = outline;
  el.style.boxShadow = shadow;
  el.style.borderRadius = radius;
  el.style.outlineOffset = '';
  styledNode = undefined;
}

/**
 * Colour the selected node's wires: what feeds it, and what it feeds.
 *
 * Two colours, because "what feeds this" and "what does this feed" are different questions and one
 * highlight colour would merge them. Direction comes from which side of the node each endpoint
 * touches rather than from the order the library draws in — see `wires.ts`.
 */
/**
 * The canvas a node belongs to.
 *
 * Taken from the node rather than from the surface probe, because `highlight` is reached from a
 * message and has no probe in hand — and the node's own ancestry is the more direct answer anyway.
 * Falls back to the nearest ancestor that holds other nodes, so a canvas whose id changes does not
 * silently disable the wire colouring.
 */
function flowCanvasFor(node: Element): Element | undefined {
  const byId = node.closest('[id$="-mfgx-data-flow-diagram"]');
  if (byId) return byId;
  for (let p = node.parentElement; p; p = p.parentElement) {
    if (p.querySelectorAll('[data-nodeid]').length > 1) return p;
  }
  return undefined;
}

function colourWires(canvas: Element, node: HTMLElement): { inputs: number; outputs: number; how: string } {
  const nodeRect = node.getBoundingClientRect();

  /*
   * Links, grouped by `data-linkid` — **not** one path each.
   *
   * A single link with one elbow renders as two segment paths, each doubled by a wide invisible hit
   * path, plus a circle at the joint. Keying on the link id while iterating paths therefore kept
   * only the last segment, and an elbowed wire lit up one leg of itself.
   *
   * So the group is the unit: every path and circle inside it gets painted, and its endpoints span
   * the segments — the start of the first and the end of the last, in DOM order, which is the order
   * `data-point` numbers them in.
   */
  const groups = Array.from(canvas.querySelectorAll('[data-linkid]'))
    .filter((el) => el.tagName.toLowerCase() === 'g' && el.getAttribute('data-linkid'))
    // The outer `<g>` only: segments carry the same id and would each look like a whole link.
    .filter((el) => !el.parentElement?.closest('[data-linkid]'));

  const wires: Wire[] = [];
  const byId = new Map<string, Element>();

  for (const group of groups) {
    const id = group.getAttribute('data-linkid')!;
    const segments = Array.from(group.querySelectorAll('path')).filter((path) => {
      try { return (path as SVGPathElement).getTotalLength() > 1; } catch { return false; }
    });
    if (!segments.length) continue;

    const ends = endpointsOf(segments);
    if (!ends) continue;
    wires.push({ id, start: ends.start, end: ends.end });
    byId.set(id, group);
  }

  /*
   * A canvas that draws links as bare paths still works.
   *
   * Older builds — and the flow log's own preview — render a link without the wrapping group, so
   * falling back keeps the feature working there rather than silently doing nothing.
   */
  if (!wires.length) {
    Array.from(canvas.querySelectorAll('path')).forEach((path, index) => {
      if (path.closest('[data-nodeid]')) return;
      const svg = path as SVGPathElement;
      try {
        if (!(svg.getTotalLength() > 24)) return;
        const ends = endpointsOf([svg]);
        if (!ends) return;
        const id = `path-${index}`;
        wires.push({ id, start: ends.start, end: ends.end });
        byId.set(id, svg);
      } catch { /* degenerate */ }
    });
  }

  /*
   * This node's own ports.
   *
   * The canvas puts `data-nodeid` on each port, so attachment is exact rather than a proximity guess
   * — which is what was recolouring wires that merely passed near the node.
   */
  const ports: Port[] = Array.from(node.querySelectorAll('[data-nodeid]'))
    .map((port) => {
      const rect = port.getBoundingClientRect();
      if (!rect.width && !rect.height) return undefined;
      const centre = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      const midX = nodeRect.left + nodeRect.width / 2;
      const midY = nodeRect.top + nodeRect.height / 2;
      const dx = (centre.x - midX) / Math.max(1, nodeRect.width);
      const dy = (centre.y - midY) / Math.max(1, nodeRect.height);
      // Flows run left-to-right and top-to-bottom, so the leading edges are inputs.
      const role: 'input' | 'output' = Math.abs(dx) >= Math.abs(dy)
        ? (dx < 0 ? 'input' : 'output')
        : (dy < 0 ? 'input' : 'output');
      return { centre, role };
    })
    .filter((p): p is Port => !!p);

  /*
   * The model first, because it is exact.
   *
   * A link naming this node as its source is an output and one naming it as target is an input —
   * no measurement, no tolerance, and nothing claimed by proximity. Ports and then the box remain as
   * fallbacks for a canvas whose model we cannot reach, and `via` reports which ran.
   */
  const nodeId = node.getAttribute('data-nodeid') ?? '';
  const fromModel = linkModel?.filter((l) => l.sourceNode === nodeId || l.targetNode === nodeId);
  let how = 'link model';
  let verdict: WireVerdict;
  if (fromModel?.length) {
    verdict = {
      inputs: fromModel.filter((l) => l.targetNode === nodeId).map((l) => l.id),
      outputs: fromModel.filter((l) => l.sourceNode === nodeId).map((l) => l.id),
      unresolved: [],
    };
  } else {
    how = ports.length ? 'ports' : 'geometry';
    verdict = classifyWires(wires, {
      left: nodeRect.left, top: nodeRect.top, right: nodeRect.right, bottom: nodeRect.bottom,
    }, ports);
  }

  /**
   * Paint a whole link — every segment, hit path and joint circle.
   *
   * The joints matter: an elbow leaves a circle at each bend, and recolouring only the lines leaves
   * the corners in the canvas's own colour, which reads as the highlight stopping there.
   */
  const paintLink = (id: string, colour: string) => {
    const root = byId.get(id);
    if (!root) return;
    const parts: SVGElement[] = root.tagName.toLowerCase() === 'g'
      ? Array.from(root.querySelectorAll('path, circle')) as SVGElement[]
      : [root as SVGElement];
    for (const el of parts) {
      // The invisible hit circle must stay invisible; painting it would drop a blob on the wire.
      if (el.getAttribute('opacity') === '0') continue;
      styledWires.push({ el, stroke: el.style.stroke, width: el.style.strokeWidth, opacity: el.style.opacity });
      styledFills.push({ el, fill: el.style.fill });
      el.setAttribute(WIRE_MARK, '1');
      el.style.stroke = colour;
      if (el.tagName.toLowerCase() === 'circle') el.style.fill = colour;
      else el.style.strokeWidth = '4';
      el.style.opacity = '1';
    }
  };

  // Only ids the model or the classifier named — never a sweep over every link on the canvas.
  verdict.inputs.forEach((id) => paintLink(id, WIRE_COLOURS.input));
  /*
   * A colour per output.
   *
   * With three branches leaving one node, one shared colour means tracing which goes where by
   * following identical lines — the very thing this is meant to remove.
   */
  verdict.outputs.forEach((id, index) => paintLink(id, outputColour(index)));

  return { inputs: verdict.inputs.length, outputs: verdict.outputs.length, how };
}

/**
 * A link's true endpoints, spanning its segments.
 *
 * Both ends go through the same viewport conversion as the node rect they are compared against, via
 * each path's own bounding box — which folds in the canvas's zoom and pan without reading its
 * transform.
 */
function endpointsOf(segments: Element[]): { start: Point; end: Point } | undefined {
  const first = segments[0] as SVGPathElement;
  const last = segments[segments.length - 1] as SVGPathElement;
  try {
    const toViewport = (path: SVGPathElement, point: { x: number; y: number }) => {
      const box = path.getBoundingClientRect();
      const local = path.getBBox();
      const scaleX = local.width ? box.width / local.width : 1;
      const scaleY = local.height ? box.height / local.height : 1;
      return {
        x: box.left + (point.x - local.x) * scaleX,
        y: box.top + (point.y - local.y) * scaleY,
      };
    };
    return {
      start: toViewport(first, first.getPointAtLength(0)),
      end: toViewport(last, last.getPointAtLength(last.getTotalLength())),
    };
  } catch {
    return undefined;
  }
}

/**
 * Where the highlight sits in the stacking order.
 *
 * **Below** the docked console (2147483646) and the markup layer, deliberately.
 * It used to be one above at the maximum, so outlining an element painted a violet
 * box across the console itself. Ceding the top means an element hidden behind a
 * docked console is not visible — which is why the outline is now dashed and
 * unfilled: an annotation that reads as one at a glance, rather than a solid block
 * competing with the page.
 */
const HIGHLIGHT_Z = '2147483630';

/** Torn down when the highlight is cleared, so listeners never accumulate. */
let followOff: (() => void) | undefined;

function highlight(target: LocateTarget): { found: boolean; via?: string; approximate?: boolean } {
  clearOverlay();
  const { el, via, scanned } = locateWithReason(target);
  if (!el) return { found: false, via: scanned ? `no attribute held that name (scanned ${scanned} elements)` : undefined };

  /*
   * Grow to the field container.
   *
   * A running screen marks the control, not the field — so an input's outline hugged the
   * bare `<input>` and a select's could land beside what you were pointing at. See
   * `climbToContainer` for the two constraints that keep this from swallowing a neighbour.
   */
  const outlined = growToContainer(el);
  const rect = outlined.getBoundingClientRect();
  if (!rect.width && !rect.height) return { found: false, via: `${via ?? 'located'}, but it renders at zero size` };

  /*
   * A diagram node is styled in place rather than covered by a box.
   *
   * The node already has a border, so setting its outline traces its real shape — and it
   * moves with the canvas's zoom and pan for free, which a fixed-position overlay cannot do.
   */
  if (outlined.hasAttribute('data-nodeid')) {
    const node = outlined as HTMLElement;
    styledNode = {
      el: node,
      outline: node.style.outline,
      shadow: node.style.boxShadow,
      radius: node.style.borderRadius,
    };
    /*
     * Outline **and** a wash over the node.
     *
     * A 2px line on a canvas of colourful cards is easy to lose — the node's own accent already
     * draws the eye more than a thin border does. Shading the whole node makes the selection
     * unmissable, and it is applied as a `box-shadow` inset rather than a background so the
     * node's own colour still shows through: replacing the background would hide the very thing
     * that tells you what kind of node it is.
     */
    node.style.outline = '3px solid #6D3BFF';
    node.style.outlineOffset = '1px';
    /*
     * Rounded to match the node.
     *
     * The wrapper `div.node` has no radius of its own — the rounded card is the `MuiPaper` inside it
     * — so a square outline sat around a rounded node. Reading the card's radius and putting it on
     * the wrapper makes the outline follow the shape, since an outline honours `border-radius`.
     */
    const card = node.querySelector('[id^="mfgx-node-"]') as HTMLElement | null;
    let radius = '';
    try { radius = card ? getComputedStyle(card).borderRadius : ''; } catch { radius = ''; }
    node.style.borderRadius = radius && radius !== '0px' ? radius : '6px';
    node.style.boxShadow = [
      'inset 0 0 0 100vmax rgba(78, 37, 226, 0.38)',   // the wash, over the whole node
      '0 0 0 7px rgba(109, 59, 255, 0.40)',            // a wide halo outside the outline
      '0 0 20px 4px rgba(109, 59, 255, 0.55)',         // and a glow, so it reads across a busy canvas
    ].join(', ');

    // What feeds it, and what it feeds — the question a busy flow makes hard to answer.
    const surface = flowCanvasFor(node);
    const wired = surface ? colourWires(surface, node) : { inputs: 0, outputs: 0, how: 'no canvas' };
    // Guarded: not every host implements it, and losing the highlight to a missing method
    // would be a poor trade for a convenience.
    try { node.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); } catch { /* optional */ }
    return {
      found: true,
      via: `${via ?? 'diagram node'} · ${wired.inputs} in, ${wired.outputs} out (${wired.how})`,
      approximate: false,
    };
  }

  const box = document.createElement('div');
  box.id = OVERLAY_ID;
  Object.assign(box.style, {
    position: 'fixed',
    left: `${rect.left}px`, top: `${rect.top}px`,
    width: `${rect.width}px`, height: `${rect.height}px`,
    /*
     * Solid, and a shade darker than Fuuz's own Electric Violet (#4E25E2).
     *
     * Darker so the outline reads as ours rather than blending into the platform's own
     * violet chrome, and solid because a dashed line is harder to follow around a small
     * element. The fill stays almost transparent — a solid fill hid the thing being
     * diagnosed — and the white inner ring keeps the edge legible on dark and light
     * surfaces alike.
     */
    outline: '2px solid #3A18B8',
    outlineOffset: '-1px',
    boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.7), 0 0 0 1px rgba(58,24,184,0.45)',
    background: 'rgba(58, 24, 184, 0.07)',
    borderRadius: '2px',
    pointerEvents: 'none',
    zIndex: HIGHLIGHT_Z,
  } as Partial<CSSStyleDeclaration>);

  const tag = document.createElement('div');
  tag.textContent = `${target.name ?? '?'}  ${target.type ?? ''}`.trim();
  Object.assign(tag.style, {
    position: 'absolute', left: '0', top: rect.top < 24 ? '100%' : '-22px',
    background: '#3A18B8', color: '#fff', font: '11px/1.6 ui-monospace, Menlo, monospace',
    padding: '1px 6px', borderRadius: '3px', whiteSpace: 'nowrap',
  } as Partial<CSSStyleDeclaration>);
  box.appendChild(tag);

  /*
   * Mounted on `documentElement`, not `body`.
   *
   * Docking puts a `transform` on `body`, which makes body the containing block for
   * every fixed-position descendant — so a box positioned from `getBoundingClientRect`
   * (viewport coordinates) would be offset by however much the dock had shifted the
   * page. As a sibling of body it is fixed to the viewport, which is what the rect
   * describes. Same reason the console overlay mounts there.
   */
  (document.documentElement ?? document.body).appendChild(box);

  /*
   * Follow the element.
   *
   * A fixed box is painted at one moment's coordinates, so any scroll left it
   * behind — visibly wrong, and worse than no highlight because it points at the
   * wrong element. Re-measuring on scroll and resize costs a rect per frame and
   * only while a highlight is up.
   */
  let queued = false;
  const reposition = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (!box.isConnected) return;
      const now = outlined.getBoundingClientRect();
      box.style.left = `${now.left}px`;
      box.style.top = `${now.top}px`;
      box.style.width = `${now.width}px`;
      box.style.height = `${now.height}px`;
      tag.style.top = now.top < 24 ? '100%' : '-22px';
    });
  };
  window.addEventListener('scroll', reposition, { capture: true, passive: true });
  window.addEventListener('resize', reposition, { passive: true });
  followOff = () => {
    window.removeEventListener('scroll', reposition, { capture: true } as EventListenerOptions);
    window.removeEventListener('resize', reposition);
  };

  return { found: true, via, approximate: via ? isApproximate(via) : false };
}

/* ── Hiding the platform's own Console drawer ─────────────────────────────
 * Turning on `transformDebuggingEnabled` is what makes the runtime emit
 * transform logs — but it also opens Fuuz's built-in Console drawer, which now
 * duplicates this extension and eats vertical space. We hide the drawer rather
 * than turn the flag off, because the flag is the thing we actually need.
 *
 * The drawer has no stable class, so it's found structurally: a level-6 heading
 * reading "Console" whose container also holds the log-count and stick-to-bottom
 * controls. If that shape ever changes this simply stops matching — it never
 * hides something it isn't sure about.
 */
const HIDDEN_ATTR = 'data-fuuz-devtool-hid';
/**
 * Which consoles to hide, independently.
 *
 * The frontend dev console defaults to hidden because this panel replaces it —
 * two frontend consoles is one too many. The **flow log console does not**: it
 * shows per-node flow execution that nothing here reproduces, so hiding it was
 * removing information the developer needs and getting nothing back.
 */
const hidden: Record<ConsoleKind, boolean> = { frontend: true, flowLog: false };
let observer: MutationObserver | undefined;

/** Never hide these, whatever else matches — a false positive here blanks the app. */
const NEVER_HIDE = new Set(['BODY', 'HTML', 'HEAD', 'MAIN']);

/**
 * Match on a *specific descendant element*, not on aggregate `textContent`.
 *
 * An ancestor's textContent contains every descendant's text, so matching on it
 * walks straight up to `<body>` on any page that mentions the phrase anywhere —
 * which hides the entire application. Requiring an element whose own trimmed
 * text is exactly the control label keeps the match tight.
 */
/** Is this the console panel, rather than some other resizable drawer? */
function holdsConsole(el: Element): boolean {
  return Array.from(el.querySelectorAll('h6')).some((h) => h.textContent?.trim() === 'Console');
}

/**
 * The *outer* drawer, not the console panel inside it.
 *
 * Hiding only the panel leaves the drawer's resize handle and its 300px-wide
 * container still occupying the layout. The whole drawer is anchored by the
 * handle's tooltip — "Drag to resize / Double-click or alt+3 to toggle" — which
 * is user-facing copy rather than a generated `jss*` class, so it survives a
 * rebuild of the app's styles.
 */
/**
 * Which console a drawer is.
 *
 * Fuuz renders **two** drawers with identical structure — same `Console`
 * heading, same "Stick to bottom" footer, same resize handle. Matching on
 * "Drag to resize" alone finds whichever comes first in the DOM, which is how
 * this ended up hiding the *flow log* console when it was meant to hide the
 * frontend one. They are different tools and need separate switches.
 *
 * The handle's own tooltip carries the discriminator — `alt+2` for the data flow
 * log, `alt+3` for the frontend dev console. That is user-facing copy and a
 * keyboard shortcut, so it is far more stable than a generated `jss*` class.
 * Two corroborating markers are checked as well, in case the shortcuts change:
 *
 *   flow log   `data-data-path="selectedNodesMessage"` — per-node flow messages
 *   frontend   `data-icon="brackets-curly"` — the JSON glyph in its header
 */
export type ConsoleKind = 'flowLog' | 'frontend';

function classifyDrawer(drawer: HTMLElement, handle: Element): ConsoleKind | undefined {
  const hint = handle.getAttribute('title') ?? '';
  if (/alt\+2/.test(hint)) return 'flowLog';
  if (/alt\+3/.test(hint)) return 'frontend';
  // No shortcut in the tooltip: fall back to what each console uniquely renders.
  if (drawer.querySelector('[data-data-path="selectedNodesMessage"]')) return 'flowLog';
  if (drawer.querySelector('svg[data-icon="brackets-curly"]')) return 'frontend';
  return undefined;
}

/** Both console drawers, by kind. Either may be absent. */
function findConsoleDrawers(): Partial<Record<ConsoleKind, HTMLElement>> {
  const out: Partial<Record<ConsoleKind, HTMLElement>> = {};
  for (const handle of Array.from(document.querySelectorAll('[title*="Drag to resize"]'))) {
    const drawer = handle.parentElement;
    if (!drawer || NEVER_HIDE.has(drawer.tagName)) continue;
    if (!holdsConsole(drawer)) continue;
    const kind = classifyDrawer(drawer, handle);
    // An unclassifiable drawer is left alone. Hiding the wrong one is worse than
    // hiding neither — that is the bug this replaced.
    if (kind && !out[kind]) out[kind] = drawer;
  }
  return out;
}

/**
 * Returns whether the drawer was actually located — *not* whether the call
 * succeeded. The panel uses this to say "couldn't find it" honestly instead of
 * reporting success while nothing changed.
 */
function applyNativeConsoleVisibility(): { flowLog: boolean; frontend: boolean } {
  const found = findConsoleDrawers();
  for (const kind of ['flowLog', 'frontend'] as ConsoleKind[]) {
    const drawer = found[kind];
    if (!drawer) continue;
    if (hidden[kind]) {
      drawer.setAttribute(HIDDEN_ATTR, kind);
      drawer.style.display = 'none';
    } else if (drawer.getAttribute(HIDDEN_ATTR) === kind) {
      // Only un-hide what *we* hid, and only for this kind. Clearing every
      // marked node would restore a drawer the other switch wants hidden.
      drawer.style.display = '';
      drawer.removeAttribute(HIDDEN_ATTR);
    }
  }
  return { flowLog: !!found.flowLog, frontend: !!found.frontend };
}

function watchForDrawer(): void {
  observer?.disconnect();
  // Watch whenever either switch is on: the drawers mount after the screen
  // renders and remount when the designer changes tabs.
  if (!hidden.frontend && !hidden.flowLog) return;
  observer = new MutationObserver(() => { applyNativeConsoleVisibility(); });
  observer.observe(document.body, { childList: true, subtree: true });
}

/**
 * Preview a property by writing it onto the DOM.
 *
 * The honest second tier. A property with a documented `fn` setter is changed
 * through the runtime and the change is real; everything else has no way in, and
 * until now the panel said "preview" and did nothing at all.
 *
 * So this writes to the DOM directly — visible immediately, and **overwritten by
 * the next React render**. That is a preview, not a change, and the reply says so
 * rather than reporting success.
 *
 * Each prop maps to what it means in the rendered output. A `disabled` attribute
 * alone leaves an MUI input looking enabled, because MUI carries the styling in a
 * class — so both are applied.
 */
function previewProp(el: HTMLElement, prop: string, value: unknown): { ok: boolean; how: string } {
  const truthy = value === true || value === 'true';
  // The control is usually a descendant, not the located wrapper.
  const field = el.querySelector('input, textarea, select, button') as HTMLElement | null;

  switch (prop) {
    case 'disabled': {
      const target = field ?? el;
      if (truthy) {
        target.setAttribute('disabled', '');
        target.classList.add('Mui-disabled');
        el.classList.add('Mui-disabled');
      } else {
        target.removeAttribute('disabled');
        target.classList.remove('Mui-disabled');
        el.classList.remove('Mui-disabled');
      }
      return { ok: true, how: 'disabled attribute + Mui-disabled class' };
    }
    case 'visible':
      el.style.display = truthy ? '' : 'none';
      return { ok: true, how: 'style.display' };
    case 'hidden':
      el.style.display = truthy ? 'none' : '';
      return { ok: true, how: 'style.display' };
    case 'label': {
      // The label element, not the wrapper: writing textContent on the wrapper
      // would replace the whole control with a string.
      const label = el.querySelector('label, .MuiFormLabel-root') as HTMLElement | null;
      if (!label) return { ok: false, how: 'no label element found' };
      label.textContent = String(value ?? '');
      return { ok: true, how: 'label textContent' };
    }
    case 'placeholder':
      if (!field) return { ok: false, how: 'no input to place a placeholder on' };
      field.setAttribute('placeholder', String(value ?? ''));
      return { ok: true, how: 'placeholder attribute' };
    case 'value':
    case 'defaultValue': {
      if (!field) return { ok: false, how: 'no input found' };
      (field as HTMLInputElement).value = String(value ?? '');
      // React reads from its own state, so a native input event is what makes the
      // component notice a value written from outside.
      field.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: true, how: 'input value + input event' };
    }
    case 'width':
    case 'height':
    case 'padding':
    case 'margin':
    case 'color':
      el.style.setProperty(prop, String(value ?? ''));
      return { ok: true, how: `style.${prop}` };
    default:
      // Anything else becomes an attribute: visible in the DOM, and honest about
      // being a guess at how the renderer would express it.
      try {
        el.setAttribute(prop, String(value ?? ''));
        return { ok: true, how: `${prop} attribute (may not be what the renderer reads)` };
      } catch {
        return { ok: false, how: `${prop} is not a settable attribute` };
      }
  }
}

interface WriteDefinitionRequest {
  kind: 'screen' | 'flow';
  /** Screen version id or data flow version id — the version, never the parent. */
  versionId: string;
  /** The patched document to store. */
  document: unknown;
  /** The document the patch was computed from, for the moved check. */
  expect: unknown;
  /** One line describing the change, carried through to the outcome. */
  change?: string;
  /** Default false: nothing is sent unless the caller explicitly asks. */
  apply?: boolean;
}

/** Run a GraphQL request through the page's own session. */
async function pageRequest(request: GraphQLRequest): Promise<Record<string, unknown>> {
  return askMainWorld(
    'pageQuery',
    { service: request.service, query: request.query, variables: request.variables },
    { ok: false, error: 'The page did not answer — the MAIN-world hook is not installed on this tab.' },
    20000,
  ) as Promise<Record<string, unknown>>;
}

/** The stored document for a version, or undefined when the read did not answer. */
function storedFrom(kind: 'screen' | 'flow', reply: unknown): unknown {
  const data = (reply as { data?: Record<string, unknown> } | undefined)?.data;
  const key = kind === 'screen' ? 'screenVersion' : 'dataFlowVersion';
  const edges = (data?.[key] as { edges?: { node?: Record<string, unknown> }[] } | undefined)?.edges;
  const node = edges?.[0]?.node;
  if (!node) return undefined;
  return kind === 'screen' ? node.design : node.flow;
}

async function writeDefinition(req: WriteDefinitionRequest): Promise<ApplyOutcome> {
  const dry = req.apply !== true;
  const write = req.kind === 'screen'
    ? screenDesignUpdate(req.versionId, req.document, req.change ?? 'screen design update')
    : flowVersionUpdate(req.versionId, req.document, req.change ?? 'flow version update');

  // Read first, even for a dry run: "this is what would be sent" is worth much less
  // if we cannot also say the target is still what the patch was built from.
  const readBack = await pageRequest(req.kind === 'screen'
    ? screenVersionRead(req.versionId)
    : flowVersionRead(req.versionId));
  const stored = storedFrom(req.kind, readBack);

  if (stored === undefined) {
    return {
      ok: false, dryRun: true, change: req.change, request: write,
      error: `Could not read ${req.kind} version ${req.versionId} back, so nothing was written.`,
    };
  }
  if (hasMoved(req.expect, stored)) {
    return {
      ok: false, dryRun: true, change: req.change, request: write,
      error: 'The stored definition changed since this edit was prepared — someone saved in the designer. Re-read and redo the edit rather than overwriting their work.',
    };
  }
  if (dry) return { ok: true, dryRun: true, change: req.change, request: write };

  const result = await pageRequest(write);
  const errors = (result as { errors?: { message?: string }[] }).errors;
  if (errors?.length) {
    return { ok: false, dryRun: false, change: req.change, request: write, error: errors.map((e) => e.message).join('; ') };
  }
  return { ok: true, dryRun: false, change: req.change, request: write };
}

chrome.runtime.onMessage.addListener((msg: {
  type: string;
  target?: Parameters<typeof locate>[0];
  hide?: boolean;
  css?: Record<string, string>;
  includeGraph?: boolean;
  id?: string;
  node?: string;
  action?: string;
  dataUrl?: string;
  prop?: string;
  tool?: string;
  path?: string;
  value?: unknown;
  /** Which console: 'flowLog' or 'frontend' (default). */
  kind?: string;
  /** Scroll the element into view as well as outlining it. */
  reveal?: boolean;
  /** `callElementFn`: the function name from the element's own `fn` bag. */
  fn?: string;
  args?: unknown[];
}, _s, respond) => {
  if (msg?.type === 'hideNativeConsole') {
    // `kind` omitted means the frontend console, which is what the single
    // switch always meant before there were two.
    const kind: ConsoleKind = msg.kind === 'flowLog' ? 'flowLog' : 'frontend';
    hidden[kind] = msg.hide === true;
    const found = applyNativeConsoleVisibility();
    watchForDrawer();
    // Answer about the console the caller asked about; `drawers` carries both so
    // the panel can say which exist on this page.
    respond({ found: found[kind], drawers: found });
    return true;
  }
  if (msg?.type === 'highlight' && msg.target) {
    if (msg.reveal) {
      const el = locate(msg.target);
      // `center` rather than `nearest`: a tall container scrolled to its top
      // edge often leaves the highlighted box just off screen.
      try { el?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' }); }
      catch { el?.scrollIntoView(); }
    } respond(highlight(msg.target)); return true; }
  if (msg?.type === 'clearHighlight') { clearOverlay(); respond({ found: true }); return true; }
  // The page's session token. An isolated content script shares localStorage
  // with the page, so this works in the standalone window too — where the
  // DevTools evaluation API that used to supply it does not exist.
  /**
   * Styles for one element: what the design set, and what the browser computed.
   *
   * The computed set is filtered to properties a developer actually adjusts —
   * `getComputedStyle` returns 300+ entries, and dumping all of them buries the
   * handful that matter.
   */
  if (msg?.type === 'getElementStyles' && msg.target) {
    const el = locate(msg.target);
    if (!el) { respond({ found: false }); return true; }
    const computed = getComputedStyle(el);
    const interesting = [
      'display', 'position', 'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
      'margin', 'padding', 'border', 'border-radius', 'outline', 'box-shadow',
      'background', 'background-color', 'color', 'opacity', 'visibility',
      'font-family', 'font-size', 'font-weight', 'line-height', 'text-align',
      'flex-direction', 'justify-content', 'align-items', 'gap', 'flex-grow', 'flex-shrink',
      'overflow', 'z-index', 'cursor',
    ];
    const out: Record<string, string> = {};
    for (const prop of interesting) {
      const value = computed.getPropertyValue(prop).trim();
      if (value) out[prop] = value;
    }
    const inline: Record<string, string> = {};
    const styleAttr = (el as HTMLElement).style;
    for (let i = 0; i < styleAttr.length; i++) {
      const prop = styleAttr.item(i);
      inline[prop] = styleAttr.getPropertyValue(prop);
    }
    respond({ found: true, computed: out, inline, tag: el.tagName.toLowerCase() });
    return true;
  }

  /**
   * Apply CSS to the live element.
   *
   * Inline styles only — this previews the effect so you can see it before
   * committing anything to the design. A reload discards it entirely.
   */
  if (msg?.type === 'applyElementStyle' && msg.target) {
    const refused = refuseIfProduction(msg.type);
    if (refused) { respond({ found: false, error: refused }); return true; }
    const el = locate(msg.target) as HTMLElement | null;
    if (!el) { respond({ found: false }); return true; }
    let touched = 0;
    for (const [key, value] of Object.entries(msg.css ?? {})) {
      /*
       * A `selector:prop` key targets a descendant.
       *
       * Icon size is the case that needs it: `font-size` on a button changes its *label*, while
       * an icon takes its size from its own element. One transport for both beats a second
       * message type for one field.
       */
      const cut = key.indexOf(':');
      const selector = cut > 0 ? key.slice(0, cut) : '';
      const prop = cut > 0 ? key.slice(cut + 1) : key;
      const targets: HTMLElement[] = selector
        ? Array.from(el.querySelectorAll(selector))
        : [el];
      for (const target of targets) {
        try {
          if (value) target.style.setProperty(prop, String(value));
          else target.style.removeProperty(prop);
          touched += 1;
        } catch { /* an invalid declaration is the user's to see, not fatal */ }
      }
    }
    respond({ found: true, touched });
    return true;
  }

  /**
   * Preview a property on the running screen.
   *
   * Gated with the other mutations, and reported as a preview: the next render
   * overwrites it, which is a materially different promise from an `fn` call.
   */
  if (msg?.type === 'previewProp' && msg.target && typeof msg.prop === 'string') {
    const refused = refuseIfProduction('applyElementStyle');
    if (refused) { respond({ ok: false, error: refused }); return true; }
    const el = locate(msg.target) as HTMLElement | null;
    if (!el) { respond({ ok: false, error: 'That element could not be located in the page.' }); return true; }
    const result = previewProp(el, msg.prop, msg.value);
    respond({
      ok: result.ok,
      how: result.how,
      note: result.ok
        ? `Previewed via ${result.how}. The next render overwrites it — nothing is saved.`
        : `Could not preview: ${result.how}`,
    });
    return true;
  }

  /** Is this a designer surface, and which tab is open? */
  if (msg?.type === 'getDesignerSurface') {
    respond(designerSurface());
    return true;
  }

  /**
   * Can we reach this element's component, and what can it do?
   *
   * Read-only. It decides whether the inspector offers a real setter or labels
   * everything a preview — so it must run before any editing UI is shown.
   */
  if (msg?.type === 'probeElement' && msg.target) {
    const selector = selectorFor(msg.target);
    if (!selector) {
      respond({ located: false, reached: false, path: [], fnKeys: [], propKeys: [], depth: 0,
        note: 'No DOM node matched this element.' });
      return true;
    }
    void askMainWorld('probeElement', { selector }, {
      located: true, reached: false, path: [], fnKeys: [], propKeys: [], depth: 0,
      note: 'The page did not answer. The MAIN-world hook may not be installed on this tab — reload it.',
    }).then((r) => { clearProbeMarks(); respond(r); });
    return true;
  }

  /**
   * Where the design already is in the page.
   *
   * The designer cannot draw a canvas without the craft graph, so asking the
   * page beats re-fetching it over GraphQL keyed on a tab id that may not be a
   * screen id at all.
   */
  /**
   * WebMCP lives in the MAIN world — `document.modelContext` is a page API — so
   * these are forwarded like the fiber work rather than handled here.
   */
  if (msg?.type === 'webmcpStatus' || msg?.type === 'webmcpRegister' || msg?.type === 'webmcpUnregister') {
    void askMainWorld(msg.type, {}, {
      available: false, originIsolated: false, registered: [],
      reason: 'The page did not answer — the MAIN-world hook is not installed on this tab. Reload it.',
    }).then(respond);
    return true;
  }

  /**
   * Dock or float the console inside the page.
   *
   * Lives in the relay rather than the MAIN world: it only needs the DOM and
   * `chrome.runtime.getURL`, and keeping it out of the page's world means page
   * script cannot remove or drive our panel.
   */
  if (msg?.type === 'overlay') {
    const raw = (msg as { mode?: string }).mode;
    /*
     * `window` is a *preference*, recorded by the worker, and never a dock mode.
     *
     * Closing the in-page console is the right response: the developer has asked for the console to
     * live in a separate window from now on, so it should not also stay docked here.
     */
    if (raw === 'window') { closeOverlay(); respond(overlayState()); return true; }
    const mode = raw as DockMode | undefined;
    if (mode === undefined) { respond(overlayState()); return true; }
    if (mode === 'off') { closeOverlay(); respond(overlayState()); return true; }
    respond(setOverlay(mode, (msg as { tabId?: number }).tabId, (msg as { size?: number }).size));
    return true;
  }

  /**
   * Markup: draw on the page so a screenshot says something.
   *
   * Not gated the way a value edit is — it adds one overlay layer, never touches
   * app DOM, and clears completely. The screenshot it feeds is still gated.
   */
  if (msg?.type === 'markup') {
    const action = (msg as { action?: string }).action;
    if (action === 'clear') { respond(clearMarkup(true)); return true; }
    if (action === 'clearAndClose') { respond(clearMarkup(false)); return true; }
    if (action === 'undo') { respond(undoMarkup()); return true; }
    // Selection actions, so the panel can drive editing as well as the in-page bar.
    if (action === 'deleteSelected') {
      const el = selectedShape();
      respond(el ? removeShape(el) : markupState());
      return true;
    }
    if (action === 'editText') {
      const ok = editSelectedText();
      respond({ ...markupState(), error: ok ? undefined : 'Select a text label first.' });
      return true;
    }
    if (action === 'deselect') { respond(selectShape(undefined)); return true; }
    if (action === 'off') { respond(setMarkup(false)); return true; }
    if (action === 'on') { respond(setMarkup(true, (msg as { tool?: string }).tool as MarkupTool | undefined)); return true; }
    respond(markupState());
    return true;
  }

  /**
   * Hide our own chrome so a capture photographs the app, not the tool.
   *
   * The annotations stay — they are the point. The toolbar and the docked console
   * are ours, and including them makes the screenshot about the extension.
   */
  if (msg?.type === 'prepareCapture') {
    const restore = hideChromeForCapture();
    // Restored on a timer rather than a second message: if the capture fails or
    // the panel goes away, the developer must not be left with a hidden console.
    setTimeout(restore, 1200);
    // A frame's delay so the hide has painted before the worker captures.
    setTimeout(() => respond({ ready: true }), 60);
    return true;
  }

  /** The worker hands the captured image here, where a page context can copy it. */
  if (msg?.type === 'copyImage' && typeof (msg as { dataUrl?: string }).dataUrl === 'string') {
    void copyImageToClipboard((msg as { dataUrl: string }).dataUrl).then(respond);
    return true;
  }

  /** What the engine exposes for writing — prototype methods included. */
  if (msg?.type === 'engineApi') {
    void askMainWorld('engineApi', {}, { engine: [], node: [], nodesKeys: [] }, 4000).then(respond);
    return true;
  }

  /**
   * The designer's node log, read from the app's store.
   *
   * Only what is new since the last ask — the tap holds an id-keyed cursor — so this
   * is safe to poll. `seqBase` continues the console's serial so flow entries and
   * screen transforms sort into one order.
   */
  if (msg?.type === 'flowLogs') {
    const q = msg as { seqBase?: number; names?: Record<string, string> };
    void askMainWorld(
      'flowLogs',
      { seqBase: q.seqBase ?? 0, names: q.names },
      { attached: false, entries: [], tabs: [], reported: 0, source: 'redux-store', error: 'The page did not answer.' },
      4000,
    ).then(respond);
    return true;
  }

  /** Forget what has been reported — after a clear, or when the panel retargets. */
  if (msg?.type === 'resetFlowLogs') {
    void askMainWorld('resetFlowLogs', {}, { ok: false }, 3000).then(respond);
    return true;
  }

  /**
   * Write a screen or flow definition back to the platform.
   *
   * The one capability here that outlives a reload, so it is the most carefully
   * fenced: gated on `writeDefinition`, dry by default, and guarded by a read-back.
   *
   * The read-back is the part worth keeping. These mutations replace the stored
   * document wholesale and the platform offers no compare-and-swap, so a designer
   * saving between our read and our write would have their work silently overwritten.
   * Comparing what is stored now against what the patch was computed from turns that
   * into a refusal instead.
   */
  if (msg?.type === 'writeDefinition') {
    const refused = refuseIfProduction('writeDefinition');
    if (refused) { respond({ ok: false, dryRun: true, error: refused } as ApplyOutcome); return true; }
    void writeDefinition(msg as unknown as WriteDefinitionRequest).then(respond);
    return true;
  }

  /** Payloads for one node's runs — fetched on demand, never pushed. */
  /*
   * A service call, made by the page rather than by us.
   *
   * Gated like any other page interaction: a mutation typed into the GraphQL console is a write to a
   * live tenant, and it being the *page's* request rather than ours changes nothing about that.
   */
  if (msg?.type === 'pageQuery') {
    const q = msg as unknown as { service?: string; query?: string; variables?: Record<string, unknown> };
    if (/(^|[\s{}()])(mutation|subscription)\b/i.test(String(q.query ?? ''))) {
      const refused = refuseIfProduction('evaluateRemote');
      if (refused) { respond({ ok: false, error: refused }); return true; }
    }
    void askMainWorld('pageQuery', { service: q.service, query: q.query, variables: q.variables },
      { ok: false, error: 'The page did not answer — the MAIN-world hook is not installed on this tab.' },
      15000).then(respond);
    return true;
  }

  if (msg?.type === 'flowRunPayloads') {
    void askMainWorld('flowRunPayloads', { node: (msg as { node?: string }).node },
      { node: '', runs: [] }, 6000).then(respond);
    return true;
  }

  /** One node's full definition, values included. */
  if (msg?.type === 'flowNodeDetail') {
    void askMainWorld('flowNodeDetail', { id: (msg as { id?: string }).id },
      { found: false, error: 'The page did not answer.' }, 4000).then(respond);
    return true;
  }

  /**
   * Edit a live node. Gated with the other mutations — and this one is sharper
   * than the screen-side edits: it changes the designer's flow, which becomes
   * permanent if the developer then saves.
   */
  if (msg?.type === 'setFlowNodeValue') {
    const refused = refuseIfProduction('callElementFn');
    if (refused) { respond({ ok: false, error: refused }); return true; }
    const q = msg as unknown as { id?: string; path?: string; value?: unknown };
    void askMainWorld('setFlowNodeValue', { id: q.id, path: q.path, value: q.value },
      { ok: false, error: 'The page did not answer.' }, 4000).then(respond);
    return true;
  }

  /** Engine-measured node timings live in the MAIN world with the engine. */
  if (msg?.type === 'flowEvents') {
    void askMainWorld('flowEvents', {}, {
      attached: false, events: [], runs: [], summary: [], source: 'engine-events',
      error: 'The page did not answer — the MAIN-world hook is not installed on this tab.',
    }, 4000).then(respond);
    return true;
  }

  if (msg?.type === 'huntDesign') {
    void askMainWorld('huntDesign', { includeGraph: msg.includeGraph === true }, {
      tried: [], fibersVisible: false, apolloPresent: false,
      error: 'The page did not answer — the MAIN-world hook is not installed on this tab.',
    }, 6000).then(respond);
    return true;
  }

  /**
   * Call one function from the element's own `fn` bag.
   *
   * This is the runtime's supported API, so dependent transforms re-fire and the
   * console captures them — the change is real *and* traced. Still nothing is
   * saved: a reload discards it, exactly like the style preview above.
   */
  if (msg?.type === 'callElementFn' && msg.target && typeof msg.fn === 'string') {
    const refused = refuseIfProduction(msg.type);
    if (refused) { respond({ ok: false, error: refused }); return true; }
    const selector = selectorFor(msg.target);
    if (!selector) { respond({ ok: false, error: 'No DOM node matched this element.' }); return true; }
    void askMainWorld('callElementFn', { selector, fn: msg.fn, args: Array.isArray(msg.args) ? msg.args : [] },
      { ok: false, error: 'The page did not answer the call.' })
      .then((r) => { clearProbeMarks(); respond(r); });
    return true;
  }

  /**
   * Where an element sits in the viewport, so a screenshot can be cropped to it.
   * The capture itself happens in the service worker — only it can reach the
   * tab-capture API — and this supplies the rectangle plus the pixel ratio the
   * captured image is scaled by.
   */
  if (msg?.type === 'getElementRect' && msg.target) {
    const el = locate(msg.target);
    if (!el) { respond({ found: false }); return true; }
    const r = el.getBoundingClientRect();
    respond({
      found: true,
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      dpr: window.devicePixelRatio || 1,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    });
    return true;
  }

  /**
   * Session-token reading is **switched off**.
   *
   * It never worked reliably: whatever key Fuuz keeps the token under, the search did not
   * find it on a live tenant, and every dependent feature then failed at a distance —
   * the design fetch, schema introspection, the model picker, the GraphQL console. One
   * missing string produced four features that looked broken for unrelated reasons.
   *
   * Rather than leave that machinery in place failing quietly, the read is removed and the
   * dependent features say they are unavailable. The reply keeps its shape so nothing
   * has to special-case it, and `disabled` is what callers branch on — distinguishing
   * "switched off" from "searched and found nothing", which are different facts.
   *
   * See `apiAccess.ts` for the single switch that turns this back on.
   */
  if (msg?.type === 'getSessionToken') {
    respond({ token: undefined, disabled: true });
    return true;
  }
  return undefined;
});

// The overlay is absolutely positioned against the viewport, so it must go when
// the page moves underneath it.
window.addEventListener('scroll', clearOverlay, { passive: true });
window.addEventListener('resize', clearOverlay);

/*
 * Re-apply the preference on every page load.
 *
 * A reload re-injects this script with its state reset, and the panel's port
 * goes to the service worker — not to the page — so nothing would tell the new
 * instance to hide the drawer again. Reading the setting directly removes that
 * round trip entirely, and works even if no panel is open.
 */
function restorePreference(): void {
  try {
    chrome.storage?.local.get(['hideNativeConsole', 'hideFlowLogConsole'], (stored) => {
      hidden.frontend = stored?.hideNativeConsole !== false;      // default: hidden
      hidden.flowLog = stored?.hideFlowLogConsole === true;       // default: SHOWN
      applyNativeConsoleVisibility();
      watchForDrawer();
    });
  } catch { /* storage unavailable — leave the drawer alone */ }
}

restorePreference();
// Bring back the dock the developer left open, so a reload does not close it.
restoreOverlay();

/**
 * Keyboard shortcuts.
 *
 *   Ctrl/Cmd+U          undo the last markup shape
 *   Ctrl/Cmd+Shift+U    arm or disarm the markup tools
 *   Ctrl/Cmd+Shift+S    copy a screenshot to the clipboard
 *
 * All ignored while typing, so none can fire from inside a Fuuz field. `Ctrl+U`
 * is Chrome's view-source, which a page handler can pre-empt — a deliberate
 * trade, and the reason the toggle moved to Shift rather than taking a second
 * browser shortcut.
 */
function typingInField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return /^(input|textarea|select)$/i.test(el.tagName) || el.isContentEditable === true;
}

window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const key = e.key?.toLowerCase();
  if (typingInField(e.target)) return;

  if (key === 'u') {
    e.preventDefault();
    // Undo needs the tools armed to be meaningful; arm them if they are not.
    if (!markupState().active) setMarkup(true);
    else if (e.shiftKey) setMarkup(false);
    else undoMarkup();
    return;
  }
  if (key === 's' && e.shiftKey) {
    e.preventDefault();
    try { chrome.runtime.sendMessage({ type: 'captureToClipboard' }); } catch { /* worker asleep */ }
  }
}, true);
// The drawer mounts well after document_start, and again after a soft nav.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', restorePreference, { once: true });
}

export {};
