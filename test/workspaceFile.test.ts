/**
 * Saving and reopening a script or query.
 *
 * A saved script without its inputs is not reusable — you reopen it and reconstruct the
 * very payload that made it work. So a bundle carries everything, while a plain
 * `.js`/`.graphql` file still has to open, because people already have those.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkspaceFile, serializeWorkspace, suggestedName } from '../src/core/workspaceFile';

const SCRIPT = {
  kind: 'script' as const, language: 'javascript' as const,
  script: 'return payload.a;', payload: '{"a":1}', context: '{"state":{}}',
};

test('a script workspace round-trips with its inputs', () => {
  const parsed = parseWorkspaceFile(serializeWorkspace(SCRIPT), 'script');
  assert.equal(parsed.kind, 'workspace');
  assert.deepEqual(parsed.kind === 'workspace' ? parsed.workspace : undefined, SCRIPT);
});

test('a graphql workspace round-trips with its variables', () => {
  const w = { kind: 'graphql' as const, service: 'system', query: 'query A { a }', variables: '{"x":1}' };
  const parsed = parseWorkspaceFile(serializeWorkspace(w), 'graphql');
  assert.deepEqual(parsed.kind === 'workspace' ? parsed.workspace : undefined, w);
});

/* ── Plain files, which must still open ───────────────────────────────────── */

test('a plain script file opens as text', () => {
  const parsed = parseWorkspaceFile('$state.orderId', 'script');
  assert.deepEqual(parsed, { kind: 'text', text: '$state.orderId' });
});

test('a plain graphql file opens as text', () => {
  const parsed = parseWorkspaceFile('query { assetCollection { id } }', 'graphql');
  assert.equal(parsed.kind, 'text');
});

// Guessing wrong here costs nothing; refusing costs the file.
test('JSON that is not ours opens as text rather than being rejected', () => {
  const parsed = parseWorkspaceFile('{"a":1}', 'script');
  assert.deepEqual(parsed, { kind: 'text', text: '{"a":1}' });
});

// Loading a query into the script editor would report a syntax error from the wrong
// language, which is far more confusing than being told to use the other tab.
test('a bundle of the wrong kind is refused, and says which tab', () => {
  const saved = serializeWorkspace({ kind: 'graphql', service: 'system', query: 'query{a}', variables: '{}' });
  const parsed = parseWorkspaceFile(saved, 'script');
  assert.equal(parsed.kind, 'error');
  assert.match(parsed.kind === 'error' ? parsed.error : '', /GraphQL tab/);
});

test('an empty file is an error, not an empty script', () => {
  assert.equal(parseWorkspaceFile('   ', 'script').kind, 'error');
});

test('a truncated bundle degrades to text instead of throwing', () => {
  assert.doesNotThrow(() => parseWorkspaceFile('{"fuuz-dev-console": 1, "kind"', 'script'));
  assert.equal(parseWorkspaceFile('{"fuuz-dev-console": 1, "kind"', 'script').kind, 'text');
});

test('missing fields in a bundle get usable defaults', () => {
  const parsed = parseWorkspaceFile('{"fuuz-dev-console":1,"kind":"script"}', 'script');
  const w = parsed.kind === 'workspace' ? parsed.workspace : undefined;
  assert.equal(w?.kind === 'script' ? w.payload : undefined, '{}');
  assert.equal(w?.kind === 'script' ? w.language : undefined, 'jsonata');
});

/* ── Names, so a directory of saved files is navigable ────────────────────── */

test('a named operation names the file', () => {
  assert.equal(suggestedName({ kind: 'graphql', service: 'system', query: 'query AssetRows { a }', variables: '{}' }),
    'assetrows.fuuz.json');
});

test('an anonymous query falls back to its first field', () => {
  assert.equal(suggestedName({ kind: 'graphql', service: 'system', query: '{ assetCollection { id } }', variables: '{}' }),
    'assetcollection.fuuz.json');
});

test('a script is named from its first meaningful line, not a comment', () => {
  assert.equal(suggestedName({ ...SCRIPT, script: '// helper\nreturn payload.a;' }), 'return-payload-a.fuuz.json');
});

test('an empty script still gets a name', () => {
  assert.equal(suggestedName({ ...SCRIPT, script: '' }), 'script.fuuz.json');
});
