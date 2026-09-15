export function assertIsolatedTestDatabase(
  environment: Readonly<Record<string, string | undefined>>,
  options: { contactSideEffects: boolean }
): void {
  const configured = environment.DATABASE_URL?.trim();
  if (!configured) throw new Error("DATABASE_URL is required for integration tests.");

  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error("DATABASE_URL is invalid; integration tests were not started.");
  }

  const hostname = url.hostname.toLowerCase();
  const localHost =
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//u, ""));
  const explicitTestName = /(?:^|[_-])(test|e2e|audit)(?:$|[_-])/iu.test(databaseName);
  if (!localHost || !explicitTestName) {
    throw new Error(
      "Integration tests require a loopback PostgreSQL database whose name contains test, e2e or audit. Production and shared databases are refused."
    );
  }

  if (
    options.contactSideEffects &&
    environment.BOSS_FORGE_ALLOW_CONTACT_TEST_DATA !== "I_UNDERSTAND_ISOLATED_ONLY"
  ) {
    throw new Error(
      "Contact test data is disabled. Set BOSS_FORGE_ALLOW_CONTACT_TEST_DATA=I_UNDERSTAND_ISOLATED_ONLY only for a disposable local database."
    );
  }
}
