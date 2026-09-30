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

## The structure

Three layers, sliced by **feature** rather than by kind:

```
src/tools/core.ts        declaration + handler, together, per domain group
src/lib/pricing.ts       business rules — no HTTP, no MCP, unit-testable
src/lib/api/catalog.ts   the HTTP calls, per upstream domain
src/lib/api/request.ts   transport: timeout, retry, envelope, errors
```

**Declaration and handler stay together.** They are one unit — the schema
declares the arguments the handler reads. Split into separate files they drift,
and the way they drift is the bad way: the description still promises something
the handler stopped doing, and nothing connects them closely enough for anyone
to notice.

**Business rules move out.** Anything that decides something — pricing,
minimums, eligibility — goes in `src/lib/` as plain functions over plain
values. Two reasons. It is testable without a server: `npm test` runs the
pricing rules in under half a second. And a rule written inside a handler is
available to that one handler, while a rule written here is available to all of
them, plus the cron job and the admin route that arrive later.

**There is no name → handler map.** Each tool carries its own handler, so a
tool cannot be declared with nothing behind it, and a handler cannot exist that
nothing declares. Both failure modes are silent when a third mapping table is
in the middle.

## Adding a tool

**1. Write it** in `src/tools/` — a declaration and a handler, together:

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

**2. Add the endpoint** in `src/lib/api/invoices.ts` — shape the request, type
the response, decide nothing.

**3. Any real rule** goes in `src/lib/`, with a test beside it.

**4. Register the group** in `src/tools/index.ts`:

```ts
export const TOOLS: Tool[] = [...CORE_TOOLS, ...INVOICE_TOOLS];
```

## The four example tools

One per shape you will keep meeting:

| tool | shape |
|---|---|
| `get_service_info` | no arguments, no upstream — just config |
| `find_items` | a list read, and what to say when it is empty |
| `get_item` | a read by id, with validation |
| `place_order` | a write: consent, a business rule, and idempotency |

`place_order` is the one worth reading. Consent is a required `confirmed`
argument checked in the handler, not a line in the description. The minimum-order
rule comes from `lib/pricing.ts`. A repeat call in the same conversation is
refused from state. And prices are read from the catalogue, never from the
caller — an agent that can name its own price is an agent that can sell a ₹1,499
item for ₹1.

## Three things to adjust for your API

**The success rule.** `envelope_error()` in `lib/api/request.ts` decides whether a 2xx
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
