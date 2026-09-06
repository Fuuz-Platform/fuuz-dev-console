/**
 * The contextual function palette.
 *
 * The worked example from the request is the spec: `$.payload.LiveStreamCount` resolves to a
 * number, `$sum` from the palette rewrites it to `$sum($.payload.LiveStreamCount)` with the
 * caret at the end of the argument, and operators follow.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accepts, appendOperator, findFunctions, FUNCTIONS, paletteFor, platformFunctionsIn, resolveType, subtreeAccepts,
  tokenAround, typeOf, wrapInFunction,
} from '../src/core/functionPalette';

const fn = (name: string) => FUNCTIONS.find((f) => f.name === name)!;

/* ── The worked example, end to end ───────────────────────────────────────── */

test('a numeric path wraps in $sum with the caret at the end of the argument', () => {
  const script = '$.payload.LiveStreamCount';
  const token = tokenAround(script, script.length);
  assert.equal(token.text, '$.payload.LiveStreamCount');

  const next = wrapInFunction(script, token, fn('$sum'));
  assert.equal(next.text, '$sum($.payload.LiveStreamCount)');
  // Inside the parentheses, right after `Count` — not past the `)`.
  assert.equal(next.text[next.caret], ')');
  assert.equal(next.text.slice(0, next.caret), '$sum($.payload.LiveStreamCount');
});

// The caret lands *inside* the parentheses, so an operator continues the argument —
// `$sum(a + b)`, which is what you want after wrapping a count. Appending outside the call
// would need the caret past the `)`, and putting it there would make the far more common case
// (a second argument) require navigating back in.
test('and then an operator continues the argument', () => {
  const wrapped = '$sum($.payload.LiveStreamCount)';
  const inside = wrapped.length - 1;
  const after = appendOperator(wrapped, inside, '+');
  assert.equal(after.text, '$sum($.payload.LiveStreamCount + )');
  assert.equal(after.text.slice(after.caret), ')');
});

test('an operator after the closing paren extends the whole expression', () => {
  const after = appendOperator('$sum($.a)', 9, '*');
  assert.equal(after.text, '$sum($.a) * ');
});

/* ── Type resolution, which is what filters the palette ───────────────────── */

const PAYLOAD = { LiveStreamCount: 12, title: 'Pump', tags: [1, 2], when: '2026-08-17T10:00:00Z' };
const CONTEXT = { state: { locked: false, rows: [{ n: 1 }] } };

test('a document path resolves against the payload', () => {
  assert.equal(resolveType('$.LiveStreamCount', PAYLOAD, CONTEXT), 'number');
  assert.equal(resolveType('$.title', PAYLOAD, CONTEXT), 'string');
  assert.equal(resolveType('$.tags', PAYLOAD, CONTEXT), 'array');
});

test('a binding path resolves against the context', () => {
  assert.equal(resolveType('$state.locked', PAYLOAD, CONTEXT), 'boolean');
  assert.equal(resolveType('$state', PAYLOAD, CONTEXT), 'object');
});

test('array indices are followed', () => {
  assert.equal(resolveType('$state.rows[0].n', PAYLOAD, CONTEXT), 'number');
});

// `$toMillis` is what you want on a timestamp, and it is not what a plain string offers.
test('an ISO timestamp is a date', () => {
  assert.equal(resolveType('$.when', PAYLOAD, CONTEXT), 'date');
  assert.equal(typeOf('2026-08-17T10:00:00Z'), 'date');
  assert.equal(typeOf('Pump'), 'string');
});

test('literals are typed too, since typing one is a normal way to start', () => {
  assert.equal(resolveType('42', PAYLOAD, CONTEXT), 'number');
  assert.equal(resolveType('"x"', PAYLOAD, CONTEXT), 'string');
  assert.equal(resolveType('true', PAYLOAD, CONTEXT), 'boolean');
});

// A wrong subset is worse than no filter: `unknown` offers everything.
test('an unresolvable path reports unknown and offers the whole catalogue', () => {
  assert.equal(resolveType('$.nope.deeper', PAYLOAD, CONTEXT), 'unknown');
  assert.equal(paletteFor('unknown').functions.length, FUNCTIONS.length);
});

/* ── What each type offers ────────────────────────────────────────────────── */

test('a number offers numeric functions and arithmetic', () => {
  const p = paletteFor('number');
  assert.ok(p.functions.some((f) => f.name === '$round'));
  assert.ok(!p.functions.some((f) => f.name === '$uppercase'));
  assert.deepEqual(p.operators.slice(0, 3).map((o) => o.op), ['+', '-', '*']);
});

