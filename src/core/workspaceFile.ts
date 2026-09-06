/**
 * Saving and reopening a script or a query, inputs included.
 *
 * A saved script without its payload and context is not reusable — you reopen it and
 * have to reconstruct the very inputs that made it work, which is most of the effort.
 * So a save writes the whole workspace as one JSON file.
 *
 * But a plain `.jsonata` / `.js` / `.graphql` file has to work too: people already
 * have those, and refusing them because they lack our wrapper would be obstructive.
 * So **open accepts both** — a bundle restores everything, and anything else is
 * treated as the script text with the current inputs left alone.
 *
 * Pure. The picker and the file handles live in the panel.
 */

export type WorkspaceKind = 'script' | 'graphql';

export interface ScriptWorkspace {
  kind: 'script';
  language: 'javascript' | 'jsonata';
  script: string;
  payload: string;
  context: string;
}

export interface GraphqlWorkspace {
  kind: 'graphql';
  service: string;
  query: string;
  variables: string;
}

export type Workspace = ScriptWorkspace | GraphqlWorkspace;

/** Marks a file as ours, and which version wrote it. */
const MARKER = 'fuuz-dev-console';
const VERSION = 1;

/** Serialise a workspace. Pretty-printed, because it lands in a repo and gets diffed. */
export function serializeWorkspace(workspace: Workspace): string {
  return `${JSON.stringify({ [MARKER]: VERSION, ...workspace }, null, 2)}\n`;
}

export type OpenResult =
  | { kind: 'workspace'; workspace: Workspace }
  /** A plain script or query file: its text, and nothing else claimed. */
  | { kind: 'text'; text: string }
  | { kind: 'error'; error: string };

/**
 * Interpret an opened file.
 *
 * A JSON file that is *not* one of ours is reported as text rather than rejected —
 * pasting a JSON payload into the script box is a reasonable thing to have wanted, and
 * guessing wrong here costs nothing while refusing costs the file.
 */
export function parseWorkspaceFile(text: string, expect?: WorkspaceKind): OpenResult {
  const trimmed = text.trim();
  if (!trimmed) return { kind: 'error', error: 'That file is empty.' };
  if (!trimmed.startsWith('{')) return { kind: 'text', text };

  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); }
  catch { return { kind: 'text', text }; }

  const record = parsed as Record<string, unknown>;
  if (typeof record?.[MARKER] !== 'number') return { kind: 'text', text };

  /*
   * A bundle of the wrong kind is refused rather than coerced.
   *
   * Loading a saved GraphQL query into the script editor would put a query where
   * JavaScript is expected and report a syntax error from the wrong language — a much
   * more confusing outcome than being told the file is for the other tab.
   */
  if (expect && record.kind !== expect) {
    return { kind: 'error', error: `That file is a saved ${String(record.kind)} workspace — open it in the ${String(record.kind) === 'graphql' ? 'GraphQL' : 'Script'} tab.` };
  }

  if (record.kind === 'script') {
    return {
      kind: 'workspace',
      workspace: {
        kind: 'script',
        language: record.language === 'javascript' ? 'javascript' : 'jsonata',
        script: asText(record.script),
        payload: asText(record.payload) || '{}',
        context: asText(record.context) || '{}',
      },
    };
  }
  if (record.kind === 'graphql') {
    return {
      kind: 'workspace',
      workspace: {
        kind: 'graphql',
        service: asText(record.service) || 'application',
        query: asText(record.query),
        variables: asText(record.variables) || '{}',
      },
    };
  }
  return { kind: 'text', text };
}

const asText = (v: unknown) => (typeof v === 'string' ? v : '');

/**
 * A filename that says what the file is.
 *
 * Named from the operation or the first meaningful line, so a directory of saved
 * scripts is navigable rather than `script-1` through `script-9`.
 */
export function suggestedName(workspace: Workspace): string {
  const base = workspace.kind === 'graphql'
    ? nameFromQuery(workspace.query)
    : nameFromScript(workspace.script);
  return `${base || workspace.kind}.fuuz.json`;
}

function nameFromQuery(query: string): string {
  const named = /\b(?:query|mutation|subscription)\s+([A-Za-z_][\w]*)/.exec(query);
  if (named) return slug(named[1]);
  // The first selected field is the next best description of what it fetches.
  const field = /\{\s*([A-Za-z_][\w]*)/.exec(query);
  return field ? slug(field[1]) : '';
}

function nameFromScript(script: string): string {
  const line = script.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('//') && !l.startsWith('/*'));
  return line ? slug(line).slice(0, 40) : '';
}

const slug = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();

/** File-picker filters, kept next to the parser that has to accept them. */
export const ACCEPTED = {
  script: ['.fuuz.json', '.json', '.js', '.jsonata', '.txt'],
  graphql: ['.fuuz.json', '.json', '.graphql', '.gql', '.txt'],
} as const;
