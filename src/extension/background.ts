/**
 * Service worker: route console events to the DevTools panel for their tab.
 *
 * A DevTools panel can't receive `chrome.runtime.sendMessage` from a content
 * script directly — it has no tab of its own — so panels register a long-lived
 * port keyed by the tab they inspect, and this forwards by `sender.tab.id`.
 */
import { isGated, mutationsAllowed, refusalFor, type GatedCapability } from '../core/environment';
import { isolationState, setOriginIsolation } from './originIsolation';

const panels = new Map<number, chrome.runtime.Port>();

/**
 * Refuse anything that changes or copies a production page.
 *
 * Checked here, in the worker, against the URL **Chrome** reports for the tab —
 * not a URL supplied by the caller and not one read from page script. The panel
 * hides these controls too, but hiding a button is not a control; this is.
 */
async function gate(tabId: number, type: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isGated(type)) return { ok: true };
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url ?? '';
    if (mutationsAllowed(url)) return { ok: true };
    return { ok: false, error: refusalFor(url, type as GatedCapability) };
  } catch {
    // If the tab cannot be read we cannot establish the environment, and an
    // unverifiable environment is treated as production.
    return { ok: false, error: 'The environment of this tab could not be verified, so changes are refused.' };
  }
}

/* ── Screenshots ─────────────────────────────────────────────────────────── */

interface CaptureRequest {
  type: 'captureTab';
  /** Crop to one element, located by the page. Omit for the whole viewport. */
  target?: { name?: string; type?: string; dataPath?: string; label?: string };
  /** Longest edge in CSS pixels. A retina capture is ~4x this before scaling. */
  maxEdge?: number;
}

/**
 * Capture the watched tab and send it to the panel.
 *
 * Downscaled before it leaves here, and that is not cosmetic: a raw retina
 * capture is several megabytes of base64, and this image's destination is often
 * an LLM context window by way of the MCP bridge. Shrinking at the source is the
 * difference between a usable tool and one that costs a large chunk of a
 * conversation per screenshot.
 *
 * Two limits are inherent and reported rather than worked around: the API
 * captures the **visible viewport only**, and it cannot capture DevTools itself.
 */
async function captureForPanel(port: chrome.runtime.Port, tabId: number, req: CaptureRequest): Promise<void> {
  const fail = (error: string) => {
    try { port.postMessage({ type: 'screenshot', ok: false, error }); } catch { /* panel gone */ }
  };
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.windowId === undefined) return fail('The watched tab has no window.');

    // A background tab renders nothing to capture; say that rather than
    // returning a blank or stale image.
    if (!tab.active) {
      return fail('That tab is not the active one in its window — Chrome can only capture what is on screen.');
    }

    // Hide our own UI first, so the image is the developer's screen plus their
    // annotations — not a photograph of this extension.
    await new Promise<void>((resolve) => {
      chrome.tabs.sendMessage(tabId, { type: 'prepareCapture' }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
      // Never block a capture on the page answering.
      setTimeout(resolve, 400);
    });

    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });

    let rect: { x: number; y: number; width: number; height: number } | undefined;
    let dpr = 1;
    if (req.target) {
      const reply = await new Promise<{
        found?: boolean; rect?: typeof rect; dpr?: number;
      } | undefined>((resolve) => {
        chrome.tabs.sendMessage(tabId, { type: 'getElementRect', target: req.target }, (r) => {
          void chrome.runtime.lastError;
          resolve(r);
        });
      });
      if (!reply?.found || !reply.rect) {
        return fail('That element could not be located in the page, so there is nothing to crop to.');
      }
      rect = reply.rect;
      dpr = reply.dpr ?? 1;
    }

    const png = await resize(dataUrl, rect, dpr, req.maxEdge ?? 1200);
    try {
      port.postMessage({ type: 'screenshot', ok: true, ...png, cropped: !!rect });
    } catch { /* panel closed mid-capture */ }
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Crop and downscale in the worker.
 *
 * MV3 workers have no `document`, so this uses `createImageBitmap` +
 * `OffscreenCanvas` — both available in a service worker, unlike an `Image`.
 */
