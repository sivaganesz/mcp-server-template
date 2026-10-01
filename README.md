# MCP server template

A starting point for an MCP server that puts an existing HTTP API in reach of an
AI agent. The protocol, transport, identity, state, logging and error handling
are done; you add the tools.

Node 20+, TypeScript strict, ESM, Express.

## What an MCP server is

An AI agent can only talk. On its own it cannot read a calendar, price an order
or look up a customer — and asked to anyway, it will produce something
plausible, which is worse than refusing.

MCP (Model Context Protocol) is how it gets to act instead. The server publishes
a list of **tools** — each a name, a description and a JSON schema for its
arguments. The agent reads that list, decides which to call, and sends the call
over JSON-RPC 2.0. The server does the real work against the real API and
returns a real answer.

Two consequences shape everything in this repository.

**The description is the interface.** It is what the agent reads to decide
whether to call a tool and how. A schema says a field is a string; only the
description can say it is an id from another tool rather than one you invent.

**The server is where correctness lives.** The agent can ignore any instruction
it is given. It cannot ignore a check in a handler. Anything that must not
happen — booking twice, acting without consent, skipping a required step —
belongs in code, not in wording.

## Why this template rather than the SDK

The protocol layer is about 120 readable lines in `src/mcp.ts`. The decisions
inside it — what a tool error looks like to the agent, what a notification must
not return, what goes in `content` versus `structuredContent` — are ones worth
seeing rather than inheriting, because they decide how failures reach the agent.

## Getting started

```bash
npm install
cp .env.example .env      # fill in the settings for your service
npm run dev               # http://localhost:9000/mcp
npm run smoke             # in another terminal
npm test                  # the business rules — no server needed
```

`npm run smoke` exercises the handshake, `tools/list`, a tool call and the error
paths against the running server. Run it after adding a tool.

## Folder structure

```
src/
├── server.ts            HTTP: Express, auth, /mcp, /health, graceful shutdown
├── mcp.ts               the protocol: initialize, tools/list, tools/call
├── config.ts            every setting, read once, validated at boot
├── types.ts             protocol and tool types
├── errors.ts            failure helpers, and readers for untrusted arguments
├── identity.ts          who the current call is for
├── state.ts             what this conversation has already done
├── logging.ts           paired START/END timing
│
├── tools/               ← the agent's surface. One file per domain.
│   ├── index.ts         the registry: joins groups, checks consistency
│   └── <domain>.ts      declarations + handlers + name → handler map
│
└── lib/                 ← everything that is not the protocol
    ├── <domain>.ts      business rules: plain functions, no HTTP, no MCP
    ├── <domain>.test.ts their tests
    └── api/
        ├── request.ts   transport: timeout, retry, envelope, errors
        └── <service>.ts endpoints for one upstream service

scripts/smoke.ts         protocol smoke test
```

### What each layer is for

| layer | holds | never holds |
|---|---|---|
| `src/tools/` | what the agent may do, in what order, and what to tell it | HTTP calls, business rules |
| `src/lib/` | rules that decide something | HTTP, MCP shapes, config reads |
| `src/lib/api/` | the shape of each request and response | decisions, messages for the agent |

The split is by **feature**, not by kind. A tool's declaration and its handler
live in the same file because they are one unit — the schema declares the
arguments the handler reads. Kept apart they drift, and the way they drift is
the bad way: the description still promises something the handler stopped doing,
and nothing in the code connects them closely enough for anyone to notice.

Business rules move out for two reasons. They are testable with nothing running
— `npm test` covers them in under a second — and a rule written inside a handler
is available to that one handler, while a rule in `lib/` is available to all of
them, plus the cron job and the admin route that arrive later.

`src/lib/api/request.ts` is shared by every service. The timeout, the retry rule
and the way a failure is described must be identical everywhere, and the way
they stop being identical is someone copying that file.

## Adding a tool

Four files, in this order. Say you are adding `get_invoice`.

### 1. The endpoint — `src/lib/api/invoices.ts`

One file per upstream service. Shape the request, type the response, decide
nothing. Every call names the service it is for; there is no default host.

```ts
import { api_request, type ApiResult } from './request.js';
import { config } from '../../config.js';

export interface Invoice { id: string; total: number; status: string }

export async function fetch_invoice(invoice_no: string): Promise<ApiResult<Invoice>> {
  return api_request<Invoice>(`/invoices/${encodeURIComponent(invoice_no)}`, {
    base_url: config.billing.base_url,
    headers: { Authorization: `Bearer ${config.billing.token}` },
  });
}
```

A write adds `method: 'POST'` and `retry: false` — a retried write can land
twice with no way to tell.

### 2. Any real rule — `src/lib/invoices.ts`

Only if something has to be decided: a format normalised, a total checked, an
eligibility rule applied. Plain values in, plain values out, settings passed as
arguments rather than read from config — that is what keeps it testable.

```ts
export function is_overdue(due_date: string, now: number): boolean { … }
```

Put the test beside it as `src/lib/invoices.test.ts`.

### 3. The tool — `src/tools/invoices.ts`

Three parts in one file: declarations, `handle_*` functions, then the map.

