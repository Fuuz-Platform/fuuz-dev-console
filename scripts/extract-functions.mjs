/**
 * Generate the JSONata function catalogue from the platform's own skill.
 *
 * The alternative was a hand-typed list of 64 functions, which would be wrong the moment the
 * platform's JSONata version moved and wrong in a way nobody would notice — a palette that
 * offers a function the runtime does not have is worse than no palette.
 *
 * `--check` fails the build if the generated file has drifted from the skill, the same guard
 * `extract-elements.mjs` uses for the element registry.
 */
import * as fs from 'fs';
import * as path from 'path';

const SKILLS = [
  { file: '../vsCodeFuuzExtension/resources/skills/fuuz-expressions/functions-builtin.md', origin: 'jsonata' },
  { file: '../vsCodeFuuzExtension/resources/skills/fuuz-expressions/functions-platform.md', origin: 'fuuz' },
];
const OUT = 'src/core/data/jsonataFunctions.json';

/**
 * Section heading → the type its functions operate on.
 *
 * This mapping is the whole value of the catalogue: it is what lets the palette offer `$sum`
 * when the cursor holds a number and not when it holds a string.
 */
const SECTION_TYPE = {
  // Standard JSONata.
  'String Functions': 'string',
  'Numeric Functions': 'number',
  'Aggregation Functions': 'array',
  'Boolean Functions': 'boolean',
  'Array Functions': 'array',
  'Object Functions': 'object',
  'Date/Time Functions': 'date',
  'Higher-Order Functions': 'array',

  /*
   * Fuuz's own library, by what its first argument holds.
   *
   * Semver, XML, EDI and encryption all take strings; joins and parallel execution take arrays;
   * moment, calendars and scheduling take dates. Getting these right is what makes the palette
   * useful — `$semverGt` offered on a number would be noise, and absent on a version string would
   * be a miss.
   */
  'Core -- General Utility': 'any',
  'Core -- Type Predicates': 'any',
  'Core -- Conversion': 'any',
  'Core -- String': 'string',
  'Core -- Rich Text / Markdown': 'string',
  'Core -- Object': 'object',
  'Core -- Array': 'array',
  'Core -- Parallel Execution': 'array',
  'Core -- Predicate Filters': 'array',
  'Core -- Schema Validation': 'object',
  'Core -- Tree': 'object',
  Semver: 'string',
  Joins: 'array',
  'Moment.js': 'date',
  XML: 'string',
  EDI: 'string',
  Encryption: 'string',
  Network: 'any',
  Calendars: 'date',
  Scheduling: 'date',
  'Unit Conversion': 'number',
  'MFGx Application Functions': 'any',
};

/**
 * Functions a **model trigger** may not call.
 *
 * From the `fuuz-data-model` skill: triggers run in read-only mode. Offering `$mutate` in trigger
 * mode would hand someone an expression the platform rejects at save time, which is a worse outcome
 * than not offering it — so the catalogue carries the restriction and the palette filters on it.
 */
const NOT_IN_TRIGGERS = new Set([
  '$mutate', '$integrate', '$executeTransform', '$executeFlow', '$aggregate',
  '$executeDataMapping', '$executeDeviceFunction', '$executeDeviceGatewayFunction', '$document',
]);

/** Casts and tests apply to anything, which is exactly when you reach for them. */
const UNIVERSAL = new Set(['$string', '$number', '$boolean', '$type', '$exists', '$not', '$count', '$length']);

function extract(markdown, origin, seen) {
  const out = [];
  let section = null;

  for (const line of markdown.split('\n')) {
    // `##` and `###` alike: the platform file uses both, and a `###` example block under a section
    // must not be read as a new section with no type mapping.
    // Both count styles: `## String Functions (21)` and `## Semver (28 functions)`.
    const heading = /^##\s+(.*?)\s*(\(\d+(?:\s*functions?)?\))?\s*$/.exec(line);
    if (heading) { section = heading[1].trim(); continue; }

    const row = /^\|\s*`\$(\w+)\(([^`]*)\)`\s*\|\s*(.*?)\s*\|\s*$/.exec(line);
    if (!row || !SECTION_TYPE[section]) continue;

    const [, name, args, description] = row;
    // `$sift` is documented twice — under Object and again under Higher-Order — and one entry
    // is enough.
    if (seen.has(name)) continue;
    seen.add(name);

    out.push({
      name: `$${name}`,
      signature: `$${name}(${args.trim()})`,
      arity: args.trim() ? args.split(',').filter((a) => a.trim()).length : 0,
      applies: UNIVERSAL.has(`$${name}`) ? 'any' : SECTION_TYPE[section],
      section: section.replace(' Functions', '').replace('Core -- ', ''),
      description: description.replace(/\*\*|`/g, '').slice(0, 180),
      /*
       * Where it can run.
       *
       * `jsonata` functions evaluate in this panel's bundled engine; `fuuz` ones exist only on the
       * platform, so the local runner will reject them. Marking it is the difference between a
       * useful warning and a baffling "unknown function" at the moment you press Run.
       */
      origin,
      ...(NOT_IN_TRIGGERS.has(`$${name}`) ? { notInTriggers: true } : {}),
    });
  }
  return out;
}

if (!SKILLS.some(({ file }) => fs.existsSync(path.resolve(file)))) {
  console.error('[functions] skills not found — catalogue left unchanged');
  process.exit(process.argv.includes('--check') ? 0 : 1);
}

const functions = [];
const seen = new Set();
for (const { file, origin } of SKILLS) {
  const path2 = path.resolve(file);
  if (!fs.existsSync(path2)) continue;
  // Built-ins first, so a name documented in both keeps the standard definition — the platform file
  // re-documents a few, and the JSONata semantics are the ones that hold.
  functions.push(...extract(fs.readFileSync(path2, 'utf8'), origin, seen));
}
const json = `${JSON.stringify(functions, null, 2)}\n`;

if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (current !== json) {
    console.error('[functions] catalogue has drifted from the skill — run: node scripts/extract-functions.mjs');
    process.exit(1);
  }
  const platform = functions.filter((f) => f.origin === 'fuuz').length;
  console.log(`catalogue matches the skills — ${functions.length} functions ·`,
    `${functions.length - platform} JSONata, ${platform} Fuuz ·`,
    `${functions.filter((f) => f.notInTriggers).length} unavailable in triggers`);
} else {
  fs.writeFileSync(OUT, json);
  console.log(`[functions] wrote ${functions.length} functions to ${OUT}`);
}
