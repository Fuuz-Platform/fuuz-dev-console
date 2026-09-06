/**
 * The runtime↔design join.
 *
 * Fixtures are real pushed screens from `business-systems/cpq/.../seed/screens`,
 * not hand-written shapes — including `assetSetupTable`, which contains a
 * genuinely ambiguous pair (two TableColumns sharing one cacheKey *and* one
 * transform). That ambiguity is the interesting case: the join must decline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  indexScreenDesign, attributeEntry, applyDesign, designCoverage,
  normalizeTransform, compareVersions, namesMatch,
} from '../src/core/designJoin';
import type { LogEntry } from '../src/core/types';

const fixture = (name: string): unknown => {
  const path = [
    join(__dirname, 'fixtures', name),
    join(__dirname, '..', '..', 'test', 'fixtures', name),
  ].find(existsSync);
  return JSON.parse(readFileSync(path!, 'utf8'));
};

const PLAYER = indexScreenDesign(fixture('screenDesign.assetPlayerDialog.json'));
const TABLE = indexScreenDesign(fixture('screenDesign.assetSetupTable.json'));

/** A minimal entry shaped the way `classify` emits one. */
const entryFor = (opts: {
  write: string; property: string; transform?: string; cacheKey?: string; seq?: number;
}): LogEntry => ({
  id: `e${opts.seq ?? 1}`, seq: opts.seq ?? 1, ts: '10:24:31.000', epoch: 1,
  kind: 'debug', title: `Transform Debugging · ${opts.property}`, dur: '1ms',
  write: opts.write, reads: [], level: 'debug', after: 'x',
  expr: opts.transform,
  payload: ['Transform Debugging: ', {
    expression: opts.transform,
    trace: {
      property: opts.property,
      dynamicProps: { [opts.property]: { info: { __transform: opts.transform, __cacheKey: opts.cacheKey ?? '' } } },
    },
  }],
});

/* ── Indexing ────────────────────────────────────────────────────────────── */

test('indexScreenDesign: finds craft nodes inside design.components[].props.design', () => {
  assert.equal(PLAYER.screenName, 'Asset Player Dialog');
  assert.equal(PLAYER.version, '0.0.2');
  const url = PLAYER.props.find(p => p.property === 'url');
  assert.ok(url, 'url dynamic prop missing');
  assert.equal(url!.elementName, 'AssetPlayer');
  assert.equal(url!.elementType, 'EmbeddedWebpage');
  assert.equal(url!.cacheKey, 'playerUrl');
});

test('indexScreenDesign: maps every element name to its type', () => {
  assert.equal(TABLE.elementTypes.get('AssetTable'), 'Table');
  assert.ok(TABLE.props.some(p => p.elementType === 'ActionButton' && p.property === 'disabled'));
});

test('indexScreenDesign: an empty cacheKey is not indexed as a key', () => {
  assert.ok(!PLAYER.byCacheKey.has(''), 'empty cacheKey should not be a join key');
  assert.ok(TABLE.props.some(p => p.cacheKey === undefined), 'expected some unnamed transforms');
});

test('normalizeTransform: whitespace differences do not break the join', () => {
  assert.equal(normalizeTransform('(\n  $a := 1;\n  $a\n)'), '( $a := 1; $a )');
});

/* ── Attribution — the point of the join ─────────────────────────────────── */

test('attributeEntry: resolves the owner the RUNTIME could not, via cacheKey', () => {
  // This is the `(computed).url` case: the runtime logs `property: "url"` with
  // no component, and the design says it belongs to AssetPlayer.
  const { prop, via } = attributeEntry(
    entryFor({ write: '(computed).url', property: 'url', cacheKey: 'playerUrl' }),
    PLAYER
  );
  assert.equal(via, 'cacheKey');
  assert.equal(prop?.elementName, 'AssetPlayer');
  assert.equal(prop?.elementType, 'EmbeddedWebpage');
});

test('attributeEntry: resolves by exact transform text when the cacheKey is empty', () => {
  const design = PLAYER.props.find(p => p.property === 'url')!;
  const { prop, via } = attributeEntry(
    entryFor({ write: '(computed).url', property: 'url', transform: design.transform }),
    PLAYER
  );
  assert.equal(via, 'transform');
  assert.equal(prop?.elementName, 'AssetPlayer');
});