```ts
import { missing, str, upstream_failed } from '../errors.js';
import { fetch_invoice } from '../lib/api/invoices.js';
import type { ToolDeclaration, ToolHandlerMap } from '../types.js';

export const INVOICE_TOOL_DECLARATIONS: ToolDeclaration[] = [
  {
    name: 'get_invoice',
    description:
      'Read one invoice by its number. Use it when the customer asks about a specific invoice. The number comes from the customer or from an earlier tool result — never construct one.',
    inputSchema: {
      type: 'object',
      properties: {
        invoice_no: { type: 'string', description: 'The invoice number, e.g. "INV-1042".' },
      },
      required: ['invoice_no'],
    },
  },
];

async function handle_get_invoice(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const invoice_no = str(args['invoice_no']);
  if (!invoice_no) return missing('invoice_no', 'Pass the invoice number.');

  const res = await fetch_invoice(invoice_no);
  if (!res.ok) return upstream_failed(res, 'invoice_unavailable', `Invoice ${invoice_no} could not be read.`);

  return {
    invoice: res.data,
    message: 'Read the invoice and its total back to the customer.',
  };
}

export const INVOICE_TOOL_HANDLERS: ToolHandlerMap = {
  get_invoice: handle_get_invoice,
};
```

Keep a group to one domain. The cost of this shape is distance between a
declaration and its handler, and that cost grows with file length — at a handful
of tools they are fifty lines apart, which is fine. Split before a file gets long.

### 4. Register it — `src/tools/index.ts`

```ts
import { INVOICE_TOOL_DECLARATIONS, INVOICE_TOOL_HANDLERS } from './invoices.js';

export const TOOL_DECLARATIONS: ToolDeclaration[] = [
  ...APPOINTMENT_TOOL_DECLARATIONS,
  ...INVOICE_TOOL_DECLARATIONS,
];

export const TOOL_HANDLERS: ToolHandlerMap = {
  ...APPOINTMENT_TOOL_HANDLERS,
  ...INVOICE_TOOL_HANDLERS,
};
```

`assert_tools_consistent()` runs at boot and refuses to start if a tool is
declared with no handler, a handler is declared by nothing, a name appears
twice, or a description is empty. All four are silent otherwise — the first
reaches the customer as an error, the second is dead code that looks alive.

### 5. Settings, if the service needs any

Add them to `src/config.ts` as a block of their own, and to `.env.example` with
a comment saying what breaks when they are wrong. `config.ts` is the only file
that reads `process.env`: a lookup buried in a handler is a setting nobody knows
exists and nobody documents.

## Conventions

**Handlers return failures, they do not throw.** A throw becomes a protocol
error the agent cannot reason about. A returned `{ error, message }` is
something it can act on and relay. `mcp.ts` catches throws as a backstop, but
reaching that path means a bug.

**Every message is an instruction.** The agent is the reader. Say what went
wrong *and what to do instead*. `"Nothing was booked. Read the time back, ask
whether to confirm, and end your turn."` beats `"Not confirmed."`

**A guard beats an instruction.** If a tool must not run twice, must follow
another, or needs consent, check it in the handler. A description can be
skipped; a check cannot. The appointment tools show all three: a required
`confirmed` argument, validation of the times, and per-conversation state that
refuses a repeat booking.

**Descriptions are sent on every model call.** Not once at startup — the agent
is stateless, so the whole tool list goes into the prompt every time it thinks.
Say what the schema cannot, and say it briefly.

**Names are permanent.** The agent's instructions refer to tools by name, so
renaming one later silently breaks whatever names it.

**Trust nothing in `args`.** They come from a model: a number arrives as a
string, an optional field as the literal `"null"`. Use `str()`, `num()` and
`bool()` from `src/errors.ts` rather than reading the raw value.

**Never retry a write.** `api_request` retries GET once on a transport fault and
nothing else.

## Adjusting it for your API

**The success rule.** `envelope_error()` in `src/lib/api/request.ts` decides
whether a 2xx actually succeeded. Many APIs answer `200` with `success: 0` or a
non-empty `error` array, and a client that trusts the status code reports those
as successes — so the agent tells the customer something that did not happen.
The default covers the common conventions; replace it with yours.

**Where the payload lives.** `unwrap()` returns `body.data` when there is one,
otherwise the whole body.

**The identity headers.** `src/identity.ts` reads `x-sa-*`. Change the names to
match your platform. `caller_key()` is what scopes per-conversation state.

## The current tools

One service is wired up as a worked example: appointment availability and
booking against GoHighLevel, in `src/tools/appointments.ts`. Read
`handle_book_appointment` — it is the fullest illustration of the conventions
above, since it cannot be undone and therefore has to get consent, validation
and idempotency all right.

Leave that service's token empty in `.env` and its tools refuse one call at a
time with a message the agent can relay, rather than the process failing to
boot. That is the pattern to copy for any service whose settings might be absent.

## Deploying

```bash
npm run build && npm start
```

Set `MCP_SHARED_SECRET` in production — without it, anything that can reach the
port can drive the tools. Keep `.env` out of the image; the container gets real
values from the environment.