async function resize(
  dataUrl: string,
  rect: { x: number; y: number; width: number; height: number } | undefined,
  dpr: number,
  maxEdge: number
): Promise<{ dataUrl: string; width: number; height: number; bytes: number }> {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);

  // The capture is in device pixels; a rectangle measured in the page is in CSS
  // pixels. Without this scaling a crop lands in the wrong place on any retina
  // display — which is most of them.
  const sx = rect ? Math.max(0, rect.x * dpr) : 0;
  const sy = rect ? Math.max(0, rect.y * dpr) : 0;
  const sw = rect ? Math.min(bitmap.width - sx, rect.width * dpr) : bitmap.width;
  const sh = rect ? Math.min(bitmap.height - sy, rect.height * dpr) : bitmap.height;
  if (sw <= 0 || sh <= 0) throw new Error('That element has no visible area on screen.');

  const scale = Math.min(1, maxEdge / Math.max(sw, sh));
  const dw = Math.max(1, Math.round(sw * scale));
  const dh = Math.max(1, Math.round(sh * scale));

  const canvas = new OffscreenCanvas(dw, dh);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No 2D context available to resize the capture.');
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, dw, dh);
  bitmap.close();

  const out = await canvas.convertToBlob({ type: 'image/png' });
  const buf = new Uint8Array(await out.arrayBuffer());
  let binary = '';
  for (let i = 0; i < buf.length; i += 1) binary += String.fromCharCode(buf[i]);
  return { dataUrl: `data:image/png;base64,${btoa(binary)}`, width: dw, height: dh, bytes: buf.length };
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'fuuz-dev-console-panel') return;
  let tabId: number | undefined;
  port.onMessage.addListener((msg: { type: string; tabId?: number; target?: unknown }) => {
    if (msg.type === 'init' && typeof msg.tabId === 'number') {
      tabId = msg.tabId;
      panels.set(tabId, port);
      return;
    }
    if (msg.type === 'webmcpAnswer' && typeof (msg as { id?: number }).id === 'number') {
      const { id, result } = msg as unknown as { id: number; result: unknown };
      const waiter = pending.get(id);
      if (waiter) { pending.delete(id); waiter(result); }
      return;
    }

    // Screenshots are the one request the page cannot serve: only the worker can
    // reach the capture API. It still asks the page for the element rectangle
    // first, so a crop is measured in the page's own coordinates.
    if (msg.type === 'captureTab' && tabId !== undefined) {
      const id = tabId;
      void gate(id, 'captureTab').then((verdict) => {
        if (!verdict.ok) {
          try { port.postMessage({ type: 'screenshot', ok: false, error: verdict.error }); } catch { /* gone */ }
          return;
        }
        return captureForPanel(port, id, msg as CaptureRequest);
      });
      return;
    }

    // Highlight requests travel panel → here → the page's content script.
    const toPage = ['highlight', 'clearHighlight', 'hideNativeConsole', 'getSessionToken',
      'getElementStyles', 'applyElementStyle', 'probeElement', 'callElementFn', 'getElementRect', 'huntDesign', 'flowEvents', 'overlay', 'flowNodeDetail', 'setFlowNodeValue', 'markup', 'copyImage', 'previewProp',
      // Must travel this way like the rest: `chrome.runtime.sendMessage` from the
      // panel reaches extension contexts only, never a content script, so asking
      // the page directly silently returns undefined.
      'getDesignerSurface'];
    /*
     * One console per tab, in one place.
     *
     * Docking used to leave the popup window open and add an iframe, so two
     * panels ran two captures against the same tab — a duplicate, not a move.
     * Docking now closes the window; undocking to `off` reopens it, so the
     * console follows the developer instead of multiplying.
     */
    if (msg.type === 'overlay' && tabId !== undefined) {
      const id = tabId;
      const mode = (msg as { mode?: string; size?: number }).mode;
      const size = (msg as { size?: number }).size;
      void size;   // the relay persists the size itself, under `overlay`
      /*
       * Closing is deliberately *not* a preference.
       *
       * Closing the console means "done for now", not "give me a separate window next time" — and
       * treating it as the latter is what made the toolbar keep opening a window. The only way to
       * prefer a window is to ask for one, which `preferWindow` records.
       */
      if (mode === 'window') void preferWindow();
      if (mode && mode !== 'off' && mode !== 'window') {
        void rememberedWindow(id).then(async (windowId) => {
          if (windowId === undefined) return;
          await rememberWindow(id, undefined);
          try { await chrome.windows.remove(windowId); } catch { /* already closed */ }
        });
      }
    }

    if (toPage.includes(msg.type) && tabId !== undefined) {
      const id = tabId;
      void gate(id, msg.type).then((verdict) => {
        if (!verdict.ok) {
          const reply = msg.type === 'callElementFn'
            ? { type: 'fnResult', ok: false, error: verdict.error }
            : { type: 'highlightResult', found: false, error: verdict.error };
          try { port.postMessage(reply); } catch { /* gone */ }
          return;
        }
        chrome.tabs.sendMessage(id, msg, (reply) => {
          void chrome.runtime.lastError;   // the tab may have no content script yet
          try {
            // `from` and `searchedKeys` travel with it: "no session token" is the
            // single most blocking failure in this extension, and without knowing
            // which keys were searched it is undiagnosable from the panel.
            if (msg.type === 'getSessionToken') {
              port.postMessage({
                type: 'sessionToken', token: reply?.token,
                from: reply?.from, searchedKeys: reply?.searchedKeys,
              });
            }
            else if (msg.type === 'getElementStyles') port.postMessage({ type: 'elementStyles', ...reply });
            else if (msg.type === 'probeElement') port.postMessage({ type: 'elementProbe', ...reply });
            else if (msg.type === 'getDesignerSurface') port.postMessage({ type: 'designerSurface', ...reply });
            else if (msg.type === 'huntDesign') port.postMessage({ type: 'designHunt', ...reply });
            else if (msg.type === 'flowEvents') port.postMessage({ type: 'flowEvents', ...reply });
            else if (msg.type === 'callElementFn') port.postMessage({ type: 'fnResult', ...reply });
            else if (msg.type === 'previewProp') port.postMessage({ type: 'previewResult', ...reply });
            // `via` says which attribute matched, which is the only way to tell an
            // exact hit from the type-level fallback — so it travels with the result.
            else port.postMessage({
              type: 'highlightResult', found: reply?.found === true,
              via: reply?.via, approximate: reply?.approximate === true,
            });
          } catch { /* gone */ }
        });
      });
    }
  });
  port.onDisconnect.addListener(() => {
    /*
     * Only forget this port if it is still the registered one.
     *
     * Docking closes the popup window and opens the panel in an iframe. The
     * iframe registers first, then the popup's disconnect arrives — and an
     * unconditional delete removed the *new* port, leaving the tab with no panel
     * registered at all. The panel then showed "hook installed and waiting"
     * forever, because the worker had nowhere to forward console events.
     */
    if (tabId === undefined) return;
    if (panels.get(tabId) === port) panels.delete(tabId);
  });
});

