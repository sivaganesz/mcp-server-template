/**
 * The MCP protocol layer: JSON-RPC 2.0 over HTTP POST.
 *
 * Hand-rolled rather than taken from an SDK, deliberately. It is about a hundred
 * lines, every one of them visible, and the failure modes that matter here —
 * what a tool error looks like to the agent, what a notification must not
 * return, what goes in `content` versus `structuredContent` — are decisions you
 * want to see rather than inherit.
 */
import { config } from './config.js';
import { log_end, log_start } from './logging.js';
import { TOOLS } from './tools/index.js';
import { RPC, type JsonRpcRequest, type JsonRpcResponse } from './types.js';

/** The spec revision this server implements. */
const PROTOCOL_VERSION = '2025-06-18';

function ok(id: JsonRpcRequest['id'], result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function err(id: JsonRpcRequest['id'], code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

/**
 * Handles one request. Returns null for a notification, which must get no reply.
 *
 * A notification is a request with no `id`. Answering one is a protocol
 * violation and some clients will close the connection over it.
 */
export async function handle_rpc(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const is_notification = request.id === undefined;

  if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    return is_notification ? null : err(request.id, RPC.INVALID_REQUEST, 'Not a JSON-RPC 2.0 request.');
  }

  switch (request.method) {
    case 'initialize':
      return ok(request.id, {
        protocolVersion: PROTOCOL_VERSION,
        // Only what this server actually does. Claiming a capability it does not
        // implement makes a client call something that is not there.
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: config.server_name, version: config.server_version },
      });

    // Acknowledgement that the handshake finished. Nothing to do, nothing to say.
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;

    case 'ping':
      return ok(request.id, {});

    case 'tools/list':
      return ok(request.id, { tools: TOOLS.map((t) => t.declaration) });

    case 'tools/call':
      return await call_tool(request);

    default:
      return is_notification ? null : err(request.id, RPC.METHOD_NOT_FOUND, `Unknown method "${request.method}".`);
  }
}

async function call_tool(request: JsonRpcRequest): Promise<JsonRpcResponse> {
  const params = (request.params ?? {}) as { name?: unknown; arguments?: unknown };
  const name = typeof params.name === 'string' ? params.name : '';
  const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;

  const tool = TOOLS.find((t) => t.declaration.name === name);
  if (!tool) {
    // A protocol error, not a tool error: the agent asked for something that
    // does not exist, so naming what does exist is the useful reply.
    return err(request.id, RPC.INVALID_PARAMS, `No tool named "${name}".`, {
      available: TOOLS.map((t) => t.declaration.name),
    });
  }

  const started = log_start('TOOL', { tool: name, args: Object.keys(args) });

  try {
    const result = await tool.handler(args);
    const failed = typeof result === 'object' && result !== null && 'error' in result;
    log_end('TOOL', started, { tool: name, ok: !failed, ...(failed ? { error: result['error'] } : {}) });
    return ok(request.id, tool_result(result, failed));
  } catch (error) {
    // A handler that throws is a bug in the handler. Report it as a tool result
    // rather than a protocol error, so the agent can tell the customer something
    // went wrong instead of the call vanishing into an unusable failure.
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[TOOL ERROR] ${name}:`, error);
    log_end('TOOL', started, { tool: name, ok: false, threw: true });
    return ok(
      request.id,
      tool_result(
        {
          error: 'tool_failed',
          message: 'That could not be completed because of a fault on our side. Tell the customer briefly and do not retry the same call.',
          details: message,
        },
        true,
      ),
    );
  }
}

/**
 * One result, in both shapes a client might read.
 *
 * `structuredContent` is the machine-readable object; `content` is the text
 * fallback. Clients differ in which they use, and one that only reads `content`
 * gets nothing at all if it is omitted — so both are always sent.
 *
 * `isError` marks a tool-level failure. It is not a protocol error: the call
 * reached the tool and the tool has something to say about why it did not work.
 */
function tool_result(result: Record<string, unknown>, is_error: boolean): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
    ...(is_error ? { isError: true } : {}),
  };
}

export { PROTOCOL_VERSION };
