import { assertCurrentConversationMatches } from "@joohw/boss-cli/dist/toolset/send.js";
import { describe, expect, it } from "vitest";
import {runInNewContext} from 'node:vm';

type MatchSnapshot = {
  matched: boolean;
  selectedName: string;
  detailName: string;
  selectedGeekId: string;
};

function pageReturning(snapshot: MatchSnapshot) {
  return {
    async evaluate(script: string): Promise<MatchSnapshot> {
      expect(script).toContain(".geek-item.selected");
      expect(script).toContain(".base-info-single-container");
      expect(script).toContain("data-geekid");
      return snapshot;
    }
  };
}

describe("patched boss-cli send target guard", () => {
  function nativePage(input:{id?:string;secondId?:string;multiple?:boolean;missing?:boolean;selectedId?:string}) {
    class Element {
      __vue__={conversation$:{encryptUid:input.id??'approved-geek-id',encryptGeekId:input.secondId}};
      textContent='同名候选人';
      getBoundingClientRect(){return {width:600,height:400};}
      querySelector(){return null;}
      querySelectorAll(){return [];}
      closest(){return this;}
      getAttribute(name:string){return name==='data-geekid'?input.selectedId??null:null;}
    }
    const host=new Element();
    return {async evaluate(script:string):Promise<MatchSnapshot>{
      return runInNewContext(script,{HTMLElement:Element,window:{getComputedStyle:()=>({display:'block',visibility:'visible'})},
        document:{querySelectorAll:(selector:string)=>selector==='.conversation-message'?(input.missing?[]:input.multiple?[host,host]:[host]):selector.includes('.geek-item.selected')&&input.selectedId?[host]:[]}});
    }};
  }
  it('verifies the active native conversation when BOSS has no legacy DOM ID attributes',async()=>{
    await expect(assertCurrentConversationMatches(nativePage({}),'__boss_geek_id__:approved-geek-id')).resolves.toBeUndefined();
  });
  it('rejects wrong, absent, duplicate and conflicting native conversation identities',async()=>{
    for(const input of [{id:'wrong-geek-id'},{missing:true},{multiple:true},{secondId:'other-geek-id'},{selectedId:'other-geek-id'}]){
      await expect(assertCurrentConversationMatches(nativePage(input),'__boss_geek_id__:approved-geek-id')).rejects.toThrow('BOSS_SEND_TARGET_MISMATCH');
    }
  });
  it("requires an approval-bound candidate before any editor work", async () => {
    await expect(
      assertCurrentConversationMatches(
        pageReturning({
          matched: false,
          selectedName: "",
          detailName: "",
          selectedGeekId: ""
        }),
        ""
      )
    ).rejects.toThrow("发送前必须提供 --candidate");
  });

  it("fails closed when the selected conversation is not the approved candidate", async () => {
    await expect(
      assertCurrentConversationMatches(
        pageReturning({
          matched: false,
          selectedName: "同名候选人",
          detailName: "同名候选人",
          selectedGeekId: "different-geek-id"
        }),
        "__boss_geek_id__:approved-geek-id"
      )
    ).rejects.toThrow("BOSS_SEND_TARGET_MISMATCH");
  });

  it("accepts only the selected conversation already matched by stable ID", async () => {
    await expect(
      assertCurrentConversationMatches(
        pageReturning({
          matched: true,
          selectedName: "候选人",
          detailName: "候选人",
          selectedGeekId: "approved-geek-id"
        }),
        "__boss_geek_id__:approved-geek-id"
      )
    ).resolves.toBeUndefined();
  });
});
