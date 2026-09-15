import { runInNewContext } from "node:vm";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { getBossCliInstallation } from "./installation.js";

let dispatch: (frame: {evaluate: (script: string) => Promise<unknown>}, input: {candidateId: string; jobId: string; body: string}, execute?: boolean) => Promise<unknown>;
beforeAll(async () => {
  const {packageRoot} = await getBossCliInstallation();
  dispatch = (await import(pathToFileURL(`${packageRoot}/dist/toolset/approved-greet.js`).href)).dispatchApprovedGreeting;
});
const input = { candidateId: "original-geek", jobId: "amazon-job", body: "你好，想交流亚马逊运营岗位。" };
function fixture() {
  const chatStop = vi.fn();
  const vm = { personInfo: {encryptGeekId: input.candidateId, encryptJobId: "old-other-job"},
    onlineJobList: [{jid: input.jobId}], chatStop, isFriend: false as boolean | number, isLoadding: false };
  const button = {disabled:false, classList:{contains:()=>false}};
  const card = {querySelector:(selector: string) => selector === ".card-inner" ? {getAttribute:()=>input.candidateId} : button,
    __vue__: {$refs: {"button-chat": vm}}};
  const cards = [card];
  const frame = {evaluate:async (script: string) => runInNewContext(script, {document:{querySelectorAll:()=>cards}})};
  return {frame, vm, cards, chatStop};
}
describe("native greeting with an approved job", () => {
  it("passes the approved job and body once, even when history records another viewing job", async () => {
    const f = fixture();
    expect(await dispatch(f.frame, input)).toEqual({candidateId:input.candidateId, jobId:input.jobId, invoked:true});
    expect(f.chatStop).toHaveBeenCalledExactlyOnceWith({jobId:input.jobId, greet:input.body});
    expect(f.vm.personInfo.encryptJobId).toBe("old-other-job");
  });
  it("can verify the real native entry without calling it", async () => {
    const f = fixture();
    expect(await dispatch(f.frame, input, false)).toEqual({candidateId:input.candidateId, jobId:input.jobId, invoked:false});
    expect(f.chatStop).not.toHaveBeenCalled();
  });
  it.each(["wrong-person", "missing-job", "duplicate", "already-contacted", "numeric-friend", "busy"])("does not invoke the handler for %s", async reason => {
    const f = fixture();
    if (reason === "wrong-person") f.vm.personInfo.encryptGeekId = "another-geek";
    if (reason === "missing-job") f.vm.onlineJobList = [];
    if (reason === "duplicate") f.cards.push(f.cards[0]!);
    if (reason === "already-contacted") f.vm.isFriend = true;
    if (reason === "numeric-friend") f.vm.isFriend = 1;
    if (reason === "busy") f.vm.isLoadding = true;
    expect(await dispatch(f.frame, input)).toEqual({
      candidateId: input.candidateId, jobId: input.jobId, invoked: false,
      blocked: {code: expect.stringMatching(/^BOSS_GREET_/u), message: expect.any(String)}
    });
    expect(f.chatStop).not.toHaveBeenCalled();
  });
  it("identifies existing contact even when only Continue chat is rendered", async () => {
    const f = fixture();
    f.vm.isFriend = 1;
    const query = f.cards[0]!.querySelector;
    f.cards[0]!.querySelector = selector => selector === ".card-inner" ? query(selector) : null!;
    expect(await dispatch(f.frame, input)).toMatchObject({
      invoked: false, blocked: {code: "BOSS_GREET_ALREADY_CONTACTED"}
    });
    expect(f.chatStop).not.toHaveBeenCalled();
  });
  it("does not turn an error from the invoked handler into a pre-write rejection", async () => {
    const f = fixture();
    f.chatStop.mockImplementation(() => {throw new Error("connection lost after invocation");});
    await expect(dispatch(f.frame, input)).rejects.toThrow("connection lost after invocation");
    expect(f.chatStop).toHaveBeenCalledTimes(1);
  });
});
