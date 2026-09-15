import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthorizationError, type CommunicationRepository, type SessionPrincipal } from '@boss-forge/data';
import { communicationCandidateContext } from './communication-online-resume.js';

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

it('authorizes every metadata poll and returns fresh analysis while reusing file validation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'communication-resume-'));
  directories.push(directory);
  vi.stubEnv('BOSS_FORGE_RESUME_SCREENSHOT_DIR', directory);
  const path = join(directory, 'resume.png');
  const image = Buffer.alloc(32);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(image);
  image.writeUInt32BE(900, 16);
  image.writeUInt32BE(1600, 20);
  await writeFile(path, image);
  let authorized = true;
  let analysisVersion = 1;
  const principal = { userId: 'one', role: 'recruiter' } as SessionPrincipal;
  const repository = {
    onlineResume: vi.fn(async (user) => {
      expect(user).toBe(principal);
      if (!authorized) throw new AuthorizationError('denied');
      return { screenshotPath: path, capturedAt: '2026-09-15T00:00:00Z', text: '', textStatus: 'pending', analysisVersion };
    }),
    onlineResumeRule: vi.fn(async (user) => {
      expect(user).toBe(principal);
      if (!authorized) throw new AuthorizationError('denied');
      return { target: { positionId: null, positionName: 'test' }, rule: null };
    }),
  };
  const read = () => communicationCandidateContext(repository as unknown as CommunicationRepository, principal, 'conversation-one');
  expect((await read()).resume?.analysisVersion).toBe(1);
  analysisVersion = 2;
  expect((await read()).resume?.analysisVersion).toBe(2);
  authorized = false;
  await expect(read()).rejects.toThrow(AuthorizationError);
  expect(repository.onlineResume).toHaveBeenCalledTimes(3);
  expect(repository.onlineResumeRule).toHaveBeenCalledTimes(3);
});
