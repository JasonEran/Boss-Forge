import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type LoginMethod = "wechat" | "boss_app";

export function isLoginMethod(value: unknown): value is LoginMethod {
  return value === "wechat" || value === "boss_app";
}

export async function readLoginMethod(directory: string): Promise<LoginMethod> {
  try {
    const value: unknown = JSON.parse(await readFile(join(directory, "boss-login-method.json"), "utf8"));
    return isLoginMethod(value) ? value : "wechat";
  } catch (error) {
    if (error instanceof SyntaxError || (error && typeof error === "object" && "code" in error && error.code === "ENOENT")) return "wechat";
    throw error;
  }
}

export async function saveLoginMethod(directory: string, method: LoginMethod): Promise<void> {
  const path = join(directory, "boss-login-method.json");
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(method), { mode: 0o600 });
  await rename(temporaryPath, path);
}
