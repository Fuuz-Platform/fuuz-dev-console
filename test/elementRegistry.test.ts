/**
 * The element registry, and the editability rules built on it.
 *
 * Values here come from the `fuuz-screen-elements` skill as extracted by
 * `scripts/extract-elements.mjs`; the script's `--check` mode guards drift.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  documentedTypes, editability, elementDoc, fieldTypeMeaning, functionsFor, isDocumented,
  propDoc, propsFor, registryStats, stateFor, transformablePropsFor,
} from '../src/core/elementRegistry';
import { copyablePropPaths } from '../src/core/transformableProps';

/* ── Coverage ────────────────────────────────────────────────────────────── */

test('the registry carries the whole skill, not a sample', () => {
  const s = registryStats();
  assert.ok(s.elements >= 40, `only ${s.elements} elements`);
  assert.ok(s.props >= 400, `only ${s.props} props`);
  assert.ok(s.functions >= 70, `only ${s.functions} functions`);
  assert.ok(documentedTypes().includes('ActionButton'));
});

test('resolvedName comes from the skill, not from mangling a display name', () => {
  // "Tabs" resolves to `TabBar` and "Text" to `RichText`, which no amount of
  // punctuation-stripping on the display name would ever produce.
  assert.equal(elementDoc('TabBar')?.display, 'Tabs');
  assert.equal(elementDoc('RichText')?.display, 'Text');
  assert.equal(elementDoc('ScreenAccordion')?.display, 'Accordion');
});

/* ── Props ───────────────────────────────────────────────────────────────── */

test('props carry their type and description', () => {
  const label = propDoc('ActionButton', 'label');
  assert.equal(label?.type, 'text');
  assert.equal(label?.description, 'Button label');
  assert.equal(label?.section, 'Basic');
});

test('a documented default is separated from the description', () => {
  // The skill writes "Visibility (default: `true`)" in one cell.
  const visible = propDoc('ActionButton', 'visible');
  assert.equal(visible?.default, 'true');
  assert.doesNotMatch(visible?.description ?? '', /default:/);
});

test('inputs inherit the shared field sets they never list themselves', () => {
  const props = propsFor('TextInput').map((p) => p.name);
  assert.ok(props.includes('defaultValue'), 'shared input fields are missing');
  assert.ok(props.includes('disabled'));
});

test('data-bound elements inherit the shared data fields', () => {
  assert.ok(propsFor('Table').map((p) => p.name).includes('query.parameters'));
});

test('transformable props are those the designer gives a JSONata editor', () => {
  assert.ok(transformablePropsFor('ActionButton').includes('disabled'));
  assert.ok(transformablePropsFor('EmbeddedWebpage').includes('url'));
  assert.ok(transformablePropsFor('FlowButton').includes('flowInput'));
});

// Reporting "no transformable props" for a type we never read would be inventing
// a fact — unknown and none must stay distinguishable.
test('an undocumented type is unknown, not empty', () => {
  assert.equal(isDocumented('SomeElementWeHaveNeverSeen'), false);
  assert.deepEqual(transformablePropsFor('SomeElementWeHaveNeverSeen'), []);
  assert.equal(elementDoc('SomeElementWeHaveNeverSeen'), undefined);
});

test('the field-type glossary explains what a type means', () => {
  assert.match(fieldTypeMeaning('transform') ?? '', /JSONata/);
  assert.ok(fieldTypeMeaning('switch'));
});

/* ── The fn bag ──────────────────────────────────────────────────────────── */

test('elements expose the functions the skill documents', () => {
  const form = functionsFor('Form').map((f) => f.name);
  assert.ok(form.includes('setValue'));
  assert.ok(form.includes('validate'));
  assert.equal(functionsFor('Form').find((f) => f.name === 'setValue')?.signature, 'setValue(path, value)');
  assert.ok(stateFor('Form').map((s) => s.name).includes('dirty'));
});

/* ── Editability ─────────────────────────────────────────────────────────── */

test('a field with a documented setter is a real change', () => {
  const e = editability('Form', 'data.title');
  assert.equal(e.tier, 'runtime');
  assert.match(e.call ?? '', /setValue/);
});

test('a computed prop with no setter is preview only', () => {
  assert.equal(editability('ActionButton', 'disabled').tier, 'preview');
});

// A control that silently does nothing is worse than one disabled with a reason.
test('props needing a query or flow re-run cannot be applied at all', () => {
  for (const prop of ['query.parameters', 'optionQuery', 'validation.transform', 'flowInput', 'columnsTransform']) {
    const e = editability('Table', prop);
    assert.equal(e.tier, 'none', prop);
    assert.match(e.reason, /re-run/);
  }
});

test('an unknown element type admits it rather than promising a setter', () => {
  const e = editability('SomeElementWeHaveNeverSeen', 'label');
  assert.equal(e.tier, 'preview');
  assert.match(e.reason, /No documentation/);
});

/* ── Which props offer a copyable transform path ──────────────────────────── */

// A button on all 484 documented props made the handful that matter impossible to
// spot, which is the opposite of an affordance.
test('a transformable prop on an element with functions offers its path', () => {
  const fnElement = documentedTypes().find(
    (name) => functionsFor(name).length > 0 && transformablePropsFor(name).length > 0
  );
  assert.ok(fnElement, 'expected at least one element with both functions and transformable props');
  const paths = copyablePropPaths(fnElement);
  assert.ok(paths.size > 0);
  // Every offered path is one the designer accepts a transform on.
  for (const p of paths) assert.ok(transformablePropsFor(fnElement).includes(p), p);
});

test('an element with no functions offers nothing on documentation alone', () => {
  const noFns = documentedTypes().find(
    (name) => functionsFor(name).length === 0 && transformablePropsFor(name).length > 0
  );
  if (!noFns) return;   // the registry may legitimately have none
  assert.equal(copyablePropPaths(noFns).size, 0);
});

// The authored design is direct evidence that a prop takes a transform, and it
// outranks the documentation — including for an element we know nothing about.
test('a prop this screen actually transforms is always offered', () => {
  assert.deepEqual([...copyablePropPaths('NoSuchElement', ['url'])], ['url']);
});

test('an unknown element with no authored transforms offers nothing', () => {
  assert.equal(copyablePropPaths('NoSuchElement').size, 0);
});
