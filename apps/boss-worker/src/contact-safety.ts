export function assertRealGreetExecutionAllowed(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>
): void {
  if (!argv.includes("--approve-real-greet")) {
    throw new Error("Real greeting is disabled: --approve-real-greet was not provided.");
  }
  if (environment.BOSS_FORGE_REAL_GREET_ENABLED !== "1") {
    throw new Error("Real greeting is disabled: BOSS_FORGE_REAL_GREET_ENABLED is not 1.");
  }
}
