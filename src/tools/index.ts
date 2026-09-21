/**
 * The tool registry — the one place a tool is added.
 *
 * Declaration and handler live together in the same file, so a tool cannot be
 * declared with nothing behind it, or implemented and never exposed. Both are
 * mistakes that produce a server which starts cleanly and fails at the one
 * moment it matters.
 *
 * To add a tool: write it in its own file beside example.ts, export an array,
 * import it here, and add it to TOOLS.
 */
import { EXAMPLE_TOOLS } from './example.js';
import type { Tool } from '../types.js';

export const TOOLS: Tool[] = [
  ...EXAMPLE_TOOLS,
  // ...YOUR_TOOLS,
];

/**
 * Two names for one tool means the agent gets a list it cannot use, and the
 * duplicate is unreachable — `find` returns the first every time. Cheap to
 * check at boot; very confusing to diagnose at run time.
 */
export function assert_unique_tool_names(): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const tool of TOOLS) {
    if (seen.has(tool.declaration.name)) duplicates.add(tool.declaration.name);
    seen.add(tool.declaration.name);
  }
  if (duplicates.size) {
    console.error(`\n  Duplicate tool names: ${[...duplicates].join(', ')}. Every name must be unique.\n`);
    process.exit(1);
  }
}

/** Descriptions are sent on every turn, so their total size is a running cost. */
export function tool_surface_size(): { tools: number; description_chars: number } {
  return {
    tools: TOOLS.length,
    description_chars: TOOLS.reduce((sum, t) => sum + t.declaration.description.length, 0),
  };
}
