/**
 * The console as a panel inside the page — docked or floating.
 *
 * A separate window is right for a second monitor and wrong for everything else:
 * it loses focus, it hides behind the browser, and on one screen you are
 * alt-tabbing between the screen you are debugging and the tool describing it.
 * Docked, both are visible at once.
 *
 * ## Why an iframe
 *
 * The panel is an extension page — it needs `chrome.runtime` for its port, and
 * the page's own scripts must not be able to read or drive it. An iframe on the
 * `chrome-extension://` origin gives both: the panel keeps extension privileges,
 * and the page cannot reach into it. Rendering the panel's DOM directly into the
 * page would hand the app's own scripts access to the capture.
 *
 * ## What it does to the page
 *
 * Docking reserves space by setting a margin on `<html>`, so the app reflows
 * beside the panel instead of being covered. That is a visible change to the
 * page, so it is off by default, reversible in one call, and every trace is
 * removed on close — no leftover margin, no orphan node.
 */

const HOST_ID = '__fuuz_dev_console_host';
const STYLE_ID = '__fuuz_dev_console_style';
const MARGIN_PROP = 'margin-inline-end';   // legacy, cleared on release

export type DockMode = 'right' | 'bottom' | 'float' | 'off';

export interface OverlayState {
  mode: DockMode;
  /** Width when docked right, height when docked bottom. */
  size: number;
  /**
   * Floating size, kept separately from the docked one.
   *
   * A dock has one dimension to set — the other is the viewport's. Floating has
   * both, and reusing `size` for it meant docking then floating inherited a width
   * as a height, or the reverse.
   */
  floatW?: number;
  floatH?: number;
  /** Collapsed to a thin edge tab, keeping the panel alive behind it. */
  collapsed?: boolean;
  error?: string;
}

/** Width (or height) of the collapsed tab. */
const COLLAPSED = 30;

let state: OverlayState = { mode: 'off', size: 460 };

/** Where the panel lives, with the tab id it should watch. */
function panelUrl(tabId: number | undefined): string {
  const base = chrome.runtime.getURL('panel.html');
  return tabId === undefined ? base : `${base}?tabId=${tabId}&embedded=1`;
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  // A very high z-index and `color-scheme` so the panel is not tinted by the
  // app's own theme. `all: initial` on the host keeps app CSS from reaching in —
  // Fuuz ships broad MUI selectors that would otherwise restyle our chrome.
  style.textContent = `
#${HOST_ID} { all: initial; position: fixed; z-index: 2147483646; color-scheme: dark;
  box-shadow: 0 0 0 1px rgba(0,0,0,.35), 0 8px 40px rgba(0,0,0,.45); background: #1E1E1E; }
#${HOST_ID} iframe { border: 0; width: 100%; height: 100%; display: block; }
#${HOST_ID} .fdc-grip { height: 26px; cursor: move; background: #2A2A2A; display: flex;
  align-items: center; gap: 6px; padding: 0 8px; font: 11px/26px system-ui, sans-serif; color: #C8C8C8; }
#${HOST_ID} .fdc-grip button { all: unset; cursor: pointer; padding: 2px 7px; color: #C8C8C8;
  font-size: 11px; border-radius: 4px; border: 1px solid #454545; background: #333; }
#${HOST_ID} .fdc-grip button:hover { color: #fff; background: #4E25E2; border-color: #4E25E2; }
#${HOST_ID} .fdc-grip button[data-role="collapse"] { background: #4E25E2; border-color: #4E25E2;
  color: #fff; font-weight: 600; }
#${HOST_ID} .fdc-body { height: calc(100% - 26px); }
/* A visible grab bar, not an invisible 6px strip nobody can find. */
#${HOST_ID} .fdc-edge { position: absolute; z-index: 1; background: #4E25E2; opacity: 0; transition: opacity .12s; }
#${HOST_ID} .fdc-edge:hover { opacity: .85; }
/* A visible corner grip for the floating panel, where both dimensions are ours. */
#${HOST_ID} .fdc-corner { position: absolute; right: 0; bottom: 0; width: 16px; height: 16px;
  cursor: nwse-resize; z-index: 2;
  background: linear-gradient(135deg, transparent 46%, #6A6A6A 46%, #6A6A6A 54%, transparent 54%,
    transparent 66%, #6A6A6A 66%, #6A6A6A 74%, transparent 74%); }
#${HOST_ID} .fdc-corner:hover { background: linear-gradient(135deg, transparent 42%, #4E25E2 42%, #4E25E2 58%, transparent 58%); }`;
  (document.head ?? document.documentElement).appendChild(style);
}

