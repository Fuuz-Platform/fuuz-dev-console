/**
 * Which wires feed a node, and which leave it.
 *
 * On a flow with thirty nodes, "what feeds this?" is answered by tracing a line across a canvas
 * of crossing lines. Colouring the selected node's own wires answers it at a glance — and the
 * two directions need *different* colours, because "what feeds this" and "what does this feed"
 * are separate questions and a single highlight colour would merge them.
 *
 * ## Why sides rather than draw order
 *
 * A diagram library draws each link from its source port to its target port, so the path's first
 * point is the upstream end. Relying on that would work until the library changed, and the
 * failure would be silent and exactly inverted — every arrow labelled backwards, which is worse
 * than no colour at all.
 *
 * So direction comes from **which side of the node the endpoint touches**: flows run left-to-right
 * and top-to-bottom, so an endpoint on the left or top edge is an input and one on the right or
 * bottom is an output. That holds whatever order the library draws in, and degrades to
 * `unrelated` rather than guessing when an endpoint is nowhere near the node.
 *
 * Pure.
 */

export interface Point { x: number; y: number }

export interface Rect { left: number; top: number; right: number; bottom: number }

/**
 * One link on the canvas.
 *
 * A link is **not one path**. The canvas renders it as a `<g data-linkid>` holding a path per
 * elbow segment — plus a wide invisible hit path behind each, and a circle at every joint. Keying
 * a map on `data-linkid` therefore overwrote all but the last segment, which is why an elbowed
 * wire only ever lit up one leg of itself.
 *
 * So a wire owns its segments, and its endpoints span them: the start of the first and the end of
 * the last.
 */
export interface Wire {
  id: string;
  start: Point;
  end: Point;
}

/**
 * Colours for a node's outputs, in order.
 *
 * A node with three outputs needs three colours, or tracing which branch goes where means following
 * identically-coloured lines across the canvas — the problem the colouring exists to solve. Chosen
 * to be distinguishable from each other, from the cyan used for inputs, and from the violet used for
 * the selected node.
 *
 * Inputs stay one colour: "what feeds this" is a set, and the individual sources are already
 * distinguishable by where they come from.
 */
export const OUTPUT_COLOURS = [
  '#F59E0B',   // amber
  '#A3E635',   // lime
  '#FB7185',   // rose
  '#FB923C',   // orange
  '#FDE047',   // yellow
  '#34D399',   // emerald
  '#E879F9',   // fuchsia
];

/**
 * The colour for the nth output of a node.
 *
 * Wraps rather than running out: a node with eight outputs reusing the first colour is a smaller
 * problem than one output rendered in the default stroke and looking unhighlighted.
 */
export const outputColour = (index: number) => OUTPUT_COLOURS[index % OUTPUT_COLOURS.length];

export type WireRole = 'input' | 'output' | 'unrelated';

/**
 * Colours for the two directions.
 *
 * Cyan in, amber out — chosen to be distinguishable from each other, from the violet used for the
 * selection itself, and from the greens and blues Fuuz colours its own nodes with. Both are light
 * enough to read against a dark canvas and saturated enough against a light one.
 */
export const WIRE_COLOURS: Record<'input' | 'output', string> = {
  input: '#22D3EE',
  output: OUTPUT_COLOURS[0],
};

/**
 * How close an endpoint has to be to count as attached.
 *
 * Ports sit slightly outside the node's box, and a path stops at the port rather than the node
 * edge — so a tolerance is required, not a nicety. Too large and a wire passing behind a node
 * gets claimed; this is about the width of a port.
 */
const TOLERANCE = 18;

/**
 * A port on the selected node.
 *
 * The precise answer, and available: the canvas puts `data-nodeid` on every port, so "does this wire
 * attach to this node" is a question about *ports*, not about proximity to a box. Matching against
 * the box claimed wires that merely passed nearby — on a zoomed-out canvas an 18px tolerance covers
 * a lot of diagram — which is why unrelated links were being recoloured.
 */
export interface Port {
  centre: Point;
  /** Where the port sits relative to the node, which decides in versus out. */
  role: 'input' | 'output';
}

