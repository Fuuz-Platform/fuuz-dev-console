/**
 * Draw on the page, then screenshot it.
 *
 * The point is a screenshot that *says something*: an arrow at the control that
 * misbehaved beats a clean capture of a busy screen with a paragraph explaining
 * where to look. Because `captureVisibleTab` photographs rendered pixels, whatever
 * is drawn here is in the image with no compositing step.
 *
 * ## Why SVG in the isolated world
 *
 * SVG rather than canvas so a shape stays editable and removable individually —
 * an accidental arrow can be undone rather than repainted. Isolated world because
 * this only needs the DOM: keeping it out of the page's own world means page
 * script cannot read, alter or erase the annotations.
 *
 * ## What it does to the page
 *
 * Adds one absolutely-positioned layer and nothing else. It never changes app
 * DOM, never intercepts app events while idle (`pointer-events` are enabled only
 * while a tool is armed), and `clear` removes every trace. Drawing is cosmetic by
 * construction, so it is not gated the way a value edit is — but the screenshot
 * it feeds still is.
 */

const LAYER_ID = '__fuuz_markup_layer';
const BAR_ID = '__fuuz_markup_bar';

export type MarkupTool = 'select' | 'arrow' | 'box' | 'ellipse' | 'text' | 'pen' | 'erase' | 'off';

export interface MarkupState {
  active: boolean;
  tool: MarkupTool;
  colour: string;
  shapes: number;
  /** Whether a shape is currently selected, so the panel can enable its actions. */
  selected?: boolean;
}

const COLOURS = ['#FF3B30', '#FFCC00', '#34C759', '#4E25E2', '#FFFFFF'];

let tool: MarkupTool = 'arrow';
let colour = COLOURS[0];
const stack: SVGElement[] = [];

/**
 * The shape being edited.
 *
 * Markup was write-once: a mistyped label or a badly placed arrow could only be
 * deleted and redrawn. Selection is what makes it editable — and it needs to be a
 * single piece of state, because two selected shapes would make "change the colour"
 * ambiguous.
 */
let selected: SVGElement | undefined;

const NS = 'http://www.w3.org/2000/svg';

function layer(): SVGSVGElement | null {
  return document.getElementById(LAYER_ID) as SVGSVGElement | null;
}

/** Arrowhead marker, defined once and referenced by every arrow. */
function ensureDefs(svg: SVGSVGElement): void {
  if (svg.querySelector('defs')) return;
  const defs = document.createElementNS(NS, 'defs');
  for (const c of COLOURS) {
    const marker = document.createElementNS(NS, 'marker');
    marker.setAttribute('id', `fm-head-${c.slice(1)}`);
    marker.setAttribute('viewBox', '0 0 10 10');
    marker.setAttribute('refX', '9');
    marker.setAttribute('refY', '5');
    marker.setAttribute('markerWidth', '6');
    marker.setAttribute('markerHeight', '6');
    marker.setAttribute('orient', 'auto-start-reverse');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
    path.setAttribute('fill', c);
    marker.appendChild(path);
    defs.appendChild(marker);
  }
  svg.appendChild(defs);
}

function ensureLayer(): SVGSVGElement {
  const existing = layer();
  if (existing) return existing;

  const svg = document.createElementNS(NS, 'svg') as SVGSVGElement;
  svg.id = LAYER_ID;
  Object.assign(svg.style, {
    position: 'fixed', inset: '0', width: '100vw', height: '100vh',
    // Below the console (2147483646) so the panel stays clickable above it.
    zIndex: '2147483640',
    // Idle by default: an armed layer that swallowed every click would make the
    // app unusable the moment markup was switched on.
    pointerEvents: 'none',
  } as Partial<CSSStyleDeclaration>);
  ensureDefs(svg);
  document.documentElement.appendChild(svg);
  return svg;
}

function push(el: SVGElement): void {
  stack.push(el);
  // Hit-testing a 3px stroke is unreliable, so each shape gets a hover cue and a
  // generous invisible target via `pointer-events: all` on the stroke.
  el.style.cursor = 'pointer';
  el.setAttribute('pointer-events', 'all');
}

/**
 * Show which shape is selected.
 *
 * A dashed halo drawn with the shape's own geometry rather than a bounding box: a
 * selected arrow should look like a selected arrow, and a box around a diagonal line
 * points at mostly empty space. Implemented as a filter-free stroke change so it
 * cannot be mistaken for part of the markup.
 */
