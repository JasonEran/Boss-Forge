import type { HTTPResponse, Page } from "puppeteer-core";
import { describe, expect, it, vi } from "vitest";
import { waitForRecommendationUpdate } from "./boss-recommendation-readiness.js";

const response = (body: unknown, url = "https://www.zhipin.com/wapi/zpjob/rec/geek/list?page=1") => ({ url: () => url, ok: () => true, json: async () => body }) as HTTPResponse;
describe("recommendation response readiness", () => {
  it("accepts only the first recommendation page on BOSS, with the exact job binding", async () => {
    const real = response({ code: 0, zpData: { encryptJobId: "job-a", geekList: [{ encryptGeekId: "new-person" }] } });
    const page = { url: () => "https://www.zhipin.com/web/chat/recommend", waitForResponse: vi.fn(async predicate => {
      expect(predicate(response({}, "https://other.example/wapi/zpjob/rec/geek/list?page=1"))).toBe(false);
      expect(predicate(response({}, "https://www.zhipin.com/wapi/chat/poll"))).toBe(false);
      expect(predicate(response({}, "https://www.zhipin.com/wapi/zpjob/rec/geek/list?page=2"))).toBe(false);
      expect(predicate(real)).toBe(true); return real;
    }) };
    expect(await waitForRecommendationUpdate(page as unknown as Page, async () => {}, "job-a")).toEqual({ geekIds: ["new-person"] });
  });
  it.each([
    { code: 0, zpData: { encryptJobId: "other-job", geekList: [] } },
    { code: 37, zpData: { encryptJobId: "job-a", geekList: [] } },
    { code: 0, zpData: { encryptJobId: "job-a" } },
  ])("never treats a rejected, incomplete or different-job response as ready: %j", async body => {
    const page = { waitForResponse: async () => response(body) } as unknown as Page;
    await expect(waitForRecommendationUpdate(page, async () => {}, "job-a")).rejects.toThrow("BOSS_RECOMMEND_UNVERIFIED");
  });
  it.each([undefined, null])('requires rendered empty confirmation for BOSS success with an omitted geekList (%s)', async geekList => {
    const page = { waitForResponse: async () => response({ code: 0, zpData: {
      encryptJobId: 'job-a', page: 1, hasMore: true, geekList,
    } }) } as unknown as Page;
    expect(await waitForRecommendationUpdate(page, async () => {}, 'job-a')).toEqual({ geekIds: [], emptyConfirmationRequired: true, pageNumber: 1, hasMore: true });
  });
  it('waits for the requested next page and rejects a different page in its body', async () => {
    const real = response({ code: 0, zpData: { encryptJobId: 'job-a', page: 2, hasMore: false, geekList: [] } }, 'https://www.zhipin.com/wapi/zpjob/rec/geek/list?page=2');
    const page = { url: () => 'https://www.zhipin.com/web/chat/recommend', waitForResponse: vi.fn(async predicate => {
      expect(predicate(response({}))).toBe(false);
      expect(predicate(real)).toBe(true); return real;
    }) } as unknown as Page;
    expect(await waitForRecommendationUpdate(page, async () => {}, 'job-a', 2)).toEqual({ geekIds: [], pageNumber: 2, hasMore: false });
    const wrong = { waitForResponse: async () => response({ code: 0, zpData: { encryptJobId: 'job-a', page: 1, geekList: [] } }) } as unknown as Page;
    await expect(waitForRecommendationUpdate(wrong, async () => {}, 'job-a', 2)).rejects.toThrow('分页响应与请求不一致');
  });
  it("cancels its pending response listener when the browser action fails", async () => {
    let signal: AbortSignal | undefined;
    const page = { waitForResponse: (_predicate: unknown, options: { signal: AbortSignal }) => {
      signal = options.signal;
      return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("aborted"))));
    } } as unknown as Page;
    await expect(waitForRecommendationUpdate(page, async () => { throw new Error("detached frame"); })).rejects.toThrow("detached frame");
    expect(signal?.aborted).toBe(true);
  });
});
