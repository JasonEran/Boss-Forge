import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { consumeLoginRefreshRequest } from "./login-refresh-request.js";
import { readLoginMethod } from "./login-method.js";

const directories: string[] = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "boss-login-refresh-"));
  directories.push(directory);
  return { directory, path: join(directory, "request.json") };
}
function request() { return JSON.stringify({requestId: randomUUID(), requestedAt: new Date().toISOString()}); }
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, {recursive:true, force:true}))); });

describe("login refresh request consumption", () => {
  it("keeps the selected login method through recovery and ordinary refreshes", async () => {
    const { path, directory } = await fixture();
    expect(await readLoginMethod(directory)).toBe("wechat");
    await writeFile(path, JSON.stringify({ ...JSON.parse(request()), loginMethod: "boss_app" }));
    await consumeLoginRefreshRequest(path, async value => {
      expect(value.loginMethod).toBe("boss_app");
      expect(await readLoginMethod(directory)).toBe("boss_app");
    });
    await writeFile(path, request());
    await consumeLoginRefreshRequest(path);
    expect(await readLoginMethod(directory)).toBe("boss_app");
    await writeFile(path, JSON.stringify({ ...JSON.parse(request()), loginMethod: "wechat" }));
    await consumeLoginRefreshRequest(path);
    expect(await readLoginMethod(directory)).toBe("wechat");
  });

  it("rejects an unsupported mode without changing the persisted choice", async () => {
    const { path, directory } = await fixture();
    await writeFile(path, JSON.stringify({ ...JSON.parse(request()), loginMethod: "sms" }));
    expect(await consumeLoginRefreshRequest(path)).toBe(false);
    expect(await readLoginMethod(directory)).toBe("wechat");
  });
  it("consumes an accepted refresh once even when readers race", async () => {
    const {path, directory} = await fixture();
    await writeFile(path, request());
    const onConsumed = vi.fn(async () => undefined);
    const results = await Promise.all([consumeLoginRefreshRequest(path, onConsumed), consumeLoginRefreshRequest(path, onConsumed)]);
    expect(results.sort()).toEqual([false, true]);
    expect(onConsumed).toHaveBeenCalledTimes(1);
    expect(await readdir(directory)).toEqual([]);
    expect(await consumeLoginRefreshRequest(path)).toBe(false);
  });

  it("does not delete a newer API request when the prior action finishes", async () => {
    const {path} = await fixture();
    await writeFile(path, request());
    expect(await consumeLoginRefreshRequest(path, async () => { await writeFile(path, request()); })).toBe(true);
    expect(await consumeLoginRefreshRequest(path)).toBe(true);
    expect(await consumeLoginRefreshRequest(path)).toBe(false);
  });

  it.each(["{broken", "null", "[]", "{}", JSON.stringify({requestId:randomUUID(),requestedAt:"invalid"})])("does not restart for malformed requests: %s", async raw => {
    const {path, directory} = await fixture();
    await writeFile(path, raw);
    const onConsumed = vi.fn(async () => undefined);
    expect(await consumeLoginRefreshRequest(path, onConsumed)).toBe(false);
    expect(onConsumed).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });
});