function paintSelection(): void {
  for (const el of stack) {
    const on = el === selected;
    el.style.outline = '';
    // `stroke-dasharray` on a clone would double the work; the halo is a CSS filter,
    // which leaves the shape's own attributes untouched so editing them stays simple.
    el.style.filter = on ? 'drop-shadow(0 0 0 #fff) drop-shadow(0 0 3px #4E25E2)' : '';
    el.style.opacity = on ? '1' : '';
  }
}

/**
 * Select a shape, or clear the selection with `undefined`.
 *
 * Exported because the panel needs to be able to clear it: leaving a shape selected
 * after the tools are put away would take the halo into the screenshot.
 */
export function selectShape(el: SVGElement | undefined): MarkupState {
  selected = el && stack.includes(el) ? el : undefined;
  paintSelection();
  return markupState();
}

/** The current selection, for the actions that operate on it. */
export function selectedShape(): SVGElement | undefined {
  return selected;
}

/**
 * Recolour the selected shape.
 *
 * An arrow's head is a separate marker per colour, so the `marker-end` has to be
 * re-pointed too — changing only the stroke would leave a red head on a green line.
 */
export function recolourSelection(next: string): MarkupState {
  if (!selected) return markupState();
  const isText = selected.tagName.toLowerCase() === 'text';
  selected.setAttribute(isText ? 'fill' : 'stroke', next);
  if (selected.getAttribute('marker-end')) {
    selected.setAttribute('marker-end', `url(#fm-head-${next.slice(1)})`);
  }
  return markupState();
}

/**
 * Move the selected shape by a delta.
 *
 * A `transform` rather than rewriting every coordinate: one mechanism for lines,
 * rects, ellipses, paths and text alike, and it composes so repeated drags accumulate
 * without reading geometry back out.
 */
export function nudgeSelection(dx: number, dy: number): MarkupState {
  if (!selected) return markupState();
  const current = /translate\(\s*(-?[\d.]+)[ ,]+(-?[\d.]+)\s*\)/.exec(selected.getAttribute('transform') ?? '');
  const x = (current ? Number(current[1]) : 0) + dx;
  const y = (current ? Number(current[2]) : 0) + dy;
  selected.setAttribute('transform', `translate(${x} ${y})`);
  return markupState();
}

/**
 * Retype a text label in place.
 *
 * Only text is editable this way, because only text has content to edit; a shape is
 * edited by moving and recolouring it. Returns false when the selection is not text,
 * so the caller can say why nothing happened.
 */
export function editSelectedText(): boolean {
  if (!selected || selected.tagName.toLowerCase() !== 'text') return false;
  const target = selected;
  const box = (target as SVGGraphicsElement).getBoundingClientRect();
  // Seeded with the existing value, so a typo is corrected rather than retyped.
  editText(box.left, box.top + box.height, target.textContent ?? '', target);
  return true;
}

/** The topmost shape under the pointer, if any. */
function shapeUnder(e: PointerEvent): SVGElement | undefined {
  const el = e.target as Element | null;
  if (!el || el.id === LAYER_ID) return undefined;
  return stack.includes(el as SVGElement) ? (el as SVGElement) : undefined;
}

/** Remove one shape, keeping the rest and the undo order intact. */
export function removeShape(el: SVGElement): MarkupState {
  const at = stack.indexOf(el);
  if (at >= 0) stack.splice(at, 1);
  el.remove();
  // A deleted shape must not stay selected, or the actions would operate on a node
  // that is no longer in the document.
  if (selected === el) selected = undefined;
  return markupState();
}

/** Undo the last shape. */
export function undoMarkup(): MarkupState {
  stack.pop()?.remove();
  return markupState();
}

/**
 * Remove every shape.
 *
 * Scoped to this tab by construction: the layer is DOM in this document, and each
 * tab's content script holds its own `stack`. There is no shared store, so
 * clearing here can never touch another tab's annotations — and equally, markup
 * drawn here does not follow the developer to another tab.
 *
 * `keepArmed` leaves the layer and toolbar in place, because clearing a bad set of
 * shapes to start again is far more common than clearing in order to stop.
 */
export function clearMarkup(keepArmed = true): MarkupState {
  for (const el of stack.splice(0)) el.remove();
  if (!keepArmed) {
    layer()?.remove();
    document.getElementById(BAR_ID)?.remove();
    return { active: false, tool, colour, shapes: 0 };
  }
  return markupState();
}