/**
 * A WebMCP tool in the page asking its panel for an answer.
 *
 * `return true` keeps the reply channel open: the panel answers over its port,
 * which is necessarily later than this listener returns. Without it Chrome closes
 * the channel and the tool sees `undefined`.
 */
const pending = new Map<number, (result: unknown) => void>();
let querySeq = 0;

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg?.type !== 'webmcpQuery') return undefined;
  const tabId = sender.tab?.id;
  const port = tabId === undefined ? undefined : panels.get(tabId);
  if (!port) {
    respond({ error: 'The Fuuz Dev Console is not open on this tab. Click the extension icon to open it.' });
    return undefined;
  }
  const id = ++querySeq;
  pending.set(id, respond);
  // A tool call that never returns explains nothing; time out with a reason.
  setTimeout(() => {
    const waiter = pending.get(id);
    if (!waiter) return;
    pending.delete(id);
    waiter({ error: 'The panel did not answer within five seconds.' });
  }, 5000);
  try { port.postMessage({ type: 'webmcpQuery', id, query: msg.query, args: msg.args }); }
  catch { pending.delete(id); respond({ error: 'The panel disconnected.' }); }
  return true;
});

chrome.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender.tab?.id;
  if (msg?.type !== 'console' || tabId === undefined) return;
  const port = panels.get(tabId);
  if (port) { try { port.postMessage(msg); } catch { if (panels.get(tabId) === port) panels.delete(tabId); } }
});

