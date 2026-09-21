/**
 * Timing for anything that crosses a process boundary.
 *
 * Every slow tool call this template has been used for turned out to be one
 * upstream request nobody had measured. Paired START/END lines make that visible
 * without a profiler: the START line proves the call was made, the END line
 * carries the duration, and an END with no START is a code path that returned
 * early.
 */
import { config } from './config.js';

export function log_start(tag: string, fields: Record<string, unknown>): number {
  if (config.log_timing) console.log(`[${tag} START]`, { ...fields, started_at: new Date().toISOString() });
  return Date.now();
}

export function log_end(tag: string, started_ms: number, fields: Record<string, unknown>): void {
  if (config.log_timing) console.log(`[${tag} END]`, { ...fields, duration_ms: Date.now() - started_ms });
}

/** Secrets travel in headers and query strings; neither belongs in a log line. */
export function redact(value: string): string {
  return value
    .replace(/([?&](api_?key|token|secret|password|signature)=)[^&]+/gi, '$1***')
    .replace(/(Bearer\s+)[\w.\-]+/gi, '$1***');
}
