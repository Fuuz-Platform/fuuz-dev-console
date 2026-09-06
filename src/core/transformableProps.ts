/**
 * Which props on which elements accept a transform.
 *
 * Extracted from the platform's own `fuuz-screen-elements` skill, which
 * documents each element's fields with a type column — `transform` marks the
 * ones the designer offers a JSONata editor for. That makes this authoritative
 * rather than inferred: previously the only signal was "some screen happens to
 * have a transform on this prop", which finds what is used, not what is allowed.
 *
 * Two adjustments are needed to line it up with a screen design:
 *
 *  - the skill uses display names ("Action Button"), designs use craft's
 *    `resolvedName` ("ActionButton");
 *  - some skill headings cover a *family* ("Selection Inputs", "Shared Field
 *    Sets for Input Elements") rather than one element, so their props apply to
 *    every member of that family.
 *
 * Pure.
 */
import RAW from './data/transformableProps.json';
import { functionsFor } from './elementRegistry';

/** Props every input element accepts, documented under a shared heading. */
const SHARED_INPUT_HEADING = 'Shared Field Sets for Input Elements';
const SELECTION_HEADING = 'Selection Inputs';
const DATETIME_HEADING = 'Date & Time Inputs';
const FILE_HEADING = 'File & Media Inputs';
const SHARED_DATA_HEADING = 'Shared Data Fields';

const isInput = (type: string) => /Input$|^Switch$|^ScanText/i.test(type);
const isSelection = (type: string) => /^(Select|Options|CustomFields)Input$/i.test(type);
const isDateTime = (type: string) => /^(Date|DateTime|DateRange|Time)Input$/i.test(type);
const isFile = (type: string) => /^(FileUpload|Image|Video|Media)/i.test(type);
const isDataBound = (type: string) => /^(Form|Table|DataGrid|List|Chart|Calendar|DataTree)$/i.test(type);

/** "Action Button" → "ActionButton"; leaves an already-resolved name alone. */
function toResolvedName(displayName: string): string {
  return displayName.replace(/[^A-Za-z0-9]/g, '');
}

const BY_RESOLVED: Record<string, string[]> = Object.fromEntries(
  Object.entries(RAW as Record<string, string[]>).map(([display, props]) => [toResolvedName(display), props])
);

/**
 * The props this element type accepts a transform on, deduped and sorted.
 *
 * Returns an empty array for an unknown type — which is honestly "we don't
 * know", not "none". Callers should say so rather than implying the element has
 * no transformable props.
 */
export function transformablePropsFor(resolvedName: string): string[] {
  const out = new Set<string>();
  const direct = BY_RESOLVED[resolvedName];
  if (direct) direct.forEach((p) => out.add(p));

  const family: [boolean, string][] = [
    [isInput(resolvedName), SHARED_INPUT_HEADING],
    [isSelection(resolvedName), SELECTION_HEADING],
    [isDateTime(resolvedName), DATETIME_HEADING],
    [isFile(resolvedName), FILE_HEADING],
    [isDataBound(resolvedName), SHARED_DATA_HEADING],
  ];
  for (const [applies, heading] of family) {
    if (!applies) continue;
    (BY_RESOLVED[toResolvedName(heading)] ?? []).forEach((p) => out.add(p));
  }
  return [...out].sort();
}

/** Whether we have any documentation for this element type at all. */
export function isDocumented(resolvedName: string): boolean {
  return !!BY_RESOLVED[resolvedName]
    || isInput(resolvedName) || isDataBound(resolvedName) || isFile(resolvedName);
}

/** Every element type the skill documents, for diagnostics. */
export function documentedTypes(): string[] {
  return Object.keys(BY_RESOLVED).sort();
}

/**
 * Which of an element's props are worth offering a copyable transform path for.
 *
 * Not every prop: a button on all 484 of them made the handful that matter
 * impossible to spot, which is the opposite of an affordance. Two conditions, both
 * from the registry rather than from one screen:
 *
 *  - the prop is one the designer accepts a **transform** on, so a
 *    `$components.X.prop` path is something you could actually bind; and
 *  - the element exposes **functions**, so the path leads somewhere you can read
 *    *and* act on rather than a value with no way to drive it.
 *
 * `authored` — props this screen already sets a transform on — is always included.
 * The authored design is direct evidence that this prop takes a transform, and it
 * outranks the documentation: an undocumented element with a working transform on it
 * must still offer its path.
 *
 * Pure.
 */
export function copyablePropPaths(resolvedName: string, authored: string[] = []): Set<string> {
  const out = new Set<string>(authored);
  if (!functionsFor(resolvedName).length) return out;
  for (const prop of transformablePropsFor(resolvedName)) out.add(prop);
  return out;
}

