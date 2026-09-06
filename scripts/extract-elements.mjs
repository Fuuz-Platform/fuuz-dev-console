/**
 * Build the element registry from the platform's own `fuuz-screen-elements` skill.
 *
 * The skill is the authority on what a Fuuz element is: it names each element's
 * `resolvedName` outright (so no guessing from the display name), types every
 * field — `transform` marking the ones the designer gives a JSONata editor —
 * describes each one, and documents the runtime `fn` bag and exposed state.
 *
 * That last part is what makes live editing honest rather than a DOM poke: a
 * property is really settable only when the element exposes a function for it.
 *
 *   node scripts/extract-elements.mjs [--check]
 *
 * `--check` verifies the committed JSON matches the skill and exits non-zero if
 * not, so the registry can't silently drift from the docs it claims to mirror.
 *
 * Four things the skill does that a naive `##`-split gets wrong, and that this
 * script therefore has to do properly:
 *
 *  - **Elements are not all at one heading depth.** `layout.md`, `data.md` and
 *    `display.md` give each element a `##`; `input.md` and `interaction.md` put
 *    a *category* at `##` and the elements at `###` beneath it. The structural
 *    rule that covers both: an element is any heading whose own lead paragraph
 *    declares a `**resolvedName:**`. A category never does.
 *  - **Two table shapes.** `Field|Type|Description` with the panel section in a
 *    bold line above, and `Field|Type|Section|Description` with the section in a
 *    column. Columns are read from the header row rather than by position.
 *  - **Shared field sets.** Every input cites sets from SKILL.md by name
 *    (`Basic, Display with variant, Validation with number validation`) instead
 *    of repeating ~24 fields; those fields are real and are expanded here, each
 *    tagged with the set (and variant) it came from so an element's own
 *    documentation stays distinguishable from what it inherits.
 *  - **Prose cross-references.** `Table`'s data fields are "Same data fields as
 *    Form (…)" and `Cards` is "Same data sections as Table (…)"; left
 *    unresolved, `Cards` reports zero data props, which reads as "none" when the
 *    truth is "documented elsewhere".
 *
 * The invariant `src/core/elementRegistry.ts` exists to protect applies here
 * too: nothing is invented to fill a gap. An element with no documented
 * functions records `functionsDocumented: false` rather than an empty list that
 * looks like a finding, and a cross-reference we could not resolve is kept with
 * `resolved: false` and reported, not silently dropped.
 */
import * as fs from 'fs';
import * as path from 'path';

const SKILL_DIR = path.resolve(
  process.env.FUUZ_SKILL_DIR ??
    '../vsCodeFuuzExtension/resources/skills/fuuz-screen-elements'
);
const OUT = 'src/core/data/screenElements.json';
const FILES = ['layout.md', 'input.md', 'data.md', 'display.md', 'interaction.md'];

/**
 * SKILL.md is mostly prose, but two of its headings document *families* — field
 * sets shared by every input, and by every data-bound element. Those props are
 * real and belong to elements that never list them individually, so they have to
 * be read; the rest of the file (glossary, categories, concepts) must not be
 * mistaken for element props, hence a whitelist rather than a sweep.
 */
const SHARED_INPUTS = 'Shared Field Sets for Input Elements';
const SHARED_DATA = 'Shared Data Fields';
const FAMILY_HEADINGS = new Set([SHARED_INPUTS, SHARED_DATA]);
const GLOSSARY_HEADING = 'Field Type Glossary';

/** The `###` headings inside an element that name a *kind* of table, not a section. */
const KIND_HEADINGS = new Set(['Sections', 'Exposed Functions', 'Exposed State']);

/** `**resolvedName:** …` and friends are metadata, never a section or a summary. */
const META = /^\*\*(resolvedName|Flags|Shared sets|Requires|Defaults)\s*:/i;

/**
 * A standalone bold line naming the panel section the next table belongs to.
 *
 * Deliberately narrow: the skill also writes bold *sentences* (DateRangeInput's
 * "**Do NOT use `minDate` / `maxDate` …**"), and mistaking one for a section
 * would file every following field under a paragraph of prose.
 */