/**
 * Toolbar click → our own window.
 *
 * The DevTools panel is only one way in. A standalone popup means no F12, it
 * survives page reloads, and it can live on a second monitor beside the screen
 * being tested. The tab id rides in the URL so the window knows what it watches.
 */
/**
 * The panel window id must outlive this worker.
 *
 * MV3 service workers are killed after ~30s idle, so an in-memory id is gone by
 * the time you click the toolbar again — which is why a second window would open
 * instead of the existing one being focused. `storage.session` survives the
 * worker but not the browser, which is exactly the lifetime we want.
 */
/**
 * One console **per watched tab**, not one console overall.
 *
 * A single remembered window meant clicking the toolbar on a second Fuuz tab
 * focused the first console and retargeted it — so switching tabs cost a
 * reconnect and a fresh capture every time, losing whatever the other tab had
 * collected. Keying by tab id gives each its own window, and each keeps its own
 * capture running.
 *
 * `storage.session` because an MV3 worker is killed after ~30s idle: an
 * in-memory map is gone by the next click, which is what made a second window
 * open instead of the existing one focusing.
 */
const WINDOW_KEY = 'panelWindows';

/**
 * Where the console was last put, so the toolbar reopens it there.
 *
 * Clicking the icon always created a popup window, so a developer who works with the
 * console docked had to re-dock it on every click — and the popup appears at its
 * default size first, which is the full-width flash before anything useful is on
 * screen.
 *
 * ## One record, not two
 *
 * The in-page console already persists its own placement under `overlay` — the relay
 * writes it on every dock, resize and close, including the float dimensions. That is
 * read here rather than kept in parallel: two records of the same fact drift, and the
 * one the relay maintains is the one that is actually correct.
 *
 * `bounds` is ours alone, because a popup's geometry is not something the page knows.
 */
const BOUNDS_KEY = 'consoleWindowBounds';

/** What the relay persists about the in-page console. */
interface OverlayRecord {
  mode?: 'off' | 'right' | 'bottom' | 'float' | 'window';
  size?: number;
}

interface WindowBounds { left?: number; top?: number; width?: number; height?: number }

/**
 * Where the developer last *chose* to put the console.
 *
 * `lastDock` rather than `overlay`: the latter records whether the console is currently open, and
 * closing it writes `off` — so reading that as the preference meant one close reset "dock it right"
 * to "open a separate window". Closing something says nothing about where you want it next time.
 *
 * `window` is a real preference too, set when the developer picks it explicitly, so the popup stays
 * reachable rather than becoming the thing you get when the mechanism fails.
 */
async function overlayPlacement(): Promise<OverlayRecord> {
  try {
    const stored = await chrome.storage.local.get(['lastDock', 'overlay']);
    const chosen = stored?.lastDock as OverlayRecord | undefined;
    if (chosen && typeof chosen === 'object' && chosen.mode) return chosen;
    // Nothing chosen yet: fall back to the live state, which on a first run is empty anyway.
    const live = stored?.overlay as OverlayRecord | undefined;
    if (live && typeof live === 'object' && live.mode && live.mode !== 'off') return live;
  } catch { /* first run, or storage unavailable */ }
  return {};
}

async function windowBounds(): Promise<WindowBounds | undefined> {
  try {
    const stored = await chrome.storage.local.get(BOUNDS_KEY);
    const value = stored?.[BOUNDS_KEY] as WindowBounds | undefined;
    if (value && typeof value === 'object') return value;
  } catch { /* optional */ }
  return undefined;
}

type WindowMap = Record<string, number>;

async function panelWindows(): Promise<WindowMap> {
  try {
    const stored = await chrome.storage.session.get(WINDOW_KEY);
    const map = stored?.[WINDOW_KEY];
    return map && typeof map === 'object' ? (map as WindowMap) : {};
  } catch { return {}; }
}

async function rememberWindow(tabId: number, windowId: number | undefined): Promise<void> {
  const map = await panelWindows();
  if (windowId === undefined) delete map[String(tabId)];
  else map[String(tabId)] = windowId;
  try { await chrome.storage.session.set({ [WINDOW_KEY]: map }); } catch { /* optional */ }
}

