/**
 * Appointment rules. No HTTP, no MCP.
 *
 * Phone normalisation, date-window checks and reshaping GHL's response. All of
 * it is fiddly, all of it is where the wrong answer is quiet rather than loud —
 * a date parsed in the server's timezone instead of the customer's books the
 * wrong day — and all of it is testable in milliseconds with nothing running.
 *
 * Settings arrive as arguments rather than being read from config. That is what
 * keeps the layer pure: the tests need no environment at all, and the rules can
 * be reused under different limits without being edited.
 */
import type { FreeSlotsResponse } from './api/ghl.js';

export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

// ── Phone numbers ───────────────────────────────────────────────────

/**
 * A mobile number as the customer said it, turned into E.164.
 *
 * Customers say "9360235499". GHL wants "+919360235499". Between those sit the
 * trunk zero, spaces and dashes, a country code with the + dropped, and the
 * occasional already-correct number. Guessing wrong creates a contact against
 * the wrong person, so anything unrecognised is refused rather than patched up.
 */
export function normalize_phone(raw: string, country_code: string): Parsed<string> {
  const cleaned = String(raw ?? '').replace(/[\s()\-.]/g, '');

  if (!cleaned) return { ok: false, reason: 'No mobile number was given.' };

  // An explicit country code always wins — never second-guess a + the customer typed.
  if (cleaned.startsWith('+')) {
    return /^\+\d{7,15}$/.test(cleaned)
      ? { ok: true, value: cleaned }
      : { ok: false, reason: `"${raw}" starts with + but is not a valid international number.` };
  }

  if (!/^\d+$/.test(cleaned)) {
    return { ok: false, reason: `"${raw}" is not a mobile number. Expected something like 9360235499 or +919360235499.` };
  }

  // National trunk prefix: 09360235499 -> 9360235499
  const digits = cleaned.replace(/^0+/, '');

  // Country code present, + dropped: 919360235499
  if (digits.length === 10 + country_code.length && digits.startsWith(country_code)) return { ok: true, value: `+${digits}` };

  // Bare national number. The 6-9 first digit is the Indian mobile range; widen
  // this if the shop takes numbers from elsewhere.
  if (/^[6-9]\d{9}$/.test(digits)) return { ok: true, value: `+${country_code}${digits}` };

  return {
    ok: false,
    reason: `"${raw}" is not a mobile number we recognise. Expected 10 digits (9360235499) or full international format (+919360235499).`,
  };
}

// ── Dates ───────────────────────────────────────────────────────────

export interface DateWindow {
  start_ms: number;
  end_ms: number;
  days: number;
}

/**
 * Turns two YYYY-MM-DD dates into the millisecond window GHL wants.
 *
 * Both ends are anchored in the customer's timezone, not the server's. Parsing
 * "2026-09-16T23:59:59" with `new Date` uses whatever zone the process happens
 * to run in, so the same request from a UTC container and an IST laptop asks
 * for different windows — and the difference only shows at the edges of a day,
 * which is exactly where a last-slot-of-the-evening booking lives.
 */
export function parse_window(start_date: string, end_date: string, timezone: string, max_days: number): Parsed<DateWindow> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start_date)) return { ok: false, reason: `start_date "${start_date}" is not in YYYY-MM-DD format.` };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end_date)) return { ok: false, reason: `end_date "${end_date}" is not in YYYY-MM-DD format.` };

  const offset = zone_offset(timezone, start_date);
  if (offset === null) return { ok: false, reason: `"${timezone}" is not a timezone this server recognises. Use a name like Asia/Kolkata.` };

  const start_ms = Date.parse(`${start_date}T00:00:00${offset}`);
  const end_ms = Date.parse(`${end_date}T23:59:59${offset}`);

  if (!Number.isFinite(start_ms)) return { ok: false, reason: `start_date "${start_date}" is not a real date.` };
  if (!Number.isFinite(end_ms)) return { ok: false, reason: `end_date "${end_date}" is not a real date.` };
  if (end_ms < start_ms) return { ok: false, reason: `end_date "${end_date}" is before start_date "${start_date}".` };

  const days = Math.ceil((end_ms - start_ms) / 86_400_000);
  if (days > max_days) {
    return { ok: false, reason: `That window is ${days} days. The calendar accepts at most ${max_days}, so ask for a narrower range.` };
  }

  return { ok: true, value: { start_ms, end_ms, days } };
}

