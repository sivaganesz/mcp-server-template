/**
 * Order endpoints.
 *
 * Same rules as catalog.ts: shape the request, type the response, decide
 * nothing. The one thing worth noticing here is `retry: false` on the write —
 * it is the default for POST, and it is spelled out anyway, because a reader
 * wondering "could this place two orders?" should not have to go and check.
 */
import { api_request, type ApiResult } from './request.js';

export interface OrderLine {
  item_id: string;
  quantity: number;
}

export interface Order {
  order_id: string;
  total: number;
  status: string;
  [key: string]: unknown;
}

export async function create_order(input: { lines: OrderLine[]; note?: string }): Promise<ApiResult<Order>> {
  return api_request<Order>('/orders', {
    method: 'POST',
    body: { lines: input.lines, ...(input.note ? { note: input.note } : {}) },
    retry: false,
  });
}

export async function fetch_order(order_id: string): Promise<ApiResult<Order>> {
  return api_request<Order>(`/orders/${encodeURIComponent(order_id)}`);
}
