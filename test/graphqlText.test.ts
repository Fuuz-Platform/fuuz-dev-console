/**
 * Deciding whether a document writes.
 *
 * This gates a mutation against a live tenant, so a false negative is the failure
 * that matters — and "undecided" is not a safe state, which is why this is lexical
 * rather than a parser that would reject half-typed input.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMutation, operationName, stripNonCode } from '../src/core/graphqlText';

test('a mutation is a write', () => {
  assert.equal(isMutation('mutation { updateAsset(id: 1) { id } }'), true);
  assert.equal(isMutation('mutation Named($x: ID!) { d(id: $x) { id } }'), true);
});

test('a query is not', () => {
  assert.equal(isMutation('query { assetCollection { id } }'), false);
  assert.equal(isMutation('{ assetCollection { id } }'), false);
});

// A subscription opens a long-lived stream against a tenant this console is only
// meant to inspect.
test('a subscription counts as a write', () => {
  assert.equal(isMutation('subscription { assetChanged { id } }'), true);
});

test('the word inside a string or a comment is not an operation', () => {
  assert.equal(isMutation('query { search(term: "mutation") { id } }'), false);
  assert.equal(isMutation('# mutation, later\nquery { a { id } }'), false);
  assert.equal(isMutation('query { a(note: """a mutation""") { id } }'), false);
});

test('a field merely containing the word is not an operation', () => {
  assert.equal(isMutation('query { mutationCount }'), false);
});

test('strings and comments are stripped, code is not', () => {
  assert.equal(stripNonCode('query { a(b: "c") } # note').trim(), 'query { a(b: "") }');
});

test('the operation name is read where there is one', () => {
  assert.equal(operationName('query AssetRows { a }'), 'AssetRows');
  assert.equal(operationName('{ a }'), undefined);
});