/**
 * The UTC offset a zone was on for a given date, as "+05:30".
 *
 * Computed for that date rather than today, so a window crossing a daylight
 * saving change is still anchored correctly.
 */
export function zone_offset(timezone: string, on_date: string): string | null {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' });
    const parts = formatter.formatToParts(new Date(`${on_date}T12:00:00Z`));
    const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
    if (name === 'GMT') return '+00:00';
    const match = name.match(/GMT([+-]\d{2}:\d{2})/);
    return match?.[1] ?? null;
  } catch {
    // Intl throws on an unknown zone, which is the only way to test one.
    return null;
  }
}

/** Both ISO-8601 with an offset, in order, and not in the past. */
export function check_booking_times(start_time: string, end_time: string, now = Date.now()): Parsed<{ start_ms: number; end_ms: number }> {
  const start_ms = Date.parse(start_time);
  const end_ms = Date.parse(end_time);

  if (!Number.isFinite(start_ms)) return { ok: false, reason: `start_time "${start_time}" is not a valid date and time.` };
  if (!Number.isFinite(end_ms)) return { ok: false, reason: `end_time "${end_time}" is not a valid date and time.` };

  // Without an offset the time means whatever zone the server runs in, which is
  // how a 3pm appointment lands at 9:30am.
  if (!has_offset(start_time)) return { ok: false, reason: `start_time "${start_time}" has no timezone. Use the full form, e.g. 2026-09-16T15:00:00+05:30.` };
  if (!has_offset(end_time)) return { ok: false, reason: `end_time "${end_time}" has no timezone. Use the full form, e.g. 2026-09-16T15:30:00+05:30.` };

  if (end_ms <= start_ms) return { ok: false, reason: 'end_time must be after start_time.' };
  if (start_ms < now) return { ok: false, reason: 'That time is in the past. Offer a slot in the future.' };

  return { ok: true, value: { start_ms, end_ms } };
}

function has_offset(iso: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/.test(iso.trim());
}

// ── Slots ───────────────────────────────────────────────────────────

export interface DaySlots {
  date: string;
  slots: string[];
}

export interface SlotSummary {
  days: DaySlots[];
  total_slots: number;
}

/**
 * GHL answers with an object keyed by date, plus a `traceId` alongside the real
 * entries. Passed through as-is the agent gets a shape it has to pick apart,
 * and pays tokens for a trace id nobody reads — so it is flattened to a sorted
 * list of days here.
 */
export function summarize_slots(response: FreeSlotsResponse): SlotSummary {
  const days: DaySlots[] = [];

  for (const [key, value] of Object.entries(response ?? {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue; // traceId and friends
    const slots = value && typeof value === 'object' && Array.isArray(value.slots) ? value.slots.filter((s) => typeof s === 'string') : [];
    if (slots.length) days.push({ date: key, slots });
  }

  days.sort((a, b) => a.date.localeCompare(b.date));
  return { days, total_slots: days.reduce((sum, d) => sum + d.slots.length, 0) };
}

/** Whether an exact slot was offered — used to catch a time nobody suggested. */
export function slot_is_offered(summary: SlotSummary, start_time: string): boolean {
  const wanted = Date.parse(start_time);
  if (!Number.isFinite(wanted)) return false;
  return summary.days.some((day) => day.slots.some((slot) => Date.parse(slot) === wanted));
}
