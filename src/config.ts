/**
 * Every setting, read once at boot.
 *
 * Read here and nowhere else. A `process.env` lookup buried in a handler is a
 * setting nobody knows exists: it never reaches .env.example, it is never
 * validated, and the first sign it was missing is wrong behaviour in production
 * rather than a server that refuses to start.
 */
import 'dotenv/config';

/**
 * For a setting the server genuinely cannot run without.
 *
 * Nothing uses it today: the GHL settings are deliberately optional, so that a
 * server missing them still starts and the appointment tools refuse one call at
 * a time with a message the agent can relay — better than a process that will
 * not boot. Kept because the next setting added may not be like that, and
 * failing at boot beats answering every call with a confusing error.
 */
export function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
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
    /**
     * Base URL for tools that call a general-purpose API.
     *
     * Optional, because this server's tools name their own upstream — see
     * `ghl` below. Requiring it would refuse to start over a URL nothing calls.
     * Set it once you add a tool that uses the default.
     */
    base_url: optional('UPSTREAM_BASE_URL', '').replace(/\/+$/, ''),
    /** Sent as `Authorization: Bearer …` on every upstream call when set. */
    api_key: optional('UPSTREAM_API_KEY', ''),
    /** Give up on a request after this long. No timeout means a hung upstream
     *  hangs the tool call, and the caller has no way to recover. */
    timeout_ms: number_setting('UPSTREAM_TIMEOUT_MS', 30_000),
  },

  /**
   * GoHighLevel, for the appointment tools. A separate service from the main
   * upstream, with its own host, token and header conventions.
   */
  ghl: {
    base_url: optional('GHL_API_BASE', 'https://services.leadconnectorhq.com'),
    token: optional('GHL_PRIVATE_INTEGRATION_TOKEN', ''),
    calendar_id: optional('GHL_CALENDAR_ID', ''),
    location_id: optional('GHL_LOCATION_ID', ''),
    /** Slots are returned in this zone unless the caller names another. */
    timezone: optional('GHL_TIMEZONE', 'Asia/Kolkata'),
    /** Customers give a number the way they say it, usually without one. */
    country_code: optional('GHL_DEFAULT_COUNTRY_CODE', '91'),
    /** The calendars API refuses a window wider than this. */
    max_range_days: number_setting('GHL_MAX_RANGE_DAYS', 31),
  },

  /** How long per-conversation state is kept after its last use. */
  conversation_ttl_ms: number_setting('CONVERSATION_TTL_MS', 12 * 60 * 60 * 1000),

  /** Per-call timing on stdout. On by default; set LOG_TIMING=0 to silence. */
  log_timing: process.env['LOG_TIMING'] !== '0',
} as const;

export const is_production = process.env['NODE_ENV'] === 'production';
