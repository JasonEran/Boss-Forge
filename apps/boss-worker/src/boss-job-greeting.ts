import { pathToFileURL } from "node:url";
import { BossCliExecutionError, getBossCliInstallation, parseBossGreetingPreview, type BossGreetingPreview } from "@boss-forge/boss-cli-adapter";

export class BossGreetingSaveRejectedError extends Error {}

/** The caller holds the account lock. No contact or chat-start endpoint is used. */
export async function saveBossJobGreeting(input: { bossJobId: string; body: string }): Promise<BossGreetingPreview> {
  if (!/^[A-Za-z0-9_~=-]{1,256}$/u.test(input.bossJobId) || input.body.trim() !== input.body || input.body.length < 2 || input.body.length > 100 || /\{\{/.test(input.body)) throw new Error("岗位招呼语必须为 2–100 字，且不能包含未替换变量。");
  const { packageRoot } = await getBossCliInstallation();
  const { withBossSessionPage } = await import(pathToFileURL(`${packageRoot}/dist/common/boss_session_page.js`).href);
  return withBossSessionPage((page: GreetingPage) => saveBossJobGreetingOnPage(page, input));
}

type GreetingPage = { evaluate: (script: string) => Promise<unknown> };
export async function saveBossJobGreetingOnPage(page: GreetingPage, input: { bossJobId: string; body: string }): Promise<BossGreetingPreview> {
  if (!/^[A-Za-z0-9_~=-]{1,256}$/u.test(input.bossJobId) || input.body.trim() !== input.body || input.body.length < 2 || input.body.length > 100 || /\{\{/.test(input.body)) throw new Error("岗位招呼语必须为 2–100 字，且不能包含未替换变量。");
  const { packageRoot } = await getBossCliInstallation();
  const { resolveEffectiveGreeting } = await import(pathToFileURL(`${packageRoot}/dist/toolset/greeting-preview.js`).href);

    const payload = await page.evaluate(`(async () => {
      const input = ${JSON.stringify(input)};
      const deadline = Date.now() + 30000;
      // The official page's Axios client uses XHR with this marker so its
      // installed common-header hook can supply the authenticated request data.
      // Plain fetch omits that hook and BOSS rejects writes with code 121.
      const request = (method, path, body) => new Promise((resolve, reject) => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return reject(new Error('BOSS_GREETING_REQUEST_TIMEOUT'));
        const xhr = new XMLHttpRequest();
        xhr.open(method, path);
        xhr.withCredentials = true;
        xhr.timeout = Math.min(20000, remaining);
        xhr.setRequestHeader('Accept', 'application/json, text/plain, */*');
        xhr.setRequestHeader('with-common-headers', 'true');
        if (method === 'POST') xhr.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
        xhr.onload = () => {
          if (xhr.status < 200 || xhr.status >= 300) return reject(new Error('BOSS_GREETING_HTTP_' + xhr.status));
          try { resolve(JSON.parse(xhr.responseText)); }
          catch { reject(new Error('BOSS_GREETING_INVALID_RESPONSE')); }
        };
        xhr.onerror = () => reject(new Error('BOSS_GREETING_REQUEST_FAILED'));
        xhr.ontimeout = () => reject(new Error('BOSS_GREETING_REQUEST_TIMEOUT'));
        xhr.onabort = () => reject(new Error('BOSS_GREETING_REQUEST_ABORTED'));
        xhr.send(body ?? null);
      });
      const get = () => request('GET', '/wapi/zpchat/greeting/job/get');
      const before = await get();
      if (before.code !== 0 || !Array.isArray(before.zpData?.jobs) || before.zpData.jobs.filter(job => job.encJobId === input.bossJobId).length !== 1) throw new Error('BOSS_GREETING_JOB_NOT_FOUND');
      const current = before.zpData.jobs.find(job => job.encJobId === input.bossJobId);
      if (current.jobGreeting === input.body) return before;
      const saved = await request('POST', '/wapi/zpchat/greeting/job/save',
        new URLSearchParams({encJobId:input.bossJobId, content:input.body}).toString());
      if (saved.code !== 0) return { rejected: true, code: saved.code, message: saved.message };
      let after;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) await new Promise(resolve => setTimeout(resolve, 300));
        after = await get();
        const jobs = after.code === 0 && Array.isArray(after.zpData?.jobs)
          ? after.zpData.jobs.filter(job => job.encJobId === input.bossJobId) : [];
        if (jobs.length === 1 && jobs[0].jobGreeting === input.body && jobs[0].encGreetingId) return after;
      }
      return after;
    })()`);
    if (payload && typeof payload === 'object' && 'rejected' in payload && payload.rejected === true) {
      const rejection = payload as { code?: unknown; message?: unknown };
      const code = typeof rejection.code === 'number' ? String(rejection.code) : 'unknown';
      const message = typeof rejection.message === 'string' ? rejection.message.replace(/[\r\n]/g, ' ').slice(0, 160) : 'BOSS 拒绝保存';
      throw new BossGreetingSaveRejectedError(`BOSS_GREETING_SAVE_REJECTED (${code}): ${message}`);
    }
    const preview = parseBossGreetingPreview(JSON.stringify(resolveEffectiveGreeting(payload, input.bossJobId)));
    if (preview.body !== input.body || preview.jobId !== input.bossJobId) throw new Error("BOSS_GREETING_SAVE_UNVERIFIED");
    return preview;
}

/** Preserve a known empty job as setup state; other transport errors remain errors. */
export function isUnconfiguredBossGreeting(error: unknown): boolean {
  const detail = error instanceof BossCliExecutionError ? error.result.stderr : error instanceof Error ? error.message : '';
  return /BOSS_GREETING_JOB_BODY_EMPTY(?=[:：\s]|$)/u.test(detail);
}
