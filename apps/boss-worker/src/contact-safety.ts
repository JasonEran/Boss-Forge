import {
  contactPreviewApprovalSigningKeyFromEnvironment,
  contactDispatchModeFromEnvironment,
  realContactEnabled
} from "@boss-forge/contracts";
export { contactDispatchModeFromEnvironment } from "@boss-forge/contracts";
export type { ContactDispatchMode } from "@boss-forge/contracts";

export type ContactWorkerScript =
  | "m2:contact-worker:fake"
  | "m2:contact-worker:real";

/**
 * Selects the optional contact worker independently from the resume worker.
 * Real dispatch remains unreachable until both the audited code capability and
 * the deployment environment gate are enabled.
 */
export function contactWorkerScriptFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>
): ContactWorkerScript | null {
  const mode = contactDispatchModeFromEnvironment(environment);
  if (mode === "disabled") return null;
  if (mode === "fake") return "m2:contact-worker:fake";
  if (!realContactEnabled(environment)) {
    throw new Error(
      "Real contact is unavailable: this deployment did not enable the accepted single-action transport."
    );
  }
  // Refuse to start the real worker before it can claim an intent when the
  // API/worker approval secret is absent. Deployment preflight checks the same
  // boundary, while this guard also protects direct process invocation.
  contactPreviewApprovalSigningKeyFromEnvironment(environment);
  return "m2:contact-worker:real";
}

export function assertRealGreetExecutionAllowed(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>
): void {
  if (contactDispatchModeFromEnvironment(environment) !== "real") {
    throw new Error(
      "Real contact is disabled: BOSS_FORGE_CONTACT_DISPATCH_MODE is not real."
    );
  }
  if (contactWorkerScriptFromEnvironment(environment) !== "m2:contact-worker:real") {
    throw new Error(
      "Real contact is unavailable: this deployment did not enable the accepted single-action transport."
    );
  }
  if (!argv.includes("--approve-real-greet")) {
    throw new Error("Real contact is disabled: --approve-real-greet was not provided.");
  }
  if (environment.BOSS_FORGE_REAL_GREET_ENABLED !== "1") {
    throw new Error("Real contact is disabled: BOSS_FORGE_REAL_GREET_ENABLED is not 1.");
  }
}

export function assertContactWorkerExecutionAllowed(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>
): "fake" | "real" {
  if (argv.includes("--fake")) {
    if (contactDispatchModeFromEnvironment(environment) !== "fake") {
      throw new Error(
        "Fake contact worker is disabled: BOSS_FORGE_CONTACT_DISPATCH_MODE is not fake."
      );
    }
    return "fake";
  }
  assertRealGreetExecutionAllowed(argv, environment);
  return "real";
}
