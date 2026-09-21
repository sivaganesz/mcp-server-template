/**
 * What this conversation has already done.
 *
 * Tool calls arrive independently, so without somewhere to record it the server
 * cannot know that a thing already happened. That matters for the guards worth
 * having: a step that must follow another, an action that must not run twice, a
 * total the caller has already been quoted.
 *
 * In-memory on purpose — it is a cache of conversation context, not a record of
 * anything. A restart loses it, and every guard must fail safe when it is
 * missing. Anything that must survive a restart belongs in a database.
 */
import { config } from './config.js';
import { caller_key } from './identity.js';

/** Add whatever your tools need to remember. The TTL field is required. */
export interface ConversationState {
  expires_at: number;
  [key: string]: unknown;
}

const conversations = new Map<string, ConversationState>();

/**
 * This conversation's state, created on first use and kept alive by being read.
 *
 * Returns a live object: mutate it directly and the change is stored.
 */
export function conversation_state(key: string = caller_key()): ConversationState {
  const now = Date.now();

  // Swept on access rather than on a timer. The map only grows when a call
  // arrives, so an arriving call is exactly when dead entries should go — and
  // it leaves no interval holding the process open.
  for (const [k, v] of conversations) if (v.expires_at <= now) conversations.delete(k);

  const existing = conversations.get(key);
  const state: ConversationState = existing && existing.expires_at > now ? existing : { expires_at: 0 };
  state.expires_at = now + config.conversation_ttl_ms;
  conversations.set(key, state);
  return state;
}

/** Forget one conversation — e.g. when the caller starts over. */
export function reset_conversation(key: string = caller_key()): void {
  conversations.delete(key);
}

/** For /health, and for tests that need to see the map is bounded. */
export function state_size(): number {
  return conversations.size;
}
