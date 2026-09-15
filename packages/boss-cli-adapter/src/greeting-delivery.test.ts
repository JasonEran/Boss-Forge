import {runInNewContext} from "node:vm";
import {readChatRowCandidateId} from "@joohw/boss-cli/dist/toolset/chat.js";
import {verifyGreetingChatStartReceipt} from "@joohw/boss-cli/dist/toolset/greet.js";
import {verifyGreetingDeliveryEvidence, type GreetingDeliveryEvidence} from "@joohw/boss-cli/dist/toolset/greeting-delivery.js";
import {describe, expect, it} from "vitest";

const body = "你好，我们正在招聘亚马逊运营。想邀请你进一步交流。";
const startedAt = Date.parse("2026-09-09T07:38:15.827Z");
const expected = {candidateId:"encrypted-geek-01", providerCandidateId:"513402904", body, startedAt};
const evidence: GreetingDeliveryEvidence = {
  candidateId:expected.candidateId, providerCandidateId:513402904,
  conversationId:"513402904-0", observedAt:startedAt+5000,
  messages:[{mid:"384206012461319",serverMid:"",time:startedAt+169,
    status:1,isSelf:true,type:"text",text:body}]
};
const request = {
  requestUrl:"https://www.zhipin.com/wapi/zpjob/chat/start", requestMethod:"POST",
  requestPostData:new URLSearchParams({gid:expected.candidateId,jid:"amazon-job",greet:body}).toString(),
  payload:{code:0,zpData:{status:1,newfriend:1,greeting:"",geekId:513402904}},
  expectedCandidateId:expected.candidateId,expectedJobId:"amazon-job",expectedGreetingId:"job-greeting",
  expectedBody:body,startedAt,deliveryEvidence:evidence
};

describe("real BOSS greeting receipt regression",()=>{
  it("accepts an empty greeting and numeric response ID only with the exact delivered chat message",()=>{
    expect(verifyGreetingChatStartReceipt(request)).toMatchObject({candidateId:expected.candidateId,
      providerCandidateId:expected.candidateId,responseStatus:1,newFriend:1});
    expect(verifyGreetingDeliveryEvidence(evidence,expected)).toMatchObject({
      providerCandidateId:"513402904", serverMid:"384206012461319",text:body,
      sentAt:new Date(startedAt+169).toISOString()
    });
  });
  it("does not treat a code-0 response with no chat evidence as delivery",()=>{
    const {deliveryEvidence:_,...missing}=request;
    expect(()=>verifyGreetingChatStartReceipt(missing)).toThrow("BOSS_GREET_POST_WRITE_TARGET_MISMATCH");
  });
  it.each(["wrong-response-id","wrong-conversation","missing-message","old-message","future-message","pending","incoming","different-body","no-id","duplicate-delivery","missing-start"])("rejects %s",reason=>{
    const e=structuredClone(evidence);const target={...expected};const m=e.messages[0]!;
    if(reason==="wrong-response-id")target.providerCandidateId="99999";
    if(reason==="wrong-conversation")e.candidateId="another-person";
    if(reason==="missing-message")e.messages=[];
    if(reason==="old-message")m.time=startedAt-60_000;
    if(reason==="future-message")m.time=startedAt+60_000;
    if(reason==="pending")m.status=0;
    if(reason==="incoming")m.isSelf=false;
    if(reason==="different-body")m.text="你好";
    if(reason==="no-id")m.mid="";
    if(reason==="duplicate-delivery")e.messages.push({...m,mid:"another-server-id"});
    if(reason==="missing-start")target.startedAt=NaN;
    expect(()=>verifyGreetingDeliveryEvidence(e,target)).toThrow(/BOSS_GREET_POST_WRITE_/u);
  });
  it("still rejects a changed request body, explicit returned body mismatch and provider blockers",()=>{
    expect(()=>verifyGreetingChatStartReceipt({...request,requestPostData:request.requestPostData.replace(/greet=.*/u,"greet=changed")})).toThrow("BODY_MISMATCH");
    expect(()=>verifyGreetingChatStartReceipt({...request,payload:{code:0,zpData:{...request.payload.zpData,greeting:"changed"}}})).toThrow("BODY_MISMATCH");
    expect(()=>verifyGreetingChatStartReceipt({...request,payload:{code:0,zpData:{...request.payload.zpData,blockPageData:{reason:"blocked"}}}})).toThrow("BLOCKED");
    expect(()=>verifyGreetingChatStartReceipt({...request,payload:{code:0,zpData:{...request.payload.zpData,newfriend:0}}})).toThrow("NOT_NEW_FRIEND");
  });
});

describe("BOSS chat row stable identity",()=>{
  function row(geek:Record<string,unknown>={},source=geek,attr:string|null=null){
    return {__vue__:{geek,source},getAttribute:()=>attr,querySelector:()=>null,querySelectorAll:()=>[]};
  }
  it("finds the provider-native row without any data-geek attribute",()=>{
    const r=row({encryptUid:expected.candidateId,encryptFriendId:expected.candidateId,friendId:513402904});
    expect(readChatRowCandidateId(r)).toBe(expected.candidateId);
    expect(runInNewContext(`(${readChatRowCandidateId.toString()})(row)`,{row:r,URL})).toBe(expected.candidateId);
  });
  it("keeps legacy DOM support and rejects conflicting identities or name-only matches",()=>{
    expect(readChatRowCandidateId(row({}, {},expected.candidateId))).toBe(expected.candidateId);
    expect(readChatRowCandidateId(row({encryptUid:expected.candidateId},{encryptUid:"other"}))).toBe("");
    expect(readChatRowCandidateId(row({name:"same-name",uid:513402904}))).toBe("");
  });
});

describe("greeting page lifecycle",()=>{
  it("does not replay the callback after a post-write context loss",async()=>{
    const {withBossSessionPage}=await import("@joohw/boss-cli/dist/common/boss_session_page.js");
    const page={isClosed:()=>false,bringToFront:async()=>undefined};
    const run=runInNewContext(`(${withBossSessionPage.toString()})`,{
      withBossSessionLock:(callback:()=>unknown)=>callback(),ensureBrowserSession:async()=>undefined,
      getBrowserRef:()=>({}),getPageRef:()=>page,setSessionPage:()=>undefined,
      installBossPageGuards:async()=>undefined,SHOULD_DISABLE_JS:false,
      sleepRandom:async()=>undefined,CONTEXT_DESTROY_RETRY_MS:{min:0,max:0}
    });
    let calls=0;
    await expect(run(async()=>{calls++;throw new Error("Execution context was destroyed");},{
      ensureChatShell:false,ensureMenuList:false,retryOnContextDestroyed:false
    })).rejects.toThrow("Execution context was destroyed");
    expect(calls).toBe(1);
    calls=0;
    await expect(run(async()=>{calls++;if(calls===1)throw new Error("Execution context was destroyed");return "read recovered";},{
      ensureChatShell:false,ensureMenuList:false
    })).resolves.toBe("read recovered");
    expect(calls).toBe(2);
  });
});
