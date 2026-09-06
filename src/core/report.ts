/**
 * Render a captured run as markdown, for pasting into an LLM.
 *
 * The audience is a model that has never seen the screen, so the report leads
 * with what's wrong and the evidence for it, then gives just enough state and
 * log to reason about a fix. It is deliberately bounded — a 5,000-entry dump
 * buries the signal and blows the context window.
 *
 * Tokens are redacted on the way out (see `redactTokens`): a captured console
 * can contain the page's live session JWT.
 */
import { issueTrace, type Issue } from './diagnose';
import { formatSize, type NetworkEntry } from './network';
import { redactTokens } from './screenApi';
import type { LogEntry, ScreenRunnerPayload, StateNode } from './types';

export interface ReportInput {
  payload: ScreenRunnerPayload;
  network: NetworkEntry[];
  issues: Issue[];
  /** Where the capture came from. */
  pageUrl?: string;
}

export interface ReportLimits {
  entries: number;
  requests: number;
  stateDepth: number;
  expressionChars: number;
}

export const REPORT_LIMITS: ReportLimits = {
  entries: 60,
  requests: 40,
  stateDepth: 4,
  expressionChars: 600,
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** Indented outline — cheaper in tokens than JSON, and easier for a model to scan. */
function stateOutline(nodes: StateNode[], limits: ReportLimits, depth = 0, out: string[] = []): string[] {
  if (depth > limits.stateDepth) return out;
  for (const node of nodes) {
    const mark = node.changed ? '*' : ' ';
    const trace = node.trace.length ? `  (${node.trace.length} writes)` : '';
    const value = node.value ? ` = ${clip(node.value, 100)}` : '';
    out.push(`${mark} ${'  '.repeat(depth)}${node.label}: ${node.type}${value}${trace}`);
    if (node.children) stateOutline(node.children, limits, depth + 1, out);
  }
  return out;
}

export function toMarkdown(input: ReportInput, limits: ReportLimits = REPORT_LIMITS): string {
  const { payload, issues } = input;
  const network = input.network;
  const entries = payload.entries;
  const L: string[] = [];

  L.push(`# Fuuz screen diagnostic — ${payload.screenName}`);
  L.push('');
  L.push(`- **Screen**: ${payload.screenName}`);
  if (input.pageUrl) L.push(`- **URL**: ${input.pageUrl}`);
  if (payload.design) {
    const c = payload.design.coverage;
    L.push(`- **Design**: ${payload.design.screenName}${payload.design.version ? ` v${payload.design.version}` : ''} — ${c.exercised}/${c.total} dynamic props evaluated`);
  }
  L.push(`- **Captured**: ${entries.length} console entries, ${network.length} requests, snapshot at ${payload.snapshotAt}`);
  L.push('');

  /* ── Issues first: this is the point of the report ─────────────────── */

  L.push('## Issues');
  L.push('');
  if (!issues.length) {
    L.push('None detected by the built-in rules. That is not proof the screen is healthy — it means nothing matched.');
  } else {
    for (const issue of issues) {
      L.push(`### [${issue.severity.toUpperCase()}] ${issue.title}`);
      L.push('');
      L.push(issue.detail);
      L.push('');
      L.push(`- rule: \`${issue.rule}\`${issue.count > 1 ? ` · occurrences: ${issue.count}` : ''}`);
      if (issue.path) L.push(`- path: \`${issue.path}\``);

      // The write chain, so the model can see how the value was produced.
      const trace = issueTrace(issue, entries);
      if (trace.length) {
        L.push('');
        L.push('Trace:');
        L.push('');
        L.push('```');
        trace.slice(0, 12).forEach((id, i) => {
          const e = entries.find((x) => x.id === id);
          if (!e) return;
          L.push(`${i + 1}. ${e.ts}  ${e.title}${e.dur ? `  (${e.dur})` : ''}`);
          if (e.write) L.push(`     writes ${e.write} = ${clip(String(e.after ?? '—'), 120)}`);
          if (e.expr) L.push(`     expr   ${clip(e.expr.replace(/\s+/g, ' '), limits.expressionChars)}`);
        });
        L.push('```');
      }

      const requests = network.filter((r) => issue.requestIds.includes(r.id));
      if (requests.length) {
        L.push('');
        L.push('Requests:');
        L.push('');
        L.push('```');
        for (const r of requests.slice(0, 8)) {
          L.push(`${r.ts}  ${r.status || 'ERR'} ${r.method} ${clip(r.path, 100)}  ${r.durationMs}ms`);
          for (const g of r.graphqlErrors ?? []) L.push(`      graphql: ${clip(g, 160)}`);
        }
        L.push('```');
      }
      L.push('');
    }
  }

  /* ── State ─────────────────────────────────────────────────────────── */

  L.push('## Screen state');
  L.push('');
  L.push('`*` marks a value written during this run.');
  L.push('');
  L.push('```');
  const outline = stateOutline(payload.tree, limits);
  L.push(...(outline.length ? outline : ['(nothing captured)']));
  L.push('```');
  L.push('');

  /* ── Log ───────────────────────────────────────────────────────────── */

  const shown = entries.slice(-limits.entries);
  L.push(`## Execution log${entries.length > shown.length ? ` (last ${shown.length} of ${entries.length})` : ''}`);
  L.push('');
  L.push('| time | kind | entry | writes | value | dur |');
  L.push('| --- | --- | --- | --- | --- | --- |');
  for (const e of shown) {
    L.push(`| ${e.ts} | ${e.kind} | ${cell(clip(e.title, 60))} | ${e.write ? `\`${cell(e.write)}\`` : ''} | ${cell(clip(String(e.after ?? ''), 60))} | ${e.dur} |`);
  }
  L.push('');

  /* ── Network ───────────────────────────────────────────────────────── */

  if (network.length) {
    const requests = network.slice(-limits.requests);
    L.push(`## Network${network.length > requests.length ? ` (last ${requests.length} of ${network.length})` : ''}`);
    L.push('');
    L.push('| time | status | method | path | op | dur | size |');
    L.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const r of requests) {
      const status = r.graphqlErrors?.length ? `${r.status} ⚠` : String(r.status || 'ERR');
      L.push(`| ${r.ts} | ${status} | ${r.method} | ${cell(clip(r.path, 60))} | ${cell(r.operation ?? '')} | ${r.durationMs}ms | ${formatSize(r.sizeBytes)} |`);
    }
    L.push('');
  }

  /* ── Expressions behind the failures ───────────────────────────────── */

  const failing = entries.filter((e) => e.kind === 'error' && e.expr);
  if (failing.length) {
    L.push('## Expressions that failed');
    L.push('');
    for (const e of failing.slice(0, 5)) {
      L.push(`**${e.write || e.title}**`);
      L.push('');
      L.push('```');
      L.push(clip(String(e.expr), limits.expressionChars));
      L.push('```');
      L.push('');
    }
  }

  L.push('---');
  L.push('');
  L.push('Generated by the Fuuz Dev Console. Session tokens are redacted.');

  return redactTokens(L.join('\n'));
}
