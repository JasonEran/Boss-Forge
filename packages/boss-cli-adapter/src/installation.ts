import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

export type BossCliInstallation = {
  packageName: "@joohw/boss-cli";
  version: string;
  entrypoint: string;
  packageRoot: string;
};

const require = createRequire(import.meta.url);

async function findPackageRoot(entrypoint: string): Promise<string> {
  let current = dirname(entrypoint);
  for (let depth = 0; depth < 6; depth += 1) {
    const manifestPath = join(current, "package.json");
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        name?: string;
      };
      if (manifest.name === "@joohw/boss-cli") {
        return current;
      }
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      if (code !== "ENOENT") {
        throw error;
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`Unable to locate @joohw/boss-cli package root from ${entrypoint}.`);
}
export async function getBossCliInstallation(): Promise<BossCliInstallation> {
  const entrypoint = require.resolve("@joohw/boss-cli");
  const packageRoot = await findPackageRoot(entrypoint);
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
    name?: string;
    version?: string;
  };
  if (manifest.name !== "@joohw/boss-cli" || !manifest.version) {
    throw new Error("Installed boss-cli manifest is invalid.");
  }
  return {
    packageName: "@joohw/boss-cli",
    version: manifest.version,
    entrypoint,
    packageRoot
  };
}
