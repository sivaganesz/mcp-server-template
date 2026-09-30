/**
 * CORE tools — one domain group, in three parts.
 *
 *   1. CORE_TOOL_DECLARATIONS  what the agent sees
 *   2. handle_*                what each one does
 *   3. CORE_TOOL_HANDLERS      name → function
 *
 * The declarations sit together on purpose: the tool surface is what the agent
 * reads on every turn, and reviewing it as one block is how you notice two
 * descriptions contradicting each other, or one that has quietly grown to a
 * thousand characters.
 *
 * Keep a group to one domain. The cost of this shape is distance — a
 * declaration and its handler drift when nobody sees them together — and that
 * cost is a function of file length, not of the shape itself. At four tools
 * they are fifty lines apart. At thirty-three in one file they were two and a
 * half thousand, which is how a description ends up promising something its
 * handler stopped doing. Split by domain before a file gets long.
 *
 * What is NOT here: HTTP (src/lib/api/) and business rules (src/lib/). A
 * handler's job is the middle bit — read the arguments, call the layers below,
 * turn the outcome into something the agent can act on.
 */
import { config } from '../config.js';
import { bool, fail, missing, num, str, upstream_failed } from '../errors.js';
import { fetch_item, search_items } from '../lib/api/catalog.js';
import { create_order } from '../lib/api/orders.js';
import { check_minimum, money, price_lines } from '../lib/pricing.js';
import { conversation_state } from '../state.js';
import type { ToolDeclaration, ToolHandlerMap } from '../types.js';

// ── 1. Declarations ─────────────────────────────────────────────────

export const CORE_TOOL_DECLARATIONS: ToolDeclaration[] = [
  {
    name: 'get_service_info',
    description:
      'Return the shop details — name, address, opening hours and the minimum order value. Use it when the caller asks where you are, when you are open, or how much they have to spend. Everything it returns is current; never answer any of these from memory.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'find_items',
    description:
      'Search the catalogue by name and return matching items with their ids, prices and stock. Use it whenever the customer describes what they want rather than naming an id — every other tool needs an id, and this is where ids come from. An empty result means nothing matched; say so and ask them to describe it differently.',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'What the customer called it, in their own words.' },
        limit: { type: 'number', description: 'Maximum results. Defaults to 20.' },
      },
      required: ['search'],
    },
  },
  {
    name: 'get_item',
    description:
      'Read one item in full by its id. The id must come from find_items or from something the customer gave you — never construct one. Use it when they ask about a specific item you have already shown them.',
    inputSchema: {
      type: 'object',
      properties: {
        item_id: { type: 'string', description: 'An item id from find_items, e.g. "18". Never invented.' },
      },
      required: ['item_id'],
    },
  },
  {
    name: 'place_order',
    description:
      'Place the order. This cannot be undone from here, so read the items and the total back, get a clear yes, and only then call it with confirmed: true. It prices the lines against the live catalogue itself — never send prices, and never work out the total yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        lines: {
          type: 'array',
          description: 'What they are ordering. Item ids come from find_items.',
          items: {
            type: 'object',
            properties: {
              item_id: { type: 'string', description: 'From find_items.' },
              quantity: { type: 'number', description: 'A whole number above zero.' },
            },
            required: ['item_id', 'quantity'],
          },
        },
        confirmed: {
          type: 'boolean',
          description: 'true ONLY after the customer has answered yes to a question you actually asked.',
        },
      },
      required: ['lines', 'confirmed'],
    },
  },
];

// ── 2. Handlers ─────────────────────────────────────────────────────

/** No arguments, no upstream — the simplest shape there is. */
function handle_get_service_info(): Record<string, unknown> {
  return {
    name: config.service.name,
    address: config.service.address,
    hours: config.service.hours,
    minimum_order: config.service.minimum_order,
    message: 'Read these back as they are. Do not add details the shop has not given you.',
  };
}

/**
 * A list read. The interesting part is the empty case: a tool that returns an
 * empty array with no guidance invites the agent to invent an id and call the
 * next tool with it.
 */
