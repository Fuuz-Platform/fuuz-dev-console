/**
 * A data flow as something you can inspect: each node with what it ran, and what
 * actually went in and came out.
 *
 * Two independent sources, joined by node name:
 *
 *  - the **definition**, found in the designer's own memory
 *    (`…diagramEngine.dataFlowEngineFlow.flow.nodes`) — id, name, type, and which
 *    fields hold logic;
 *  - the **flow log console**, whose rows the platform formats as
 *    `NodeName ▶input: { … } ▶output: { … } ▶more: { … }`.
 *
 * Three things the real data forced, none of which were obvious:
 *
 *  1. **Log order is not execution order.** A `broadcast` runs branches in
 *     parallel, so `Archive Stale Rows` appears above `Compute Stale Rows` that
 *     fed it. Ordering the UI by log position would misrepresent the flow, so the
 *     definition's own wiring orders it instead.
 *  2. **A node runs many times.** `Upsert Asset Collections` had ten entries — one
 *     per library in the broadcast. So a node maps to a *list* of executions, and
 *     a single input/output would be an arbitrary pick from them.
 *  3. **The console truncates values it prints.** `Array(10)`, `[…]`, `{…}` are
 *     the platform's own elisions. We keep what it wrote and never imply we have
 *     the whole payload — the `▶more` expander holds the rest and is collapsed.
 *
 * Pure.
 */

/** A node as the designer holds it. */
export interface FlowNodeDef {
  id?: string;
  name?: string;
  type?: string;
  /** Field paths carrying logic — `data.transform`, `data.query`, … */
  logic: string[];
  nextNodes?: string[];
}

/** One run of one node, as the console reported it. */
export interface NodeExecution {
  /** Raw text of the row, kept so nothing is lost to parsing. */
  raw: string;
  input?: string;
  output?: string;
  /** The `response:` segment, which only the terminal node emits. */
  response?: string;
  level?: string;
  /** Whether the platform elided part of the value it printed. */
  elided: boolean;
}

export interface FlowNodeCard {
  def?: FlowNodeDef;
  name: string;
  type?: string;
  /** Every run of this node, newest last. */
  executions: NodeExecution[];
  /** Depth from the entry node, for indenting the list. */
  depth: number;
  /** True when the log mentions it but the definition does not, or vice versa. */
  logOnly: boolean;
  defOnly: boolean;
}

/** The platform's own elision markers. */
const ELIDED = /Array\(\d+\)|\[…\]|\{…\}|\(\d+\)\s*\[/;

/**
 * Split one console row into its segments.
 *
 * The separator is `▶`, which the console uses for every expander. Parsing is
 * deliberately forgiving: an unrecognised segment is ignored rather than
 * discarding the row, because a row we cannot fully parse is still evidence the
 * node ran.
 */
export function parseFlowLogRow(text: string, level?: string): { node: string; exec: NodeExecution } | undefined {
  const raw = text.trim();
  if (!raw) return undefined;

  const parts = raw.split('▶').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return undefined;

  // The first segment is the node name — unless the row is a bare status line
  // like "Firing debug source node Source", which names no node's I/O.
  const head = parts[0];
  if (parts.length === 1) return undefined;

  const exec: NodeExecution = { raw, level, elided: ELIDED.test(raw) };
  for (const part of parts.slice(1)) {
    const at = part.indexOf(':');
    if (at < 0) continue;
    const key = part.slice(0, at).trim().toLowerCase();
    const value = part.slice(at + 1).trim();
    if (key === 'input') exec.input = value;
    else if (key === 'output') exec.output = value;
    else if (key === 'response') exec.response = value;
    // `more` is the collapsed expander; its contents are not in the DOM text.
  }
  if (exec.input === undefined && exec.output === undefined && exec.response === undefined) return undefined;
  return { node: head, exec };
}

/**
 * Order nodes by following the definition's wiring from its entry node.
 *
 * Log order is parallel-interleaved and would present the flow wrongly. Nodes the
 * walk never reaches are appended in definition order, so nothing is dropped just
 * because its wiring is unusual.
 */
export function orderNodes(defs: FlowNodeDef[]): { def: FlowNodeDef; depth: number }[] {
  const byId = new Map(defs.filter((d) => d.id).map((d) => [d.id!, d]));
  const targeted = new Set(defs.flatMap((d) => d.nextNodes ?? []));
  // An entry node is one nothing points at; `request` wins when several qualify.
  const entries = defs.filter((d) => d.id && !targeted.has(d.id));
  const first = entries.find((d) => /request|source/i.test(d.type ?? '')) ?? entries[0] ?? defs[0];

  const out: { def: FlowNodeDef; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (def: FlowNodeDef | undefined, depth: number) => {
    if (!def || depth > 64) return;
    const key = def.id ?? def.name ?? '';
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ def, depth });
    for (const next of def.nextNodes ?? []) walk(byId.get(next), depth + 1);
  };
  walk(first, 0);
  for (const def of defs) {
    const key = def.id ?? def.name ?? '';
    if (!seen.has(key)) { seen.add(key); out.push({ def, depth: 0 }); }
  }
  return out;
}

/**
 * Build the inspector's cards.
 *
 * Joined on **name**, because that is what the console prints — node ids never
 * appear in a log row. A name in the log with no definition, or the reverse, is
 * flagged rather than hidden: both mean the two views disagree, which is worth
 * seeing.
 */
export function buildFlowCards(
  defs: FlowNodeDef[],
  rows: { text: string; level?: string }[]
): FlowNodeCard[] {
  const execsByName = new Map<string, NodeExecution[]>();
  for (const row of rows) {
    const parsed = parseFlowLogRow(row.text, row.level);
    if (!parsed) continue;
    const list = execsByName.get(parsed.node);
    if (list) list.push(parsed.exec);
    else execsByName.set(parsed.node, [parsed.exec]);
  }

  const cards: FlowNodeCard[] = [];
  const claimed = new Set<string>();
  for (const { def, depth } of orderNodes(defs)) {
    const name = def.name ?? def.id ?? '(unnamed)';
    const executions = execsByName.get(name) ?? [];
    if (executions.length) claimed.add(name);
    cards.push({
      def, name, type: def.type, executions, depth,
      logOnly: false,
      defOnly: executions.length === 0,
    });
  }
  // Logged nodes with no definition entry — a stale definition, or a subflow.
  for (const [name, executions] of execsByName) {
    if (claimed.has(name)) continue;
    cards.push({ name, executions, depth: 0, logOnly: true, defOnly: false });
  }
  return cards;
}

/** Counts for the header, so a glance says whether the run looks complete. */
export function flowSummary(cards: FlowNodeCard[]): {
  nodes: number; ran: number; neverRan: number; executions: number; logOnly: number;
} {
  return {
    nodes: cards.length,
    ran: cards.filter((c) => c.executions.length > 0).length,
    // A node that never ran is the most useful thing in a flow diagnosis: it
    // means a branch was not taken or the flow stopped short.
    neverRan: cards.filter((c) => c.defOnly).length,
    executions: cards.reduce((n, c) => n + c.executions.length, 0),
    logOnly: cards.filter((c) => c.logOnly).length,
  };
}