// `&` is concatenation in JSONata; offering `+` would teach the wrong thing.
test('a string offers concatenation, never +', () => {
  const ops = paletteFor('string').operators.map((o) => o.op);
  assert.ok(ops.includes('&'));
  assert.ok(!ops.includes('+'));
});

// An ISO string is still a string, and `$substringBefore` is how you take the date off one.
test('a date keeps the string functions as well as its own', () => {
  const names = paletteFor('date').functions.map((f) => f.name);
  assert.ok(names.includes('$toMillis'));
  assert.ok(names.includes('$substringBefore'));
});

// JSONata's aggregations map over paths, so an array is the normal subject of $sum.
test('an array offers aggregation and numeric functions', () => {
  const names = paletteFor('array').functions.map((f) => f.name);
  assert.ok(names.includes('$sum'));
  assert.ok(names.includes('$filter'));
});

test('casts and tests are offered whatever the type', () => {
  for (const type of ['number', 'string', 'boolean', 'array', 'object'] as const) {
    const names = paletteFor(type).functions.map((f) => f.name);
    assert.ok(names.includes('$exists'), type);
    assert.ok(names.includes('$string'), type);
  }
});

/* ── The token under the cursor ───────────────────────────────────────────── */

// `$sum(x) + y` with the caret at the end must pick up `y`, not the whole line.
test('operators and parentheses end the token', () => {
  const script = '$sum($.a) + $.b';
  assert.equal(tokenAround(script, script.length).text, '$.b');
  assert.equal(tokenAround(script, 8).text, '$.a');
});

test('an empty script yields an empty token rather than throwing', () => {
  assert.equal(tokenAround('', 0).text, '');
  const next = wrapInFunction('', { start: 0, end: 0 }, fn('$now'));
  assert.equal(next.text, '$now()');
});

/* ── Wrapping details ─────────────────────────────────────────────────────── */

// `$power(x)` is not valid; the comma prompts for the argument the signature requires.
test('a multi-argument function prompts for the rest', () => {
  const next = wrapInFunction('$.a', { start: 0, end: 3 }, fn('$power'));
  assert.equal(next.text, '$power($.a, )');
  assert.equal(next.caret, next.text.length - 1);
});

// `$round(x)` is valid on its own, so no comma is forced.
test('an optional second argument is not forced', () => {
  assert.equal(wrapInFunction('$.a', { start: 0, end: 3 }, fn('$round')).text, '$round($.a)');
});

test('wrapping mid-expression leaves the rest alone', () => {
  const next = wrapInFunction('$.a + $.b', { start: 6, end: 9 }, fn('$abs'));
  assert.equal(next.text, '$.a + $abs($.b)');
});

/* ── Search, for when the type filter is not what you want ────────────────── */

test('a function is findable by name or by what it does', () => {
  assert.ok(findFunctions('upper').some((f) => f.name === '$uppercase'));
  assert.ok(findFunctions('base64').length >= 2);
  // Matching descriptions is what makes intent searchable: the skill describes `$append` as
  // "Concatenate arrays", and the name alone would never surface it.
  assert.ok(findFunctions('concatenate').some((f) => f.name === '$append'));
  assert.ok(findFunctions('regex').some((f) => f.name === '$match'));
});

test('an empty query returns nothing rather than all 64', () => {
  assert.deepEqual(findFunctions('  '), []);
});

/* ── The catalogue itself ─────────────────────────────────────────────────── */

// Generated from the platform's own skills, so a hand-typed list cannot go stale. Asserted by
// content rather than by count: the skills gain functions as the platform does, and a hard total
// would fail on every such update while telling us nothing.
test('the catalogue covers both the standard and the Fuuz libraries', () => {
  for (const name of ['$sum', '$round', '$substringBefore', '$fromMillis', '$reduce', '$sift']) {
    const fn = FUNCTIONS.find((f) => f.name === name);
    assert.equal(fn?.origin, 'jsonata', name);
  }
  for (const name of ['$query', '$mutate', '$cuid', '$executeFlow', '$moment']) {
    const fn = FUNCTIONS.find((f) => f.name === name);
    assert.equal(fn?.origin, 'fuuz', name);
  }
});

