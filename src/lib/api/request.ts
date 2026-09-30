/**
 * Transport. Every upstream call in the server goes through this one function.
 *
 * Nothing here knows what the API is *for* — that belongs in the endpoint files
 * beside it. This file owns only the things that must be identical on every
 * call: the timeout, the retry rule, how success is told from failure, and how a
 * failure is described.
 *
 * Keeping them here is what stops the three-in-the-morning version of this bug,
 * where one endpoint quietly has no timeout because it was written on a Friday.
 */
import { config } from '../../config.js';
import { log_end, log_start } from '../../logging.js';

export type ApiResult<T> =
  | { ok: true; data: T; raw: unknown }
  | { ok: false; error: string; status?: number; details?: unknown };

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type Query = Record<string, string | number | boolean | undefined>;

export interface RequestOptions {
  method?: Method;
  query?: Query;
  /** JSON body. Omit for GET. */
  body?: unknown;
  /** Multipart body, for file uploads. Sent instead of `body`; Content-Type is
   *  left unset so fetch can add its own boundary. */
  form?: FormData;
  headers?: Record<string, string>;
  /**
   * Retry once on a transport fault. Defaults to true for GET and false for
   * everything else — a retried write can land twice, and neither the caller
   * nor the customer has any way to tell that it did.
   */
  retry?: boolean;
}

type FetchOutcome =
  | { ok: true; status: number; body: unknown; text: string }
  | { ok: false; error: string; detail: string };

/**
 * Never throws.
 *
 * A timeout or dropped connection thrown from here would sail past every
 * business-error path above it and surface as an unusable protocol error, so it
 * is turned into a value at the boundary.
 */
async function raw_fetch(url: string, init: RequestInit): Promise<FetchOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.upstream.timeout_ms);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // Kept for diagnostics — an HTML error page is a common upstream reply,
      // and its first line usually says more than the status code does.
      body = { raw: text };
    }
    return { ok: true, status: res.status, body, text };
  } catch (err) {
    const aborted = controller.signal.aborted || (err instanceof Error && err.name === 'AbortError');
    if (aborted) return { ok: false, error: 'upstream_timeout', detail: `No response within ${config.upstream.timeout_ms}ms.` };
    return { ok: false, error: 'upstream_unreachable', detail: describe_cause(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Node's fetch throws a bare "fetch failed" and hides the reason in `cause`,
 * sometimes nested, sometimes an AggregateError with one entry per address
 * family. Told to a developer, "fetch failed" is worth nothing.
 */
function describe_cause(err: unknown, depth = 0): string {
  if (!err || depth > 4) return '';
  if (err instanceof AggregateError && err.errors.length) {
    const inner = [...new Set(err.errors.map((e) => describe_cause(e, depth + 1)).filter(Boolean))];
    if (inner.length) return inner.join('; ');
  }
  if (!(err instanceof Error)) return String(err);
  const code = (err as NodeJS.ErrnoException).code;
  const nested = describe_cause((err as { cause?: unknown }).cause, depth + 1);
  const own = code ? `${code}${err.message && err.message !== 'fetch failed' ? ` — ${err.message}` : ''}` : err.message;
  if (nested && (!own || own === 'fetch failed')) return nested;
  if (nested && nested !== own) return `${own}: ${nested}`;
  return own || 'the request could not be sent';
}

function build_url(path: string, query: Query = {}): string {
  const qs = Object.entries(query)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${config.upstream.base_url}${suffix}${qs ? `?${qs}` : ''}`;
}

/**
 * Whether a 2xx response actually succeeded.
 *
 * Plenty of APIs answer 200 with the real outcome in the body — `success: 0`, a
 * non-empty `error` array, `status: "error"`. A client that trusts the status
 * code reports those as successes, and the agent then tells a customer
 * something that did not happen.
 *
 * REPLACE THIS with your API's convention. It is the single most important
 * thing to get right in this file.
 */
function envelope_error(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const envelope = body as Record<string, unknown>;

  const errors = envelope['error'] ?? envelope['errors'];
  if (Array.isArray(errors) && errors.length > 0) return String(errors[0]);
  if (typeof errors === 'string' && errors.trim()) return errors;

  const success = envelope['success'] ?? envelope['ok'];
  if (success === false || success === 0) return 'the service reported the request did not succeed';

  const status = envelope['status'];
  if (status === 'error' || status === 'failure') return `the service reported status "${String(status)}"`;

  return null;
}

/** Where the useful part of a successful response lives. Adjust to your API. */
function unwrap<T>(body: unknown): T {
  if (body && typeof body === 'object' && !Array.isArray(body) && 'data' in (body as Record<string, unknown>)) {
    return (body as { data: T }).data;
  }
  return body as T;
}

function http_error(status: number, body: unknown, text: string): string {
  const envelope = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  const said = String(envelope?.['message'] ?? envelope?.['error'] ?? '') || text.slice(0, 160).replace(/\s+/g, ' ').trim();
  if (status === 401) return `Unauthorized${said ? ` — ${said}` : ' — the credentials were not accepted'}`;
  if (status === 403) return `Forbidden${said ? ` — ${said}` : ' — this caller lacks permission'}`;
  if (status === 404) return `Not found${said ? ` — ${said}` : ' — no such record or route'}`;
  if (status === 429) return `Rate limited${said ? ` — ${said}` : ' — too many requests'}`;
  if (status >= 500) return `The service is having trouble (HTTP ${status})${said ? ` — ${said}` : ''}`;
  return `HTTP ${status}${said ? ` — ${said}` : ''}`;
}

export async function api_request<T = unknown>(path: string, opts: RequestOptions = {}, _retried = false): Promise<ApiResult<T>> {
  const method = opts.method ?? 'GET';
  const url = build_url(path, opts.query);
  const started = log_start('UPSTREAM', { method, path, retry: _retried });

  // Spread rather than assigned: under exactOptionalPropertyTypes an explicit
  // `body: undefined` is not the same as no body at all.
  const payload: string | FormData | undefined = opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined);

  const outcome = await raw_fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      ...(config.upstream.api_key ? { Authorization: `Bearer ${config.upstream.api_key}` } : {}),
      ...(opts.body !== undefined && !opts.form ? { 'Content-Type': 'application/json' } : {}),
      ...opts.headers,
    },
    ...(payload !== undefined ? { body: payload } : {}),
  });

  if (!outcome.ok) {
    const may_retry = opts.retry ?? method === 'GET';
    if (!_retried && may_retry) {
      log_end('UPSTREAM', started, { method, path, ok: false, error: outcome.error, retrying: true });
      return api_request<T>(path, opts, true);
    }
    log_end('UPSTREAM', started, { method, path, ok: false, error: outcome.error });
    return { ok: false, error: outcome.detail || outcome.error, details: outcome.error };
  }

  const { status, body, text } = outcome;

  if (status >= 400) {
    log_end('UPSTREAM', started, { method, path, status, ok: false });
    return { ok: false, error: http_error(status, body, text), status, details: body };
  }

  const business_error = envelope_error(body);
  if (business_error) {
    log_end('UPSTREAM', started, { method, path, status, ok: false, envelope: true });
    return { ok: false, error: business_error, status, details: body };
  }

  log_end('UPSTREAM', started, { method, path, status, ok: true });
  return { ok: true, data: unwrap<T>(body), raw: body };
}
