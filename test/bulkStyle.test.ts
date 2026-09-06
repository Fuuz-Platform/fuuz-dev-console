/**
 * Restyling every element of one kind at once.
 *
 * Two things decide whether this is useful or dangerous: offering the *right* properties per
 * element kind (all twenty for every group recreates the problem it solves), and never applying
 * a field the developer left blank — an empty string clears a CSS property, so sending them all
 * would wipe the element's own styling.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEdit, editSize, groupByType, pageRoots, styleFieldsFor } from '../src/core/bulkStyle';
import type { StructureNode } from '../src/core/structure';

const node = (name: string, type: string, children: StructureNode[] = []): StructureNode =>
  ({ nodeId: name, name, type, children, named: true, props: [] } as unknown as StructureNode);

const SCREEN = [
  node('IntakePage', 'Container', [
    node('Header', 'Container', [node('Title', 'Text')]),
    node('SaveButton', 'ActionButton'),
    node('CancelButton', 'ActionButton'),
    node('TitleField', 'TextInput'),
  ]),
  node('ReviewPage', 'Container', [node('DoneButton', 'ActionButton')]),
];

/* ── Which properties make sense per kind ─────────────────────────────────── */

// A button has an icon and a label; a container has neither.
test('a button gets text and icon fields, a container gets layout', () => {
  const button = styleFieldsFor('ActionButton').map((f) => f.css);
  assert.ok(button.includes('font-size'));
  assert.ok(button.includes('svg:font-size'));
  assert.ok(!button.includes('gap'));

  const container = styleFieldsFor('Container').map((f) => f.css);
  assert.ok(container.includes('gap'));
  assert.ok(!container.includes('svg:font-size'));
});

// `font-size` on a button changes its *label*; an icon sizes from its own element.
test('icon size is a descendant field, not the element’s own font size', () => {
  const icon = styleFieldsFor('ActionButton').find((f) => f.css === 'svg:font-size');
  assert.equal(icon?.label, 'Icon size');
});

test('every kind offers corner radius, which is the common bulk edit', () => {
  for (const type of ['ActionButton', 'TextInput', 'Container', 'Table']) {
    assert.ok(styleFieldsFor(type).some((f) => f.css === 'border-radius'), type);
  }
});

// We cannot claim an undocumented element has no font, and offering nothing makes the group
// useless — so the safe superset.
test('an unknown type gets box and text rather than nothing', () => {
  const fields = styleFieldsFor('SomeNewElement').map((f) => f.css);
  assert.ok(fields.includes('width'));
  assert.ok(fields.includes('color'));
});

/* ── Grouping ─────────────────────────────────────────────────────────────── */

// Biggest groups first — that is where a bulk edit pays off — with ties broken alphabetically so
// the order is stable between renders rather than depending on tree traversal.
test('elements group by type, largest group first', () => {
  const groups = groupByType(undefined, SCREEN);
  assert.deepEqual(groups.map((g) => `${g.type}×${g.elements.length}`),
    ['ActionButton×3', 'Container×3', 'Text×1', 'TextInput×1']);
});

test('a bigger group outranks a smaller one regardless of name', () => {
  const skewed = [node('A', 'Zebra'), node('B', 'Zebra'), node('C', 'Alpha')];
  assert.deepEqual(groupByType(undefined, skewed).map((g) => g.type), ['Zebra', 'Alpha']);
});

// "All the buttons" usually means all the buttons *on this page*.
test('scoping to a page narrows the group', () => {
  const page = SCREEN[0];
  const groups = groupByType(page, SCREEN);
  assert.equal(groups.find((g) => g.type === 'ActionButton')?.elements.length, 2);
});

test('nested elements are found, not just direct children', () => {
  const groups = groupByType(SCREEN[0], SCREEN);
  assert.ok(groups.some((g) => g.type === 'Text'));
});

// An unnamed element cannot be located, so applying to it would silently do nothing and inflate
// the count.
test('unnamed and untyped elements are skipped', () => {
  const messy = [node('', 'ActionButton'), node('Real', 'ActionButton'), node('Odd', 'Unknown')];
  const groups = groupByType(undefined, messy);
  assert.deepEqual(groups.map((g) => g.type), ['ActionButton']);
  assert.equal(groups[0].elements.length, 1);
});

test('the page list is the screen’s own containers', () => {
  assert.deepEqual(pageRoots(SCREEN).map((r) => r.name), ['IntakePage', 'ReviewPage']);
});

test('a screen with no top-level container still offers a root', () => {
  assert.equal(pageRoots([node('Solo', 'ActionButton')]).length, 1);
});

/* ── Building the edit ────────────────────────────────────────────────────── */

const FIELDS = styleFieldsFor('ActionButton');

// The one that matters: an empty string clears a property, so blank fields must never be sent.
test('only filled fields are applied', () => {
  const edit = buildEdit(FIELDS, { 'border-radius': '6px', height: '', color: '  ' });
  assert.deepEqual(edit.own, { 'border-radius': '6px' });
  assert.equal(editSize(edit), 1);
});

test('descendant fields are separated from the element’s own', () => {
  const edit = buildEdit(FIELDS, { height: '32px', 'svg:font-size': '18px' });
  assert.deepEqual(edit.own, { height: '32px' });
  assert.deepEqual(edit.descendant, [{ selector: 'svg', css: { 'font-size': '18px' } }]);
  assert.equal(editSize(edit), 2);
});

test('several descendant properties share one selector', () => {
  const edit = buildEdit(FIELDS, { 'svg:font-size': '18px', 'svg:color': '#fff' });
  assert.equal(edit.descendant.length, 1);
  assert.equal(Object.keys(edit.descendant[0].css).length, 2);
});

test('an empty form produces an empty edit, so Apply can be refused', () => {
  assert.equal(editSize(buildEdit(FIELDS, {})), 0);
});

// A value for a property this kind does not offer must not sneak through.
test('a value for an unoffered field is ignored', () => {
  const edit = buildEdit(styleFieldsFor('Container'), { 'svg:font-size': '18px' });
  assert.equal(editSize(edit), 0);
});
