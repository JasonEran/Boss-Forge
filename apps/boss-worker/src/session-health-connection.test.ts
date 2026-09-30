import { afterEach, describe, expect, it, vi } from "vitest";
import puppeteer from "puppeteer-core";
import { inspectBossBrowserSession, SESSION_HEALTH_TIMEOUT_MS } from "./session-health.js";

class HealthSocket extends EventTarget {
  static sockets: HealthSocket[] = [];
  close = vi.fn(() => this.dispatchEvent(new Event("close")));
  send = vi.fn();
  constructor() {
    super();
    HealthSocket.sockets.push(this);
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }
}

const fetcher = vi.fn<typeof fetch>(async (input) => new Response(JSON.stringify(
  String(input).endsWith("/json/version")
    ? { webSocketDebuggerUrl: "ws://127.0.0.1:53470/devtools/browser/test" }
    : [{ type: "page", url: "https://www.zhipin.com/web/chat/recommend" }]
)));

function setup() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  HealthSocket.sockets = [];
  vi.stubGlobal("WebSocket", HealthSocket);
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("bounded browser health connections", () => {
  it("closes the socket when connect fails before returning a Browser", async () => {
    setup();
    vi.spyOn(puppeteer, "connect").mockRejectedValue(new Error("Page.enable timed out"));
    expect(await inspectBossBrowserSession(53470, fetcher)).toMatchObject({ state: "unavailable" });
    expect(HealthSocket.sockets).toHaveLength(1);
    expect(HealthSocket.sockets[0]!.close).toHaveBeenCalledTimes(1);
  });

  it("bounds a connect that never settles and cleans every repeated probe", async () => {
    setup();
    vi.spyOn(puppeteer, "connect").mockImplementation(() => new Promise(() => {}));
    for (let i = 0; i < 3; i++) {
      const result = inspectBossBrowserSession(53470, fetcher);
      await vi.advanceTimersByTimeAsync(SESSION_HEALTH_TIMEOUT_MS);
      expect(await result).toMatchObject({ state: "unavailable", message: expect.stringContaining("15000ms") });
      expect(HealthSocket.sockets[i]!.close).toHaveBeenCalledTimes(1);
    }
  });

  it("bounds a page probe that hangs after a successful connection", async () => {
    setup();
    const browser = { pages: vi.fn(() => new Promise(() => {})), disconnect: vi.fn(async () => {}) };
    vi.spyOn(puppeteer, "connect").mockResolvedValue(browser as never);
    const result = inspectBossBrowserSession(53470, fetcher);
    await vi.advanceTimersByTimeAsync(SESSION_HEALTH_TIMEOUT_MS);
    expect(await result).toMatchObject({ state: "unavailable" });
    expect(browser.disconnect).toHaveBeenCalledOnce();
    expect(HealthSocket.sockets[0]!.close).toHaveBeenCalledOnce();
  });

  it("returns a verification challenge without opening a browser connection", async () => {
    setup();
    const connect = vi.spyOn(puppeteer, "connect");
    const riskFetch = vi.fn<typeof fetch>(async () => new Response(JSON.stringify([
      { type: "page", url: "https://www.zhipin.com/web/user/safe/verify" }
    ])));
    expect(await inspectBossBrowserSession(53470, riskFetch)).toMatchObject({ state: "risk_controlled" });
    expect(connect).not.toHaveBeenCalled();
    expect(HealthSocket.sockets).toHaveLength(0);
  });
});
