/**
 * How the designer writes an element's identity, and how to read it back.
 *
 * Kept apart from `domStructure` deliberately: this is pure string handling with
 * no DOM in it, so it compiles into the Node build and can be unit-tested
 * directly. `domStructure` needs `lib.dom` and only ever runs in the page.
 *
 * Pure.
 */

/**
 * Split `Name (Label)` into its parts.
 *
 * The App Designer appends an element's label to its name in the structure
 * tree — and that label can itself contain parentheses, as in the real
 * `TicketTableSlot (Upload tickets (diagnostic))`. This matters more than it
 * looks: the DOM locator matches `data-system-name="TicketTableSlot"` exactly,
 * so carrying the label into the name silently breaks highlighting, CSS preview
 * and the property inspector for precisely those elements that have labels.
 *
 * The scan is balanced and runs from the end, because a lazy regex would stop at
 * the inner `(diagnostic)` and a greedy one would take the wrong opener.
 *
 * A title with no trailing group, or with unbalanced parentheses, is returned
 * whole — guessing at a name we cannot parse is worse than not splitting.
 */
export function splitNameAndLabel(title: string): { name: string; label?: string } {
  const text = title.trim();
  if (!text.endsWith(')')) return { name: text };

  let depth = 0;
  for (let i = text.length - 1; i >= 0; i -= 1) {
    if (text[i] === ')') depth += 1;
    else if (text[i] === '(') {
      depth -= 1;
      if (depth !== 0) continue;
      // Require whitespace before the group, so a call-shaped name like
      // `doThing(x)` keeps its arguments instead of losing them to a label.
      if (i === 0 || !/\s/.test(text[i - 1])) return { name: text };
      const name = text.slice(0, i).trim();
      const label = text.slice(i + 1, -1).trim();
      if (!name) return { name: text };
      return label ? { name, label } : { name };
    }
  }
  return { name: text };
}
