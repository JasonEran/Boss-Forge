import { resolveEffectiveGreeting } from "@joohw/boss-cli/dist/toolset/greeting-preview.js";
import { describe, expect, it } from "vitest";
import { parseBossGreetingPreview } from "./greeting-preview.js";

const jobResponse = {
  code: 0,
  zpData: {
    jobs: [
      {
        encJobId: "job-overseas-01",
        jobName: "海外运营",
        jobGreeting: "你好，想和你聊聊海外运营岗位。",
        encGreetingId: "greeting-job-01"
      },
      {
        encJobId: "job-amazon-01",
        jobName: "亚马逊运营",
        jobGreeting: null,
        encGreetingId: null
      }
    ]
  }
};

describe("boss greeting preview", () => {
  it("prefers the exact job greeting and preserves its body byte-for-byte", () => {
    expect(
      resolveEffectiveGreeting(jobResponse, "海外运营")
    ).toEqual({
      schemaVersion: 1,
      kind: "greeting-preview",
      source: "job",
      jobId: "job-overseas-01",
      jobName: "海外运营",
      greetingId: "greeting-job-01",
      body: "你好，想和你聊聊海外运营岗位。"
    });
  });

  it("fails closed instead of guessing a global fallback for an empty job", () => {
    expect(() => resolveEffectiveGreeting(jobResponse, "job-amazon-01")).toThrow(
      "BOSS_GREETING_JOB_BODY_EMPTY"
    );
  });

  it("fails closed for an ambiguous exact job and never uses a partial match", () => {
    expect(() =>
      resolveEffectiveGreeting(
        {
          code: 0,
          zpData: {
            jobs: [
              { ...jobResponse.zpData.jobs[0], encJobId: "job-1" },
              { ...jobResponse.zpData.jobs[0], encJobId: "job-2" }
            ]
          }
        },
        "海外运营"
      )
    ).toThrow("BOSS_GREETING_JOB_AMBIGUOUS");
    expect(() => resolveEffectiveGreeting(jobResponse, "海外")).toThrow(
      "BOSS_GREETING_JOB_NOT_FOUND"
    );
  });

  it("strictly parses the read-only JSON contract without altering whitespace", () => {
    const body = "  你好，方便沟通吗？  ";
    const preview = parseBossGreetingPreview(
      JSON.stringify({
        schemaVersion: 1,
        kind: "greeting-preview",
        source: "job",
        jobId: "job-amazon-01",
        jobName: "亚马逊运营",
        greetingId: "greeting-global-01",
        body
      })
    );
    expect(preview.body).toBe(body);
    expect(() =>
      parseBossGreetingPreview(
        JSON.stringify({ ...preview, unexpected: "not allowed" })
      )
    ).toThrow("strict validation");
  });
});