/**
 * Give the page back its full size.
 *
 * Every property set by `reserveSpace` is removed here, including the transform —
 * leaving that behind would keep a containing block the app never asked for and
 * subtly change how its own fixed elements position.
 */
function releaseSpace(): void {
  for (const el of [document.documentElement, document.body]) {
    if (!el) continue;
    for (const prop of ['width', 'height', 'transform', 'overflow', MARGIN_PROP, 'margin-block-end']) {
      el.style.removeProperty(prop);
    }
  }
}

/**
 * Reserve space so the app reflows beside the panel instead of behind it.
 *
 * A margin on `<html>` is not enough, which is why docking overlapped: Fuuz lays
 * its shell out with `position: fixed`, and a fixed element is positioned against
 * the **viewport**, ignoring any ancestor's margin or width.
 *
 * The fix is a `transform`, which makes an element the containing block for its
 * fixed-position descendants — so a narrowed, transformed ancestor makes the app's
 * fixed shell resolve against *it* rather than the viewport, and genuinely move.
 *
 * It has to be **`<body>`, not `<html>`**. Transforming html contained our own
 * overlay too, since the overlay is a descendant of html: `right: 0` became the
 * right edge of the narrowed html (still overlapping the app) and `bottom: 0`
 * became the bottom of the shortened html (floating upward). Transforming body
 * and mounting the overlay on `documentElement` — a *sibling* of body — leaves the
 * overlay positioned against the real viewport while the app is constrained.
 *
 * The trade-off, stated because it is real: this changes the containing block for
 * every fixed element inside body, so an app relying on viewport-relative fixed
 * positioning can shift. It is reverted completely on undock.
 */
function reserveSpace(mode: DockMode, size: number): void {
  releaseSpace();
  const body = document.body?.style;
  if (!body) return;
  if (mode === 'right') {
    body.setProperty('width', `calc(100% - ${size}px)`);
    // Establishes the containing block; `translateZ(0)` is visually a no-op.
    body.setProperty('transform', 'translateZ(0)');
  } else if (mode === 'bottom') {
    body.setProperty('height', `calc(100% - ${size}px)`);
    body.setProperty('transform', 'translateZ(0)');
    body.setProperty('overflow', 'hidden');
  }
}

