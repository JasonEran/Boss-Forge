import { describe, expect, it } from "vitest";
import {
  REAL_CONTACT_TRANSPORT_AVAILABLE,
  contactDispatchModeFromEnvironment,
  contactSideEffectsModeFromEnvironment,
  realContactEnabled
} from "./contact-capability.js";

describe("real contact capability gate", () => {
  it("requires both the accepted compiled transport and explicit deployment enablement", () => {
    expect(REAL_CONTACT_TRANSPORT_AVAILABLE).toBe(true);
    expect(realContactEnabled({ BOSS_FORGE_REAL_GREET_ENABLED: "1" })).toBe(true);
    expect(realContactEnabled({ BOSS_FORGE_REAL_GREET_ENABLED: "0" })).toBe(false);
  });

  it("defaults contact dispatch to preview-only", () => {
    expect(contactDispatchModeFromEnvironment({})).toBe("disabled");
    expect(contactSideEffectsModeFromEnvironment({})).toBe("preview_only");
    expect(
      contactSideEffectsModeFromEnvironment({
        BOSS_FORGE_REAL_GREET_ENABLED: "1"
      })
    ).toBe("preview_only");
  });

  it("requires fake dispatch explicitly", () => {
    expect(
      contactSideEffectsModeFromEnvironment({
        BOSS_FORGE_CONTACT_DISPATCH_MODE: "fake"
      })
    ).toBe("fake_only");
    expect(
      contactSideEffectsModeFromEnvironment({
        BOSS_FORGE_CONTACT_DISPATCH_MODE: "fake",
        BOSS_FORGE_REAL_GREET_ENABLED: "1"
      })
    ).toBe("fake_only");
  });

  it("reports real side effects only when both runtime gates are explicit", () => {
    const environment = {
      BOSS_FORGE_CONTACT_DISPATCH_MODE: "real",
      BOSS_FORGE_REAL_GREET_ENABLED: "1"
    };
    expect(contactDispatchModeFromEnvironment(environment)).toBe("real");
    expect(contactSideEffectsModeFromEnvironment(environment)).toBe("real_greet_enabled");
  });

  it("keeps a real dispatch configuration preview-only when its side-effect gate is off", () => {
    const environment = {
      BOSS_FORGE_CONTACT_DISPATCH_MODE: "real",
      BOSS_FORGE_REAL_GREET_ENABLED: "0"
    };

    expect(contactDispatchModeFromEnvironment(environment)).toBe("real");
    expect(realContactEnabled(environment)).toBe(false);
    expect(contactSideEffectsModeFromEnvironment(environment)).toBe("preview_only");
  });

  it("rejects unknown dispatch modes instead of guessing", () => {
    expect(() =>
      contactDispatchModeFromEnvironment({
        BOSS_FORGE_CONTACT_DISPATCH_MODE: "enabled"
      })
    ).toThrow("must be exactly disabled, fake or real");
  });
});