/** How near an endpoint must be to a port's centre. About a port's own radius. */
const PORT_TOLERANCE = 14;

/**
 * Classify a wire by the port it lands on.
 *
 * Preferred over the box test wherever ports are found: it cannot claim a passing wire, and the
 * direction comes from the port rather than being inferred from geometry. Returns `unrelated` when
 * neither end reaches a port of this node — which is the answer that stops over-highlighting.
 */
export function roleByPorts(wire: Wire, ports: Port[]): WireRole {
  if (!ports.length) return 'unrelated';
  const near = (point: Point) => ports.find((port) =>
    Math.abs(port.centre.x - point.x) <= PORT_TOLERANCE
    && Math.abs(port.centre.y - point.y) <= PORT_TOLERANCE);

  const atStart = near(wire.start);
  const atEnd = near(wire.end);
  if (!atStart && !atEnd) return 'unrelated';
  // Both ends on this node is a self-loop; it does leave, so it reads as an output.
  if (atStart && atEnd) return 'output';
  return (atStart ?? atEnd)!.role;
}

/** Whether a point is within tolerance of a rect. */
function touches(point: Point, rect: Rect): boolean {
  return point.x >= rect.left - TOLERANCE && point.x <= rect.right + TOLERANCE
    && point.y >= rect.top - TOLERANCE && point.y <= rect.bottom + TOLERANCE;
}

/**
 * Which side of the node an endpoint sits on.
 *
 * The dominant axis decides: an endpoint 40px left and 3px above the centre is on the *left*, and
 * treating it as "above" would call an input an output. Comparing normalised distances rather than
 * raw pixels keeps that true for a wide, short node as well as a square one.
 */
function side(point: Point, rect: Rect): 'input' | 'output' {
  const midX = (rect.left + rect.right) / 2;
  const midY = (rect.top + rect.bottom) / 2;
  const width = Math.max(1, rect.right - rect.left);
  const height = Math.max(1, rect.bottom - rect.top);

  const dx = (point.x - midX) / width;
  const dy = (point.y - midY) / height;

  // Flows run left-to-right and top-to-bottom, so the leading edges are inputs.
  return Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 'input' : 'output') : (dy < 0 ? 'input' : 'output');
}

/**
 * Classify one wire against the selected node.
 *
 * A wire with **both** ends on the node is a self-loop and is reported as an output: it does leave
 * the node, and colouring it as an input would be the less useful of two half-truths.
 */
export function roleOf(wire: Wire, node: Rect): WireRole {
  const startTouches = touches(wire.start, node);
  const endTouches = touches(wire.end, node);
  if (!startTouches && !endTouches) return 'unrelated';

  if (startTouches && endTouches) return 'output';
  return side(startTouches ? wire.start : wire.end, node);
}

export interface WireVerdict {
  inputs: string[];
  /** Outputs in canvas order, so each gets a stable colour from {@link OUTPUT_COLOURS}. */
  outputs: string[];
  /** Wires that touch the node but could not be placed on a side. */
  unresolved: string[];
}

/**
 * Every wire attached to the node, split by direction.
 *
 * Returned as ids so the caller can style exactly those paths and restore the rest untouched —
 * repainting every link and hoping the originals are recoverable is how a canvas ends up
 * permanently recoloured.
 */
export function classifyWires(wires: Wire[], node: Rect, ports: Port[] = []): WireVerdict {
  const verdict: WireVerdict = { inputs: [], outputs: [], unresolved: [] };
  for (const wire of wires) {
    /*
     * Ports decide when we have them; the box test is the fallback.
     *
     * The box test is looser by nature — it asks "is this endpoint near the node" — and that is what
     * claimed wires passing behind it. Ports answer "is this endpoint *on* the node", which is the
     * question, so they win wherever the canvas exposes them.
     */
    const role = ports.length ? roleByPorts(wire, ports) : roleOf(wire, node);
    if (role === 'input') verdict.inputs.push(wire.id);
    else if (role === 'output') verdict.outputs.push(wire.id);
  }
  return verdict;
}
