import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import type { ParsedCandidate } from "@boss-forge/contracts";
import { findResumeCandidateInPages } from "./resume-list-recovery.js";
import { collectedRecommendJobLabel } from "./resume-source-context.js";

const candidate: ParsedCandidate = {
  index: 1, name: "测试候选人", source: "recommend",
  sourceLocator: { kind: "boss_geek_id", value: "original-candidate-id" },
  fields: { 信息: "上海 / 本科", 经历: "英语教学 5 年" }, evidence: [], raw: "fixture"
};
describe("bounded resume list recovery", () => {
  it("scrolls the real viewport for propagated BODY overflow and preserves nested list scrollers", () => {
    const script = String.raw`
      import {runInNewContext} from 'node:vm';
      import {scrollRecommendationList} from './apps/boss-worker/src/resume-list-recovery.ts';
      function element(height, client, overflow, parent, movable=true) {
        let offset=0;
        return {scrollHeight:height,clientHeight:client,overflow,parentElement:parent,
          get scrollTop(){return offset;},set scrollTop(value){if(movable)offset=Math.max(0,Math.min(value,height-client));},
          dispatchEvent() {}};
      }
      const html=element(4000,780,'visible',null);
      const body=element(4000,780,'scroll',html,false);
      let list=element(3900,3900,'visible',body);
      const document={body,documentElement:html,scrollingElement:html,querySelector:()=>list};
      const frame={evaluate:async(fn,top)=>runInNewContext('('+fn.toString()+')('+JSON.stringify(top)+')',
        {document,getComputedStyle:n=>({overflowY:n.overflow}),Event:class Event{}})};
      const moved=await scrollRecommendationList(frame,false);
      const viewport={moved,html:html.scrollTop,body:body.scrollTop};
      const atEnd=await scrollRecommendationList(frame,false);
      await scrollRecommendationList(frame,true);
      const reset=html.scrollTop;
      const nested=element(2500,500,'auto',body); list=element(2500,2500,'visible',nested);
      const nestedMoved=await scrollRecommendationList(frame,false);
      console.log(JSON.stringify({viewport,atEnd,reset,nested:{moved:nestedMoved,top:nested.scrollTop,html:html.scrollTop}}));
    `;
    const result = JSON.parse(execFileSync(process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script], {
        encoding: "utf8", cwd: new URL("../../../", import.meta.url), timeout: 5_000
      }));
    expect(result).toEqual({ viewport: { moved: true, html: 3220, body: 0 }, atEnd: false,
      reset: 0, nested: { moved: true, top: 2000, html: 0 } });
  });
  it("finds the original candidate in a later loaded batch", async () => {
    const read = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([candidate]);
    const advance = vi.fn().mockResolvedValue(true);
    expect(await findResumeCandidateInPages(candidate, read, advance)).toEqual(candidate);
    expect(advance).toHaveBeenCalledTimes(1);
  });
  it("stops at the list end without inventing a replacement", async () => {
    const different = { ...candidate, sourceLocator: { ...candidate.sourceLocator!, value: "other-candidate-id" }, fields: { 信息: "北京 / 专科" } };
    const read = vi.fn().mockResolvedValue([different]);
    const advance = vi.fn().mockResolvedValue(false);
    expect(await findResumeCandidateInPages(candidate, read, advance)).toBeNull();
    expect(read).toHaveBeenCalledOnce();
  });
  it("bounds an endlessly loading list", async () => {
    const read = vi.fn().mockResolvedValue([]);
    const advance = vi.fn().mockResolvedValue(true);
    expect(await findResumeCandidateInPages(candidate, read, advance, 6)).toBeNull();
    expect(read).toHaveBeenCalledTimes(6);
    expect(advance).toHaveBeenCalledTimes(5);
  });
  it("propagates a login/read failure without repeated scrolling", async () => {
    const advance = vi.fn();
    await expect(findResumeCandidateInPages(candidate, async () => { throw new Error('login expired'); }, advance)).rejects.toThrow('login expired');
    expect(advance).not.toHaveBeenCalled();
  });
  it("does not retry an ambiguous identity", async () => {
    const advance = vi.fn();
    await expect(findResumeCandidateInPages(candidate, async () => [candidate, candidate], advance)).rejects.toThrow('BOSS_TARGET_AMBIGUOUS');
    expect(advance).not.toHaveBeenCalled();
  });
  it("captures the actual job from collection output even without a configured keyword", () => {
    expect(collectedRecommendJobLabel('当前岗位：海外运营（深圳）\n常规推荐')).toBe('海外运营（深圳）');
    expect(collectedRecommendJobLabel('当前岗位：默认\n')).toBeNull();
    expect(collectedRecommendJobLabel('没有岗位信息')).toBeNull();
  });
});
