/**
 * The payoff for keeping business rules out of the handlers.
 *
 * No server, no network, no MCP client — these run in milliseconds. Run with
 * `npm test`. If a rule can only be tested by starting a server and posting
 * JSON-RPC at it, it is in the wrong file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { check_minimum, price_lines, round_money } from './pricing.js';
import type { Item } from './api/catalog.js';

const CATALOG: Item[] = [
  { id: '1', name: 'Blue Widget', price: 249.5, in_stock: true },
  { id: '2', name: 'Red Widget', price: 199, in_stock: false },
  { id: '3', name: 'Green Gadget', price: 1499, in_stock: true },
];

test('prices lines from the catalogue, not from the request', () => {
  // The caller asks for a price of its own. It must be ignored.
  const priced = price_lines([{ item_id: '1', quantity: 2, price: 1 } as never], CATALOG);
  assert.equal(priced.lines[0]?.unit_price, 249.5);
  assert.equal(priced.lines[0]?.line_total, 499);
  assert.equal(priced.subtotal, 499);
});

test('rejects an unknown item with a reason, and keeps the rest', () => {
  const priced = price_lines([{ item_id: '1', quantity: 1 }, { item_id: '99', quantity: 1 }], CATALOG);
  assert.equal(priced.lines.length, 1);
  assert.deepEqual(priced.rejected, [{ item_id: '99', quantity: 1, reason: 'no such item' }]);
});

test('rejects an out-of-stock item rather than pricing it', () => {
  const priced = price_lines([{ item_id: '2', quantity: 1 }], CATALOG);
  assert.equal(priced.lines.length, 0);
  assert.equal(priced.rejected[0]?.reason, 'out of stock');
});

test('rejects quantities that are not whole numbers above zero', () => {
  const priced = price_lines(
    [{ item_id: '1', quantity: 0 }, { item_id: '1', quantity: -3 }, { item_id: '1', quantity: NaN }],
    CATALOG,
  );
  assert.equal(priced.lines.length, 0);
  assert.equal(priced.rejected.length, 3);
});

test('a shortfall is reported as the exact figure owed', () => {
  const check = check_minimum(1650, 2000);
  assert.equal(check.meets_minimum, false);
  assert.equal(check.shortfall, 350);
  assert.match(check.message, /₹350\.00 more/);
});

test('a total a hair under the minimum still counts as met', () => {
  // Line prices are rounded, so an exact total does not always land exactly.
  assert.equal(check_minimum(1999.995, 2000).meets_minimum, true);
  assert.equal(check_minimum(1999.5, 2000).meets_minimum, false);
});

test('money is rounded to whole paise', () => {
  assert.equal(round_money(0.1 + 0.2), 0.3);
  assert.equal(round_money(249.5 * 3), 748.5);
});
