/**
 * APPOINTMENT tools — checking availability and booking, against GoHighLevel.
 *
 * Two tools that belong together: the second is only safe to call once the
 * first has run, and the agent is told so in both the description and the code.
 *
 * Validation lives in lib/appointments.ts, HTTP in lib/api/ghl.ts. What is left
 * here is the part that is actually about the conversation — what the agent is
 * allowed to do, in which order, and what it should say about the result.
 */
import { config } from '../config.js';
import { bool, fail, missing, str, upstream_failed } from '../errors.js';
import { create_appointment, fetch_free_slots, upsert_contact, type UpsertedContact } from '../lib/api/ghl.js';
import { check_booking_times, normalize_phone, parse_window, slot_is_offered, summarize_slots, type SlotSummary } from '../lib/appointments.js';
import { conversation_state } from '../state.js';
import type { ToolDeclaration, ToolHandlerMap } from '../types.js';

// ── 1. Declarations ─────────────────────────────────────────────────

export const APPOINTMENT_TOOL_DECLARATIONS: ToolDeclaration[] = [
  {
    name: 'check_appointment_availability',
    description:
      "Show the free appointment slots for the dates the customer asked about. Call it as soon as they name a day or a rough time — it only reads the calendar and books nothing. Read the slots back and ask which one they want. If the exact time they asked for is not in the list, say so plainly and offer what is there instead of the nearest thing. The window cannot be wider than 31 days.",
    inputSchema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'First day to check, as YYYY-MM-DD (e.g. 2026-09-16).' },
        end_date: { type: 'string', description: 'Last day to check, as YYYY-MM-DD. Same as start_date for a single day. At most 31 days after it.' },
        timezone: { type: 'string', description: "The customer's timezone, e.g. Asia/Kolkata. Defaults to the shop's own." },
        calendar_id: { type: 'string', description: "Only when booking against a calendar other than the shop's default." },
      },
      required: ['start_date', 'end_date'],
    },
  },
  {
    name: 'book_appointment',
    description:
      "Book one of the slots that check_appointment_availability returned. This puts a real appointment in the calendar and this server cannot cancel it, so read the day, the time and the customer's number back, get a clear yes, and only then call it with confirmed: true. Pass start_time and end_time exactly as the slot was listed, including the timezone offset. You also need their mobile number — ask for it if you do not have one; it is matched to their record automatically.",
    inputSchema: {
      type: 'object',
      properties: {
        mobile_number: {
          type: 'string',
          description: 'The number as the customer gave it, e.g. 9360235499 or +919360235499. The country code is added when they omit it.',
        },
        start_time: { type: 'string', description: 'Exactly as listed by check_appointment_availability, e.g. 2026-09-16T15:00:00+05:30.' },
        end_time: { type: 'string', description: 'When it finishes, same format, e.g. 2026-09-16T15:30:00+05:30.' },
        title: { type: 'string', description: 'What the appointment is for, e.g. "Office visit". Defaults to "Appointment".' },
        confirmed: { type: 'boolean', description: 'true ONLY after the customer has answered yes to a question you actually asked.' },
        calendar_id: { type: 'string', description: "Only when booking against a calendar other than the shop's default." },
        location_id: { type: 'string', description: "Only when booking against a location other than the shop's default." },
      },
      required: ['mobile_number', 'start_time', 'end_time', 'confirmed'],
    },
  },
];

// ── 2. Handlers ─────────────────────────────────────────────────────

/** Refuses rather than calling GHL with half a configuration. */
function ghl_ready(): string | null {
  if (!config.ghl.token) return 'GHL_PRIVATE_INTEGRATION_TOKEN';
  if (!config.ghl.calendar_id) return 'GHL_CALENDAR_ID';
  if (!config.ghl.location_id) return 'GHL_LOCATION_ID';
  return null;
}

async function handle_check_appointment_availability(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const unset = ghl_ready();
  if (unset) {
    return fail('calendar_not_configured', `The calendar is not set up on this server (${unset} is missing). Tell the customer you cannot check availability right now, and do not guess at times.`);
  }

  const start_date = str(args['start_date']);
  const end_date = str(args['end_date']);
  if (!start_date) return missing('start_date', 'Pass the first day to check, as YYYY-MM-DD.');
  if (!end_date) return missing('end_date', 'Pass the last day to check, as YYYY-MM-DD. Use the same date as start_date for a single day.');

  const timezone = str(args['timezone']) || config.ghl.timezone;

  // Both ends are anchored in the customer's zone, and the 31-day limit is
  // enforced here rather than left to the calendar to reject.
  const window = parse_window(start_date, end_date, timezone, config.ghl.max_range_days);
  if (!window.ok) return fail('invalid_dates', `${window.reason} Ask the customer for the dates again rather than guessing.`);

  const res = await fetch_free_slots({
    calendar_id: str(args['calendar_id']) || config.ghl.calendar_id,
    start_ms: window.value.start_ms,
    end_ms: window.value.end_ms,
    timezone,
  });
  if (!res.ok) return upstream_failed(res, 'availability_unavailable', 'The calendar could not be read, so no times are confirmed.');

  // GHL answers keyed by date with a traceId mixed in; the agent gets a list.
  const summary = summarize_slots(res.data);

  // Remembered so book_appointment can tell a slot that was offered from one
  // the agent invented.
  const state = conversation_state();
  state['offered_slots'] = summary;

  return {
    timezone,
    from: start_date,
    to: end_date,
    days: summary.days,
    total_slots: summary.total_slots,
    message: summary.total_slots
      ? `Read these times back in ${timezone} and ask which one they want. Offer only what is listed here — do not round a time or suggest one that is not in this response. Nothing is booked until they choose and you call book_appointment.`
      : `There are no free slots between ${start_date} and ${end_date}. Say so and ask for other dates. Do NOT offer a time that is not in this response.`,
  };
}