const SECTION_BOLD = /^\*\*([A-Z][A-Za-z0-9 &/-]{0,40})\*\*$/;

/** `|---|---|` — part of a table, and the one row that carries no cells. */
const SEPARATOR = /^\|[\s:|-]+\|$/;

/** `| a | b | c |` → ['a','b','c']; separator rows return null. */
function tableRow(line) {
  const t = line.trim();
  if (!t.startsWith('|') || !t.endsWith('|')) return null;
  if (SEPARATOR.test(t)) return null;
  return t.slice(1, -1).split('|').map((c) => c.trim());
}

const unTick = (s = '') => s.replace(/^`|`$/g, '').trim();

/** "Inner padding (default: `0`)" → { description, default } */
function splitDefault(text) {
  const m = text.match(/\(default:\s*`([^`]*)`\)\s*$/);
  if (!m) return { description: text.trim(), default: undefined };
  return { description: text.slice(0, m.index).trim(), default: m[1] };
}

/** "fontSize" → "Font size" — for a field the skill names but never describes. */
const humanise = (name) =>
  name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()).toLowerCase()
    .replace(/^./, (c) => c.toUpperCase());

/**
 * Which columns a table has, read from its header row.
 *
 * The skill uses `Field|Type|Description`, `Field|Type|Section|Description`,
 * `Function|Description` and `State|Description`; reading positionally makes the
 * 4-column form file the section name as the description.
 */
function columns(header) {
  const at = (...names) => header.findIndex((h) => names.includes(unTick(h).toLowerCase()));
  const name = at('field', 'function', 'state', 'property');
  return {
    name,
    type: at('type'),
    section: at('section'),
    description: at('description', 'meaning'),
    kind: /^function$/i.test(unTick(header[name] ?? ''))
      ? 'function'
      : /^state$/i.test(unTick(header[name] ?? '')) ? 'state' : 'prop',
  };
}

/**
 * Read one heading's body: its tables, its sections, and the prose that stands
 * in for a table.
 *
 * `kind` starts at 'Sections' because `input.md`'s elements have no `### Sections`
 * heading — their fields sit directly under the element with the section in a
 * column — while the other files announce it.
 */
function scanBlock(lines) {
  const out = {
    summary: '',
    props: [],
    functions: [],
    state: [],
    prose: [],
    sections: [],
    functionsDocumented: false,
    stateDocumented: false,
  };
  let kind = 'Sections';
  let section = '';
  let cols = null;
  let fence = false;
  let sawSummary = false;

  const noteSection = (s) => { if (s && !out.sections.includes(s)) out.sections.push(s); };

  for (const raw of lines) {
    const line = raw.trim();
    if (/^```/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    if (!line) { cols = null; continue; }

    const heading = /^#{3,6}\s+(.*)$/.exec(line);
    if (heading) {
      kind = heading[1].trim();
      // In the per-element files a `###` names the *kind* of table that follows
      // (Sections / Exposed Functions / Exposed State). In SKILL.md's family
      // blocks there is no bold layer, so the `###` is itself the section —
      // "Validation Fields", "Display Fields".
      section = KIND_HEADINGS.has(kind) ? '' : kind;
      noteSection(section);
      if (kind === 'Exposed Functions') out.functionsDocumented = true;
      if (kind === 'Exposed State') out.stateDocumented = true;
      cols = null;
      continue;
    }
    if (META.test(line)) continue;

    const bold = SECTION_BOLD.exec(line);
    if (bold) { section = bold[1].trim(); noteSection(section); cols = null; continue; }

    if (SEPARATOR.test(line)) continue;            // still inside the table
    const cells = tableRow(line);
    if (cells) {
      if (!cols) { cols = columns(cells); continue; }
      if (cols.name < 0 || cols.description < 0) continue;
      const name = unTick(cells[cols.name] ?? '');
      const description = cells[cols.description] ?? '';
      if (!name) continue;
      if (cols.kind === 'function') {
        out.functions.push({ name: name.replace(/\(.*$/, '').trim(), signature: name, description });
      } else if (cols.kind === 'state') {
        out.state.push({ name, description });
      } else {
        const own = cols.section >= 0 ? (cells[cols.section] ?? '').trim() : section;
        const split = splitDefault(description);
        noteSection(own);
        out.props.push({
          name,
          type: cols.type >= 0 ? unTick(cells[cols.type] ?? '') : '',
          description: split.description,
          ...(split.default === undefined ? {} : { default: split.default }),
          ...(own ? { section: own } : {}),
          origin: 'element',
        });
      }
      continue;
    }
    cols = null;
    if (line.startsWith('-') || line.startsWith('>')) continue;

    // The first plain prose line is the element's one-line summary.
    if (!sawSummary) { out.summary = line; sawSummary = true; continue; }

    // "Same data fields as Form (…)", "Combines Form functions (…)" — a table
    // the skill chose to write as a sentence. Recorded here, resolved once every
    // element is known.
    if (/\b(Same|Combines)\b/.test(line)) {
      out.prose.push({ kind, section: section || null, text: line, resolved: false });
    }
  }
  return out;
}

/** Split a file into `##`/`###` headings, each with its lead paragraph and full body. */
function headings(text) {
  const lines = text.split('\n');
  const heads = [];
  let fence = false;
  lines.forEach((raw, i) => {
    if (/^\s*```/.test(raw)) fence = !fence;
    if (fence) return;
    const m = /^(#{2,6})\s+(.*)$/.exec(raw);
    if (m) heads.push({ level: m[1].length, title: m[2].trim(), at: i });
  });
  return heads.map((h, i) => {
    let end = lines.length;
    for (let j = i + 1; j < heads.length; j += 1) {
      if (heads[j].level <= h.level) { end = heads[j].at; break; }
    }
    const leadEnd = i + 1 < heads.length ? Math.min(heads[i + 1].at, end) : end;
    return {
      ...h,
      lead: lines.slice(h.at + 1, leadEnd).join('\n'),
      body: lines.slice(h.at + 1, end),
    };
  });
}

/* ── Shared field sets ───────────────────────────────────────────────────── */

/**
 * The input field sets, with their variants.
 *
 * A set is a `###` inside "Shared Field Sets for Input Elements" — "Basic
 * Fields" → `Basic`. A *variant* is an optional extra an element cites by
 * phrase: a bullet ("**with variant** — adds `variant` (options: …)") or a
 * table introduced by "Validation variant — **with number validation** adds:".
 */
function parseSharedSets(block) {
  const sets = {};
  for (const sub of headings(block.body.join('\n')).filter((h) => h.level === 3)) {
    const name = sub.title.replace(/\s+Fields$/i, '').trim();
    const set = { name, props: [], variants: {} };
    let cols = null;
    let pendingVariant = null;
    let fence = false;

    for (const raw of sub.body) {
      const line = raw.trim();
      if (/^```/.test(line)) { fence = !fence; continue; }
      if (fence) continue;
      if (!line) { cols = null; continue; }

      const bullet = /^-\s+\*\*([^*]+)\*\*\s*—\s*(.*)$/.exec(line);
      if (bullet) {
        const phrase = bullet[1].trim().replace(/^with\s+/i, '');
        const rest = bullet[2];
        const variant = { adds: [], removes: [] };
        // "adds `fontSize` (text)" / "adds `fontSize` but no `variant`"
        const addM = /adds\s+`([^`]+)`(?:\s*\(([^)]*)\))?/.exec(rest);
        if (addM) {
          const paren = (addM[2] ?? '').trim();
          const type = paren.includes(':') ? paren.slice(0, paren.indexOf(':')).trim() : paren;
          const detail = paren.includes(':') ? paren.trim() : '';
          variant.adds.push({
            name: addM[1],
            type,
            description: detail
              ? `${detail.charAt(0).toUpperCase()}${detail.slice(1)}.`
              : `${humanise(addM[1])}.`,
            addedByVariant: true,
          });
        }
        for (const m of rest.matchAll(/but\s+no\s+`([^`]+)`/g)) variant.removes.push(m[1]);
        set.variants[phrase] = variant;
        continue;
      }

      const introduces = /^(?!-).*\*\*with\s+([^*]+)\*\*.*\badds\b/i.exec(line);
      if (introduces) { pendingVariant = introduces[1].trim(); cols = null; continue; }

      if (SEPARATOR.test(line)) continue;          // still inside the table
      const cells = tableRow(line);
      if (!cells) { cols = null; continue; }
      if (!cols) { cols = columns(cells); continue; }
      if (cols.name < 0 || cols.description < 0) continue;
      const split = splitDefault(cells[cols.description] ?? '');
      const prop = {
        name: unTick(cells[cols.name] ?? ''),
        type: cols.type >= 0 ? unTick(cells[cols.type] ?? '') : '',
        description: split.description,
        ...(split.default === undefined ? {} : { default: split.default }),
      };
      if (!prop.name) continue;
      if (pendingVariant) {
        const variant = (set.variants[pendingVariant] ??= { adds: [], removes: [] });
        variant.adds.push({ ...prop, addedByVariant: true });
      } else {
        set.props.push(prop);
      }
    }
    if (set.props.length || Object.keys(set.variants).length) sets[name] = set;
  }
  return sets;
}

/**
 * `Basic, Display with variant and font size, Behavior (step)` → the sets an
 * element cites, each with the wording that qualifies it.
 */
function parseCitations(text, setNames) {
  const ordered = [...setNames].sort((a, b) => b.length - a.length);
  const out = [];
  for (const item of text.split(',').map((s) => s.trim()).filter(Boolean)) {
    const set = ordered.find((n) => item === n || item.startsWith(`${n} `) || item.startsWith(`${n}(`));
    if (!set) { out.push({ set: null, qualifier: item }); continue; }
    out.push({ set, qualifier: item.slice(set.length).trim() });
  }
  return out;
}

/**
 * One citation's fields.
 *
 * The qualifier is read twice: a parenthesised list names *which* of the set's
 * fields are meant ("Behavior (step)"), and the remaining words select variants
 * ("with variant and font size" is both the `variant` and the `fontSize`
 * variant, which is why phrases are matched and consumed rather than the whole
 * qualifier being looked up as one name).
 */
function expandCitation(set, qualifier) {
  const label = qualifier || null;
  const parenM = /\(([^)]+)\)/.exec(qualifier);
  let rest = qualifier.replace(/\([^)]*\)/g, ' ').replace(/^with\s+/i, ' ').trim();

  const props = set.props.map((p) => ({ ...p }));
  const removed = new Set();
  for (const phrase of Object.keys(set.variants).sort((a, b) => b.length - a.length)) {
    if (!rest.includes(phrase)) continue;
    rest = rest.replace(phrase, ' ');
    for (const add of set.variants[phrase].adds) props.push({ ...add });
    for (const gone of set.variants[phrase].removes) removed.add(gone);
  }

  let out = props.filter((p) => !removed.has(p.name));
  if (parenM) {
    // Only a genuine field list narrows the set; a parenthetical that names no
    // field is description, and dropping every field on it would be a fiction.
    const wanted = parenM[1].split(',').map((t) => unTick(t.trim()));
    if (wanted.every((w) => out.some((p) => p.name === w))) out = out.filter((p) => wanted.includes(p.name));
  }
  return out.map((p) => ({
    ...p,
    section: set.name,
    origin: 'sharedSet',
    sharedSet: set.name,
    ...(label ? { sharedSetVariant: label } : {}),
  }));
}

/* ── Read the skill ──────────────────────────────────────────────────────── */

const elements = {};
const families = {};
const fieldTypes = {};
let sharedSets = {};
let files = 0;

function read(file) {
  const full = path.join(SKILL_DIR, file);
  if (!fs.existsSync(full)) {
    console.error(`missing skill file: ${full}`);
    process.exit(2);
  }
  files += 1;
  // The skill files are a mix of CRLF and LF; JS `.` does not match `\r`, so a
  // stray carriage return silently defeats every `$`-anchored pattern below.
  return fs.readFileSync(full, 'utf8').replace(/\r\n?/g, '\n');
}

// SKILL.md first: the shared field sets, and the glossary explaining what a
// field `type` means — which is how the inspector can say "this prop takes a
// JSONata expression" rather than just printing the word `transform`.
for (const block of headings(read('SKILL.md')).filter((h) => h.level === 2)) {
  if (block.title === GLOSSARY_HEADING) {
    for (const line of block.body) {
      const cells = tableRow(line);
      if (cells && cells.length >= 2 && !/^Type$/i.test(cells[0])) fieldTypes[unTick(cells[0])] = cells[1];
    }
    continue;
  }
  if (!FAMILY_HEADINGS.has(block.title)) continue;
  if (block.title === SHARED_INPUTS) sharedSets = parseSharedSets(block);
  // The flattened view is kept for reference: it is the family as the skill
  // prints it, before any element cites part of it.
  const scanned = scanBlock(block.body);
  families[block.title] = {
    display: block.title,
    flags: [],
    summary: scanned.summary,
    props: scanned.props,
    functions: scanned.functions,
    state: scanned.state,
    file: 'SKILL.md',
  };
}

const setNames = Object.keys(sharedSets);

for (const file of FILES) {
  const category = file.replace(/\.md$/, '');
  const heads = headings(read(file));
  heads.forEach((h, i) => {
    const rn = h.lead.match(/\*\*resolvedName:\*\*\s*`([^`]+)`/);
    if (!rn) return;                                   // a category heading, not an element
    const internal = h.lead.match(/\*\*resolvedName:\*\*\s*`[^`]+`\s*\(internally\s*`([^`]+)`\)/);
    const flagLine = h.lead.match(/\*\*Flags:\*\*(.*)/)?.[1] ?? '';
    const requires = h.lead.match(/\*\*Requires:\*\*\s*(.*)/)?.[1]?.trim();
    const citations = h.lead.match(/\*\*Shared sets:\*\*\s*(.*)/)?.[1]?.trim();

    // The enclosing `##` when the element is a `###` — "Text Inputs",
    // "Custom Action Buttons".
    let subcategory;
    for (let j = i - 1; j >= 0; j -= 1) {
      if (heads[j].level < h.level) { subcategory = heads[j].title; break; }
    }

    const scanned = scanBlock(h.body);
    const cited = citations ? parseCitations(citations, setNames) : [];
    const props = [...scanned.props];
    const have = new Set(props.map((p) => p.name));
    for (const { set, qualifier } of cited) {
      if (!set) continue;
      for (const p of expandCitation(sharedSets[set], qualifier)) {
        if (have.has(p.name)) continue;                // the element's own entry is the specific one
        have.add(p.name);
        props.push(p);
      }
    }

    elements[rn[1]] = {
      display: h.title,
      resolvedName: rn[1],
      ...(internal ? { internalName: internal[1] } : {}),
      category,
      ...(subcategory ? { subcategory } : {}),
      flags: flagLine.match(/`([^`]+)`/g)?.map(unTick) ?? [],
      flagsDeclaredNone: /\bnone\b/i.test(flagLine),
      ...(requires ? { requires } : {}),
      ...(citations ? { sharedSets: cited.map((c) => c.qualifier ? `${c.set ?? ''} ${c.qualifier}`.trim() : c.set) } : {}),
      summary: scanned.summary,
      props,
      functions: scanned.functions,
      state: scanned.state,
      functionsDocumented: scanned.functionsDocumented,
      stateDocumented: scanned.stateDocumented,
      ...(scanned.prose.length ? { proseReferences: scanned.prose } : {}),
      sections: scanned.sections,
      file,
    };
  });
}

/* ── Prose cross-references ──────────────────────────────────────────────── */

/**
 * Resolve "Same data fields as Form (…)" into the fields themselves.
 *
 * A reference names a target element and a parenthesised list. What the list
 * means depends on where the sentence sits: under a *section* it names fields
 * (`query.dataSubscription` standing for every field beneath it), under
 * `### Sections` with no section it names the target's sections, and under
 * Exposed Functions / State it names those.
 *
 * Run to a fixpoint because references chain — `Cards` cites `Table`'s data
 * sections, which are themselves a reference to `Form`.
 */
const byName = {};
for (const el of Object.values(elements)) {
  byName[el.resolvedName] = el;
  byName[el.display.replace(/[^A-Za-z0-9]/g, '')] = el;
}

const sameSection = (a = '', b = '') => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x === y || x.startsWith(y) || y.startsWith(x);
};

for (let pass = 0; pass < 8; pass += 1) {
  let added = 0;
  for (const el of Object.values(elements)) {
    for (const ref of el.proseReferences ?? []) {
      // `Form (…)`, `Table functions (…)` — a documented element followed by its list.
      for (const m of ref.text.matchAll(/\b([A-Z][A-Za-z0-9]*)\b(?:\s+\w+)?\s*\(([^)]+)\)/g)) {
        const target = byName[m[1]];
        if (!target || target === el) continue;
        ref.resolved = true;
        const items = m[2].split(',').map((t) => unTick(t.trim())).filter(Boolean);

        if (ref.kind === 'Exposed Functions') {
          const have = new Set(el.functions.map((f) => f.name));
          for (const item of items) {
            const fn = target.functions.find((f) => f.name === item.replace(/\(.*$/, ''));
            if (!fn || have.has(fn.name)) continue;
            el.functions.push({ ...fn, origin: 'prose-reference', from: target.resolvedName });
            have.add(fn.name);
            added += 1;
          }
          el.functionsDocumented = true;
          continue;
        }
        if (ref.kind === 'Exposed State') {
          const have = new Set(el.state.map((s) => s.name));
          for (const item of items) {
            const st = target.state.find((s) => s.name === item);
            if (!st || have.has(st.name)) continue;
            el.state.push({ ...st, origin: 'prose-reference', from: target.resolvedName });
            have.add(st.name);
            added += 1;
          }
          el.stateDocumented = true;
          continue;
        }

        const have = new Set(el.props.map((p) => p.name));
        for (const item of items) {
          const picked = ref.section
            // Under a section the list names fields; a prefix stands for the
            // whole group beneath it (`query.dataSubscription` → its four fields).
            ? target.props.filter((p) => p.name === item || p.name.startsWith(`${item}.`))
            : target.props.filter((p) => sameSection(p.section ?? '', item));
          for (const p of picked) {
            if (have.has(p.name)) continue;
            have.add(p.name);
            el.props.push({
              ...p,
              ...(ref.section ? { section: ref.section } : {}),
              origin: 'prose-reference',
              from: target.resolvedName,
            });
            added += 1;
          }
        }
      }
    }
  }
  if (!added) break;
}

/* ── Emit ────────────────────────────────────────────────────────────────── */

const out = { elements, families, sharedSets, fieldTypes };
const json = `${JSON.stringify(out, null, 2)}\n`;

const all = Object.values(elements);
const count = (origin) => all.reduce((n, e) => n + e.props.filter((p) => p.origin === origin).length, 0);
const propCount = all.reduce((n, e) => n + e.props.length, 0);
const transformCount = all.reduce((n, e) => n + e.props.filter((p) => p.type === 'transform').length, 0);
const fnCount = all.reduce((n, e) => n + e.functions.length, 0);
const unresolved = all.flatMap((e) =>
  (e.proseReferences ?? []).filter((r) => !r.resolved).map((r) => `${e.resolvedName}: ${r.text}`));
const summary =
  `${files} files · ${all.length} elements · ${Object.keys(families).length} families · ` +
  `${propCount} props (${count('element')} own, ${count('sharedSet')} shared, ` +
  `${count('prose-reference')} referenced; ${transformCount} transformable) · ${fnCount} functions`;

if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (current !== json) {
    console.error('screenElements.json is out of date with the skill — run: node scripts/extract-elements.mjs');
    process.exit(1);
  }
  console.log(`registry matches the skill — ${summary}`);
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, json);
  console.log(`${OUT} — ${summary}`);
}
// An unresolved cross-reference is a real gap in what we can say about an
// element, so it is reported rather than left to look like "no fields".
for (const line of unresolved) console.warn(`unresolved cross-reference — ${line}`);
