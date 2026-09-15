import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createDatabase } from "./client.js";

const migrationsUrl = new URL("../migrations/", import.meta.url);

async function main(): Promise<void> {
  const sql = createDatabase();
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now(),
        checksum text
      )
    `;
    await sql`ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text`;
    const directory = fileURLToPath(migrationsUrl);
    const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
    const applied: string[] = [];
    for (const name of files) {
      const migration = await readFile(new URL(name, migrationsUrl), "utf8");
      const checksum = createHash("sha256").update(migration).digest("hex");
      const existing = await sql<{ name: string; checksum: string | null }[]>`
        SELECT name, checksum FROM schema_migrations WHERE name = ${name}
      `;
      if (existing.length > 0) {
        const recordedChecksum = existing[0]!.checksum;
        if (recordedChecksum === null) {
          // Existing installations predate checksum tracking. Pin their current
          // migration files once; all subsequent edits will fail closed.
          await sql`
            UPDATE schema_migrations SET checksum = ${checksum}
            WHERE name = ${name} AND checksum IS NULL
          `;
          continue;
        }
        if (recordedChecksum !== checksum) {
          throw new Error(
            `Applied migration ${name} no longer matches its recorded checksum. Add a new migration instead of editing history.`
          );
        }
        continue;
      }
      await sql.begin(async (transaction) => {
        await transaction.unsafe(migration);
        await transaction`
          INSERT INTO schema_migrations (name, checksum) VALUES (${name}, ${checksum})
        `;
      });
      applied.push(name);
    }
    console.log(JSON.stringify({ ok: true, applied }));
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
