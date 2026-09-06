/**
 * What the platform says each screen element is.
 *
 * Backed by `data/screenElements.json`, generated from the `fuuz-screen-elements`
 * skill by `scripts/extract-elements.mjs`. The skill names each element's
 * `resolvedName` outright, so nothing here is inferred from a display name.
 *
 * Three things it supplies that the design alone cannot:
 *
 *  - **every** prop an element accepts, not just the ones a given screen uses,
 *    each with its type and description;
 *  - which of those accept a **transform** — the props the designer offers a
 *    JSONata editor for;
 *  - the runtime **`fn` bag** and exposed state, which is what separates a
 *    property that can really be set from one that can only be previewed.
 *
 * The distinction this file exists to protect: an undocumented element type is
 * *unknown*, never *empty*. Reporting "no transformable props" for a type we
 * have never read would be inventing a fact.
 *
 * Pure.
 */
import REGISTRY from './data/screenElements.json';

export interface ElementProp {
  name: string;
  /** Field type from the skill — `transform`, `text`, `switch`, `action`, … */
  type: string;
  description: string;
  default?: string;
  /** The designer panel section it appears under: Basic, Display, Validation… */
  section?: string;
}

export interface ElementFunction {
  name: string;
  signature: string;
  description: string;
}

export interface ElementDoc {
  display: string;
  resolvedName: string;
  internalName?: string;
  flags: string[];
  summary: string;
  props: ElementProp[];
  functions: ElementFunction[];
  state: { name: string; description: string }[];
  file: string;
}

interface RegistryShape {
  elements: Record<string, ElementDoc>;
  families: Record<string, Omit<ElementDoc, 'resolvedName'> & { resolvedName?: string }>;
  fieldTypes: Record<string, string>;
}

const DATA = REGISTRY as unknown as RegistryShape;

/** Families whose fields every member inherits but never lists individually. */
const SHARED_INPUTS = 'Shared Field Sets for Input Elements';
const SHARED_DATA = 'Shared Data Fields';

const isInput = (type: string) => /Input$|^Switch$|^ScanText/i.test(type);
const isDataBound = (type: string) =>
  /^(Form|Table|DataGrid|List|Chart|Calendar|DataTree)$/i.test(type);

/** What a field type means, from the skill's glossary. */
export function fieldTypeMeaning(type: string): string | undefined {
  return DATA.fieldTypes[type];
}

/** The element's own documentation, or undefined if the skill has no entry. */
export function elementDoc(resolvedName: string): ElementDoc | undefined {
  return DATA.elements[resolvedName];
}

/**
 * Whether we have documentation for this type at all.
 *
 * Callers must branch on this before saying anything about an element's props;
 * `false` means unknown, which is not the same as none.
 */
export function isDocumented(resolvedName: string): boolean {
  return !!DATA.elements[resolvedName] || isInput(resolvedName) || isDataBound(resolvedName);
}

/** Every prop this element accepts — its own, plus any inherited family fields. */
export function propsFor(resolvedName: string): ElementProp[] {
  const seen = new Map<string, ElementProp>();
  // Family fields first so an element's own entry wins on a name clash: the
  // specific documentation is the more accurate one.
  if (isInput(resolvedName)) for (const p of DATA.families[SHARED_INPUTS]?.props ?? []) seen.set(p.name, p);
  if (isDataBound(resolvedName)) for (const p of DATA.families[SHARED_DATA]?.props ?? []) seen.set(p.name, p);
  for (const p of DATA.elements[resolvedName]?.props ?? []) seen.set(p.name, p);
  return [...seen.values()];
}

/** The props that accept a JSONata transform, sorted. */
export function transformablePropsFor(resolvedName: string): string[] {
  return propsFor(resolvedName)
    .filter((p) => p.type === 'transform' || p.type === 'jsonata')
    .map((p) => p.name)
    .sort();
}

/** One prop's documentation, family fields included. */
export function propDoc(resolvedName: string, prop: string): ElementProp | undefined {
  return propsFor(resolvedName).find((p) => p.name === prop);
}

/**
 * The runtime functions this element exposes — its `fn` bag.
 *
 * This is what makes an edit real rather than cosmetic: `Form` exposes
 * `setValue(path, value)`, so a field really can be set; nothing exposes a
 * setter for a computed `disabled`, so that can only ever be previewed.
 */
export function functionsFor(resolvedName: string): ElementFunction[] {
  return DATA.elements[resolvedName]?.functions ?? [];
}

/** The state keys an element publishes — `data`, `loading`, `dirty`, … */
export function stateFor(resolvedName: string): { name: string; description: string }[] {
  return DATA.elements[resolvedName]?.state ?? [];
}

/** Every documented type, for diagnostics and coverage checks. */
export function documentedTypes(): string[] {
  return Object.keys(DATA.elements).sort();
}

export function registryStats(): { elements: number; props: number; transformable: number; functions: number } {
  const els = Object.values(DATA.elements);
  return {
    elements: els.length,
    props: els.reduce((n, e) => n + e.props.length, 0),
    transformable: els.reduce((n, e) => n + e.props.filter((p) => p.type === 'transform').length, 0),
    functions: els.reduce((n, e) => n + e.functions.length, 0),
  };
}

/* ── Editability ─────────────────────────────────────────────────────────── */

export type EditTier = 'runtime' | 'preview' | 'none';

export interface Editability {
  tier: EditTier;
  /** The `fn` call that would apply it, when one exists. */
  call?: string;
  /** Why it is this tier — shown to the developer next to the control. */
  reason: string;
}

/**
 * How — and whether — a property can be changed on the running screen.
 *
 * Deliberately conservative. A control that silently does nothing is worse than
 * one that is disabled with a reason, so anything not backed by a documented
 * function is `preview` at best, and props whose effect requires the runtime to
 * re-run a query or a flow are `none`.
 */
export function editability(resolvedName: string, prop: string): Editability {
  // Re-running a query or dispatching a flow is not something a value poke can
  // trigger; setting these would show a changed input with unchanged output.
  if (/^(query\.|optionQuery|validation\.transform|flowInput|columnsTransform)/.test(prop)) {
    return { tier: 'none', reason: 'Applying this needs the runtime to re-run its query or flow, which cannot be driven from here.' };
  }

  const fns = functionsFor(resolvedName);
  const has = (name: string) => fns.find((f) => f.name === name);

  if (/^data\./.test(prop) || prop === 'dataPath') {
    const fn = has('setValue');
    if (fn) return { tier: 'runtime', call: fn.signature, reason: 'The element exposes setValue, so this is a real change the runtime will react to.' };
  }
  if (prop === 'data') {
    const fn = has('setData');
    if (fn) return { tier: 'runtime', call: fn.signature, reason: 'The element exposes setData.' };
  }
  if (prop === 'visible' || prop === 'hidden') {
    const show = has('show');
    const hide = has('hide');
    if (show && hide) return { tier: 'runtime', call: `${show.signature} / ${hide.signature}`, reason: 'The element exposes show/hide.' };
  }
  if (prop === 'disabled') {
    const fn = has('disableField') ?? has('setDisabled');
    if (fn) return { tier: 'runtime', call: fn.signature, reason: 'The element exposes a disable function.' };
  }

  if (!isDocumented(resolvedName)) {
    return { tier: 'preview', reason: `No documentation for ${resolvedName}, so whether this can really be set is unknown — treat any change as a preview.` };
  }
  return { tier: 'preview', reason: 'No runtime setter is documented for this property, so the next render will overwrite anything set here.' };
}
