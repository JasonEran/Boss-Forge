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

  it("rejects a remark action without content", () => {
    expect(() => buildBossArgv({ type: "action", action: "remark" })).toThrow(
      "remark must not be empty"
    );
  });
});
describe("commandRisk", () => {
  it("classifies write and quota-consuming commands", () => {
    expect(commandRisk({ type: "greet", candidateTarget: "张三" })).toBe("external-write");
    expect(commandRisk({ type: "preview", candidateTarget: "张三" })).toBe(
      "quota-consuming-read"
    );
    expect(commandRisk({ type: "positions" })).toBe("read");
  });
});
