/**
 * Business rules. No HTTP, no MCP, no tool result shapes.
 *
 * This is the layer worth separating, and the reason is narrow: rules like
 * these are where the expensive mistakes live, and they can only be tested
 * cheaply if nothing else has to be running. Every function here takes plain
 * values and returns plain values, so pricing.test.ts covers them in
 * milliseconds with no server and no network.
 *
 * The other reason: a rule written inside a tool handler is available to that
 * one handler. Written here it is available to all of them — and to the cron
 * job, the admin route, and whatever else arrives later.
 */
import type { Item } from './api/catalog.js';
import type { OrderLine } from './api/orders.js';

export interface PricedLine {
  item_id: string;
  name: string;
  quantity: number;
  unit_price: number;
  line_total: number;
}

export interface Priced {
  lines: PricedLine[];
  subtotal: number;
  /** Lines that could not be priced, each with a reason the agent can relay. */
  rejected: Array<{ item_id: string; quantity: number; reason: string }>;
}

/**
 * Turns requested lines into priced ones, against the catalogue as it is now.
 *
 * Prices come from the catalogue, never from the request. A caller that can
 * name its own price is a caller that can order a £900 item for £9, and the
 * agent passing the number through is not a defence.
 */
export function price_lines(requested: OrderLine[], catalog: Item[]): Priced {
  const by_id = new Map(catalog.map((item) => [item.id, item]));
  const lines: PricedLine[] = [];
  const rejected: Priced['rejected'] = [];

  for (const line of requested) {
    const quantity = Math.floor(Number(line.quantity));
    if (!Number.isFinite(quantity) || quantity <= 0) {
      rejected.push({ item_id: line.item_id, quantity: line.quantity, reason: 'quantity must be a whole number above zero' });
      continue;
    }
    const item = by_id.get(line.item_id);
    if (!item) {
      rejected.push({ item_id: line.item_id, quantity, reason: 'no such item' });
      continue;
    }
    if (!item.in_stock) {
      rejected.push({ item_id: line.item_id, quantity, reason: 'out of stock' });
      continue;
    }
    lines.push({
      item_id: item.id,
      name: item.name,
      quantity,
      unit_price: item.price,
      line_total: round_money(item.price * quantity),
    });
  }

  return { lines, subtotal: round_money(lines.reduce((sum, l) => sum + l.line_total, 0)), rejected };
}

export interface MinimumCheck {
  meets_minimum: boolean;
  minimum: number;
  shortfall: number;
  /** Written for the agent to relay, with the exact figure owed. */
  message: string;
}

/**
 * Whether an order clears the minimum.
 *
 * Returns the shortfall rather than a yes/no, because "add ₹350 more" is a
 * thing the customer can act on and "your order is too small" is not.
 */
export function check_minimum(subtotal: number, minimum: number): MinimumCheck {
  const shortfall = round_money(Math.max(minimum - subtotal, 0));
  // A hair under counts as met: a total assembled from rounded line prices does
  // not always agree with the threshold in the last decimal place.
  const meets = shortfall <= 0.01;
  return {
    meets_minimum: meets,
    minimum,
    shortfall: meets ? 0 : shortfall,
    message: meets
      ? `The order total of ${money(subtotal)} meets the ${money(minimum)} minimum.`
      : `The order comes to ${money(subtotal)}, and the minimum is ${money(minimum)}. Tell the customer they need ${money(shortfall)} more, using that exact figure.`,
  };
}

/** Money in paise-free floats drifts; every total goes through here. */
export function round_money(value: number): number {
  return Math.round(value * 100) / 100;
}

export function money(value: number): string {
  return `₹${value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
