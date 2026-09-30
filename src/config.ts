/**
 * Every setting, read once at boot.
 *
 * Read here and nowhere else. A `process.env` lookup buried in a handler is a
 * setting nobody knows exists: it never reaches .env.example, it is never
 * validated, and the first sign it was missing is wrong behaviour in production
 * rather than a server that refuses to start.
 */
import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    // Fail at boot, loudly. A server that starts without its upstream URL will
    // answer every tool call with a confusing error instead of an obvious one.
    console.error(`\n  Missing required setting ${name}. Copy .env.example to .env and fill it in.\n`);
    process.exit(1);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function number_setting(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    console.error(`\n  ${name} must be a number, got "${raw}".\n`);
    process.exit(1);
  }
  return value;
}

export const config = {
  /** Port this MCP server listens on. */
  port: number_setting('PORT', 9000),

  /**
   * Shared secret the calling platform sends as `Authorization: Bearer <secret>`.
   * Empty disables the check — acceptable in local development, never in
   * production, where anything that can reach the port could drive the tools.
   */
  shared_secret: optional('MCP_SHARED_SECRET', ''),

  /** Name and version reported to the client during `initialize`. */
  server_name: optional('MCP_SERVER_NAME', 'mcp-server-template'),
  server_version: optional('MCP_SERVER_VERSION', '0.1.0'),

  upstream: {
    /** Base URL of the API these tools front. Trailing slash normalised away. */
    base_url: required('UPSTREAM_BASE_URL').replace(/\/+$/, ''),
    /** Sent as `Authorization: Bearer …` on every upstream call when set. */
    api_key: optional('UPSTREAM_API_KEY', ''),
    /** Give up on a request after this long. No timeout means a hung upstream
     *  hangs the tool call, and the caller has no way to recover. */
    timeout_ms: number_setting('UPSTREAM_TIMEOUT_MS', 30_000),
  },

  /**
   * Whatever the business itself is. Kept in config rather than hardcoded in a
   * handler: a shop that changes its minimum order should not need a deploy,
   * and a value nobody can find is a value nobody updates.
   */
  service: {
    name: optional('SERVICE_NAME', 'Example Shop'),
    address: optional('SERVICE_ADDRESS', ''),
    hours: optional('SERVICE_HOURS', 'Mon–Sat, 9am–7pm'),
    minimum_order: number_setting('SERVICE_MINIMUM_ORDER', 0),
  },

  /** How long per-conversation state is kept after its last use. */
  conversation_ttl_ms: number_setting('CONVERSATION_TTL_MS', 12 * 60 * 60 * 1000),

  /** Per-call timing on stdout. On by default; set LOG_TIMING=0 to silence. */
  log_timing: process.env['LOG_TIMING'] !== '0',
} as const;

export const is_production = process.env['NODE_ENV'] === 'production';
