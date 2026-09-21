/**
 * A worked example, kept deliberately complete.
 *
 * It shows the shape every tool in this server should follow: validate the
 * arguments, call the client, translate the outcome into something the agent can
 * act on, and return — never throw. Two tools, one read and one write, because
 * the write is where the interesting decisions are.
 *
 * Copy this file, rename it, register it in ./index.ts, and delete the parts you
 * do not need.
 */
import { get_example, list_examples } from '../lib/api-client.js';
import { fail, missing, num, str, upstream_failed } from '../errors.js';
import { conversation_state } from '../state.js';
import type { Tool } from '../types.js';

// ── A read ──────────────────────────────────────────────────────────

const get_item: Tool = {
  declaration: {
    name: 'get_item',
    description:
      'Read one item by its id. Use it when the customer names a specific item or asks about one you have already shown them. The id must come from search_items or from something the customer gave you — never invent one.',
    inputSchema: {
      type: 'object',
      properties: {
        item_id: { type: 'string', description: 'The item id, e.g. "18". From search_items, never guessed.' },
      },
      required: ['item_id'],
    },
  },

  handler: async (args) => {
    const item_id = str(args['item_id']);
    if (!item_id) return missing('item_id', 'Pass the id of the item to read.');

    const res = await get_example(item_id);
    if (!res.ok) {
      return upstream_failed(res, 'item_unavailable', `Could not read item ${item_id}.`);
    }

    // Return what the agent needs, not the whole payload. Everything here is
    // paid for in tokens on every turn that follows.
    return {
      item: { id: res.data.id, name: res.data.name },
      message: 'Read the item back to the customer. Do not quote any field that is not in this response.',
    };
  },
};

// ── A search ────────────────────────────────────────────────────────

const search_items: Tool = {
  declaration: {
    name: 'search_items',
    description:
      'Search the catalogue by name. Use it whenever the customer describes what they want rather than naming an id. Returns matches with their ids, which the other tools need. An empty list means nothing matched — say so and ask them to describe it differently rather than guessing an id.',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'What the customer called it, in their own words.' },
        limit: { type: 'number', description: 'Maximum results. Defaults to 20.' },
      },
      required: ['search'],
    },
  },

  handler: async (args) => {
    const search = str(args['search']);
    if (!search) return missing('search', 'Pass what the customer is looking for.');

    const res = await list_examples({ search, ...(num(args['limit']) !== undefined ? { limit: num(args['limit']) as number } : {}) });
    if (!res.ok) return upstream_failed(res, 'search_unavailable', 'The catalogue could not be searched.');

    const items = res.data.map((item) => ({ id: item.id, name: item.name }));
    return {
      items,
      count: items.length,
      message: items.length
        ? 'List these back to the customer and ask which one they mean.'
        : `Nothing matched "${search}". Say so and ask them to describe it another way. Do NOT call get_item with a guessed id.`,
    };
  },
};

// ── A write, with a guard ───────────────────────────────────────────

const claim_item: Tool = {
  declaration: {
    name: 'claim_item',
    description:
      'Reserve an item for this customer. This is not reversible from here, so read the item back and get a clear yes before calling it, then pass their answer in `confirmed`.',
    inputSchema: {
      type: 'object',
      properties: {
        item_id: { type: 'string', description: 'From search_items or get_item.' },
        confirmed: {
          type: 'boolean',
          description: 'true ONLY after the customer has answered yes to a question you actually asked.',
        },
      },
      required: ['item_id', 'confirmed'],
    },
  },

  handler: async (args) => {
    const item_id = str(args['item_id']);
    if (!item_id) return missing('item_id', 'Pass the id of the item to claim.');

    // Consent checked in the handler, not left to the description.
    // An instruction can be skipped; a guard cannot.
    if (args['confirmed'] !== true) {
      return fail(
        'not_confirmed',
        'Nothing was claimed. Read the item back, ask whether to reserve it, and end your turn. Only once they answer yes, call this again with confirmed: true.',
      );
    }

    // Per-conversation guard: a second call for the same item is almost always
    // the agent retrying, not the customer asking twice.
    const state = conversation_state();
    const claimed = (state['claimed_items'] as string[] | undefined) ?? [];
    if (claimed.includes(item_id)) {
      return fail('already_claimed', `Item ${item_id} was already reserved in this conversation. Tell the customer it is done; do not reserve it again.`, {
        item_id,
      });
    }

    const res = await get_example(item_id); // stand-in for the real write
    if (!res.ok) return upstream_failed(res, 'claim_failed', `Item ${item_id} could not be reserved.`);

    state['claimed_items'] = [...claimed, item_id];

    return {
      status: 'claimed',
      item_id,
      message: `Item ${item_id} is reserved. Tell the customer, and do not offer to undo it — this tool cannot.`,
    };
  },
};

export const EXAMPLE_TOOLS: Tool[] = [get_item, search_items, claim_item];