// A trigger runs read-only, so offering these would hand over an expression the platform rejects at
// save time — worse than not offering them.
test('the write functions are marked unavailable in triggers', () => {
  for (const name of ['$mutate', '$integrate', '$executeFlow', '$executeTransform']) {
    assert.equal(FUNCTIONS.find((f) => f.name === name)?.notInTriggers, true, name);
  }
  assert.equal(FUNCTIONS.find((f) => f.name === '$query')?.notInTriggers, undefined);
});

test('trigger mode drops them from the palette entirely', () => {
  const names = paletteFor('object', undefined, 'trigger').functions.map((f) => f.name);
  assert.ok(!names.includes('$mutate'));
  assert.ok(paletteFor('object').functions.some((f) => f.name === '$mutate'));
});

// The local engine is stock JSONata, so a Fuuz function cannot be evaluated here — naming them beats
// a bare "unknown function" at the moment you press Run.
test('platform functions in an expression are detected by name', () => {
  assert.deepEqual(platformFunctionsIn('$query({"statement": $.q}) + $sum($.n)'), ['$query']);
  assert.deepEqual(platformFunctionsIn('$sum($.n)'), []);
  assert.deepEqual(platformFunctionsIn('$cuid() & $uuid()'), ['$cuid', '$uuid']);
});

// `$not` is the only negation in JSONata and applies to anything.
test('every function is typed, and casts are universal', () => {
  for (const f of FUNCTIONS) assert.ok(f.applies, f.name);
  assert.equal(fn('$not').applies, 'any');
});

/* ── The inverse: which data suits the function you picked ─────────────────── */

// Advisory, not a lock: JSONata coerces, so `$string(42)` is correct and a hard block would make a
// legitimate expression impossible to write.
test('a string function does not suit a number', () => {
  assert.equal(accepts('string', 'number'), false);
  assert.equal(accepts('string', 'string'), true);
});

test('a cast suits anything, because that is when you reach for one', () => {
  for (const type of ['number', 'string', 'boolean', 'array', 'object', 'null'] as const) {
    assert.equal(accepts('any', type), true, type);
  }
});

// An aggregation over a path of numbers is the normal shape in JSONata.
test('an array function suits a number', () => {
  assert.equal(accepts('array', 'number'), true);
});

// A date *is* a string, in both directions: `$uppercase` applies to one, `$toMillis` takes one.
test('dates and strings suit each other', () => {
  assert.equal(accepts('string', 'date'), true);
  assert.equal(accepts('date', 'string'), true);
});

// An unresolvable value must not be dimmed — we do not know, and dimming would assert we did.
test('an unknown type is never dimmed', () => {
  assert.equal(accepts('number', 'unknown'), true);
});

/* ── Branches stay lit when something inside fits ─────────────────────────── */

// The part that makes dimming usable: `$components` is an object and `$substring` does not apply to
// an object, but the string you want is three levels inside it.
test('a branch containing a match is not dimmed', () => {
  assert.equal(subtreeAccepts({ components: { Form: { title: 'Pump' } } }, 'string'), true);
});

test('a branch containing nothing suitable is dimmed', () => {
  assert.equal(subtreeAccepts({ counts: { a: 1, b: 2 } }, 'string'), false);
});

test('arrays are searched too', () => {
  assert.equal(subtreeAccepts([{ n: 1 }, { s: 'text' }], 'string'), true);
});

test('a leaf is judged on itself', () => {
  assert.equal(subtreeAccepts('Pump', 'string'), true);
  assert.equal(subtreeAccepts(42, 'string'), false);
});

// This runs per row on every keystroke, so it cannot walk an unbounded capture.
test('the search is depth-bounded', () => {
  let deep: unknown = 'found';
  for (let i = 0; i < 20; i += 1) deep = { down: deep };
  assert.equal(subtreeAccepts(deep, 'string'), false);
});

/* ── The type a search hit reports ────────────────────────────────────────── */

// A search hit carries only its preview, so the dimming in search results is judged on that. The
// preview is derived from the value, so the two cannot disagree — but the parsing has to be right or
// the filter reads as random.
test('accepts() judges every type a preview can express', () => {
  assert.equal(accepts('string', typeOf('Pump')), true);
  assert.equal(accepts('string', typeOf(12)), false);
  assert.equal(accepts('number', typeOf(12)), true);
  assert.equal(accepts('array', typeOf([1])), true);
  assert.equal(accepts('object', typeOf({ a: 1 })), true);
  assert.equal(accepts('boolean', typeOf(false)), true);
});
