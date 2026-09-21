/**
 * Boot: HTTP in, MCP out.
 *
 * Three routes and nothing else. `/mcp` is the protocol endpoint, `/health` is
 * for whatever watches the process, and everything else is a 404 with a hint
 * rather than a blank page.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { config, is_production } from './config.js';
import { handle_rpc, PROTOCOL_VERSION } from './mcp.js';
import { identity_from_request, with_identity } from './identity.js';
import { assert_unique_tool_names, tool_surface_size } from './tools/index.js';
import { state_size } from './state.js';
import { RPC, type JsonRpcRequest } from './types.js';

assert_unique_tool_names();

const app = express();

// Tool arguments and upstream payloads are small, but a file upload passed as
// base64 is not. Generous, but bounded — an unbounded body is a way to run the
// process out of memory from outside.
app.use(express.json({ limit: '10mb' }));

/**
 * Shared secret from the calling platform.
 *
 * Optional so local development works with no setup, and refused outright in
 * production: a server whose tools can place orders should not be drivable by
 * anything that can reach the port.
 */
function authorize(req: Request, res: Response, next: NextFunction): void {
  if (!config.shared_secret) { next(); return; }
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (token !== config.shared_secret) {
    res.status(401).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: RPC.UNAUTHORIZED, message: 'Unauthorized. Send the shared secret as `Authorization: Bearer <secret>`.' },
    });
    return;
  }
  next();
}

app.get('/health', (_req, res) => {
  const surface = tool_surface_size();
  res.json({
    status: 'ok',
    service: config.server_name,
    version: config.server_version,
    protocol: PROTOCOL_VERSION,
    tools: surface.tools,
    description_chars: surface.description_chars,
    conversations: state_size(),
    uptime_s: Math.round(process.uptime()),
  });
});

app.post('/mcp', authorize, async (req, res) => {
  const body = req.body as JsonRpcRequest | JsonRpcRequest[] | undefined;

  if (!body || typeof body !== 'object') {
    res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: RPC.PARSE_ERROR, message: 'Body must be a JSON-RPC request.' } });
    return;
  }

  // Identity is per HTTP request, so it is established once here and every
  // handler beneath reads it without being passed it.
  const caller = identity_from_request(req);

  await with_identity(caller, async () => {
    // A batch is an array. Notifications drop out of the response entirely, and
    // a batch of only notifications gets 204 rather than an empty array.
    if (Array.isArray(body)) {
      const results = await Promise.all(body.map((entry) => handle_rpc(entry)));
      const answers = results.filter((r) => r !== null);
      if (answers.length === 0) { res.status(204).end(); return; }
      res.json(answers);
      return;
    }

    const response = await handle_rpc(body);
    if (response === null) { res.status(204).end(); return; }
    res.json(response);
  });
});

app.use((req, res) => {
  res.status(404).json({ error: 'not_found', message: `No route ${req.method} ${req.path}. The MCP endpoint is POST /mcp.` });
});

// Express 4 needs four parameters here to recognise an error handler.
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[UNHANDLED]', error);
  res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: RPC.INTERNAL_ERROR, message: 'Internal error.' } });
});

const server = app.listen(config.port, () => {
  const surface = tool_surface_size();
  console.log('');
  console.log(`  ${config.server_name} v${config.server_version}`);
  console.log('  ' + '─'.repeat(config.server_name.length + config.server_version.length + 2));
  console.log(`  MCP:      POST http://localhost:${config.port}/mcp`);
  console.log(`  Health:   http://localhost:${config.port}/health`);
  console.log(`  Upstream: ${config.upstream.base_url}`);
  console.log(`  Tools:    ${surface.tools} (${surface.description_chars.toLocaleString()} chars of description per turn)`);
  console.log(`  Auth:     ${config.shared_secret ? 'shared secret required' : 'OPEN — no MCP_SHARED_SECRET set'}`);
  console.log('');
  if (!config.shared_secret && is_production) {
    console.warn('  WARNING: running in production with no shared secret. Anything that can reach this port can call these tools.\n');
  }
});

server.on('error', (error: NodeJS.ErrnoException) => {
  // Easily the most common reason this fails to start, and the default trace
  // says nothing about how to fix it.
  if (error.code === 'EADDRINUSE') {
    console.error(`\n  Port ${config.port} is already in use. Stop the other process, or set PORT to something else.\n`);
    process.exit(1);
  }
  throw error;
});

// Finish in-flight calls before exiting, so a deploy does not cut a tool call in
// half and leave the caller with no answer at all.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n  ${signal} — shutting down.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