test('attributeEntry: an ambiguous design declines rather than guessing', () => {
  // assetSetupTable has TWO TableColumns sharing cacheKey "shareUrlLink" and the
  // same transform. Picking either would be a lie.
  const shared = TABLE.byCacheKey.get('shareUrlLink');
  assert.ok(shared && shared.length > 1, 'fixture no longer contains the ambiguous pair');
  const { prop, via } = attributeEntry(
    entryFor({ write: '(computed).linkTarget', property: 'linkTarget', cacheKey: 'shareUrlLink' }),
    TABLE
  );
  assert.equal(via, 'ambiguous');
  assert.equal(prop, undefined);
});

test('attributeEntry: a runtime-named component keeps its name and gains its type', () => {
  const { prop, via } = attributeEntry(
    entryFor({ write: 'components.AssetPlayer.url', property: 'url', cacheKey: 'playerUrl' }),
    PLAYER
  );
  assert.equal(via, 'runtime');
  assert.equal(prop?.elementType, 'EmbeddedWebpage');
});

test('attributeEntry: an unknown transform is reported unknown, not attached anywhere', () => {
  const { prop, via } = attributeEntry(
    entryFor({ write: '(computed).nothingLikeThis', property: 'nothingLikeThis', transform: '$foo' }),
    PLAYER
  );
  assert.equal(via, 'unknown');
  assert.equal(prop, undefined);
});

/* ── applyDesign ─────────────────────────────────────────────────────────── */

test('applyDesign: re-points (computed) writes at their real element', () => {
  const [out] = applyDesign([entryFor({ write: '(computed).url', property: 'url', cacheKey: 'playerUrl' })], PLAYER);
  assert.equal(out.write, 'components.AssetPlayer.url');
  assert.equal(out.elementType, 'EmbeddedWebpage');
  assert.equal(out.cacheKey, 'playerUrl');
  assert.equal(out.attribution, 'cacheKey');
});

test('applyDesign: stamps the element identity, not only the dot path', () => {
  // `write` encodes the owner, but a consumer asking "which element produced this"
  // should not have to parse it — and only the node id survives a rename.
  const [out] = applyDesign([entryFor({ write: '(computed).url', property: 'url', cacheKey: 'playerUrl' })], PLAYER);
  assert.equal(out.elementName, 'AssetPlayer');
  assert.equal(out.property, 'url');
  assert.equal(out.nodeId, PLAYER.props.find((p) => p.property === 'url')!.nodeId);
  assert.ok(out.nodeId, 'the design fixture carries a craft node id');
});

test('applyDesign: leaves an ambiguous entry where it was, flagged', () => {
  const input = entryFor({ write: '(computed).linkTarget', property: 'linkTarget', cacheKey: 'shareUrlLink' });
  const [out] = applyDesign([input], TABLE);
  assert.equal(out.write, '(computed).linkTarget', 'must not be re-pointed');
  assert.equal(out.attribution, 'ambiguous');
});

test('applyDesign: entries that write nothing pass through untouched', () => {
  const plain: LogEntry = { ...entryFor({ write: '', property: 'x' }), write: '' };
  assert.deepEqual(applyDesign([plain], PLAYER)[0], plain);
});

/* ── Coverage ────────────────────────────────────────────────────────────── */

test('designCoverage: reports which declared dynamic props never ran', () => {
  const cov = designCoverage([entryFor({ write: '(computed).url', property: 'url', cacheKey: 'playerUrl' })], PLAYER);
  assert.equal(cov.total, PLAYER.props.length);
  assert.equal(cov.exercised, 1);
  assert.ok(!cov.unexercised.some(u => u.property === 'url'), 'url ran, so it must not be listed');
});

test('designCoverage: nothing captured means nothing exercised', () => {
  const cov = designCoverage([], TABLE);
  assert.equal(cov.exercised, 0);
  assert.equal(cov.unexercised.length, TABLE.props.length);
  // Every entry names an element and a type, so the list is actionable.
  assert.ok(cov.unexercised.every(u => u.elementName && u.elementType && u.property));
});

/* ── Design discovery ────────────────────────────────────────────────────── */

test('compareVersions: compares numerically, so 0.0.27 beats 0.0.7', () => {
  assert.ok(compareVersions('0.0.27', '0.0.7') > 0);
  assert.ok(compareVersions('1.0.0', '0.9.9') > 0);
  assert.equal(compareVersions('0.0.2', '0.0.2'), 0);
});

test('namesMatch: tolerates spacing and case between screen name and design', () => {
  assert.ok(namesMatch('Asset Intake', 'assetintake'));
  assert.ok(namesMatch('Asset Player Dialog', 'Asset-Player-Dialog'));
  assert.ok(!namesMatch('Asset Intake', 'Asset Library Setup'));
  assert.ok(!namesMatch('', 'anything'));
});
