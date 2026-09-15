import { createHash } from "node:crypto";
import {
  hasPreexistingSameBodyPending,
  resolveDeliveredMessageReceipt
} from "@joohw/boss-cli/dist/toolset/send.js";
import { describe, expect, it } from "vitest";

const candidateId = "candidate-geek-01";
const conversationId = "friend-01-0";
const body = "你好，想继续沟通一下这个岗位。";
const observedMessage = {
  clientMid: "",
  time: 1_788_500_800_000,
  isSelf: true,
  type: "text",
  text: body
};

function probeWith(
  events: Array<{
    at: number;
    candidateId: string;
    conversationId: string;
    messages: Array<{
      mid: string;
      clientMid: string;
      serverMid: string;
      status: number;
      time: number;
      isSelf: boolean;
      type: string;
      text: string;
    }>;
  }>
) {
  return {
    baselineMids: ["old-server-mid"],
    startedAt: 1_788_500_800_000,
    events
  };
}

const target = { candidateId, conversationId, body };

describe("BOSS message delivery receipt", () => {
  it("blocks before Enter when an indistinguishable same-body message is pending", () => {
    expect(
      hasPreexistingSameBodyPending(
        [
          {
            mid: "older-client-mid",
            serverMid: "",
            status: 0,
            isSelf: true,
            type: "text",
            text: body
          }
        ],
        body
      )
    ).toBe(true);
    expect(
      hasPreexistingSameBodyPending(
        [
          {
            mid: "older-server-mid",
            serverMid: "older-server-mid",
            status: 1,
            isSelf: true,
            type: "text",
            text: body
          }
        ],
        body
      )
    ).toBe(false);
  });

  it("requires a new exact-body outgoing message acknowledged with serverMid", () => {
    const receipt = resolveDeliveredMessageReceipt(
      probeWith([
        {
          at: 1_788_500_800_010,
          candidateId,
          conversationId,
          messages: [
            { ...observedMessage, mid: "new-client-mid", serverMid: "", status: 0 }
          ]
        },
        {
          at: 1_788_500_800_020,
          candidateId,
          conversationId,
          messages: [
            {
              ...observedMessage,
              mid: "new-server-mid",
              serverMid: "new-server-mid",
              status: 1
            }
          ]
        }
      ]),
      target
    );
    expect(receipt).toEqual({
      schemaVersion: 1,
      kind: "contact-provider-receipt",
      actionKind: "message",
      candidateId,
      bodySha256: createHash("sha256").update(body, "utf8").digest("hex"),
      clientMid: "new-client-mid",
      serverMid: "new-server-mid",
      providerConversationId: conversationId,
      acceptedAt: new Date(1_788_500_800_020).toISOString()
    });
  });

  it("does not accept optimistic local state without the provider serverMid", () => {
    expect(() =>
      resolveDeliveredMessageReceipt(
        probeWith([
          {
            at: 1_788_500_800_010,
            candidateId,
            conversationId,
            messages: [
              { ...observedMessage, mid: "new-client-mid", serverMid: "", status: 0 }
            ]
          }
        ]),
        target
      )
    ).toThrow("BOSS_SEND_POST_WRITE_ACK_PENDING");
  });

  it("rejects target drift, duplicate ACKs and wrong text", () => {
    expect(() =>
      resolveDeliveredMessageReceipt(
        probeWith([
          {
            at: 1_788_500_800_010,
            candidateId: "other-candidate",
            conversationId,
            messages: []
          }
        ]),
        target
      )
    ).toThrow("BOSS_SEND_POST_WRITE_TARGET_MISMATCH");
    expect(() =>
      resolveDeliveredMessageReceipt(
        probeWith([
          {
            at: 1_788_500_800_010,
            candidateId,
            conversationId,
            messages: [
              { ...observedMessage, mid: "client-1", serverMid: "", status: 0 },
              { ...observedMessage, mid: "client-2", serverMid: "", status: 0 }
            ]
          },
          {
            at: 1_788_500_800_020,
            candidateId,
            conversationId,
            messages: [
              { ...observedMessage, mid: "server-1", serverMid: "server-1", status: 1 },
              { ...observedMessage, mid: "server-2", serverMid: "server-2", status: 1 }
            ]
          }
        ]),
        target
      )
    ).toThrow("BOSS_SEND_POST_WRITE_ACK_AMBIGUOUS");
    expect(() =>
      resolveDeliveredMessageReceipt(
        probeWith([
          {
            at: 1_788_500_800_010,
            candidateId,
            conversationId,
            messages: [
              {
                ...observedMessage,
                mid: "new-client-mid",
                serverMid: "",
                status: 0,
                text: "不同正文"
              }
            ]
          }
        ]),
        target
      )
    ).toThrow("BOSS_SEND_POST_WRITE_ACK_PENDING");
  });
});
