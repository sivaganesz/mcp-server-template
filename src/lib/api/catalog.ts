/**
 * Catalog endpoints.
 *
 * One file per upstream domain. Each function does one thing: shape the
 * request, name the response type, return. No decisions, no messages for the
 * agent, no business rules — those belong in src/lib/ and src/tools/.
 *
 * Thin on purpose. When this file starts making choices it becomes a second
 * place where behaviour lives, and the tool handler stops being the whole story.
 */
import { api_request, type ApiResult } from './request.js';

export interface Item {
  id: string;
  name: string;
  price: number;
  in_stock: boolean;
  [key: string]: unknown;
}

export async function fetch_item(id: string): Promise<ApiResult<Item>> {
  return api_request<Item>(`/items/${encodeURIComponent(id)}`);
}

export async function search_items(query: { search: string; limit?: number }): Promise<ApiResult<Item[]>> {
  return api_request<Item[]>('/items', {
    query: { q: query.search, limit: query.limit ?? 20 },
  });
}