function applyGeometry(host: HTMLElement): void {
  const { mode, collapsed } = state;
  // Collapsed reserves only the tab's own width, so the page reclaims the rest
  // without the capture being torn down.
  const size = collapsed ? COLLAPSED : state.size;
  const body = host.querySelector('.fdc-body') as HTMLElement | null;
  if (body) body.style.display = collapsed ? 'none' : '';

  /*
   * Collapsed, only the expand control is shown.
   *
   * At 26px the grip's six buttons overflowed and were clipped, so there was no
   * way to reopen — the console became permanently a stripe. Now everything except
   * the expand button is hidden while collapsed, and the grip is given the whole
   * 26px to itself.
   */
  const grip = host.querySelector('.fdc-grip') as HTMLElement | null;
  if (grip) {
    grip.style.height = collapsed ? '100%' : '22px';
    grip.style.flexDirection = collapsed && mode === 'right' ? 'column' : 'row';
    for (const el of Array.from(grip.children) as HTMLElement[]) {
      const isExpander = el.dataset?.role === 'collapse';
      el.style.display = collapsed && !isExpander ? 'none' : '';
    }
  }
  if (body) body.style.height = collapsed ? '0' : 'calc(100% - 26px)';

  /*
   * Re-place the resize handle whenever the mode changes.
   *
   * It was positioned once at creation, so after switching from right to bottom
   * the handle stayed on the left edge and the height could not be dragged at all.
   */
  const corner = host.querySelector('.fdc-corner') as HTMLElement | null;
  if (corner) corner.style.display = mode === 'float' && !collapsed ? 'block' : 'none';

  const edge = host.querySelector('.fdc-edge') as HTMLElement | null;
  if (edge) {
    edge.style.display = collapsed || mode === 'float' ? 'none' : 'block';
    if (mode === 'right') Object.assign(edge.style, { left: '-4px', top: '0', width: '8px', height: '100%', cursor: 'col-resize', right: 'auto', bottom: 'auto' });
    else if (mode === 'bottom') Object.assign(edge.style, { top: '-4px', left: '0', height: '8px', width: '100%', cursor: 'row-resize', right: 'auto', bottom: 'auto' });
  }
  Object.assign(host.style, { inset: '', top: '', right: '', bottom: '', left: '', width: '', height: '' });

  if (mode === 'right') {
    Object.assign(host.style, { top: '0', right: '0', bottom: '0', width: `${size}px`, height: 'auto' });
    reserveSpace('right', size);
  } else if (mode === 'bottom') {
    Object.assign(host.style, { left: '0', right: '0', bottom: '0', height: `${size}px`, width: 'auto' });
    reserveSpace('bottom', size);
  } else {
    releaseSpace();
    // Floating covers content by design, so it reserves nothing. Its own
    // remembered size, and only defaults on first use.
    Object.assign(host.style, {
      top: host.style.top && host.style.top !== '0px' ? host.style.top : '80px',
      left: host.style.left || 'auto',
      right: host.style.left ? 'auto' : '40px',
      width: `${state.floatW ?? 560}px`,
      height: `${state.floatH ?? Math.round(window.innerHeight * 0.6)}px`,
    });
  }
}

/** Drag a floating panel by its grip; docked modes ignore it. */
function makeDraggable(host: HTMLElement, grip: HTMLElement): void {
  let startX = 0, startY = 0, originX = 0, originY = 0, dragging = false;
  grip.addEventListener('pointerdown', (e) => {
    /*
     * Never start a drag on a control.
     *
     * `setPointerCapture` on the grip redirects every later pointer event to the
     * grip, so the button under the cursor never receives its `click`. That is why
     * the close button did nothing while floating: it was starting a drag instead.
     */
    if ((e.target as Element | null)?.closest('button')) return;
    // Primary button only; a right-click should not drag the panel either.
    if (e.button !== 0) return;
    if (state.mode !== 'float') return;
    dragging = true;
    const rect = host.getBoundingClientRect();
    startX = e.clientX; startY = e.clientY; originX = rect.left; originY = rect.top;
    grip.setPointerCapture(e.pointerId);
  });
  grip.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    // Clamped so the grip can never be dragged off-screen and become unreachable.
    const x = Math.max(0, Math.min(window.innerWidth - 120, originX + (e.clientX - startX)));
    const y = Math.max(0, Math.min(window.innerHeight - 40, originY + (e.clientY - startY)));
    Object.assign(host.style, { left: `${x}px`, top: `${y}px`, right: 'auto', bottom: 'auto' });
  });
  grip.addEventListener('pointerup', () => { dragging = false; });
}

/**
 * Resize handles.
 *
 * A docked panel has one draggable edge; a floating one needs a corner, because
 * both dimensions are its own. Without it, floating was stuck at whatever the
 * defaults happened to be.
 */
