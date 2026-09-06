/**
 * Which wires feed a node, and which leave it.
 *
 * The failure to avoid is a *silent inversion*: labelling every input as an output would look
 * plausible and be exactly backwards, which is worse than no colour at all. So direction comes
 * from the side of the node an endpoint touches, not from the order the library draws in.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyWires, OUTPUT_COLOURS, outputColour, roleByPorts, roleOf, WIRE_COLOURS,
} from '../src/core/wires';

/** A node at 200..300 × 100..160. */
const NODE = { left: 200, top: 100, right: 300, bottom: 160 };

const wire = (id: string, start: [number, number], end: [number, number]) =>
  ({ id, start: { x: start[0], y: start[1] }, end: { x: end[0], y: end[1] } });

test('a wire arriving at the left edge is an input', () => {
  assert.equal(roleOf(wire('a', [40, 130], [200, 130]), NODE), 'input');
});

test('a wire leaving the right edge is an output', () => {
  assert.equal(roleOf(wire('b', [300, 130], [520, 130]), NODE), 'output');
});

// Draw order must not decide: the same geometry with the ends swapped is the same wire.
test('reversing a path does not change its direction', () => {
  assert.equal(roleOf(wire('a', [200, 130], [40, 130]), NODE), 'input');
  assert.equal(roleOf(wire('b', [520, 130], [300, 130]), NODE), 'output');
});

test('vertical flows work too — top in, bottom out', () => {
  assert.equal(roleOf(wire('c', [250, 20], [250, 100]), NODE), 'input');
  assert.equal(roleOf(wire('d', [250, 160], [250, 260]), NODE), 'output');
});

// An endpoint 40px left and 3px above the centre is on the *left*; calling it "above" would turn
// an input into an output.
test('the dominant axis decides, not whichever is non-zero', () => {
  assert.equal(roleOf(wire('e', [198, 128], [40, 128]), NODE), 'input');
});

// Ports sit slightly outside the node and a path stops at the port, so tolerance is required.
test('an endpoint just outside the box still attaches', () => {
  assert.equal(roleOf(wire('f', [190, 130], [40, 130]), NODE), 'input');
  assert.equal(roleOf(wire('g', [312, 130], [520, 130]), NODE), 'output');
});

// Too much tolerance would claim a wire merely passing behind the node.
test('a wire passing nowhere near is unrelated', () => {
  assert.equal(roleOf(wire('h', [40, 400], [520, 400]), NODE), 'unrelated');
  assert.equal(roleOf(wire('i', [40, 130], [150, 130]), NODE), 'unrelated');
});

// It does leave the node, and calling it an input would be the less useful half-truth.
test('a self-loop counts as an output', () => {
  assert.equal(roleOf(wire('j', [300, 130], [205, 130]), NODE), 'output');
});

/* ── Classifying a whole canvas ───────────────────────────────────────────── */

test('a canvas splits into the node’s inputs and outputs, ignoring the rest', () => {
  const verdict = classifyWires([
    wire('in1', [40, 120], [200, 120]),
    wire('in2', [40, 150], [198, 150]),
    wire('out1', [300, 130], [520, 130]),
    wire('elsewhere', [40, 400], [520, 400]),
  ], NODE);

  assert.deepEqual(verdict.inputs, ['in1', 'in2']);
  assert.deepEqual(verdict.outputs, ['out1']);
});

test('a node with nothing attached yields empty lists, not an error', () => {
  const verdict = classifyWires([wire('x', [0, 0], [10, 10])], NODE);
  assert.deepEqual(verdict.inputs, []);
  assert.deepEqual(verdict.outputs, []);
});

test('no wires at all is handled', () => {
  assert.deepEqual(classifyWires([], NODE), { inputs: [], outputs: [], unresolved: [] });
});

/* ── The colours ──────────────────────────────────────────────────────────── */

// Two questions — what feeds this, and what does this feed — so two colours. One would merge them.
test('the two directions have distinct colours, neither of them the selection violet', () => {
  assert.notEqual(WIRE_COLOURS.input, WIRE_COLOURS.output);
  for (const colour of Object.values(WIRE_COLOURS)) {
    assert.match(colour, /^#[0-9A-F]{6}$/i);
    assert.ok(!/^#6D3BFF$/i.test(colour), 'must not clash with the node selection colour');
  }
});

/* ── Ports, which are the exact answer ────────────────────────────────────── */

// Matching against the node's box asked "is this endpoint *near* the node", and on a zoomed-out
// canvas an 18px tolerance covers a lot of diagram — so wires merely passing behind a node were
// recoloured. Ports carry `data-nodeid`, so the real question is answerable exactly.
const PORTS = [
  { centre: { x: 200, y: 130 }, role: 'input' as const },
  { centre: { x: 300, y: 120 }, role: 'output' as const },
  { centre: { x: 300, y: 145 }, role: 'output' as const },
];

test('a wire landing on an input port is an input', () => {
  assert.equal(roleByPorts(wire('a', [40, 130], [200, 130]), PORTS), 'input');
});

test('a wire leaving an output port is an output', () => {
  assert.equal(roleByPorts(wire('b', [300, 120], [520, 60]), PORTS), 'output');
});

// The whole point: near the node but on no port of it.
test('a wire passing the node without touching a port is unrelated', () => {
  assert.equal(roleByPorts(wire('c', [40, 100], [520, 100]), PORTS), 'unrelated');
  // Inside the node's box, and still not attached.
  assert.equal(roleByPorts(wire('d', [250, 135], [520, 135]), PORTS), 'unrelated');
});

test('the port decides the direction, not the geometry', () => {
  // An endpoint on the right-hand output port, reached from the right — still an output.
  assert.equal(roleByPorts(wire('e', [520, 145], [300, 145]), PORTS), 'output');
});

test('a self-loop between two of its own ports is an output', () => {
  assert.equal(roleByPorts(wire('f', [300, 120], [200, 130]), PORTS), 'output');
});

// A canvas that exposes no ports must still work, so the box test remains the fallback.
test('with no ports the classification falls back to the box', () => {
  const verdict = classifyWires([wire('in', [40, 130], [200, 130])], NODE, []);
  assert.deepEqual(verdict.inputs, ['in']);
});

test('with ports, the box test does not get a say', () => {
  // Near the node, so the box test would claim it; no port, so ports refuse it.
  const verdict = classifyWires([wire('near', [190, 105], [40, 105])], NODE, PORTS);
  assert.deepEqual(verdict.inputs, []);
  assert.deepEqual(verdict.outputs, []);
});

/* ── One colour per output ────────────────────────────────────────────────── */

// Three branches leaving one node in one colour means tracing identical lines — the thing this is
// meant to remove.
test('each output gets a distinct colour, and none is the input colour', () => {
  const colours = [0, 1, 2].map(outputColour);
  assert.equal(new Set(colours).size, 3);
  for (const colour of colours) assert.notEqual(colour, WIRE_COLOURS.input);
});

test('more outputs than colours wraps rather than running out', () => {
  assert.equal(outputColour(OUTPUT_COLOURS.length), OUTPUT_COLOURS[0]);
  assert.ok(outputColour(99));
});
