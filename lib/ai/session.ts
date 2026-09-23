import type { ChatMessage } from "@/components/ai/types";

const SESSION_KEY = "gridforge.workspace.session.v1";

/**
 * The subset of the Storage interface this module needs — so tests can pass
 * a plain object instead of standing up jsdom, and the client component can
 * pass `window.localStorage` unmodified.
 */
export interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Restore a workspace conversation from storage.
 *
 * /workspace held the transcript in bare useState with no persistence: a
 * reload — or a phone locking mid-conversation — silently discarded a
 * scoping conversation that was on its way to becoming a lead. This is the
 * read half of the fix.
 *
 * Every failure mode (no storage, corrupt JSON, a shape that isn't an
 * array) fails closed to an empty conversation, the same pattern
 * tests/site/unreachable-store.test.ts established for the token-addressed
 * pages: a broken restore must degrade to "start over", never throw into a
 * client render.
 */
export function loadWorkspaceSession(storage: SessionStorageLike | undefined): ChatMessage[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(SESSION_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ChatMessage[]) : [];
  } catch {
    return [];
  }
}

/** Persist the current transcript. An empty transcript clears the slot rather than storing `[]`. */
export function saveWorkspaceSession(
  storage: SessionStorageLike | undefined,
  messages: ChatMessage[]
): void {
  if (!storage) return;
  try {
    if (messages.length === 0) {
      storage.removeItem(SESSION_KEY);
      return;
    }
    storage.setItem(SESSION_KEY, JSON.stringify(messages));
  } catch {
    // Storage full or unavailable (private browsing, quota). The conversation
    // still works for this tab; it just will not survive a reload.
  }
}

/** Explicit "start over" — clears the stored transcript. */
export function clearWorkspaceSession(storage: SessionStorageLike | undefined): void {
  if (!storage) return;
  try {
    storage.removeItem(SESSION_KEY);
  } catch {
    // no-op
  }
}
