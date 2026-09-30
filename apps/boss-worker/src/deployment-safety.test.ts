import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("intranet deployment safety", () => {
  it("serves the built web app with the production runner", () => {
    const webPackage = JSON.parse(source("apps/web/package.json")) as {
      scripts: Record<string, string>;
    };
    expect(webPackage.scripts.start).toBe("vinext start");
    expect(webPackage.scripts.start).not.toContain("wrangler dev");
  });

  it("keeps incremental image builds non-interactive", () => {
    const incrementalDockerfile = source(
      "deploy/docker/Dockerfile.boss-forge.incremental"
    );
    expect(incrementalDockerfile).toContain("CI=true");
    expect(incrementalDockerfile).toContain("pnpm install --frozen-lockfile");
  });

  it("embeds an immutable release identity and constrains runtime resources", () => {
    const compose = source("deploy/compose.intranet.yaml");
    const dockerfile = source("deploy/docker/Dockerfile.boss-forge");
    expect(compose).toContain("BOSS_FORGE_RELEASE_ID: ${BOSS_FORGE_RELEASE_ID:-unversioned}");
    expect(dockerfile).toContain("BOSS_FORGE_RELEASE_ID=${BOSS_FORGE_RELEASE_ID}");
    expect(compose).toContain("BOSS_LOGIN_MEMORY_LIMIT");
    expect(compose).toContain("BOSS_LOGIN_PIDS_LIMIT");
    expect(compose).toContain("browser_profile:\n    external: true");
    expect(compose).toContain("BOSS_BROWSER_PROFILE_VOLUME:?");
    expect(compose).toContain("boss_cli_data:\n    external: true");
    expect(compose).toContain("BOSS_CLI_DATA_VOLUME:?");
    const bossLogin = compose.slice(
      compose.indexOf("  boss-login:"),
      compose.indexOf("  boss-worker:")
    );
    expect(bossLogin).toContain(
      "restart: ${BOSS_FORGE_BOSS_LOGIN_RESTART_POLICY:-on-failure}"
    );
    expect(bossLogin).toContain(
      "BOSS_FORGE_M1_MODE: ${BOSS_FORGE_M1_MODE:-}"
    );
    expect(bossLogin).toContain(
      "BOSS_FORGE_CANARY_MAX_RESUME_ATTEMPTS: ${BOSS_FORGE_CANARY_MAX_RESUME_ATTEMPTS:-}"
    );
    expect(bossLogin).toContain("--remote-debugging-address=127.0.0.1");
    expect(bossLogin).toContain('BOSS_BROWSER_REMOTE_ONLY: "1"');
    expect(bossLogin).not.toMatch(/^    ports:/mu);
    expect(bossLogin).toContain("worker_runtime:/var/lib/boss-forge/runtime");
    const api = compose.slice(compose.indexOf("  api:"), compose.indexOf("  web:"));
    expect(api).toContain("worker_runtime:/var/lib/boss-forge/runtime");
    expect(api).toContain("boss_cli_data:/home/node/.boss-cli:ro");
    const preflight = source("deploy/preflight-intranet.sh");
    expect(preflight).toContain("api must mount boss_cli_data at /home/node/.boss-cli read-only");
    expect(preflight).toContain("no|on-failure");
    expect(preflight).toContain(
      "Controlled M1 canaries require BOSS_FORGE_BOSS_LOGIN_RESTART_POLICY=no"
    );
    expect(preflight).toContain("boss-login must set BOSS_BROWSER_REMOTE_ONLY=1");
    expect(preflight).toContain(
      "boss-login Chromium remote debugging must remain bound to 127.0.0.1"
    );
    expect(preflight).toContain(
      "must mount the shared worker_runtime volume for private browser-control IPC"
    );
    expect(source("deploy/intranet.env.example")).toContain(
      "BOSS_FORGE_BOSS_LOGIN_RESTART_POLICY=on-failure"
    );
  });

  it("keeps browser commands in the authenticated supervisor behind private IPC", () => {
    const supervisor = source("apps/boss-worker/src/session-supervisor.ts");
    const api = source("apps/control-api/src/server.ts");
    expect(supervisor).toContain("startBossBrowserControlServer");
    expect(supervisor).toContain("bossBrowserControlSocketPath(runtime)");
    expect(supervisor).toContain('BOSS_BROWSER_REMOTE_ONLY: "1"');
    expect(supervisor).toContain("inspectBossBrowserSession(debuggingPort)");
    expect(api).toContain("requestBossGreetingPreviewViaIpc");
    expect(api).not.toContain("runBossCommand(");
    expect(api).not.toContain("withBossAccountLock(");
  });

  it("fails closed on project drift or a missing and mistagged release image", () => {
    const preflight = source("deploy/preflight-intranet.sh");
    expect(preflight).toContain("expected_project=boss-forge-intranet");
    expect(preflight).toContain('docker image inspect "$application_image"');
    expect(preflight).toContain('"$image_release_id" != "$release_id"');
    expect(preflight).toContain('"$image_control_api_url" != "$configured_control_api_url"');
    expect(preflight).toContain('NEXT_PUBLIC_CONTROL_API_URL');
    expect(preflight).toContain("do not build on the production BOSS host");
    execFileSync("sh", ["-n", resolve(process.cwd(), "deploy/preflight-intranet.sh")]);
  });

  it("documents boss-login startup without dependency recreation or production builds", () => {
    const deployment = source("docs/INTRANET_DEPLOYMENT.md");
    const starts = deployment.split("\n").filter(line => /\bup -d\b/.test(line) && /\bboss-login\b/.test(line));
    expect(starts.length).toBeGreaterThan(0);
    for (const command of starts) {
      expect(command).toContain("--no-build");
      expect(command).toContain("--no-deps");
    }
  });

  it("keeps real contact off by default and requires every real-mode gate", () => {
    const compose = source("deploy/compose.intranet.yaml");
    const backup = source("deploy/postgres-backup.sh");
    const preflight = source("deploy/preflight-intranet.sh");
    expect(compose).toContain(
      "BOSS_FORGE_REAL_GREET_ENABLED: ${BOSS_FORGE_REAL_GREET_ENABLED:-0}"
    );
    expect(compose).toContain(
      "BOSS_FORGE_CONTACT_DISPATCH_MODE: ${BOSS_FORGE_CONTACT_DISPATCH_MODE:-disabled}"
    );
    expect(compose).toContain(
      "BOSS_FORGE_CONTACT_PREVIEW_SIGNING_KEY: ${BOSS_FORGE_CONTACT_PREVIEW_SIGNING_KEY:-}"
    );
    expect(compose).toContain("postgres-backup:");
    expect(backup).toContain("pg_restore --list");
    expect(backup).toContain(".dump.tmp");
    expect(preflight).toContain(
      "Disabled or fake contact mode requires BOSS_FORGE_REAL_GREET_ENABLED=0"
    );
    expect(preflight).toContain(
      "BOSS_FORGE_CONTACT_DISPATCH_MODE=real also requires BOSS_FORGE_REAL_GREET_ENABLED=1"
    );
    expect(preflight).toContain(
      "Real contact requires a deployment-specific BOSS_FORGE_CONTACT_PREVIEW_SIGNING_KEY of at least 32 bytes"
    );
    expect(preflight).toContain("preview_signing_key_bytes=$(LC_ALL=C");
    expect(preflight).toContain('"contactDispatchMode":"%s"');
    expect(preflight).not.toContain(
      "Real contact is not an accepted product capability in this release"
    );
    expect(preflight).not.toContain("BOSS_FORGE_ALLOW_REAL_CONTACT_DEPLOY");
    expect(preflight).toContain("CHANGE_ME_BOOTSTRAP_PASSWORD");
    expect(preflight).toContain("setting BOSS_DB_PASSWORD");
    expect(preflight).toContain("CHANGE_ME_BOSS_DB_PASSWORD");
    expect(preflight).not.toContain("setting POSTGRES_PASSWORD");
    expect(preflight).toContain('docker volume inspect "$browser_profile_volume"');
    expect(preflight).toContain('"$browser_volume" != "$browser_profile_volume"');
    expect(preflight).toContain('"$cli_volume" != "$boss_cli_data_volume"');
    expect(preflight).toContain("Legacy boss-worker is running");
    expect(preflight).toContain("Multiple boss-login containers are running");
    expect(preflight).toContain(
      "Another running container is using BOSS_BROWSER_PROFILE_VOLUME"
    );
    expect(preflight).toContain("Standalone contact-worker-fake is running");
    expect(preflight).toContain(
      "BOSS_FORGE_RESUME_PREVIEW_ENABLED BOSS_RESUME_OCR"
    );
    expect(preflight).toContain("must be exactly 0 or 1");
    expect(compose).toContain('command: ["pnpm", "m2:contact-worker:fake"]');
    const fakeWorker = compose.slice(compose.indexOf("  contact-worker-fake:"));
    expect(fakeWorker).toContain("BOSS_FORGE_CONTACT_DISPATCH_MODE: fake");
  });
});