async function handle_find_items(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const search = str(args['search']);
  if (!search) return missing('search', 'Pass what the customer is looking for.');

  const limit = num(args['limit']);
  const res = await search_items({ search, ...(limit !== undefined ? { limit } : {}) });
  if (!res.ok) return upstream_failed(res, 'search_unavailable', 'The catalogue could not be searched.');

  const items = res.data.map((item) => ({ id: item.id, name: item.name, price: item.price, in_stock: item.in_stock }));

  return {
    items,
    count: items.length,
    message: items.length
      ? 'Read these back with their prices and ask which they want. Quote only the prices in this response.'
      : `Nothing matched "${search}". Say so and ask them to describe it another way. Do NOT call get_item with a guessed id.`,
  };
}

/** A read by id. */
async function handle_get_item(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const item_id = str(args['item_id']);
  if (!item_id) return missing('item_id', 'Pass the id of the item to read.');

  const res = await fetch_item(item_id);
  if (!res.ok) return upstream_failed(res, 'item_unavailable', `Item ${item_id} could not be read.`);

  return {
    item: { id: res.data.id, name: res.data.name, price: res.data.price, in_stock: res.data.in_stock },
    message: res.data.in_stock
      ? 'Read the item and its price back to the customer.'
      : 'This item is out of stock. Say so before they choose it, and offer to search for something else.',
  };
}

/**
 * A write, with everything a write needs: consent, a business rule, and
 * idempotency. All three are checked here rather than asked for in the
 * description, because a rule that lives only in the description is a rule the
 * agent can skip — and the one time it does is the time money moves.
 */
async function handle_place_order(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const raw_lines = Array.isArray(args['lines']) ? args['lines'] : [];
  if (raw_lines.length === 0) return missing('lines', 'Pass the items the customer is ordering.');

  const requested = raw_lines.map((line) => {
    const entry = (line ?? {}) as Record<string, unknown>;
    return { item_id: str(entry['item_id']), quantity: num(entry['quantity']) ?? 0 };
  });

  if (!bool(args['confirmed'])) {
    return fail(
      'not_confirmed',
      'Nothing was ordered. Read the items and the total back, ask whether to place the order, and end your turn. Call this again with confirmed: true only once they have answered yes.',
    );
  }

  const state = conversation_state();
  const placed = state['placed_order_id'];
  if (typeof placed === 'string' && placed) {
    // Almost always the agent retrying rather than the customer asking twice.
    // A placed order cannot be unplaced, so guessing wrong is one-sided.
    return fail(
      'already_placed',
      `Order ${placed} was already placed in this conversation. Tell the customer it is done. If they want more, that is a new order — ask them to say so explicitly.`,
      { order_id: placed },
    );
  }

  // Prices come from the catalogue, never from the caller. A caller that can
  // name its own price can sell a 1,499 item for 1.
  const catalog = await search_items({ search: '', limit: 500 });
  if (!catalog.ok) return upstream_failed(catalog, 'catalog_unavailable', 'The order could not be priced.');

  const priced = price_lines(requested, catalog.data);
  if (priced.lines.length === 0) {
    return fail('nothing_orderable', 'None of those lines could be ordered. Tell the customer which failed and why, then offer to search again.', {
      rejected: priced.rejected,
    });
  }

  const minimum = check_minimum(priced.subtotal, config.service.minimum_order);
  if (!minimum.meets_minimum) {
    return fail('below_minimum', minimum.message, {
      subtotal: priced.subtotal,
      minimum: minimum.minimum,
      shortfall: minimum.shortfall,
      lines: priced.lines,
    });
  }

  const res = await create_order({ lines: priced.lines.map((l) => ({ item_id: l.item_id, quantity: l.quantity })) });
  if (!res.ok) return upstream_failed(res, 'order_failed', 'The order was NOT placed.');

  state['placed_order_id'] = res.data.order_id;

  return {
    status: 'placed',
    order_id: res.data.order_id,
    total: res.data.total,
    lines: priced.lines,
    ...(priced.rejected.length ? { rejected: priced.rejected } : {}),
    message:
      `Order ${res.data.order_id} is placed for ${money(res.data.total)}. Give them the order number. ` +
      (priced.rejected.length ? 'Some lines were dropped — say which and why. ' : '') +
      'Do not offer to change or cancel it: this server cannot.',
  };
}

// ── 3. Name → handler ───────────────────────────────────────────────

export const CORE_TOOL_HANDLERS: ToolHandlerMap = {
  get_service_info: handle_get_service_info,
  find_items: handle_find_items,
  get_item: handle_get_item,
  place_order: handle_place_order,
};
