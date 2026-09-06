/**
 * Splitting `Name (Label)` as the designer writes it.
 *
 * The DOM locator matches `data-system-name="TicketTableSlot"` exactly, so
 * carrying the label into the name silently breaks highlighting, CSS preview
 * and the property inspector for precisely the elements that have labels.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitNameAndLabel } from '../src/core/elementNames';

test('a plain name is left alone', () => {
  assert.deepEqual(splitNameAndLabel('IntakeFormSlot'), { name: 'IntakeFormSlot' });
  assert.deepEqual(splitNameAndLabel('Screen'), { name: 'Screen' });
});

test('a trailing label is split off', () => {
  assert.deepEqual(splitNameAndLabel('IntakeTitle (Title)'), { name: 'IntakeTitle', label: 'Title' });
});

// The real one, straight off admin.fuuz.app.
test('a label containing parentheses survives intact', () => {
  assert.deepEqual(
    splitNameAndLabel('TicketTableSlot (Upload tickets (diagnostic))'),
    { name: 'TicketTableSlot', label: 'Upload tickets (diagnostic)' }
  );
});

test('several nested groups still resolve to the outermost', () => {
  assert.deepEqual(
    splitNameAndLabel('Thing (a (b) c (d))'),
    { name: 'Thing', label: 'a (b) c (d)' }
  );
});

// Scanning from the end means the *trailing balanced group* wins, even when
// earlier text has a stray opener. `(b)` is balanced, so it is the label and
// the stray `(a` stays part of the name. Not beautiful, but well-defined — and
// the alternative (bail out on any stray opener anywhere) would refuse to split
// perfectly good titles.
test('the trailing balanced group wins over an earlier stray opener', () => {
  assert.deepEqual(splitNameAndLabel('Thing (a (b)'), { name: 'Thing (a', label: 'b' });
});

test('an unbalanced title is returned whole rather than guessed at', () => {
  assert.deepEqual(splitNameAndLabel('Thing )'), { name: 'Thing )' });
  assert.deepEqual(splitNameAndLabel(')'), { name: ')' });
});

// `fn(x)` is one token — a call-looking name must not lose its arguments.
test('a group with no space before it stays part of the name', () => {
  assert.deepEqual(splitNameAndLabel('doThing(x)'), { name: 'doThing(x)' });
});

test('an empty label yields a name and no label', () => {
  assert.deepEqual(splitNameAndLabel('Thing ()'), { name: 'Thing' });
});

test('a title that is only a group is kept whole', () => {
  assert.deepEqual(splitNameAndLabel('(orphan)'), { name: '(orphan)' });
});

test('surrounding whitespace is trimmed from both parts', () => {
  assert.deepEqual(splitNameAndLabel('  Thing   ( Label )  '), { name: 'Thing', label: 'Label' });
});
