/**
 * Which node the developer has selected on a flow or schema canvas.
 *
 * The screen designer was straightforward: its structure tree marks the selected row
 * with `aria-selected`, which is what the element tree already mirrors. A diagram
 * canvas has no tree — the nodes *are* the canvas — and diagram libraries disagree
 * about how they mark selection: a class, an `aria-selected`, a `data-` attribute,
 * or an added outline.
 *
 * So rather than hard-code one convention, every known marker is checked and the one
 * that matched is reported. If Fuuz's canvas uses something else again, the reported
 * `via` is `undefined` with the node list still populated — which is a diagnosable
 * state, unlike silently detecting nothing.
 *
 * Pure. The DOM reading lives in the relay.
 */

/** What the relay observed about one canvas node. */
export interface NodeDescriptor {
  /** `data-nodeid` — the diagram's own id. */
  id: string;
  /** The node's visible title, when it has one. */
  name?: string;
  ariaSelected?: string | null;
  dataSelected?: string | null;
  /** The element's class list, joined. */
  classes?: string;
  /**
   * The node's own accent colour, as the canvas draws it.
   *
   * Fuuz colours a flow node by what it does — a source, a query, a branch — so the colour is
   * information the list was throwing away. Carrying it through lets the node list read the
   * same way the canvas does, which is what makes the two navigable together.
   */
  colour?: string;
  /**
   * What visually distinguishes this node from its peers.
   *
   * Fuuz marks a selected node with **a different emotion class** — `css-nlpftr` becomes
   * something else — and with no `aria-selected`, no `data-selected` and no `selected` class
   * anywhere. Verified on a live schema canvas: four nodes, all `class="node css-…"`, and the
   * selected one indistinguishable by any attribute.
   *
   * So the signature carries the styling that could differ (generated classes, plus the
   * outline and shadow the canvas might use instead), and selection is inferred from which
   * nodes are in the *minority*. That works whichever CSS property the platform picks, and
   * survives them renaming the class — which a hard-coded class name would not.
   */
  signature?: string;
}

export interface CanvasSelection {
  /** Ids of every node that appears selected. */
  ids: string[];
  /** Names, where the node carried one — what a browser pane actually displays. */
  names: string[];
  /** Which convention matched, or undefined when none did. */
  via?: string;
}

/**
 * Whether one node is selected, and by which marker.
 *
 * Order is by how explicit the signal is. A class match is last and is anchored to a
 * word boundary: `selected` must not be found inside `unselected` or
 * `selectedNodesMessage`, both of which exist in this DOM.
 */
export function selectionOf(node: NodeDescriptor): { selected: boolean; via?: string } {
  if (node.ariaSelected === 'true') return { selected: true, via: 'aria-selected' };
  if (node.dataSelected === 'true') return { selected: true, via: 'data-selected' };
  const classes = node.classes ?? '';
  // `Mui-selected` is what the platform's own components use; react-flow uses a bare
  // `selected`. Both are single class tokens, so the boundary check is what keeps
  // `unselected` from matching.
  if (/(^|\s)(Mui-selected|selected|is-selected|node-selected)(\s|$)/.test(classes)) {
    return { selected: true, via: 'class' };
  }
  return { selected: false };
}

/**
 * Every selected node on the canvas.
 *
 * Multi-select is supported because diagram canvases support it and because the
 * schema browser is explicitly meant to accumulate several models — collapsing to a
 * single selection would throw away the thing the user asked for.
 */
export function selectedNodes(nodes: NodeDescriptor[]): CanvasSelection {
  const hits = nodes.map((n) => ({ node: n, ...selectionOf(n) })).filter((h) => h.selected);
  if (hits.length) {
    return {
      ids: hits.map((h) => h.node.id),
      names: hits.map((h) => h.node.name ?? h.node.id).filter(Boolean),
      via: hits[0]?.via,
    };
  }
  return byOddSignature(nodes);
}

/**
 * Selection inferred from the node that looks different from its peers.
 *
 * The fallback for a canvas that marks selection purely in generated CSS. The reasoning is
 * that a canvas draws every *unselected* node identically, so the odd one out is the selected
 * one — and this holds whatever property the platform actually changes.
 *
 * Three guards, because "the odd one out" is only meaningful sometimes:
 *
 *  - **At least three nodes.** With two, "minority" is a coin toss.
 *  - **A clear majority.** If signatures split evenly, nothing is inferable and saying so is
 *    better than picking one.
 *  - **The minority stays small.** Half the canvas is not a selection; that is two kinds of
 *    node, drawn differently.
 */
function byOddSignature(nodes: NodeDescriptor[]): CanvasSelection {
  const withSignature = nodes.filter((n) => n.signature);
  if (withSignature.length < 3) return { ids: [], names: [] };

  const counts = new Map<string, NodeDescriptor[]>();
  for (const node of withSignature) {
    const list = counts.get(node.signature!);
    if (list) list.push(node);
    else counts.set(node.signature!, [node]);
  }
  if (counts.size < 2) return { ids: [], names: [] };

  const groups = [...counts.values()].sort((a, b) => b.length - a.length);
  const majority = groups[0];
  const minority = groups.slice(1).flat();
  // A third of the canvas is a category, not a selection.
  if (majority.length <= minority.length || minority.length > Math.max(1, Math.floor(nodes.length / 3))) {
    return { ids: [], names: [] };
  }

  return {
    ids: minority.map((n) => n.id),
    names: minority.map((n) => n.name ?? n.id).filter(Boolean),
    via: 'drawn differently from the other nodes (the canvas marks selection in generated CSS only)',
  };
}

/**
 * Add newly-selected names to an accumulated list, newest first, without duplicates.
 *
 * The browser pane keeps every model the developer has clicked, so clicking a fourth
 * does not lose the first three. Newest-first because the one just clicked is the one
 * being looked at; capped because an unbounded list of open cards stops being a
 * browser and becomes a memory leak with a scrollbar.
 */
export function accumulate(existing: string[], incoming: string[], cap = 12): string[] {
  const out = [...incoming.filter((n) => !existing.includes(n)), ...existing];
  return out.slice(0, cap);
}
