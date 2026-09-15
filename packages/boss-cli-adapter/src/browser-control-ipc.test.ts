import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BossBrowserControlError,
  bossBrowserControlSocketPath,
  requestBossGreetingPreviewViaIpc,
  requestBossGreetingSaveViaIpc,
  requestBossPositionsViaIpc,
  requestBossFilterOptionsViaIpc,
  startBossBrowserControlServer
} from "./browser-control-ipc.js";

describe.sequential("browser-control Unix socket", () => {
  const created: string[] = [];

  afterEach(async () => {
    await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  async function socketPath(): Promise<string> {
    const runtime = await mkdtemp(join(tmpdir(), "boss-browser-control-"));
    created.push(runtime);
    return bossBrowserControlSocketPath(runtime);
  }

  it('fetches fresh options for the exact requested job and rejects a mismatched job response', async () => {
    const path = await socketPath();
    let labels = ['英语读写'];
    let wrongJob = false;
    const server = await startBossBrowserControlServer({ socketPath: path, accountId: 'boss-account-01',
      filterOptions: async ({ bossJobId, jobKeyword }) => ({ bossJobId: wrongJob ? 'other-job' : bossJobId, bossJobName: jobKeyword, fetchedAt: new Date().toISOString(), fields: { keyword1: labels, salary:['5-10K'] },definitions:[
        {key:'age',label:'年龄',kind:'range',source:'vip',available:true,range:{min:16,max:45,step:1}},
        {key:'salary',label:'薪资待遇',kind:'single',source:'normal',available:true,maxSelected:1},
        {key:'keyword1',label:'牛人关键词',kind:'multiple',source:'vip',available:true,maxSelected:12},
      ] }),
      greetingPreview: async () => { throw new Error('Not a contact request'); },
    });
    const request = { socketPath: path, accountId: 'boss-account-01', bossJobId: 'job-amazon', jobKeyword: '亚马逊运营', timeoutMs: 1000 };
    try {
      await expect(requestBossFilterOptionsViaIpc(request)).resolves.toMatchObject({ bossJobId: 'job-amazon', fields: { keyword1: ['英语读写'] } });
      const snapshot = await requestBossFilterOptionsViaIpc(request);
      expect(snapshot.definitions).toHaveLength(3);
      expect(snapshot.definitions?.find(item=>item.key==='age')?.range).toEqual({min:16,max:45,step:1});
      expect(snapshot.fields.salary).toEqual(['5-10K']);
      labels = ['店铺运营'];
      await expect(requestBossFilterOptionsViaIpc(request)).resolves.toMatchObject({ fields: { keyword1: ['店铺运营'] } });
      wrongJob = true;
      await expect(requestBossFilterOptionsViaIpc(request)).rejects.toMatchObject({ code: 'unavailable' });
    } finally { await server.close(); }
  });

  it('preserves an unconfigured greeting as a distinct setup state across IPC', async () => {
    const path = await socketPath();
    const server = await startBossBrowserControlServer({socketPath:path,accountId:'boss-account-01',greetingPreview:async()=>{throw new BossBrowserControlError('greeting_not_configured','private provider detail');}});
    try {
      await expect(requestBossGreetingPreviewViaIpc({socketPath:path,accountId:'boss-account-01',jobKeyword:'job-amazon',timeoutMs:1000})).rejects.toMatchObject({code:'greeting_not_configured',message:'Browser-control request failed: greeting_not_configured.'});
    } finally {await server.close()}
  });

  it('preserves an explicit greeting rejection across the save IPC', async () => {
    const path = await socketPath();
    const server = await startBossBrowserControlServer({socketPath:path,accountId:'boss-account-01',greetingPreview:async()=>{throw new Error('unexpected')},greetingSave:async()=>{throw new BossBrowserControlError('greeting_save_rejected','private diagnostic')}});
    try {
      await expect(requestBossGreetingSaveViaIpc({socketPath:path,accountId:'boss-account-01',bossJobId:'job-test-1',jobKeyword:'job-test-1',body:'你好',timeoutMs:1000})).rejects.toMatchObject({code:'greeting_save_rejected'});
    } finally {await server.close()}
  });

  it("reads a structured job catalog through the authenticated account socket", async () => {
    const path = await socketPath();
    const catalog = { complete: true, jobs: [{ id: "job-1", name: "运营", status: "开放中" }] };
    const server = await startBossBrowserControlServer({
      socketPath: path, accountId: "boss-account-01",
      positions: async () => catalog,
      greetingPreview: async () => { throw new Error("Unexpected greeting request"); },
    });
    try {
      await expect(requestBossPositionsViaIpc({ socketPath: path, accountId: "boss-account-01", timeoutMs: 1000 })).resolves.toEqual(catalog);
      await expect(requestBossPositionsViaIpc({ socketPath: path, accountId: "another-account", timeoutMs: 1000 })).rejects.toMatchObject({ code: "unavailable" });
    } finally { await server.close(); }
  });

  it("binds an exact preview to a random request and a 0600 socket", async () => {
    const path = await socketPath();
    let observedRequestId = "";
    const server = await startBossBrowserControlServer({
      socketPath: path,
      accountId: "boss-account-01",
      async greetingPreview(request) {
        observedRequestId = request.requestId;
        expect(request.jobKeyword).toBe("测试岗位");
        return {
          schemaVersion: 1,
          kind: "greeting-preview",
          source: "job",
          jobId: "job-001",
          jobName: "测试岗位",
          greetingId: "greeting-001",
          body: "你好，想和你沟通一下这个岗位。"
        };
      }
    });
    try {
      await expect(requestBossGreetingPreviewViaIpc({
        socketPath: path,
        accountId: "boss-account-01",
        jobKeyword: "测试岗位",
        timeoutMs: 1_000
      })).resolves.toMatchObject({ jobId: "job-001", greetingId: "greeting-001" });
      expect(observedRequestId).toMatch(/^[0-9a-f-]{36}$/u);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await server.close();
    }
  });

  it("rejects concurrent work as busy without releasing the active request", async () => {
    const path = await socketPath();
    let saveCalls = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let startedFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => { startedFirst = resolve; });
    const server = await startBossBrowserControlServer({
      socketPath: path,
      accountId: "boss-account-01",
      async greetingSave() { saveCalls++; throw new Error("A busy request must not reach a save"); },
      async greetingPreview() {
        startedFirst();
        await firstGate;
        return {
          schemaVersion: 1,
          kind: "greeting-preview",
          source: "job",
          jobId: "job-001",
          jobName: "测试岗位",
          greetingId: "greeting-001",
          body: "你好"
        };
      }
    });
    try {
      const first = requestBossGreetingPreviewViaIpc({
        socketPath: path,
        accountId: "boss-account-01",
        jobKeyword: "测试岗位",
        timeoutMs: 1_000
      });
      await firstStarted;
      await expect(requestBossGreetingPreviewViaIpc({
        socketPath: path,
        accountId: "boss-account-01",
        jobKeyword: "测试岗位",
        timeoutMs: 1_000
      })).rejects.toMatchObject({ code: "busy" });
      // A rejected concurrent request must not clear the first request's busy flag.
      await expect(requestBossGreetingPreviewViaIpc({
        socketPath: path,
        accountId: "boss-account-01",
        jobKeyword: "测试岗位",
        timeoutMs: 1_000
      })).rejects.toMatchObject({ code: "busy" });
      await expect(requestBossGreetingSaveViaIpc({
        socketPath: path, accountId: 'boss-account-01', bossJobId: 'job-001', jobKeyword: 'job-001', body: '你好', timeoutMs: 1000,
      })).rejects.toMatchObject({ code: 'busy' });
      expect(saveCalls).toBe(0);
      releaseFirst();
      await expect(first).resolves.toMatchObject({ jobId: "job-001" });
    } finally {
      releaseFirst();
      await server.close();
    }
  });

  it("fails closed for a missing supervisor or an account mismatch", async () => {
    const missing = await socketPath();
    await expect(requestBossGreetingPreviewViaIpc({
      socketPath: missing,
      accountId: "boss-account-01",
      jobKeyword: "测试岗位",
      timeoutMs: 200
    })).rejects.toBeInstanceOf(BossBrowserControlError);

    const path = await socketPath();
    const server = await startBossBrowserControlServer({
      socketPath: path,
      accountId: "boss-account-01",
      async greetingPreview() {
        throw new Error("must not run");
      }
    });
    try {
      await expect(requestBossGreetingPreviewViaIpc({
        socketPath: path,
        accountId: "another-account",
        jobKeyword: "测试岗位",
        timeoutMs: 1_000
      })).rejects.toMatchObject({ code: "unavailable" });
    } finally {
      await server.close();
    }
  });
});