/* ── Drawing ─────────────────────────────────────────────────────────────── */

function attachDrawing(svg: SVGSVGElement): void {
  let start: { x: number; y: number } | undefined;
  let current: SVGElement | undefined;
  /** Where the last move-drag sampled from, so moves apply as deltas. */
  let dragFrom: { x: number; y: number } | undefined;

  const begin = (e: PointerEvent) => {
    if (tool === 'off') return;
    // Ignore drags that start on our own toolbar.
    if ((e.target as Element | null)?.closest(`#${BAR_ID}`)) return;

    /*
     * Delete one shape.
     *
     * Two ways in, because the eraser being armed is easy to forget: the eraser
     * tool, and a right-click on any shape whatever tool is active. Both remove
     * that shape only — everything else stays.
     */
    if (tool === 'erase' || e.button === 2) {
      const hit = shapeUnder(e);
      if (hit) { removeShape(hit); e.preventDefault(); }
      return;
    }
    if (e.button !== 0) return;

    /*
     * Select, and drag to move.
     *
     * Clicking empty layer clears the selection rather than doing nothing — the
     * standard behaviour everywhere else, and without it there is no way to deselect
     * short of switching tools.
     */
    if (tool === 'select') {
      const hit = shapeUnder(e);
      selectShape(hit);
      if (!hit) return;
      e.preventDefault();
      dragFrom = { x: e.clientX, y: e.clientY };
      return;
    }

    start = { x: e.clientX, y: e.clientY };

    if (tool === 'text') {
      /*
       * Stop the pointerdown's default action.
       *
       * Without this the browser moves focus as part of the gesture, taking it
       * straight back off the input we just created — and the `blur` handler then
       * committed an empty value and removed it. The box appeared and vanished,
       * which is why text "did not work".
       */
      e.preventDefault();
      placeText(start.x, start.y);
      start = undefined;
      return;
    }
    if (tool === 'pen') {
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', `M ${start.x} ${start.y}`);
      path.setAttribute('stroke', colour);
      path.setAttribute('stroke-width', '3');
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke-linecap', 'round');
      svg.appendChild(path);
      current = path;
      return;
    }
    const el = document.createElementNS(NS, tool === 'arrow' ? 'line' : tool === 'box' ? 'rect' : 'ellipse');
    el.setAttribute('stroke', colour);
    el.setAttribute('stroke-width', '3');
    el.setAttribute('fill', 'none');
    if (tool === 'arrow') el.setAttribute('marker-end', `url(#fm-head-${colour.slice(1)})`);
    svg.appendChild(el);
    current = el;
  };

  const move = (e: PointerEvent) => {
    // Dragging a selected shape. Deltas rather than absolute coordinates, so the
    // translate composes with whatever the shape already carried.
    if (dragFrom && selected) {
      nudgeSelection(e.clientX - dragFrom.x, e.clientY - dragFrom.y);
      dragFrom = { x: e.clientX, y: e.clientY };
      return;
    }
    if (!start || !current) return;
    const [x0, y0, x1, y1] = [start.x, start.y, e.clientX, e.clientY];
    if (tool === 'pen') {
      current.setAttribute('d', `${current.getAttribute('d')} L ${x1} ${y1}`);
    } else if (tool === 'arrow') {
      current.setAttribute('x1', String(x0)); current.setAttribute('y1', String(y0));
      current.setAttribute('x2', String(x1)); current.setAttribute('y2', String(y1));
    } else if (tool === 'box') {
      current.setAttribute('x', String(Math.min(x0, x1)));
      current.setAttribute('y', String(Math.min(y0, y1)));
      current.setAttribute('width', String(Math.abs(x1 - x0)));
      current.setAttribute('height', String(Math.abs(y1 - y0)));
    } else {
      current.setAttribute('cx', String((x0 + x1) / 2));
      current.setAttribute('cy', String((y0 + y1) / 2));
      current.setAttribute('rx', String(Math.abs(x1 - x0) / 2));
      current.setAttribute('ry', String(Math.abs(y1 - y0) / 2));
    }
  };

  const end = () => {
    dragFrom = undefined;
    // A click with no drag leaves a zero-size shape; drop it rather than leaving
    // an invisible node that Undo would appear to no-op on.
    if (current) {
      const box = (current as SVGGraphicsElement).getBBox?.();
      if (box && box.width < 2 && box.height < 2) current.remove();
      else push(current);
    }
    start = undefined;
    current = undefined;
  };

  // Right-click is a delete gesture here, so suppress the page menu inside the
  // layer only — outside it the app behaves normally.
  svg.addEventListener('contextmenu', (e) => {
    if (shapeUnder(e as unknown as PointerEvent)) e.preventDefault();
  });
  /*
   * Double-click a label to retype it.
   *
   * Bound on the layer rather than per shape, so labels created later are covered
   * without re-binding — and it works whatever tool is active, because wanting to fix
   * a typo does not mean wanting to switch tools first.
   */
  svg.addEventListener('dblclick', (e) => {
    const hit = shapeUnder(e as unknown as PointerEvent);
    if (!hit || hit.tagName.toLowerCase() !== 'text') return;
    e.preventDefault();
    e.stopPropagation();
    selectShape(hit);
    editSelectedText();
  });
  svg.addEventListener('pointerdown', begin);
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointerleave', end);
}

