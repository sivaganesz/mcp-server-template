/**
 * Exercises the protocol against a running server.
 *
 * Not a substitute for testing your tools, but it catches the things that break
 * a whole server rather than one handler: a bad handshake, a tool that is
 * declared and not registered, a notification that wrongly gets a reply.
 *
 *   npm run dev          # in one terminal
 *   npm run smoke        # in another
 */
import { config } from '../src/config.js';

const BASE = process.env['SMOKE_URL'] ?? `http://127.0.0.1:${config.port}`;

let passed = 0;
let failed = 0;

function check(condition: boolean, label: string, note = ''): void {
  if (condition) passed++;
  else failed++;
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${note ? `  → ${note}` : ''}`);
}

async function rpc(method: string, params?: Record<string, unknown>, id: number | null = 1): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-sa-conversation-id': 'smoke-test',
      ...(config.shared_secret ? { authorization: `Bearer ${config.shared_secret}` } : {}),
    },
    body: JSON.stringify(id === null ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id, method, params }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

console.log(`\nSmoke test against ${BASE}\n`);

console.log('-- health --');
const health = await fetch(`${BASE}/health`).then((r) => r.json() as Promise<Record<string, unknown>>).catch(() => null);
if (!health) {
  console.error(`\n  Nothing answered at ${BASE}. Start the server with \`npm run dev\` first.\n`);
  process.exit(1);
}
check(health['status'] === 'ok', 'health responds', `${String(health['tools'])} tools`);

console.log('\n-- handshake --');
const init = (await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} })).body as Record<string, any>;
check(Boolean(init?.result?.protocolVersion), 'initialize returns a protocol version', init?.result?.protocolVersion);
check(Boolean(init?.result?.serverInfo?.name), 'and identifies the server', init?.result?.serverInfo?.name);

const notified = await rpc('notifications/initialized', {}, null);
check(notified.status === 204, 'a notification gets no reply', `HTTP ${notified.status}`);

console.log('\n-- tools --');
const listed = (await rpc('tools/list')).body as Record<string, any>;
const tools = (listed?.result?.tools ?? []) as Array<{ name: string; description: string; inputSchema: unknown }>;
check(tools.length > 0, 'tools/list returns tools', tools.map((t) => t.name).join(', '));
check(tools.every((t) => t.name && t.description && t.inputSchema), 'every tool has a name, a description and a schema');
check(new Set(tools.map((t) => t.name)).size === tools.length, 'every name is unique');

console.log('\n-- calling a tool --');
const first = tools[0];
if (first) {
  const called = (await rpc('tools/call', { name: first.name, arguments: {} })).body as Record<string, any>;
  const result = called?.result;
  check(Array.isArray(result?.content), 'a call returns `content`');
  check(result?.structuredContent !== undefined, 'and `structuredContent`');
  // Called with no arguments, so a required-argument tool SHOULD refuse — and
  // refusing with a usable message is the behaviour worth checking.
  const structured = result?.structuredContent as Record<string, unknown> | undefined;
  if (structured?.['error']) {
    check(typeof structured['message'] === 'string' && (structured['message'] as string).length > 20,
      'a refusal explains what to do instead', String(structured['error']));
  }
}

const unknown = (await rpc('tools/call', { name: 'no_such_tool', arguments: {} })).body as Record<string, any>;
check(unknown?.error?.code === -32602, 'an unknown tool is a protocol error', unknown?.error?.message);

const bad_method = (await rpc('definitely/not/a/method')).body as Record<string, any>;
check(bad_method?.error?.code === -32601, 'an unknown method is method-not-found');

console.log(`\n${failed ? 'FAILURES' : 'ALL PASS'} — ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
