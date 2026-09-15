import { describe, expect, it } from "vitest";
import {
  resumeDwellSeconds,
  nextResumeViewingAt,
  resumeViewingAllowedAt,
  resumeViewPolicyState,
  resumeViewPolicyFromEnvironment,
  shanghaiDayStart
} from "./resume-view-policy.js";

describe("resume viewing policy", () => {
  it('honors a ten-second override and keeps partial duration overrides ordered', () => {
    const ten = resumeViewPolicyFromEnvironment({ BOSS_FORGE_RESUME_DWELL_MIN_SECONDS: '10', BOSS_FORGE_RESUME_DWELL_TARGET_SECONDS: '10', BOSS_FORGE_RESUME_DWELL_MAX_SECONDS: '10' });
    expect([ten.dwellMinSeconds, ten.dwellTargetSeconds, ten.dwellMaxSeconds]).toEqual([10, 10, 10]);
    const partial = resumeViewPolicyFromEnvironment({ BOSS_FORGE_RESUME_DWELL_MIN_SECONDS: '30' });
    expect([partial.dwellMinSeconds, partial.dwellTargetSeconds, partial.dwellMaxSeconds]).toEqual([30, 30, 30]);
  });
  it('supports an explicitly configured whole day including 23:59 and midnight', () => {
    const policy = resumeViewPolicyFromEnvironment({ BOSS_FORGE_RESUME_WORKDAY_START_HOUR: '0', BOSS_FORGE_RESUME_WORKDAY_END_HOUR: '24' });
    for (const now of ['2026-09-07T00:00:00+08:00', '2026-09-07T19:00:00+08:00', '2026-09-07T23:59:59+08:00']) {
      expect(resumeViewPolicyState(new Date(now), policy, { viewsToday: 0, absoluteViewsToday: 0, viewsLastHour: 0 })).toBe('ready');
    }
    expect(policy.workdayEndHour).toBe(24);
  });
  it("uses the configured defaults and enforces the hard daily cap", () => {
    const defaults = resumeViewPolicyFromEnvironment({});
    expect(defaults).toMatchObject({
      dwellMinSeconds: 10,
      dwellTargetSeconds: 10,
      dwellMaxSeconds: 10,
      dailyLimit: 120,
      dailyHardLimit: 200,
      hourlyLimit: 50,
      continuousBatchSize: 20,
      breakMinutes: 10,
      workdayStartHour: 9,
      workdayEndHour: 18
    });
    expect(
      resumeViewPolicyFromEnvironment({ BOSS_FORGE_RESUME_DAILY_LIMIT: "999" })
        .dailyLimit
    ).toBe(200);
  });

  it("allows the fiftieth hourly view and waits before the fifty-first", () => {
    const policy = resumeViewPolicyFromEnvironment({ BOSS_FORGE_RESUME_HOURLY_LIMIT: "50" });
    const now = new Date("2026-09-08T02:00:00Z");
    expect(policy.hourlyLimit).toBe(50);
    expect(resumeViewPolicyState(now, policy, { viewsToday: 49, absoluteViewsToday: 49, viewsLastHour: 49 })).toBe("ready");
    expect(resumeViewPolicyState(now, policy, { viewsToday: 50, absoluteViewsToday: 50, viewsLastHour: 50 })).toBe("hourly_quota_reached");
    expect(resumeViewPolicyFromEnvironment({ BOSS_FORGE_RESUME_HOURLY_LIMIT: "999" }).hourlyLimit).toBe(50);
    expect(resumeViewPolicyFromEnvironment({ BOSS_FORGE_RESUME_HOURLY_LIMIT: "20" }).hourlyLimit).toBe(20);
  });

  it("defaults to ten seconds for both short and long resumes", () => {
    const policy = resumeViewPolicyFromEnvironment({});
    expect(resumeDwellSeconds(policy, 300)).toBe(10);
    expect(resumeDwellSeconds(policy, 900)).toBe(10);
    expect(resumeDwellSeconds(policy, 2_000)).toBe(10);
  });

  it("uses the Shanghai workday and day boundary", () => {
    const policy = resumeViewPolicyFromEnvironment({});
    expect(resumeViewingAllowedAt(new Date("2026-09-02T01:00:00Z"), policy)).toBe(true);
    expect(resumeViewingAllowedAt(new Date("2026-09-02T10:00:00Z"), policy)).toBe(false);
    expect(shanghaiDayStart(new Date("2026-09-02T03:00:00Z")).toISOString()).toBe(
      "2026-09-01T16:00:00.000Z"
    );
    expect(
      nextResumeViewingAt(new Date("2026-09-02T00:00:00Z"), policy).toISOString()
    ).toBe("2026-09-02T01:00:00.000Z");
    expect(
      nextResumeViewingAt(new Date("2026-09-02T12:00:00Z"), policy).toISOString()
    ).toBe("2026-09-03T01:00:00.000Z");
  });

  it("uses one canonical wait-state vocabulary with the hard cap taking priority", () => {
    const policy = resumeViewPolicyFromEnvironment({});
    const workHour = new Date("2026-09-02T02:00:00Z");
    expect(
      resumeViewPolicyState(workHour, policy, {
        viewsToday: 0,
        absoluteViewsToday: 0,
        viewsLastHour: 0
      })
    ).toBe("ready");
    expect(
      resumeViewPolicyState(workHour, policy, {
        viewsToday: 120,
        absoluteViewsToday: 120,
        viewsLastHour: 20
      })
    ).toBe("daily_quota_reached");
    expect(
      resumeViewPolicyState(workHour, policy, {
        viewsToday: 50,
        absoluteViewsToday: 50,
        viewsLastHour: 50
      })
    ).toBe("hourly_quota_reached");
    expect(
      resumeViewPolicyState(new Date("2026-09-02T12:00:00Z"), policy, {
        viewsToday: 200,
        absoluteViewsToday: 200,
        viewsLastHour: 20
      })
    ).toBe("daily_hard_limit_reached");
  });
});