/** A new text label, typed in place. */
function placeText(x: number, y: number): void {
  editText(x, y, '', undefined);
}

/**
 * The in-place text editor, for a new label or an existing one.
 *
 * One implementation for both: `replacing` is the label being retyped, and its old
 * node is removed only once a value is committed — so cancelling an edit leaves the
 * original intact rather than destroying it on the way in.
 */
function editText(x: number, y: number, initial: string, replacing: SVGElement | undefined): void {
  const svg = ensureLayer();
  const input = document.createElement('input');
  input.value = initial;
  Object.assign(input.style, {
    position: 'fixed', left: `${x}px`, top: `${y - 12}px`, zIndex: '2147483645',
    font: '600 15px system-ui, sans-serif', color: colour, background: 'rgba(0,0,0,.6)',
    border: `1px solid ${colour}`, padding: '2px 4px', outline: 'none',
  } as Partial<CSSStyleDeclaration>);
  input.placeholder = 'label…';
  document.documentElement.appendChild(input);
  // After the current gesture, not during it: focusing inside pointerdown is
  // undone by the browser's own focus handling for that same event.
  setTimeout(() => {
    input.focus();
    // Selected, so retyping replaces the label; a new one starts empty anyway.
    if (initial) input.select();
  }, 0);

  // Blur fires on the way in as well as the way out; committing before the
  // developer has typed anything is what removed the box immediately.
  let ready = false;
  setTimeout(() => { ready = true; }, 150);

  let done = false;
  const commit = () => {
    if (done || !ready) return;
    done = true;
    const value = input.value.trim();
    input.remove();
    /*
     * An emptied label is a deletion, not a no-op.
     *
     * Clearing the text and pressing Enter is how anyone expects to remove a label,
     * and leaving the old one in place would look like the edit had failed.
     */
    if (!value) { if (replacing) removeShape(replacing); return; }
    if (replacing) removeShape(replacing);
    const text = document.createElementNS(NS, 'text');
    text.setAttribute('x', String(x));
    text.setAttribute('y', String(y));
    text.setAttribute('fill', colour);
    text.setAttribute('font-size', '15');
    text.setAttribute('font-weight', '600');
    text.setAttribute('font-family', 'system-ui, sans-serif');
    // A dark halo so a label stays readable over light and dark screens alike.
    text.setAttribute('stroke', 'rgba(0,0,0,.75)');
    text.setAttribute('stroke-width', '3');
    text.setAttribute('paint-order', 'stroke');
    text.textContent = value;
    // The colour it already had, so retyping a label does not silently restyle it to
    // whatever the toolbar happens to be set to.
    if (replacing) {
      const had = replacing.getAttribute('fill');
      if (had) text.setAttribute('fill', had);
    }
    svg.appendChild(text);
    push(text);
    if (replacing) selectShape(text);
  };
  input.addEventListener('keydown', (e) => {
    // Keep typing inside the input rather than letting the layer act on it.
    e.stopPropagation();
    if (e.key === 'Enter') { ready = true; commit(); }
    if (e.key === 'Escape') { done = true; input.remove(); }
  });
  // Typing should always work, so the pointer gestures on the input never reach
  // the drawing layer underneath.
  input.addEventListener('pointerdown', (e) => e.stopPropagation());
  input.addEventListener('blur', commit);
}

/* ── Toolbar ─────────────────────────────────────────────────────────────── */

