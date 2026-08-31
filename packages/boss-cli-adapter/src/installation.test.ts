import { describe, expect, it } from "vitest";
import { getBossCliInstallation } from "./installation.js";
import { runBossCommand } from "./runner.js";

describe("installed boss-cli", () => {
  it("is pinned to the M0 contract version", async () => {
    const installation = await getBossCliInstallation();
    expect(installation.packageName).toBe("@joohw/boss-cli");
    expect(installation.version).toBe("0.6.6");
    expect(installation.entrypoint).toMatch(/boss-cli.+dist.+cli.+index\.js$/);
  });

  it("can execute the help command without a browser session", async () => {
    const result = await runBossCommand(
      { type: "help" },
      { timeoutMs: 10_000, env: { BOSS_RESUME_OCR: "0" } }
    );
    expect(result.exitCode).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("boss-cli");
    expect(result.argv).toEqual(["help"]);
  });
});
