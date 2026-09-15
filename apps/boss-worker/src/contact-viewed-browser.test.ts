import {describe, expect, it, vi} from "vitest";
import {runInNewContext} from "node:vm";
import type {Frame} from "puppeteer-core";
import {retryViewedListRead, viewedHistoryDomReady} from "./contact-viewed-browser.js";

describe("first entry into BOSS viewing history", () => {
  it("waits for the history component rather than accepting an updated URL with old recommendation data", async () => {
    const vm = {status:0, jobId:"-1"};
    let menuWidth = 100;
    const document = {querySelector:(selector: string) => selector.startsWith('.card-list')
      ? {__vue__:vm} : {getBoundingClientRect:()=>({width:menuWidth})}};
    const frame = {evaluate:async (script: string) => runInNewContext(script, {document})} as unknown as Frame;
    expect(await viewedHistoryDomReady(frame, "8", "-1")).toBe(false);
    vm.status = 8;
    expect(await viewedHistoryDomReady(frame, "8", "-1")).toBe(true);
    menuWidth = 0;
    expect(await viewedHistoryDomReady(frame, "8", "-1")).toBe(false);
    menuWidth = 100;
    vm.jobId = "another-job";
    expect(await viewedHistoryDomReady(frame, "8", "-1")).toBe(false);
  });
  it("reacquires a rendered history frame after the first readiness wait times out", async () => {
    const timeout = Object.assign(new Error("Waiting failed: 15000ms exceeded"), {name:"TimeoutError"});
    const read = vi.fn().mockRejectedValueOnce(timeout).mockResolvedValue({id:"original-geek-id"});
    expect(await retryViewedListRead(read)).toEqual({id:"original-geek-id"});
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("bounds transient recovery and never retries an ambiguous identity", async () => {
    const read = vi.fn().mockRejectedValue(new Error("detached Frame"));
    await expect(retryViewedListRead(read)).rejects.toThrow("detached Frame");
    expect(read).toHaveBeenCalledTimes(2);
    const ambiguous = vi.fn().mockRejectedValue(new Error("BOSS_TARGET_AMBIGUOUS"));
    await expect(retryViewedListRead(ambiguous)).rejects.toThrow("BOSS_TARGET_AMBIGUOUS");
    expect(ambiguous).toHaveBeenCalledOnce();
  });
  it("reacquires a frame when Puppeteer wraps frame replacement in a selector error", async () => {
    const error = new Error('Waiting for selector `.tab-item` failed', {
      cause: new Error("waitForFunction failed: frame got detached.")
    });
    const read = vi.fn().mockRejectedValueOnce(error).mockResolvedValue({id: "original-geek-id"});
    expect(await retryViewedListRead(read)).toEqual({id: "original-geek-id"});
    expect(read).toHaveBeenCalledTimes(2);
  });
});