function ensureBar(): void {
  if (document.getElementById(BAR_ID)) return;
  const bar = document.createElement('div');
  bar.id = BAR_ID;
  Object.assign(bar.style, {
    all: 'initial', position: 'fixed', top: '12px', left: '50%', transform: 'translateX(-50%)',
    zIndex: '2147483644', display: 'flex', gap: '4px', alignItems: 'center',
    background: '#1E1E1E', border: '1px solid #3A3A3A', borderRadius: '6px', padding: '4px 6px',
    boxShadow: '0 6px 24px rgba(0,0,0,.5)', font: '12px system-ui, sans-serif', color: '#DDD',
  } as Partial<CSSStyleDeclaration>);

  const button = (label: string, title: string, onClick: () => void) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.title = title;
    Object.assign(b.style, {
      all: 'unset', cursor: 'pointer', padding: '2px 6px', borderRadius: '4px', color: '#DDD',
    } as Partial<CSSStyleDeclaration>);
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); paint(); });
    bar.appendChild(b);
    return b;
  };

  const tools: [MarkupTool, string, string][] = [
    // Select first: markup was write-once, and editing is now the default thing you
    // reach for on a drawing that is already there.
    ['select', '⬚', 'Select — click a shape to move or recolour it, double-click a label to retype it'],
    ['arrow', '↗', 'Arrow'], ['box', '▭', 'Box'], ['ellipse', '◯', 'Circle'],
    ['text', 'T', 'Text'], ['pen', '✎', 'Freehand'],
    ['erase', '⌧', 'Erase one shape — or right-click any shape with any tool'],
  ];
  const toolButtons = tools.map(([t, label, title]) => {
    // Switching away from Select drops the halo, so it never lands in a screenshot.
    const b = button(label, title, () => { tool = t; if (t !== 'select') selectShape(undefined); });
    b.dataset.tool = t;
    return b;
  });

  for (const c of COLOURS) {
    const dot = document.createElement('button');
    dot.title = 'Colour';
    dot.dataset.colour = c;
    Object.assign(dot.style, {
      all: 'unset', cursor: 'pointer', width: '13px', height: '13px', borderRadius: '50%',
      background: c, border: '1px solid rgba(255,255,255,.35)',
    } as Partial<CSSStyleDeclaration>);
    /*
     * A colour applies to the selection when there is one.
     *
     * Picking a colour with a shape selected can only reasonably mean "make it this
     * colour" — setting the colour for the *next* shape instead would look like the
     * click did nothing. With no selection it sets the drawing colour as before.
     */
    dot.addEventListener('click', (e) => {
      e.stopPropagation();
      colour = c;
      if (selectedShape()) recolourSelection(c);
      paint();
    });
    bar.appendChild(dot);
  }

  /*
   * Capture, right where the annotating happens.
   *
   * Going back to the panel's overflow menu to take the shot breaks the flow —
   * and the panel may be docked out of the way or closed entirely.
   */
  const shot = button('⧉', 'Copy a screenshot of this tab to the clipboard', () => {
    shot.textContent = '…';
    try {
      chrome.runtime.sendMessage({ type: 'captureToClipboard' }, (reply) => {
        void chrome.runtime.lastError;
        const ok = reply?.ok === true;
        shot.textContent = ok ? '✓' : '✕';
        shot.title = ok
          ? 'Copied to the clipboard — paste it anywhere'
          : `Capture failed: ${reply?.error ?? 'no response'}`;
        setTimeout(() => { shot.textContent = '⧉'; shot.title = 'Copy a screenshot of this tab to the clipboard'; }, 1600);
      });
    } catch {
      shot.textContent = '✕';
    }
  });

  /*
   * Delete and retype, which only make sense with something selected.
   *
   * Disabled rather than hidden: a control that appears and disappears is harder to
   * find than one that is visibly unavailable, and the title says what to do first.
   */
  const del = button('␡', 'Delete the selected shape', () => {
    const el = selectedShape();
    if (el) removeShape(el);
  });
  const retype = button('✎T', 'Retype the selected label — or double-click it', () => {
    if (!editSelectedText()) {
      retype.title = 'Select a text label first — shapes are edited by moving and recolouring';
      setTimeout(() => { retype.title = 'Retype the selected label — or double-click it'; }, 2200);
    }
  });

  button('⤺', 'Undo the last shape', () => { undoMarkup(); });
  // Clearing keeps the tools armed: wiping a bad set to start again is much more
  // common than wiping in order to stop.
  button('⌫', 'Clear all markup on this tab', () => { clearMarkup(true); });
  button('✕', 'Clear and put the tools away', () => { clearMarkup(false); });

  /** Show which tool and colour are armed — otherwise it is guesswork. */
  const paint = () => {
    for (const b of toolButtons) {
      b.style.background = b.dataset.tool === tool ? '#4E25E2' : 'transparent';
    }
    for (const dot of Array.from(bar.querySelectorAll<HTMLElement>('[data-colour]'))) {
      dot.style.outline = dot.dataset.colour === colour ? '2px solid #FFF' : 'none';
      dot.style.outlineOffset = '1px';
    }
    // Dimmed rather than removed: a control that vanishes is harder to find again
    // than one that is visibly unavailable.
    const hasSelection = !!selectedShape();
    for (const b of [del, retype]) {
      b.style.opacity = hasSelection ? '1' : '.35';
      b.style.pointerEvents = hasSelection ? 'auto' : 'none';
    }
  };

  /*
   * Repaint when the selection changes from a click on the canvas.
   *
   * The toolbar's own buttons repaint themselves, but selecting a shape happens on the
   * SVG layer — without this the delete and retype buttons stayed dimmed after a
   * successful selection, which read as selection not working at all.
   */
  const l = layer();
  l?.addEventListener('pointerup', () => paint());
  l?.addEventListener('dblclick', () => paint());

  document.documentElement.appendChild(bar);
  paint();
}

