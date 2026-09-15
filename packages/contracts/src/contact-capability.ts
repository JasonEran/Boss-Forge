/**
 * This release contains an audited, single-action transport for both greeting
 * and message sends. Deployment remains fail-closed unless the operator also
 * enables the explicit runtime mode; environment variables cannot change what
 * the compiled release supports.
 */
export const REAL_CONTACT_TRANSPORT_AVAILABLE = true;

export type ContactDispatchMode = "disabled" | "fake" | "real";

export type ContactSideEffectsMode =
  | "preview_only"
  | "fake_only"
  | "real_greet_enabled";

/**
 * Resume screening and contact dispatch have independent switches. Contact
 * dispatch is fail-closed: an omitted value means that no contact worker is
 * started and the product may only render a message preview.
 */
export function contactDispatchModeFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>
): ContactDispatchMode {
  const value = environment.BOSS_FORGE_CONTACT_DISPATCH_MODE?.trim() || "disabled";
  if (value === "disabled" || value === "fake" || value === "real") return value;
  throw new Error(
    "BOSS_FORGE_CONTACT_DISPATCH_MODE must be exactly disabled, fake or real."
  );
}

export function realContactEnabled(
  environment: Readonly<Record<string, string | undefined>>
): boolean {
  return (
    REAL_CONTACT_TRANSPORT_AVAILABLE &&
    environment.BOSS_FORGE_REAL_GREET_ENABLED === "1"
  );
}

export function contactSideEffectsModeFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>
): ContactSideEffectsMode {
  const dispatchMode = contactDispatchModeFromEnvironment(environment);
  if (dispatchMode === "fake") return "fake_only";
  if (dispatchMode === "real" && realContactEnabled(environment)) {
    return "real_greet_enabled";
  }
  return "preview_only";
}
