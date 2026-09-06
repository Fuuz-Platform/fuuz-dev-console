/**
 * Reading enough of a GraphQL document to know whether it writes.
 *
 * This decides whether the environment gate applies, so a wrong answer matters in
 * one direction especially: a mutation mistaken for a query would run against a
 * production tenant. It is deliberately a *lexical* check and not a parser — a
 * parser would reject a half-typed document and leave the gate undecided, and
 * "undecided" is not a safe state for a write.
 *
 * Comments and strings are stripped first, because `# mutation` in a comment and
 * `query { search(term: "mutation") }` both contain the word and neither is a write.
 *
 * Pure.
 */

/**
 * Strip comments and string literals.
 *
 * Block strings (`"""…"""`) first, since they can contain quotes that would
 * otherwise terminate a plain string early and leave real code inside "a string".
 */
export function stripNonCode(text: string): string {
  return text
    .replace(/"""[\s\S]*?"""/g, '""')
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/#[^\n]*/g, '');
}

/**
 * Whether the document contains a mutation or a subscription operation.
 *
 * Subscriptions count as not-a-read: they open a long-lived stream, which is not
 * something this console should start against a tenant it is only meant to inspect.
 *
 * The `{` lookahead is what makes `mutation` the operation keyword rather than a
 * field called `mutationCount` or a variable named `$mutation`.
 */
export function isMutation(text: string): boolean {
  const code = stripNonCode(text);
  return /(^|[\s{}()])(mutation|subscription)\b/i.test(code) && /[{(]/.test(code);
}

/**
 * The operation name, for labelling a result. Undefined for an anonymous operation,
 * which is the common case when typing into a console.
 */
export function operationName(text: string): string | undefined {
  const m = /\b(query|mutation|subscription)\s+([A-Za-z_][\w]*)/.exec(stripNonCode(text));
  return m?.[2];
}