async function rememberedWindow(tabId: number): Promise<number | undefined> {
  const id = (await panelWindows())[String(tabId)];
  return typeof id === 'number' ? id : undefined;
}

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id === undefined) return;
  const url = chrome.runtime.getURL(`panel.html?tabId=${tab.id}`);

  const existing = await rememberedWindow(tab.id);
  if (existing !== undefined) {
    // Focus this tab's own console rather than retargeting another tab's.
    try { await chrome.windows.update(existing, { focused: true }); return; }
    catch { await rememberWindow(tab.id, undefined); }   // the user closed it
  }

  const where = await overlayPlacement();

  /*
   * Reopen in the page when that is where it was last.
   *
   * The in-page console mounts immediately and in place, so there is no popup to
   * appear at its default size and then be repositioned — which is the delay and the
   * full-width flash. A `mode` of `off` means the developer deliberately closed the
   * in-page console, so the popup is correct then.
   *
   * If the content script is not there — a non-Fuuz tab, or the extension was reloaded
   * without refreshing the page — this falls through to the window, because a click
   * that does nothing at all is the worse failure.
   */
  if (where.mode && where.mode !== 'off') {
    const delivered = await new Promise<boolean>((resolve) => {
      try {
        chrome.tabs.sendMessage(
          tab.id!,
          { type: 'overlay', mode: where.mode, size: where.size, tabId: tab.id },
          () => resolve(!chrome.runtime.lastError)
        );
      } catch { resolve(false); }
    });
    if (delivered) return;
  }

  /*
   * The popup, at the size and position it was left.
   *
   * Chrome clamps these to the available displays, so bounds from a monitor that is no
   * longer attached degrade to something visible rather than opening off screen.
   */
  const b = await windowBounds();
  const win = await chrome.windows.create({
    url, type: 'popup',
    width: b?.width ?? 1100, height: b?.height ?? 800,
    ...(b?.left !== undefined ? { left: b.left } : {}),
    ...(b?.top !== undefined ? { top: b.top } : {}),
  });
  await rememberWindow(tab.id, win.id);
});

/**
 * Record "a separate window" as a deliberate choice.
 *
 * Without this the only way to express it would be to close the in-page console, which is the very
 * conflation that broke the preference in the first place.
 */
async function preferWindow(): Promise<void> {
  try { await chrome.storage.local.set({ lastDock: { mode: 'window' } }); } catch { /* optional */ }
}

/**
 * Remember where the popup was moved or resized to.
 *
 * Chrome fires this while dragging, so it is debounced — writing to storage on every
 * pixel of a drag would be dozens of writes for one gesture.
 */
let boundsTimer: ReturnType<typeof setTimeout> | undefined;
chrome.windows.onBoundsChanged?.addListener((win) => {
  const id = win.id;
  if (id === undefined) return;
  void panelWindows().then((map) => {
    if (!Object.values(map).includes(id)) return;
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      const bounds: WindowBounds = { left: win.left, top: win.top, width: win.width, height: win.height };
      try { void chrome.storage.local.set({ [BOUNDS_KEY]: bounds }); } catch { /* optional */ }
    }, 400);
  });
});

chrome.windows.onRemoved.addListener(async (id) => {
  // Forget whichever tab owned it, so the next click opens a fresh one.
  const map = await panelWindows();
  for (const [tabId, windowId] of Object.entries(map)) {
    if (windowId === id) await rememberWindow(Number(tabId), undefined);
  }
});

// A closed tab's console should not linger claiming a tab that no longer exists.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const windowId = await rememberedWindow(tabId);
  await rememberWindow(tabId, undefined);
  if (windowId !== undefined) { try { await chrome.windows.remove(windowId); } catch { /* already gone */ } }
});

