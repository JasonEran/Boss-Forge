import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { remoteOnlyBrowserEnabled } from "@joohw/boss-cli/dist/browser/cdp_browser.js";
import { describe, expect, it } from "vitest";

describe("patched boss-cli remote-only browser mode", () => {
  it("recognizes only explicit truthy remote-only configuration", () => {
    expect(remoteOnlyBrowserEnabled({ BOSS_BROWSER_REMOTE_ONLY: "1" })).toBe(true);
    expect(remoteOnlyBrowserEnabled({ BOSS_BROWSER_REMOTE_ONLY: "true" })).toBe(true);
    expect(remoteOnlyBrowserEnabled({ BOSS_BROWSER_REMOTE_ONLY: "0" })).toBe(false);
    expect(remoteOnlyBrowserEnabled({})).toBe(false);
  });

  it("fails after the CDP probe and before any spawn in remote-only mode", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "packages/boss-cli-adapter/node_modules/@joohw/boss-cli/dist/browser/cdp_browser.js"
      ),
      "utf8"
    );
    const probe = source.indexOf("probeRemoteDebuggingWsEndpoint(REMOTE_DEBUGGING_PORT");
    const remoteOnlyGuard = source.indexOf("if (remoteOnlyBrowserEnabled())", probe);
    const spawn = source.indexOf("const proc = spawn(", remoteOnlyGuard);
    expect(probe).toBeGreaterThan(-1);
    expect(remoteOnlyGuard).toBeGreaterThan(probe);
    expect(spawn).toBeGreaterThan(remoteOnlyGuard);
    expect(source.slice(remoteOnlyGuard, spawn)).toContain(
      "BOSS_BROWSER_REMOTE_ONLY_UNAVAILABLE"
    );
  });

  it("passes the mode through the shell-free adapter runner", () => {
    const source = readFileSync(
      resolve(process.cwd(), "packages/boss-cli-adapter/src/runner.ts"),
      "utf8"
    );
    expect(source).toContain('"BOSS_BROWSER_REMOTE_ONLY"');
  });
});
