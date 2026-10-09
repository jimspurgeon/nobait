/**
 * Unit tests for the background message-handler response pattern.
 *
 * The listener MUST use the Firefox-native async pattern: return a
 * Promise from the listener (OnMessageListenerAsync) so that
 * `browser.runtime.sendMessage` awaiters in content scripts receive the
 * resolved value. The old Chrome-callback pattern (returning `true` and
 * calling `sendResponse` later) never reaches promise-based awaiters on
 * Firefox.
 *
 * These tests simulate a Firefox-style listener invocation: the listener's
 * return value is consumed by the runtime, and `sendResponse` is NEVER
 * called.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Heavy collaborators of the background module: stubbed out so importing
// the module has no real side effects beyond listener registration.
vi.mock("./scheduler", () => ({
  scheduler: { onResult: vi.fn().mockReturnValue(() => {}), evaluate: vi.fn() },
}));
vi.mock("../storage/cache", () => ({
  cacheDB: {
    init: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  },
}));
vi.mock("../ai/factory", () => ({
  aiProviderFactory: {
    initialize: vi.fn().mockResolvedValue(null),
  },
}));
vi.mock("../ai/gemini", () => ({
  GeminiProvider: class {},
}));
vi.mock("./factcheck", () => ({
  evaluateFactCheck: vi.fn().mockResolvedValue({ result: null }),
  StampTier: { UNSURE: "unsure" },
}));

type ListenerFn = (
  message: unknown,
  sender: unknown,
  sendResponse?: (response: unknown) => void,
) => unknown;

/** Minimal Firefox-style runtime stub capturing registered listeners. */
function installFirefoxRuntime(): ListenerFn[] {
  const listeners: ListenerFn[] = [];
  (globalThis as Record<string, unknown>).browser = {
    runtime: {
      onMessage: {
        addListener: (cb: ListenerFn) => listeners.push(cb),
      },
      sendMessage: vi.fn(),
    },
    tabs: { query: vi.fn(), sendMessage: vi.fn() },
  };
  return listeners;
}

describe("background message handler (Firefox-native response pattern)", () => {
  let listeners: ListenerFn[];

  beforeEach(async () => {
    vi.resetModules();
    listeners = installFirefoxRuntime();
    await import("./index");
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).browser;
    delete (globalThis as Record<string, unknown>).chrome;
  });

  it("registers the listener via webext runtime", () => {
    expect(listeners.length).toBeGreaterThanOrEqual(1);
  });

  it("returns a Promise for async messages and never calls sendResponse (EVALUATE_VIDEO)", async () => {
    const listener = listeners[0]!;
    const sendResponse = vi.fn();

    const ret = listener(
      { type: "EVALUATE_VIDEO", videoId: "abc12345678", title: "T" },
      { tab: {} },
      sendResponse,
    );

    // Firefox consumes the returned Promise; it must be a Promise…
    expect(ret).toBeInstanceOf(Promise);

    // …and sendResponse must NEVER be called (old Chrome-callback style).
    const response = await ret;
    expect(sendResponse).not.toHaveBeenCalled();

    // The response shape content scripts rely on.
    const env = response as { success: boolean; result?: unknown };
    expect(env.success).toBe(true);
  });

  it("responds via returned Promise for GET_CACHE_STATUS", async () => {
    const listener = listeners[0]!;
    const sendResponse = vi.fn();

    const ret = listener({ type: "GET_CACHE_STATUS" }, {}, sendResponse);
    expect(ret).toBeInstanceOf(Promise);
    const response = (await ret) as { success: boolean };
    expect(response.success).toBe(true);
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it("returns an error envelope via Promise for unknown message types", async () => {
    const listener = listeners[0]!;
    const sendResponse = vi.fn();

    const ret = listener({ type: "NO_SUCH_TYPE" }, {}, sendResponse);
    expect(ret).toBeInstanceOf(Promise);
    const response = (await ret) as { success: boolean; error: string };
    expect(response.success).toBe(false);
    expect(response.error).toContain("Unknown message type");
    expect(sendResponse).not.toHaveBeenCalled();
  });
});
