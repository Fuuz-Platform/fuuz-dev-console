/**
 * Which designer surface the panel is currently describing.
 *
 * The Application Designer keeps several tabs open at once — a screen, a schema, a
 * flow — and switching between them replaces everything the panel shows while the
 * browser tab, the port and the polling loop all stay identical. Nothing in the
 * transport changes, so nothing invalidates the caches, and the panel went on
 * showing a screen's structure, design coverage and element selection while the
 * developer was looking at a flow.
 *
 * Stale state that looks live is the failure mode worth engineering against: an
 * empty element tree reads as "the extension is broken", and the *previous* tab's
 * element tree reads as a bug in the tab you switched to.
 *
 * Pure.
 */

/** What the page reports about the tab it is showing. */
export interface SurfaceReport {
  /** `screen`, `schema`, `flow` — or null when this is not a designer at all. */
  designer?: string | null;
  /** The flow's own id, when the canvas carries one. */
  designerId?: string;
  /** The open designer tab's id. */
  tabId?: string;
  tabName?: string;
}

/**
 * A stable identity for the open surface, or undefined outside a designer.
 *
 * Keyed on kind **and** id, because both distinctions matter and neither is
 * sufficient: a screen and a flow are obviously different surfaces, and so are two
 * screens open in two tabs — keying on kind alone would leave the first screen's
 * design on display after switching to the second.
 *
 * The id falls back through `designerId` → `tabId` → `tabName`, which is ordered by
 * how stable each is. A name is a poor key (rename it and we reset for nothing) but
 * it beats no key at all, which would never reset.
 */
export function surfaceIdentity(report: SurfaceReport | null | undefined): string | undefined {
  const kind = report?.designer;
  if (!kind) return undefined;
  return `${kind}:${report?.designerId ?? report?.tabId ?? report?.tabName ?? ''}`;
}

/**
 * Whether the surface actually changed.
 *
 * Not a bare `!==`, because the id is scraped from the DOM and the DOM is
 * best-effort: a poll that lands mid-render can report `screen:` where the previous
 * one reported `screen:t1`. Treating that as a switch would remount the panel and
 * throw away the developer's expanded rows and selection several times a second —
 * a worse failure than the stale state this exists to prevent.
 *
 * So a change of *kind* always counts, and a change of id counts only when both ids
 * are actually known.
 */
export function surfaceChanged(before: string | undefined, after: string | undefined): boolean {
  if (before === after) return false;
  if (before === undefined || after === undefined) return true;
  const [beforeKind, beforeId] = split(before);
  const [afterKind, afterId] = split(after);
  if (beforeKind !== afterKind) return true;
  // Same kind, and one side could not name itself: assume the same surface.
  return !!beforeId && !!afterId && beforeId !== afterId;
}

function split(key: string): [string, string] {
  const cut = key.indexOf(':');
  return cut === -1 ? [key, ''] : [key.slice(0, cut), key.slice(cut + 1)];
}


/* ── Choosing among several mounted canvases ──────────────────────────────── */

/** One designer canvas found in the document. */
export interface CanvasCandidate {
  kind: string;
  /** The id the canvas carries, when its kind encodes one (flows do). */
  designerId?: string;
  /**
   * Whether it is actually on screen.
   *
   * The decisive fact, and the one that was never checked.
   */
  visible: boolean;
  /** Rendered area, to break ties between two visible canvases. */
  area: number;
}

/**
 * Which canvas the developer is actually looking at.
 *
 * The Application Designer **keeps every open tab mounted** and hides the inactive ones,
 * so a document can hold a screen canvas, a schema canvas and a flow canvas at once. The
 * original code took the first match in a fixed order — screen, schema, flow — which
 * meant that opening a screen tab alongside a flow made the flow permanently unreadable:
 * the panel reported `screen`, fetched a screen design, never asked the flow engine for
 * events, and looked broken in a way that pointed nowhere.
 *
 * Visibility is the answer, and it is not a heuristic: exactly one tab panel is displayed
 * at a time, so exactly one canvas has a layout box.
 *
 * Falls back to the largest when nothing reports visible — a document where every canvas
 * is hidden should not be called "no designer", because the developer is plainly in one.
 */
export function pickCanvas(candidates: CanvasCandidate[]): CanvasCandidate | undefined {
  if (!candidates.length) return undefined;
  const visible = candidates.filter((c) => c.visible && c.area > 0);
  const pool = visible.length ? visible : candidates;
  return pool.slice().sort((a, b) => b.area - a.area)[0];
}

/**
 * The tab that owns a canvas.
 *
 * By id where the canvas carries one — a flow canvas is prefixed with its own id, which
 * is exact — and otherwise by kind. Kind alone is ambiguous with two flows open, so the
 * id is tried first even though it only sometimes applies.
 */
export function tabForCanvas<T extends { id: string; kind?: string }>(
  tabs: T[],
  canvas: { kind: string; designerId?: string } | undefined
): T | undefined {
  if (!canvas) return undefined;
  if (canvas.designerId) {
    const byId = tabs.find((t) => t.id === canvas.designerId);
    if (byId) return byId;
  }
  return tabs.find((t) => t.kind === canvas.kind);
}
