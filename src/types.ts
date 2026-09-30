/** Shared shapes: the MCP wire protocol, and what a tool looks like. */

// ── JSON-RPC 2.0 ────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  /** Absent on a notification, which must not be answered. */
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: string | number | null;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

/** Standard codes. -32000 and below are ours to define. */
export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  UNAUTHORIZED: -32001,
} as const;

// ── Tools ───────────────────────────────────────────────────────────

export interface JsonSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface ToolDeclaration {
  /** snake_case. The agent's instructions refer to this, so renaming one later
   *  silently breaks whatever prompt names it. */
  name: string;
  /**
   * What the agent reads to decide whether to call this tool, and how.
   *
   * This is the product, not a label. Say when to use it, what each argument
   * means in the caller's terms, and anything true of the API that the schema
   * cannot express — an id that is not the id you would expect, a call that has
   * to happen first, a result that looks like success but is not.
   *
   * It is also sent on every single turn, so length has a running cost. Earn it.
   */
  description: string;
  inputSchema: JsonSchema;
}

/**
 * Handlers return a plain object and never throw for a business outcome.
 *
 * A thrown error becomes a protocol-level failure the agent cannot reason
 * about. A returned `{ error, message }` is something it can act on and relay,
 * which is why every failure path in a tool is a return, not a throw.
 *
 * Sync or async, and free to ignore `args` entirely — a tool with an empty
 * schema has nothing to read.
 */
export type ToolHandler = (args: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>;

/** Tool name → the function behind it. */
export type ToolHandlerMap = Record<string, ToolHandler>;