function makeResizable(host: HTMLElement): void {
  const corner = document.createElement('div');
  corner.className = 'fdc-corner';
  corner.title = 'Drag to resize';
  host.appendChild(corner);
  corner.addEventListener('pointerdown', (e) => {
    if (state.mode !== 'float' || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    corner.setPointerCapture(e.pointerId);
    const rect = host.getBoundingClientRect();
    const startX = e.clientX, startY = e.clientY;
    const move = (ev: PointerEvent) => {
      // Floors so the grip and its buttons always stay reachable; ceilings so the
      // panel cannot be dragged larger than the window it lives in.
      state.floatW = Math.max(320, Math.min(window.innerWidth - rect.left - 8, rect.width + (ev.clientX - startX)));
      state.floatH = Math.max(140, Math.min(window.innerHeight - rect.top - 8, rect.height + (ev.clientY - startY)));
      host.style.width = `${state.floatW}px`;
      host.style.height = `${state.floatH}px`;
    };
    const up = () => { corner.removeEventListener('pointermove', move); void persist(); };
    corner.addEventListener('pointermove', move);
    corner.addEventListener('pointerup', up, { once: true });
  });

  const edge = document.createElement('div');
  edge.className = 'fdc-edge';
  host.appendChild(edge);
  const place = () => {
    if (state.mode === 'right') Object.assign(edge.style, { left: '-3px', top: '0', width: '6px', height: '100%', cursor: 'col-resize' });
    else if (state.mode === 'bottom') Object.assign(edge.style, { top: '-3px', left: '0', height: '6px', width: '100%', cursor: 'row-resize' });
    else edge.style.display = 'none';
  };
  place();
  edge.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (state.mode === 'off' || state.mode === 'float') return;
    edge.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const next = state.mode === 'right'
        ? window.innerWidth - ev.clientX
        : window.innerHeight - ev.clientY;
      state.size = Math.max(280, Math.min(next, state.mode === 'right' ? window.innerWidth - 200 : window.innerHeight - 120));
      applyGeometry(host);
      place();
    };
    const up = () => {
      edge.removeEventListener('pointermove', move);
      void persist();
    };
    edge.addEventListener('pointermove', move);
    edge.addEventListener('pointerup', up, { once: true });
  });
}

async function persist(): Promise<void> {
  try {
    await chrome.storage?.local.set({
      overlay: {
        mode: state.mode, size: state.size, collapsed: state.collapsed,
        floatW: state.floatW, floatH: state.floatH,
      },
      /*
       * The last placement the developer *chose*, kept apart from whether the console is open.
       *
       * `overlay.mode` becomes `off` when the console is closed, which is correct — but the toolbar
       * was reading it as the preference, so closing the console silently reset "where I like it" to
       * "a separate window". Closing something is not a statement about where you want it next time.
       *
       * Only ever written with a real dock mode, so it survives every close.
       */
      ...(state.mode === 'off' ? {} : { lastDock: { mode: state.mode, size: state.size } }),
    });
  } catch { /* optional */ }
}

/** Remove every trace: node, style, and the margin we reserved. */
export function closeOverlay(): void {
  document.getElementById(HOST_ID)?.remove();
  document.getElementById(STYLE_ID)?.remove();
  releaseSpace();
  state = { ...state, mode: 'off' };
  // Persisted immediately, so a reload does not bring back a console the
  // developer just closed — which made it feel impossible to get rid of.
  void persist();
}

/**
 * Show the console in the page. Idempotent — calling again re-docks the existing
 * panel rather than stacking a second iframe, which would run two captures.
 */
/** The tab this page is, once the worker has told us. */
let knownTabId: number | undefined;