async function handle_book_appointment(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const unset = ghl_ready();
  if (unset) {
    return fail('calendar_not_configured', `The calendar is not set up on this server (${unset} is missing). Nothing was booked. Tell the customer you cannot book right now.`);
  }

  const mobile_number = str(args['mobile_number']);
  const start_time = str(args['start_time']);
  const end_time = str(args['end_time']);
  if (!mobile_number) return missing('mobile_number', 'Ask the customer for their mobile number before booking.');
  if (!start_time) return missing('start_time', 'Pass the slot start exactly as check_appointment_availability listed it.');
  if (!end_time) return missing('end_time', 'Pass the slot end exactly as check_appointment_availability listed it.');

  // Consent is checked here, not asked for in the description. An instruction
  // can be skipped; this cannot — and a booking cannot be undone from here.
  if (!bool(args['confirmed'])) {
    return fail(
      'not_confirmed',
      'Nothing was booked. Read the day, the time and the mobile number back, ask whether to book it, and end your turn. Call this again with confirmed: true only once they have answered yes.',
    );
  }

  const times = check_booking_times(start_time, end_time);
  if (!times.ok) return fail('invalid_times', `${times.reason} Nothing was booked. Use a slot exactly as check_appointment_availability listed it.`);

  const phone = normalize_phone(mobile_number, config.ghl.country_code);
  if (!phone.ok) {
    return fail('invalid_mobile_number', `${phone.reason} Nothing was booked — ask the customer to repeat their number.`);
  }

  const state = conversation_state();

  // Booking the same slot twice is almost always the agent retrying rather than
  // the customer asking again, and the calendar will happily take both.
  const already = state['booked_appointment'] as { id: string; start_time: string } | undefined;
  if (already) {
    return fail(
      'already_booked',
      `Appointment ${already.id} was already booked in this conversation, for ${already.start_time}. Tell the customer it is done. If they want to change it, the shop has to do that — this server cannot.`,
      { appointment_id: already.id, start_time: already.start_time },
    );
  }

  // A slot the agent was never shown is usually one it worked out itself from a
  // customer's "around three-ish". Warned about rather than refused: the check
  // may legitimately have happened in an earlier conversation.
  const offered = state['offered_slots'] as SlotSummary | undefined;
  const was_offered = offered ? slot_is_offered(offered, start_time) : null;

  const location_id = str(args['location_id']) || config.ghl.location_id;

  // The booking API takes a contactId and the agent only has a phone number.
  // Upsert rather than search, so a first-time customer is not a failed booking.
  const contact = await upsert_contact({ location_id, phone: phone.value });
  if (!contact.ok) return upstream_failed(contact, 'contact_failed', 'Nothing was booked — the customer record could not be reached.');

  const entry = (Array.isArray(contact.data) ? contact.data[0] : contact.data) as UpsertedContact | undefined;
  const contact_id = str(entry?.contact?.id);
  if (!contact_id) {
    return fail('contact_failed', `Nothing was booked. The customer record for ${phone.value} came back without an id, so there is nothing to book against. Tell the customer the booking did not go through.`);
  }

  const res = await create_appointment({
    calendar_id: str(args['calendar_id']) || config.ghl.calendar_id,
    location_id,
    contact_id,
    start_time,
    end_time,
    title: str(args['title']) || 'Appointment',
    appointment_status: 'confirmed',
  });
  if (!res.ok) return upstream_failed(res, 'booking_failed', 'The appointment was NOT booked.');

  const appointment_id = str(res.data.id);
  if (appointment_id) state['booked_appointment'] = { id: appointment_id, start_time };

  return {
    status: 'booked',
    ...(appointment_id ? { appointment_id } : {}),
    start_time,
    end_time,
    mobile_number: phone.value,
    title: str(args['title']) || 'Appointment',
    ...(was_offered === false ? { warning: 'this time was not among the slots last offered' } : {}),
    message:
      `Booked for ${start_time}. Confirm the day and time back to the customer${appointment_id ? ` and give them reference ${appointment_id}` : ''}. ` +
      'Do not offer to move or cancel it — this server cannot, and the shop would have to.' +
      (was_offered === false ? ' NOTE: this time was not in the slots last offered, so check with the shop that it was genuinely free.' : ''),
  };
}

// ── 3. Name → handler ───────────────────────────────────────────────

export const APPOINTMENT_TOOL_HANDLERS: ToolHandlerMap = {
  check_appointment_availability: handle_check_appointment_availability,
  book_appointment: handle_book_appointment,
};