/* ── Public ──────────────────────────────────────────────────────────────── */

export function markupState(): MarkupState {
  return { active: !!layer(), tool, colour, shapes: stack.length, selected: !!selected };
}

/** Arm or disarm markup. Disarming keeps the shapes; `clearMarkup` removes them. */
export function setMarkup(on: boolean, which?: MarkupTool): MarkupState {
  if (!on) {
    const svg = layer();
    if (svg) svg.style.pointerEvents = 'none';
    document.getElementById(BAR_ID)?.remove();
    return markupState();
  }
  const svg = ensureLayer();
  if (which) tool = which;
  // Only capture pointer events while armed, so the app stays usable otherwise.
  svg.style.pointerEvents = 'auto';
  if (!svg.dataset.wired) { attachDrawing(svg); svg.dataset.wired = '1'; }
  ensureBar();
  return markupState();
}

/**
 * Write a PNG to the clipboard.
 *
 * A download leaves a file to find, open and delete for something usually pasted
 * straight into a ticket or a chat. Clipboard needs a real `ClipboardItem` with a
 * `Blob` — writing the data URI as text would paste the base64 string, not the
 * image — and it must run in a page context with a user gesture, which is why the
 * worker sends the image here rather than copying it itself.
 */
export async function copyImageToClipboard(dataUrl: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const write = (navigator.clipboard as unknown as {
      write?: (items: ClipboardItem[]) => Promise<void>;
    }).write;
    if (typeof write !== 'function' || typeof ClipboardItem === 'undefined') {
      return { ok: false, error: 'This browser cannot put an image on the clipboard.' };
    }
    await write.call(navigator.clipboard, [new ClipboardItem({ [blob.type]: blob })]);
    return { ok: true };
  } catch (e) {
    // Usually a lost user gesture or a focus requirement, both worth saying.
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Hide our own chrome for a capture, and put it back.
 *
 * The annotations must stay — they are the point — but the toolbar and the docked
 * console are *our* UI, not the developer's screen, and including them makes the
 * screenshot about the tool rather than about the bug.
 */
export function hideChromeForCapture(): () => void {
  const hidden: { el: HTMLElement; prior: string }[] = [];
  /*
   * The selection halo is our chrome too.
   *
   * It marks which shape you are editing; it is not part of the annotation, and a
   * violet glow around one arrow in a screenshot reads as meaning something. Dropped
   * for the capture and restored after, like the toolbar.
   */
  const wasSelected = selected;
  selectShape(undefined);
  for (const id of [BAR_ID, '__fuuz_dev_console_host']) {
    const el = document.getElementById(id);
    if (!el) continue;
    hidden.push({ el, prior: el.style.visibility });
    // `visibility` rather than `display`: it keeps layout stable, so the docked
    // page does not reflow mid-capture and shift what is being photographed.
    el.style.visibility = 'hidden';
  }
  return () => {
    for (const { el, prior } of hidden) el.style.visibility = prior;
    selectShape(wasSelected);
  };
}
