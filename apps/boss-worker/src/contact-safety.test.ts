import { describe, expect, it } from "vitest";
import {
  assertContactWorkerExecutionAllowed,
  assertRealGreetExecutionAllowed,
  contactDispatchModeFromEnvironment,
  contactWorkerScriptFromEnvironment
} from "./contact-safety.js";

describe("contact dispatch worker gate", () => {
  it("defaults to disabled and starts no contact worker", () => {
    expect(contactDispatchModeFromEnvironment({})).toBe("disabled");
    expect(contactWorkerScriptFromEnvironment({})).toBeNull();
  });

  it("requires an explicit fake mode for the simulation worker", () => {
    expect(
      contactWorkerScriptFromEnvironment({
        BOSS_FORGE_CONTACT_DISPATCH_MODE: "fake"
      })
    ).toBe("m2:contact-worker:fake");
    expect(() => assertContactWorkerExecutionAllowed(["--fake"], {})).toThrow(
      "BOSS_FORGE_CONTACT_DISPATCH_MODE is not fake"
    );
    expect(
      assertContactWorkerExecutionAllowed(["--fake"], {
        BOSS_FORGE_CONTACT_DISPATCH_MODE: "fake"
      })
    ).toBe("fake");
  });

  it("rejects ambiguous dispatch modes", () => {
    expect(() =>
      contactWorkerScriptFromEnvironment({
        BOSS_FORGE_CONTACT_DISPATCH_MODE: "enabled"
      })
    ).toThrow("must be exactly disabled, fake or real");
  });

  it("starts real mode only when both explicit runtime gates are enabled", () => {
    expect(
      contactWorkerScriptFromEnvironment({
        BOSS_FORGE_CONTACT_DISPATCH_MODE: "real",
        BOSS_FORGE_REAL_GREET_ENABLED: "1",
        BOSS_FORGE_CONTACT_PREVIEW_SIGNING_KEY: "s".repeat(32)
      })
    ).toBe("m2:contact-worker:real");
    expect(() =>
      contactWorkerScriptFromEnvironment({
        BOSS_FORGE_CONTACT_DISPATCH_MODE: "real",
        BOSS_FORGE_REAL_GREET_ENABLED: "0"
      })
    ).toThrow("deployment did not enable the accepted single-action transport");
  });

  it("refuses to start a real worker without the shared approval signing key", () => {
    const environment = {
      BOSS_FORGE_CONTACT_DISPATCH_MODE: "real",
      BOSS_FORGE_REAL_GREET_ENABLED: "1"
    };
    expect(() => contactWorkerScriptFromEnvironment(environment)).toThrow(
      "真实联系许可签名密钥不可用"
    );
    expect(() =>
      contactWorkerScriptFromEnvironment({
        ...environment,
        BOSS_FORGE_CONTACT_PREVIEW_SIGNING_KEY: "短密钥"
      })
    ).toThrow("真实联系许可签名密钥不可用");
    expect(
      contactWorkerScriptFromEnvironment({
        ...environment,
        BOSS_FORGE_CONTACT_PREVIEW_SIGNING_KEY: "密".repeat(11)
      })
    ).toBe("m2:contact-worker:real");
  });

  it("requires the explicit real-process acknowledgement argument", () => {
    const environment = {
      BOSS_FORGE_CONTACT_DISPATCH_MODE: "real",
      BOSS_FORGE_REAL_GREET_ENABLED: "1",
      BOSS_FORGE_CONTACT_PREVIEW_SIGNING_KEY: "s".repeat(32)
    };
    expect(() => assertContactWorkerExecutionAllowed([], environment)).toThrow(
      "--approve-real-greet was not provided"
    );
    expect(
      assertContactWorkerExecutionAllowed(["--approve-real-greet"], environment)
    ).toBe("real");
  });

  it("requires the real dispatch mode even for direct worker execution", () => {
    expect(() =>
      assertRealGreetExecutionAllowed(["--approve-real-greet"], {
        BOSS_FORGE_CONTACT_DISPATCH_MODE: "disabled",
        BOSS_FORGE_REAL_GREET_ENABLED: "1"
      })
    ).toThrow("BOSS_FORGE_CONTACT_DISPATCH_MODE is not real");
  });
});
