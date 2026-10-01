/**
 * The appointment rules, tested without a server, a network or GHL.
 *
 * Worth reading as the specification: every case here is one a customer can
 * actually produce, and most of them are ways a number or a date can be subtly
 * wrong rather than obviously wrong.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { check_booking_times, normalize_phone, parse_window, slot_is_offered, summarize_slots, zone_offset } from './appointments.js';

// ── Phone numbers ───────────────────────────────────────────────────

test('a bare 10-digit mobile gets the default country code', () => {
  const result = normalize_phone('9360235499', '91');
  assert.equal(result.ok && result.value, '+919360235499');
});

test('spaces, dashes and brackets are stripped', () => {
  for (const raw of ['93602 35499', '936-023-5499', '(936) 023 5499']) {
    const result = normalize_phone(raw, '91');
    assert.equal(result.ok && result.value, '+919360235499', raw);
  }
});

test('a trunk zero is dropped', () => {
  const result = normalize_phone('09360235499', '91');
  assert.equal(result.ok && result.value, '+919360235499');
});

test('a country code with the + missing is restored', () => {
  const result = normalize_phone('919360235499', '91');
  assert.equal(result.ok && result.value, '+919360235499');
});

test('an explicit international number is left alone', () => {
  const result = normalize_phone('+14155552671', '91');
  assert.equal(result.ok && result.value, '+14155552671');
});

test('rubbish is refused rather than guessed at', () => {
  for (const raw of ['', 'call me', '12345', '+12', 'abc9360235499']) {
    assert.equal(normalize_phone(raw, '91').ok, false, raw);
  }
});

test('a 10-digit number outside the mobile range is refused', () => {
  // Landlines and typos must not become a contact against the wrong person.
  assert.equal(normalize_phone('1234567890', '91').ok, false);
});

// ── Date windows ────────────────────────────────────────────────────

test('a window is anchored in the customer timezone, not the server one', () => {
  const window = parse_window('2026-09-16', '2026-09-16', 'Asia/Kolkata', 31);
  assert.ok(window.ok);
  // 2026-09-16T00:00:00+05:30 is 18:30 the previous day in UTC.
  assert.equal(new Date(window.value.start_ms).toISOString(), '2026-09-15T18:30:00.000Z');
  assert.equal(new Date(window.value.end_ms).toISOString(), '2026-09-16T18:29:59.000Z');
});

test('the same dates in another zone give a different window', () => {
  const ist = parse_window('2026-09-16', '2026-09-16', 'Asia/Kolkata', 31);
  const ny = parse_window('2026-09-16', '2026-09-16', 'America/New_York', 31);
  assert.ok(ist.ok && ny.ok);
  assert.notEqual(ist.value.start_ms, ny.value.start_ms);
});

test('a malformed date is refused with the reason', () => {
  assert.equal(parse_window('16-09-2026', '2026-09-23', 'Asia/Kolkata', 31).ok, false);
  assert.equal(parse_window('2026-09-16', 'next tuesday', 'Asia/Kolkata', 31).ok, false);
});

test('an end before the start is refused', () => {
  assert.equal(parse_window('2026-09-23', '2026-09-16', 'Asia/Kolkata', 31).ok, false);
});

test('a window wider than the calendar allows is refused', () => {
  const result = parse_window('2026-09-01', '2026-12-01', 'Asia/Kolkata', 31);
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.reason, /at most 31/);
});

test('an unknown timezone is refused, not silently treated as UTC', () => {
  assert.equal(parse_window('2026-09-16', '2026-09-17', 'Mars/Olympus', 31).ok, false);
  assert.equal(zone_offset('Mars/Olympus', '2026-09-16'), null);
});

test('offsets are read for the date in question, so DST is respected', () => {
  assert.equal(zone_offset('Asia/Kolkata', '2026-09-16'), '+05:30');
  assert.equal(zone_offset('America/New_York', '2026-01-15'), '-05:00'); // winter
  assert.equal(zone_offset('America/New_York', '2026-07-15'), '-04:00'); // summer
});

// ── Booking times ───────────────────────────────────────────────────

const NOW = Date.parse('2026-09-16T10:00:00+05:30');

test('a valid slot passes', () => {
  const result = check_booking_times('2026-09-16T15:00:00+05:30', '2026-09-16T15:30:00+05:30', NOW);
  assert.equal(result.ok, true);
});

test('a time with no offset is refused', () => {
  // Without one it means the server's zone, which is how 3pm becomes 9:30am.
  const result = check_booking_times('2026-09-16T15:00:00', '2026-09-16T15:30:00+05:30', NOW);
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.reason, /no timezone/);
});

test('an end at or before the start is refused', () => {
  assert.equal(check_booking_times('2026-09-16T15:00:00+05:30', '2026-09-16T15:00:00+05:30', NOW).ok, false);
  assert.equal(check_booking_times('2026-09-16T15:30:00+05:30', '2026-09-16T15:00:00+05:30', NOW).ok, false);
});

test('a time in the past is refused', () => {
  const result = check_booking_times('2026-09-16T08:00:00+05:30', '2026-09-16T08:30:00+05:30', NOW);
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.reason, /in the past/);
});

// ── Slots ───────────────────────────────────────────────────────────

const GHL_RESPONSE = {
  '2026-09-17': { slots: ['2026-09-17T09:00:00+05:30', '2026-09-17T09:30:00+05:30'] },
  '2026-09-16': { slots: ['2026-09-16T15:00:00+05:30'] },
  '2026-09-18': { slots: [] },
  traceId: 'abc-123',
};

test('the date-keyed response becomes a sorted list of days', () => {
  const summary = summarize_slots(GHL_RESPONSE);
  assert.deepEqual(summary.days.map((d) => d.date), ['2026-09-16', '2026-09-17']);
  assert.equal(summary.total_slots, 3);
});

test('traceId and empty days are dropped', () => {
  const summary = summarize_slots(GHL_RESPONSE);
  assert.ok(!summary.days.some((d) => d.date === 'traceId'));
  assert.ok(!summary.days.some((d) => d.slots.length === 0));
});

test('an empty response is a summary with no days, not a crash', () => {
  assert.equal(summarize_slots({}).total_slots, 0);
  assert.equal(summarize_slots({ traceId: 'x' }).total_slots, 0);
});

test('an offered slot is recognised however it is written', () => {
  const summary = summarize_slots(GHL_RESPONSE);
  assert.equal(slot_is_offered(summary, '2026-09-16T15:00:00+05:30'), true);
  // Same instant, different offset — still the slot that was offered.
  assert.equal(slot_is_offered(summary, '2026-09-16T09:30:00+00:00'), true);
  assert.equal(slot_is_offered(summary, '2026-09-16T16:00:00+05:30'), false);
});