// Reloading the watched tab is a panel affordance: refreshing the Fuuz page is
// how you get a cold evaluation, and doing it by hand means leaving the panel.
chrome.runtime.onMessage.addListener((msg: { type?: string; tabId?: number }, sender, respond) => {
  // Panel → worker → page, for the WebMCP questions. The panel has no tab of its
  // own, so it names the tab and the worker relays.
  if (msg?.type === 'webmcpStatus' || msg?.type === 'webmcpRegister' || msg?.type === 'webmcpUnregister'
    || msg?.type === 'flowNodeDetail' || msg?.type === 'setFlowNodeValue'
    || msg?.type === 'flowRunPayloads' || msg?.type === 'engineApi'
    || msg?.type === 'flowLogs' || msg?.type === 'resetFlowLogs'
    || msg?.type === 'writeDefinition'
    || msg?.type === 'pageQuery') {
    const tabId = (msg as { tabId?: number }).tabId;
    if (typeof tabId !== 'number') { respond({ error: 'No tab to ask.' }); return undefined; }
    // Forward the whole message minus the routing field, so `id`/`path`/`value`
    // reach the page rather than being dropped.
    const { tabId: _drop, ...forward } = msg as Record<string, unknown>;
    chrome.tabs.sendMessage(tabId, forward, (reply) => {
      void chrome.runtime.lastError;
      respond(reply ?? { available: false, originIsolated: false, registered: [], reason: 'The content script is not loaded on that tab. Reload it.' });
    });
    return true;
  }
  /**
   * Capture this tab and put it on its own clipboard.
   *
   * Driven from the markup toolbar in the page, so the developer never leaves the
   * screen they are annotating. The worker takes the shot — only it can — and
   * hands the image back to the page, which is where a clipboard write is allowed.
   */
  if (msg?.type === 'captureToClipboard') {
    const tabId = sender.tab?.id;
    if (typeof tabId !== 'number') { respond({ ok: false, error: 'No tab.' }); return undefined; }
    void (async () => {
      const verdict = await gate(tabId, 'captureTab');
      if (!verdict.ok) { respond({ ok: false, error: verdict.error }); return; }
      try {
        const tab = await chrome.tabs.get(tabId);
        if (!tab.active) { respond({ ok: false, error: 'That tab is not the active one in its window.' }); return; }
        // Hide our own chrome, keep the annotations.
        await new Promise<void>((done) => {
          chrome.tabs.sendMessage(tabId, { type: 'prepareCapture' }, () => { void chrome.runtime.lastError; done(); });
          setTimeout(done, 400);
        });
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId!, { format: 'png' });
        chrome.tabs.sendMessage(tabId, { type: 'copyImage', dataUrl }, (reply) => {
          void chrome.runtime.lastError;
          respond(reply ?? { ok: false, error: 'The page did not confirm the copy.' });
        });
      } catch (e) {
        respond({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return true;
  }

  /**
   * Tell a content script which tab it is in.
   *
   * A content script cannot know its own tab id — only the worker sees
   * `sender.tab.id`. Without it the in-page console was framed as
   * `panel.html` with no tab, so it fell back to whichever tab the panel
   * happened to target: on a freshly opened screen it kept selecting the
   * *designer* tab it was launched from, which is the cross-tab behaviour.
   */
  if (msg?.type === 'whoAmI') {
    respond({ tabId: sender.tab?.id, url: sender.tab?.url });
    return undefined;
  }

  if (msg?.type === 'originIsolation') {
    const want = (msg as { enabled?: boolean }).enabled;
    const token = (msg as { token?: string }).token;
    const run = want === undefined ? isolationState() : setOriginIsolation(want === true, token);
    run.then(respond, (e) => respond({ enabled: false, supported: true, error: String(e) }));
    return true;
  }
  if (msg?.type === 'reloadTab' && typeof msg.tabId === 'number') {
    chrome.tabs.reload(msg.tabId).then(() => respond({ ok: true }), () => respond({ ok: false }));
    return true;
  }
  // Which Fuuz tabs are open, so a detached panel can say what it watches — and
  // let you retarget it. Host permissions cover url/title without `tabs`.
  if (msg?.type === 'listTabs') {
    chrome.tabs.query({ url: ['https://*.fuuz.app/*'] }).then(
      (tabs) => respond({
        tabs: tabs
          .filter((t) => t.id !== undefined)
          .map((t) => ({ id: t.id!, title: t.title ?? '', url: t.url ?? '', active: t.active === true })),
      }),
      () => respond({ tabs: [] })
    );
    return true;
  }
  return undefined;
});

export {};
