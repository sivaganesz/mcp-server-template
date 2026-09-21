/**
 * Failures the agent can act on.
 *
 * A tool failure is a business outcome, not a crash. The agent is reading the
 * result, so every failure carries a machine-readable `error` to branch on and a
 * `message` written to be acted upon — what went wrong, and what to do instead.
 * "Request failed" tells the agent nothing and it will either invent a reason or
 * try the same call again.
 */
import type { ApiResult } from './lib/api-client.js';

/** A tool failure. `error` is a stable slug; `message` is the instruction. */
export function fail(error: string, message: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { error, message, ...extra };
}

/** A required argument was missing or empty. */
export function missing(field: string, how: string): Record<string, unknown> {
  return fail(`missing_${field}`, `${how} Do not guess a value or send a placeholder.`);
}

/**
 * An upstream call that did not succeed.
 *
 * The upstream's own wording is passed through rather than paraphrased: it is
 * usually the only accurate thing available, business rules change server-side
 * without notice, and a summary invented here becomes something the agent tells
 * a customer as fact.
 */
export function upstream_failed(
  result: Extract<ApiResult<unknown>, { ok: false }>,
  error: string,
  guidance: string,
): Record<string, unknown> {
  return {
    error,
    upstream_error: result.error,
    ...(result.status !== undefined ? { status: result.status } : {}),
    message: `${guidance} The service said: "${result.error}". Tell the customer what it actually says rather than paraphrasing it.`,
    ...(result.details !== undefined ? { details: result.details } : {}),
  };
}

// ── Argument readers ────────────────────────────────────────────────
// Arguments arrive from a model, so a number can be a string, an optional field
// can be the literal "null", and a missing one can be absent or empty. These
// normalise all of that in one place instead of at every call site.

export function str(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

export function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** Only a real boolean or an explicit "true"/"1" counts. Anything else is false,
 *  which is the safe default for a flag that gates a destructive action. */
export function bool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  const text = str(value).toLowerCase();
  return text === 'true' || text === '1' || text === 'yes';
}
