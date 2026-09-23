/**
 * /workspace held its scoping conversation in bare useState with no
 * persistence: a reload, or a phone locking mid-conversation, silently threw
 * away a transcript that was on its way to becoming a lead (HANDOFF.md §6c
 * #14). lib/ai/session.ts is the fix — a storage-agnostic save/load/clear
 * pair the client component wires to window.localStorage.
 *
 * Tested here against a fake Storage rather than jsdom, and every failure
 * mode (missing storage, corrupt JSON, a non-array payload, a storage that
 * throws) must fail closed to an empty conversation — the same contract
 * tests/site/unreachable-store.test.ts established for the token-addressed
 * pages: a broken restore degrades to "start over", it never throws into a
 * render.
 */
import { describe, expect, it } from "vitest";
import {
  clearWorkspaceSession,
  loadWorkspaceSession,
  saveWorkspaceSession,
  type SessionStorageLike,
} from "@/lib/ai/session";
import type { ChatMessage } from "@/components/ai/types";

const KEY = "gridforge.workspace.session.v1";

function fakeStorage(initial: Record<string, string> = {}): SessionStorageLike {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => void store.set(k, v),
    removeItem: (k) => void store.delete(k),
  };
}

function throwingStorage(): SessionStorageLike {
  return {
    getItem: () => {
      throw new Error("storage unavailable");
    },
    setItem: () => {
      throw new Error("quota exceeded");
    },
    removeItem: () => {
      throw new Error("storage unavailable");
    },
  };
}

const transcript: ChatMessage[] = [
  { role: "user", content: "How many racks does our hall carry today?" },
  { role: "assistant", content: "See the canvas." },
];

describe("workspace session — round trip", () => {
  it("saves and restores a transcript", () => {
    const storage = fakeStorage();
    saveWorkspaceSession(storage, transcript);
    expect(loadWorkspaceSession(storage)).toEqual(transcript);
  });

  it("clears the stored transcript on reset", () => {
    const storage = fakeStorage();
    saveWorkspaceSession(storage, transcript);
    clearWorkspaceSession(storage);
    expect(loadWorkspaceSession(storage)).toEqual([]);
  });

  it("saving an empty transcript removes the slot rather than storing []", () => {
    const storage = fakeStorage({ [KEY]: JSON.stringify(transcript) });
    saveWorkspaceSession(storage, []);
    expect(storage.getItem(KEY)).toBeNull();
  });
});

describe("workspace session — fails closed", () => {
  it("no storage (SSR, undefined) returns an empty conversation", () => {
    expect(loadWorkspaceSession(undefined)).toEqual([]);
  });

  it("nothing stored yet returns an empty conversation", () => {
    expect(loadWorkspaceSession(fakeStorage())).toEqual([]);
  });

  it("corrupt JSON returns an empty conversation, not a throw", () => {
    const storage = fakeStorage({ [KEY]: "{not json" });
    expect(loadWorkspaceSession(storage)).toEqual([]);
  });

  it("a non-array payload returns an empty conversation, not the payload", () => {
    const storage = fakeStorage({ [KEY]: JSON.stringify({ hijacked: true }) });
    expect(loadWorkspaceSession(storage)).toEqual([]);
  });

  it("a storage that throws on read returns an empty conversation", () => {
    expect(loadWorkspaceSession(throwingStorage())).toEqual([]);
  });

  it("a storage that throws on write does not throw out of saveWorkspaceSession", () => {
    expect(() => saveWorkspaceSession(throwingStorage(), transcript)).not.toThrow();
  });

  it("a storage that throws on remove does not throw out of clearWorkspaceSession", () => {
    expect(() => clearWorkspaceSession(throwingStorage())).not.toThrow();
  });

  it("undefined storage is a no-op for save and clear, not a throw", () => {
    expect(() => saveWorkspaceSession(undefined, transcript)).not.toThrow();
    expect(() => clearWorkspaceSession(undefined)).not.toThrow();
  });
});
