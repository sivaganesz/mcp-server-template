/**
 * Who the current tool call is for.
 *
 * The calling platform identifies the end user in request headers. Threading
 * those through every function as an argument would touch every signature, so
 * they go in AsyncLocalStorage instead: set once per request, readable anywhere
 * beneath it, and impossible to leak between concurrent calls the way a module
 * level `let` would.
 *
 * Use `identity()` to scope anything per-caller — sessions, carts, rate limits.
 * Never trust it for authorisation: headers are set by the platform, and the
 * platform is what the shared secret authenticates.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Request } from 'express';

export interface Identity {
  /** Stable per conversation. The natural key for per-conversation state. */
  conversation_id: string;
  user_id: string;
  name: string;
  email: string;
  phone: string;
}

const EMPTY: Identity = { conversation_id: '', user_id: '', name: '', email: '', phone: '' };

const store = new AsyncLocalStorage<Identity>();

/** Header names the platform sends. Adjust the prefix to match yours. */
const HEADER = {
  conversation_id: 'x-sa-conversation-id',
  user_id: 'x-sa-end-user-id',
  name: 'x-sa-end-user-name',
  email: 'x-sa-end-user-email',
  phone: 'x-sa-end-user-phone',
} as const;

export function identity_from_request(req: Request): Identity {
  const read = (header: string): string => {
    const value = req.headers[header];
    return (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
  };
  return {
    conversation_id: read(HEADER.conversation_id),
    user_id: read(HEADER.user_id),
    name: read(HEADER.name),
    email: read(HEADER.email),
    phone: read(HEADER.phone),
  };
}

/** Runs `fn` with this identity visible to everything it calls. */
export function with_identity<T>(value: Identity, fn: () => T): T {
  return store.run(value, fn);
}

/** Never null — an unidentified caller reads as empty strings, not a crash. */
export function identity(): Identity {
  return store.getStore() ?? EMPTY;
}

/**
 * The key to scope per-caller state by.
 *
 * Conversation first, then user. Falling back to a shared constant is
 * deliberate and worth understanding: without headers every caller shares one
 * bucket, which is fine for a read-only catalogue and very much not fine for a
 * cart. If your tools hold per-user state, refuse the call instead.
 */
export function caller_key(): string {
  const id = identity();
  return id.conversation_id || id.user_id || '_shared';
}
