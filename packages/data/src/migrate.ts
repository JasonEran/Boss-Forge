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
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;
    const directory = fileURLToPath(migrationsUrl);
    const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
    const applied: string[] = [];
    for (const name of files) {
      const existing = await sql<{ name: string }[]>`
        SELECT name FROM schema_migrations WHERE name = ${name}
      `;
      if (existing.length > 0) continue;
      const migration = await readFile(new URL(name, migrationsUrl), "utf8");
      await sql.begin(async (transaction) => {
        await transaction.unsafe(migration);
        await transaction`INSERT INTO schema_migrations (name) VALUES (${name})`;
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
