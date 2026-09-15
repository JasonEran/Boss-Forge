import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { BossGreetingSaveRejectedError, saveBossJobGreetingOnPage } from "./boss-job-greeting.js";

function fixture(options: { missing?: boolean; reject?: boolean; mismatch?: boolean; already?: boolean; unconfigured?: boolean; staleReads?: number; transport?: 'timeout' | 'network' | 'http' | 'json' } = {}) {
  const calls: { path: string; method: string; headers: Record<string, string>; credentials: boolean; timeout: number; body?: string }[] = [];
  let content = options.already ? "你好，希望了解你的运营经历。" : options.unconfigured ? '' : "原来的岗位招呼语";
  let greetingId = content ? 'greet-test-1' : null;
  let staleReads = options.staleReads ?? 0;
  let wrote = false;
  const page = { async evaluate(script: string) {
    class FixtureXHR {
      method = ''; path = ''; headers: Record<string, string> = {}; withCredentials = false; timeout = 0; status = 200; responseText = '';
      onload = () => {}; onerror = () => {}; ontimeout = () => {}; onabort = () => {};
      open(method: string, path: string) { this.method = method; this.path = path; }
      setRequestHeader(key: string, value: string) { this.headers[key] = value; }
      send(body?: string) {
        calls.push({ path: this.path, method: this.method, headers: this.headers, credentials: this.withCredentials, timeout: this.timeout, ...(body ? {body} : {}) });
        if (this.method === 'POST') {
          if (options.transport === 'timeout') return this.ontimeout();
          if (options.transport === 'network') return this.onerror();
          if (options.transport === 'http') { this.status = 503; return this.onload(); }
          if (options.transport === 'json') { this.responseText = '<html>'; return this.onload(); }
          if (!options.mismatch && !options.reject) { content = new URLSearchParams(body).get('content')!; greetingId = 'greet-test-1'; wrote = true; }
          this.responseText = JSON.stringify({ code: options.reject ? 121 : 0, message: options.reject ? '请求不合法(121).' : 'Success' });
        } else {
          const visibleContent = wrote && staleReads-- > 0 ? '' : content;
          this.responseText = JSON.stringify({ code: 0, zpData: { jobs: options.missing ? [] : [{ encJobId: 'job-test-1', jobName: '运营', jobGreeting: visibleContent, encGreetingId: visibleContent ? greetingId : null }] } });
        }
        this.onload();
      }
    }
    return vm.runInNewContext(script, { URLSearchParams, XMLHttpRequest: FixtureXHR, setTimeout });
  } };
  return { calls, page };
}
describe('editable BOSS job greeting', () => {
  it('writes only the exact job setting and verifies the body by reading it back', async () => {
    const { page, calls } = fixture();
    const body = '你好，希望了解你的运营经历。';
    await expect(saveBossJobGreetingOnPage(page, { bossJobId: 'job-test-1', body })).resolves.toMatchObject({ jobId: 'job-test-1', body });
    expect(calls.map(item => item.path)).toEqual(['/wapi/zpchat/greeting/job/get', '/wapi/zpchat/greeting/job/save', '/wapi/zpchat/greeting/job/get']);
    expect(new URLSearchParams(calls[1]!.body).get('encJobId')).toBe('job-test-1');
    expect(new URLSearchParams(calls[1]!.body).get('content')).toBe(body);
    expect(calls.every(call => call.headers['with-common-headers'] === 'true' && call.credentials && call.timeout > 0 && call.timeout <= 20000)).toBe(true);
    expect(calls[1]!.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(calls.some(item => /chat\/start|message\/send/.test(item.path))).toBe(false);
  });
  it.each(['missing', 'reject', 'mismatch'] as const)('does not report an unconfirmed %s update as saved', async flag => {
    const { page, calls } = fixture({ [flag]: true });
    await expect(saveBossJobGreetingOnPage(page, { bossJobId: 'job-test-1', body: '你好，希望了解你的运营经历。' })).rejects.toThrow();
    if (flag === 'missing') expect(calls).toHaveLength(1);
  });
  it('sets a previously unconfigured job and reads back its new greeting ID', async () => {
    const { page, calls } = fixture({ unconfigured: true });
    const body = '你好，想了解你的运营经历 & AI + 英语能力。';
    await expect(saveBossJobGreetingOnPage(page, { bossJobId: 'job-test-1', body })).resolves.toMatchObject({ body, greetingId: 'greet-test-1' });
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(1);
    expect(new URLSearchParams(calls[1]!.body).get('content')).toBe(body);
  });
  it('retries only read-back when the first response still shows the old configuration', async () => {
    const { page, calls } = fixture({ unconfigured: true, staleReads: 1 });
    await expect(saveBossJobGreetingOnPage(page, { bossJobId: 'job-test-1', body: '你好，希望了解你的运营经历。' })).resolves.toMatchObject({ greetingId: 'greet-test-1' });
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(1);
    expect(calls.filter(call => call.method === 'GET')).toHaveLength(3);
  });
  it('distinguishes an explicit BOSS rejection and preserves its diagnostic code', async () => {
    const { page, calls } = fixture({ reject: true });
    await expect(saveBossJobGreetingOnPage(page, { bossJobId: 'job-test-1', body: '你好，希望了解你的运营经历。' })).rejects.toThrow(BossGreetingSaveRejectedError);
    expect(calls).toHaveLength(2);
  });
  it.each(['timeout', 'network', 'http', 'json'] as const)('does not repeat an uncertain %s write', async transport => {
    const { page, calls } = fixture({ transport });
    await expect(saveBossJobGreetingOnPage(page, { bossJobId: 'job-test-1', body: '你好，希望了解你的运营经历。' })).rejects.toThrow();
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(1);
  });
  it('avoids a second write when a previous save already took effect', async () => {
    const { page, calls } = fixture({ already: true });
    await saveBossJobGreetingOnPage(page, { bossJobId: 'job-test-1', body: '你好，希望了解你的运营经历。' });
    expect(calls).toHaveLength(1);
  });
  it('blocks per-candidate variables in a shared job greeting', async () => {
    const { page, calls } = fixture();
    await expect(saveBossJobGreetingOnPage(page, { bossJobId: 'job-test-1', body: '你好 {{candidate_name}}' })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

import { BossCliExecutionError, type BossCliRunResult } from '@boss-forge/boss-cli-adapter';
import { isUnconfiguredBossGreeting } from './boss-job-greeting.js';
it('distinguishes an unconfigured job from transport, authentication and invalid configured bodies', () => {
  const missing = new BossCliExecutionError('boss-cli exited with code 1.', { stderr: '读取打招呼预览失败：BOSS_GREETING_JOB_BODY_EMPTY：该岗位没有专属招呼语' } as BossCliRunResult);
  expect(isUnconfiguredBossGreeting(missing)).toBe(true);
  expect(isUnconfiguredBossGreeting(new Error('connection timeout'))).toBe(false);
  expect(isUnconfiguredBossGreeting(new Error('BOSS_GREETING_CONFIG_INVALID：ID 无效'))).toBe(false);
});
