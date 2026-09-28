import { randomUUID } from "node:crypto";
import { readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { isLoginMethod, saveLoginMethod, type LoginMethod } from "./login-method.js";

/** Claim the request before doing any recovery work. A newer refresh written
 * by the API must not be removed when the previous request finishes. */
export async function consumeLoginRefreshRequest(
  path: string,
  onConsumed?: (request: { loginMethod?: LoginMethod }) => Promise<void>
): Promise<boolean> {
  const claimedPath = `${path}.${process.pid}.${randomUUID()}.consuming`;
  try {
    await rename(path, claimedPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
  try {
    let raw: unknown;
    try { raw = JSON.parse(await readFile(claimedPath, "utf8")); }
    catch (error) {
      if (error instanceof SyntaxError) return false;
      throw error;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const request = raw as Record<string, unknown>;
    if (typeof request.requestId !== "string" ||
        !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(request.requestId) ||
        typeof request.requestedAt !== "string" ||
        !Number.isFinite(Date.parse(request.requestedAt))) return false;
    if (request.loginMethod !== undefined && !isLoginMethod(request.loginMethod)) return false;
    // Persist the explicit choice before a recovery callback can restart the
    // browser. A request without a method preserves the existing preference.
    if (isLoginMethod(request.loginMethod)) await saveLoginMethod(dirname(path), request.loginMethod);
    await onConsumed?.(isLoginMethod(request.loginMethod) ? { loginMethod: request.loginMethod } : {});
    return true;
  } finally {
    await unlink(claimedPath);
  }
}
