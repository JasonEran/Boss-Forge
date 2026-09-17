import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUTO_GREET_DAILY_LIMIT,
  autoGreetDailyLimitFromEnvironment,
  dailyAutoGreetCapStopMessage,
  isDailyAutoGreetCapStopMessage,
  remainingAutoGreetDailySlots
} from "./auto-greet-daily-limit.js";

describe("auto-greet daily limit", () => {
  it("defaults to 200 and accepts explicit env overrides", () => {
    expect(autoGreetDailyLimitFromEnvironment({})).toBe(DEFAULT_AUTO_GREET_DAILY_LIMIT);
    expect(autoGreetDailyLimitFromEnvironment({ BOSS_FORGE_AUTO_GREET_DAILY_LIMIT: "200" })).toBe(
      200
    );
    expect(autoGreetDailyLimitFromEnvironment({ BOSS_FORGE_AUTO_GREET_DAILY_LIMIT: "50" })).toBe(50);
  });

  it("rejects invalid env values", () => {
    expect(() =>
      autoGreetDailyLimitFromEnvironment({ BOSS_FORGE_AUTO_GREET_DAILY_LIMIT: "0" })
    ).toThrow(/BOSS_FORGE_AUTO_GREET_DAILY_LIMIT/);
  });

  it("computes remaining slots and stop message for UI", () => {
    expect(remainingAutoGreetDailySlots(112, 200)).toBe(88);
    expect(remainingAutoGreetDailySlots(200, 200)).toBe(0);
    expect(remainingAutoGreetDailySlots(205, 200)).toBe(0);
    const message = dailyAutoGreetCapStopMessage(200);
    expect(isDailyAutoGreetCapStopMessage(message)).toBe(true);
    expect(isDailyAutoGreetCapStopMessage("任务已取消")).toBe(false);
  });
});
