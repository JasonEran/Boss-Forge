import postgres from "postgres";

export type Database = ReturnType<typeof postgres>;

export function databaseUrl(): string {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) {
    throw new Error("DATABASE_URL is required for M1 data access.");
  }
  return value;
}

export function createDatabase(url = databaseUrl()): Database {
  return postgres(url, {
    max: 8,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => undefined
  });
}
