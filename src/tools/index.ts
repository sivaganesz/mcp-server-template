/**
 * The registry — where domain groups are joined into one tool surface.
 *
 * Each group file exports two things: its declarations and its name → handler
 * map. This file concatenates them and nothing else, so adding a domain is two
 * lines here and a new file beside core.ts.
 *
 * `assert_tools_consistent()` is what makes the split shape safe. Declarations
 * and handlers are separate values, so nothing in the type system stops one
 * existing without the other — a declared tool with no handler is a tool the
 * agent will call and get an error from, and a handler nobody declared is dead
 * code that looks alive. Both are silent. The check runs at boot and refuses to
 * start, which turns a customer-facing failure into a developer-facing one.
 */
import { CORE_TOOL_DECLARATIONS, CORE_TOOL_HANDLERS } from './core.js';
import type { ToolDeclaration, ToolHandlerMap } from '../types.js';

export const TOOL_DECLARATIONS: ToolDeclaration[] = [
  ...CORE_TOOL_DECLARATIONS,
  // ...CART_TOOL_DECLARATIONS,
];

export const TOOL_HANDLERS: ToolHandlerMap = {
  ...CORE_TOOL_HANDLERS,
  // ...CART_TOOL_HANDLERS,
};

/** Called once at boot. Exits rather than starting a server that is wrong. */
export function assert_tools_consistent(): void {
  const problems: string[] = [];

  const declared = TOOL_DECLARATIONS.map((d) => d.name);
  const handled = Object.keys(TOOL_HANDLERS);

  // Declared with nothing behind it: the agent sees the tool, calls it, fails.
  for (const name of declared) {
    if (!(name in TOOL_HANDLERS)) problems.push(`"${name}" is declared but has no handler`);
  }

  // A handler nothing declares: unreachable, and usually a rename half-done.
  for (const name of handled) {
    if (!declared.includes(name)) problems.push(`"${name}" has a handler but is not declared`);
  }

  // Two declarations with one name: the second is unreachable, because the
  // handler map can only hold one entry per key.
  const seen = new Set<string>();
  for (const name of declared) {
    if (seen.has(name)) problems.push(`"${name}" is declared twice`);
    seen.add(name);
  }

  // A description is what the agent reads to decide whether to call the tool.
  // An empty one is a tool it will either ignore or misuse.
  for (const declaration of TOOL_DECLARATIONS) {
    if (!declaration.description.trim()) problems.push(`"${declaration.name}" has no description`);
  }

  if (problems.length) {
    console.error('\n  Tool registry is inconsistent:');
    for (const problem of problems) console.error(`    - ${problem}`);
    console.error('');
    process.exit(1);
  }
}

/** Descriptions are sent on every model call, so the total is a running cost. */
export function tool_surface_size(): { tools: number; description_chars: number } {
  return {
    tools: TOOL_DECLARATIONS.length,
    description_chars: TOOL_DECLARATIONS.reduce((sum, d) => sum + d.description.length, 0),
  };
}
