/**
 * GoHighLevel endpoints — calendars, contacts, appointments.
 *
 * A second upstream, so every call names its own base URL and carries its own
 * Authorization. It shares the transport in request.ts deliberately: the
 * timeout, the retry rule and the way a failure is described must be identical
 * across services, and the way they stop being identical is someone copying
 * that file.
 *
 * GHL versions its API per endpoint family rather than globally, and gets it
 * wrong loudly — the wrong `Version` comes back as a 404 or an empty body
 * rather than a version error. Each function below therefore states its own
 * version rather than inferring one from the HTTP method.
 */
import { config } from '../../config.js';
import { api_request, type ApiResult, type RequestOptions } from './request.js';

/** `GET /calendars/:id/free-slots` */
const VERSION_CALENDARS_READ = 'v3';
/** `POST /calendars/events/appointments`, `POST /contacts/upsert` */
const VERSION_WRITE = '2021-07-28';

function ghl_request<T>(path: string, version: string, opts: RequestOptions = {}): Promise<ApiResult<T>> {
  return api_request<T>(path, {
    ...opts,
    base_url: config.ghl.base_url,
    headers: {
      Authorization: `Bearer ${config.ghl.token}`,
      Version: version,
      ...opts.headers,
    },
  });
}

/**
 * Free slots for a calendar.
 *
 * The response is keyed by date — `{ "2026-09-16": { slots: [...] }, traceId }`
 * — so it is reshaped in lib/appointments.ts before the agent sees it.
 */
export interface FreeSlotsResponse {
  [date: string]: { slots?: string[] } | string | undefined;
}

export async function fetch_free_slots(input: {
  calendar_id: string;
  start_ms: number;
  end_ms: number;
  timezone: string;
}): Promise<ApiResult<FreeSlotsResponse>> {
  return ghl_request<FreeSlotsResponse>(`/calendars/${encodeURIComponent(input.calendar_id)}/free-slots`, VERSION_CALENDARS_READ, {
    query: { startDate: input.start_ms, endDate: input.end_ms, timezone: input.timezone },
  });
}

/**
 * Resolve a phone number to a contact, creating one if the number is new.
 *
 * The booking endpoint takes a contactId and the caller only ever has a mobile
 * number, so this is the step between. Upsert rather than search: a first-time
 * customer has no contact yet, and a booking that fails because the lead does
 * not exist is a booking lost for no reason.
 */
export interface UpsertedContact {
  contact?: { id?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export async function upsert_contact(input: { location_id: string; phone: string }): Promise<ApiResult<UpsertedContact | UpsertedContact[]>> {
  return ghl_request<UpsertedContact | UpsertedContact[]>('/contacts/upsert', VERSION_WRITE, {
    method: 'POST',
    body: { locationId: input.location_id, phone: input.phone },
    // A write. A retry would create a second contact or a duplicate lead.
    retry: false,
  });
}

export interface AppointmentCreated {
  id?: string;
  appointmentStatus?: string;
  startTime?: string;
  endTime?: string;
  [key: string]: unknown;
}

export async function create_appointment(input: {
  calendar_id: string;
  location_id: string;
  contact_id: string;
  start_time: string;
  end_time: string;
  title: string;
  appointment_status: string;
}): Promise<ApiResult<AppointmentCreated>> {
  return ghl_request<AppointmentCreated>('/calendars/events/appointments', VERSION_WRITE, {
    method: 'POST',
    body: {
      calendarId: input.calendar_id,
      locationId: input.location_id,
      contactId: input.contact_id,
      startTime: input.start_time,
      endTime: input.end_time,
      title: input.title,
      appointmentStatus: input.appointment_status,
    },
    // Never repeated: a retried booking puts two appointments in the calendar
    // and the customer is told about one of them.
    retry: false,
  });
}
