import { describe, expect, it } from "vitest";
import { buildBossArgv, commandRisk } from "./command.js";

describe("buildBossArgv", () => {
  it("keeps user text in a single argv element", () => {
    const candidateTarget = "张三; touch /tmp/should-not-run";
    expect(buildBossArgv({ type: "preview", candidateTarget })).toEqual([
      "preview",
      candidateTarget
    ]);
  });

  it("builds repeatable deep search conditions", () => {
    expect(
      buildBossArgv({
        type: "deep-search",
        jobKeyword: "英语老师",
        core: ["英语专业八级", "3年以上经验"],
        bonus: ["海外教学经验"],
        match: true
      })
    ).toEqual([
      "deep-search",
      "英语老师",
      "--core",
      "英语专业八级",
      "--core",
      "3年以上经验",
      "--bonus",
      "海外教学经验",
      "--match"
    ]);
  });

  it("builds a read-only exact-job greeting preview", () => {
    expect(
      buildBossArgv({ type: "greeting-preview", jobKeyword: "海外运营" })
    ).toEqual(["greeting-preview", "--job", "海外运营"]);
  });

  it("uses the stable BOSS candidate ID for an exact resume preview", () => {
    expect(
      buildBossArgv({
        type: "preview",
        candidateTarget: "王女士",
        sourceLocator: {
          kind: "boss_geek_id",
          value: "8f414ef771d340ad0HB-2tS_Elo~"
        }
      })
    ).toEqual(["preview", "__boss_geek_id__:8f414ef771d340ad0HB-2tS_Elo~"]);
  });

  it("rejects an invalid BOSS candidate ID", () => {
    expect(() =>
      buildBossArgv({
        type: "preview",
        candidateTarget: "王女士",
        sourceLocator: { kind: "boss_geek_id", value: "../../wrong target" }
      })
    ).toThrow(/valid BOSS candidate ID/u);
  });

  it("rejects a remark action without content", () => {
    expect(() => buildBossArgv({ type: "action", action: "remark" })).toThrow(
      "remark must not be empty"
    );
  });

  it("opens an exact candidate conversation before sending", () => {
    expect(
      buildBossArgv({ type: "chat-by-name", candidateName: "陈思婷", strict: true })
    ).toEqual(["chat", "陈思婷", "--strict"]);
  });

  it("binds a send to the exact stable candidate as well as the approved body", () => {
    expect(
      buildBossArgv({
        type: "send",
        text: "你好，想和你沟通一下这个岗位。",
        candidateTarget: "王女士",
        sourceLocator: {
          kind: "boss_geek_id",
          value: "8f414ef771d340ad0HB-2tS_Elo~"
        }
      })
    ).toEqual([
      "send",
      "--text",
      "你好，想和你沟通一下这个岗位。",
      "--candidate",
      "__boss_geek_id__:8f414ef771d340ad0HB-2tS_Elo~"
    ]);
  });

  it("carries the stable BOSS candidate ID through greet and chat commands", () => {
    const sourceLocator = {
      kind: "boss_geek_id" as const,
      value: "8f414ef771d340ad0HB-2tS_Elo~"
    };
    expect(
      buildBossArgv({
        type: "greet",
        candidateTarget: "王女士",
        sourceLocator,
        jobKeyword: "海外运营",
        expectedJobId: "job-fixture-01",
        expectedGreetingId: "greeting-fixture-01",
        expectedMessageSha256:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      })
    ).toEqual([
      "greet",
      "__boss_geek_id__:8f414ef771d340ad0HB-2tS_Elo~",
      "--job",
      "海外运营",
      "--expected-job-id",
      "job-fixture-01",
      "--expected-greeting-id",
      "greeting-fixture-01",
      "--expected-message-sha256",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    ]);
    expect(
      buildBossArgv({
        type: "chat-by-name",
        candidateName: "王女士",
        sourceLocator,
        strict: true
      })
    ).toEqual([
      "chat",
      "__boss_geek_id__:8f414ef771d340ad0HB-2tS_Elo~",
      "--strict"
    ]);
  });
});
describe("commandRisk", () => {
  it("classifies write and quota-consuming commands", () => {
    expect(
      commandRisk({
        type: "greet",
        candidateTarget: "张三",
        jobKeyword: "岗位",
        expectedJobId: "job-fixture-01",
        expectedGreetingId: "greeting-fixture-01",
        expectedMessageSha256:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      })
    ).toBe("external-write");
    expect(commandRisk({ type: "preview", candidateTarget: "张三" })).toBe(
      "quota-consuming-read"
    );
    expect(commandRisk({ type: "positions" })).toBe("read");
    expect(commandRisk({ type: "chat-by-name", candidateName: "张三", strict: true })).toBe(
      "read"
    );
  });
});