export function setOverlay(mode: DockMode, tabId?: number, size?: number): OverlayState {
  if (mode === 'off') { closeOverlay(); return state; }
  // Remembered, so re-docking from the grip does not lose the id and fall back to
  // another tab — which is how the console ended up reading the designer.
  if (tabId !== undefined) knownTabId = tabId;
  state = { ...state, mode, size: size ?? state.size };

  let host = document.getElementById(HOST_ID) as HTMLElement | null;
  if (!host) {
    ensureStyle();
    host = document.createElement('div');
    host.id = HOST_ID;

    const grip = document.createElement('div');
    grip.className = 'fdc-grip';
    const title = document.createElement('span');
    title.textContent = 'Fuuz Dev Console';
    grip.appendChild(title);

    const spacer = document.createElement('span');
    spacer.style.flex = '1';
    grip.appendChild(spacer);

    const collapse = document.createElement('button');
    // Marked so the geometry pass can keep it visible when everything else hides.
    collapse.dataset.role = 'collapse';
    collapse.textContent = 'Hide ▾';
    collapse.title = 'Collapse to the edge — the capture keeps running';
    collapse.addEventListener('pointerdown', (e) => e.stopPropagation());
    collapse.addEventListener('click', (e) => {
      e.stopPropagation();
      state.collapsed = !state.collapsed;
      collapse.textContent = state.collapsed ? 'Show Fuuz Dev Console ▴' : 'Hide ▾';
      collapse.title = state.collapsed ? 'Expand the console' : 'Collapse to the edge — the capture keeps running';
      const el = document.getElementById(HOST_ID) as HTMLElement | null;
      if (el) applyGeometry(el);
      void persist();
    });
    grip.appendChild(collapse);

    for (const [label, target] of [['Right', 'right'], ['Bottom', 'bottom'], ['Float', 'float'], ['Close', 'off']] as const) {
      const button = document.createElement('button');
      button.textContent = label;
      button.title = target === 'off' ? 'Close (or press Escape)' : `Dock ${target}`;
      // `pointerdown` as well as `click`: if anything upstream ever captures the
      // pointer again, close must still work rather than silently doing nothing.
      button.addEventListener('pointerdown', (e) => e.stopPropagation());
      button.addEventListener('click', (e) => { e.stopPropagation(); setOverlay(target, knownTabId ?? tabId); });
      grip.appendChild(button);
    }

    const body = document.createElement('div');
    body.className = 'fdc-body';
    const frame = document.createElement('iframe');
    // The panel keeps extension privileges here; the page cannot reach into it.
    frame.src = panelUrl(knownTabId ?? tabId);
    frame.setAttribute('title', 'Fuuz Dev Console');
    body.appendChild(frame);

    host.append(grip, body);
    // On documentElement, NOT body: body is the element we transform, and a
    // child of it would be constrained by that transform along with the app.
    document.documentElement.appendChild(host);

    // Always a way out that does not depend on hitting a 12px button.
    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      closeOverlay();
      window.removeEventListener('keydown', onEscape, true);
    };
    window.addEventListener('keydown', onEscape, true);
    makeDraggable(host, grip);
    makeResizable(host);
  }

  applyGeometry(host);
  void persist();
  return state;
}

export function overlayState(): OverlayState {
  return { ...state, mode: document.getElementById(HOST_ID) ? state.mode : 'off' };
}

/**
 * Restore the last dock on load, attached to **this** tab.
 *
 * The tab id has to come from the worker: a content script cannot see its own,
 * and framing the panel without one made it target whichever tab it last knew —
 * so opening a screen from the designer left the console still reading the
 * designer. Asking first also means a newly opened screen gets a console already
 * attached to itself, with no second reload.
 */
export function restoreOverlay(): void {
  try {
    chrome.storage?.local.get('overlay', (stored) => {
      const saved = stored?.overlay as OverlayState | undefined;
      if (!saved || saved.mode === 'off') return;
      state = {
        mode: saved.mode, size: saved.size ?? 460, collapsed: saved.collapsed,
        floatW: saved.floatW, floatH: saved.floatH,
      };
      try {
        chrome.runtime.sendMessage({ type: 'whoAmI' }, (reply) => {
          void chrome.runtime.lastError;
          // Open even without an id rather than not at all — the panel can still
          // be pointed at a tab by hand, which beats no console.
          setOverlay(state.mode, reply?.tabId, state.size);
        });
      } catch {
        setOverlay(state.mode, undefined, state.size);
      }
    });
  } catch { /* storage unavailable — stay closed */ }
}
