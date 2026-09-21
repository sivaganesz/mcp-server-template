# MCP server template

A starting point for an MCP server that fronts an existing HTTP API. The
protocol, transport, identity, state, logging and error handling are done; you
add the tools.

Node 20+, TypeScript strict, ESM, Express. No MCP SDK — the protocol layer is
about a hundred readable lines in `src/mcp.ts`, and the decisions that matter in
it are ones worth seeing rather than inheriting.

## Getting started

```bash
npm install
cp .env.example .env          # set UPSTREAM_BASE_URL at minimum
npm run dev                   # http://localhost:9000/mcp
npm run smoke                 # in another terminal
```

`npm run smoke` exercises the handshake, `tools/list`, a tool call and the error
paths against the running server. Run it after adding a tool.

## Adding a tool

Three steps, all in `src/tools/`.

**1. Write it.** Copy `example.ts`, which shows a read, a search and a guarded
write. A tool is a declaration plus a handler, kept in one file so neither can
exist without the other:

```ts
const get_invoice: Tool = {
  declaration: {
    name: 'get_invoice',
    description: 'Read one invoice by its number. …',
    inputSchema: {
      type: 'object',
      properties: { invoice_no: { type: 'string', description: '…' } },
      required: ['invoice_no'],
    },
  },
  handler: async (args) => {
    const invoice_no = str(args['invoice_no']);
    if (!invoice_no) return missing('invoice_no', 'Pass the invoice number.');

    const res = await fetch_invoice(invoice_no);
    if (!res.ok) return upstream_failed(res, 'invoice_unavailable', `Could not read invoice ${invoice_no}.`);

    return { invoice: res.data, message: 'Read the invoice back to the customer.' };
  },
};

export const INVOICE_TOOLS: Tool[] = [get_invoice];
```

**2. Add the endpoint** to `src/lib/api-client.ts`, at the bottom. Keep it thin —
shape the request, type the response, leave the decisions to the handler.

**3. Register it** in `src/tools/index.ts`:

```ts
import { INVOICE_TOOLS } from './invoices.js';

export const TOOLS: Tool[] = [...EXAMPLE_TOOLS, ...INVOICE_TOOLS];
```

## What's here

| file | what it does |
|---|---|
| `src/server.ts` | Express, auth, `/mcp`, `/health`, graceful shutdown |
| `src/mcp.ts` | JSON-RPC 2.0: `initialize`, `tools/list`, `tools/call`, notifications |
| `src/tools/index.ts` | the registry — the one place a tool is added |
| `src/tools/example.ts` | a worked read, search and guarded write |
| `src/lib/api-client.ts` | the only place that calls the upstream API |
| `src/config.ts` | every setting, read once, validated at boot |
| `src/identity.ts` | who the current call is for, via AsyncLocalStorage |
| `src/state.ts` | per-conversation state with a TTL |
| `src/errors.ts` | `fail`, `missing`, `upstream_failed`, argument readers |
| `src/logging.ts` | paired START/END timing lines |
| `scripts/smoke.ts` | protocol smoke test |

## Three things to adjust for your API

**The success rule.** `envelope_error()` in `api-client.ts` decides whether a 2xx
actually succeeded. Many APIs answer `200` with `success: 0` or a non-empty
`error` array, and a client that trusts the status code reports those as
successes — so the agent tells the customer something that did not happen. The
default handles the common conventions; replace it with yours.

**Where the payload lives.** `unwrap()` returns `body.data` when there is one,
otherwise the whole body.

**The identity headers.** `src/identity.ts` reads `x-sa-*`. Change the names to
match your platform.

## Conventions worth keeping

**Handlers return, they don't throw.** A thrown error becomes a protocol failure
the agent cannot reason about. A returned `{ error, message }` is something it
can act on. `mcp.ts` catches throws as a backstop, but that path means a bug.

**Every message is an instruction.** The agent is the reader. Say what went
wrong *and what to do instead* — `"Nothing was claimed. Read the item back, ask
whether to reserve it, and end your turn."` beats `"Not confirmed."`

**A guard beats an instruction.** If a tool must not run twice, or must follow
another, or needs consent — check it in the handler. A description can be
skipped; a check in the code cannot. `claim_item` shows both: a required
`confirmed` argument, and per-conversation state that refuses a repeat.

**Descriptions cost tokens on every turn.** `/health` reports the running total.
Say what the schema cannot — an id that is not the one you would expect, a call
that must happen first, a result that looks like success and is not.

**Names are permanent.** The agent's prompt refers to tools by name, so renaming
one later silently breaks whatever names it.

**Never retry a write.** `api_request` retries GET once on a transport fault and
nothing else, because a retried write can land twice with no way to tell.

## Deploying

```bash
npm run build && npm start
```

Set `MCP_SHARED_SECRET` in production, and keep `.env` out of the image — the
container gets real values from the environment, not from a file.
