import { mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readResumeArtifact, readResumePart, type ResumeArtifact } from '@boss-forge/boss-cli-adapter';
import { createResumeArtifactReader } from './resume-artifact-cache.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'resume-metadata-'));
  directories.push(directory);
  const path = join(directory, 'resume.png');
  const image = Buffer.alloc(1024 * 1024);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(image);
  image.writeUInt32BE(900, 16);
  image.writeUInt32BE(1600, 20);
  const artifact: ResumeArtifact = {
    version: 1,
    complete: true,
    capturedAt: '2026-09-15T00:00:00Z',
    contentWidth: 900,
    contentHeight: 3120,
    parts: [
      { file: 'resume.png', width: 900, height: 1600, offsetY: 0, cssHeight: 1600, overlapTop: 0 },
      { file: 'resume-part-002.png', width: 900, height: 1600, offsetY: 1520, cssHeight: 1600, overlapTop: 80 },
    ],
  };
  const second = join(directory, artifact.parts[1]!.file);
  await Promise.all([
    writeFile(path, image),
    writeFile(second, image),
    writeFile(path + '.manifest.json', JSON.stringify(artifact)),
  ]);
  return { path, second, artifact, image };
}

function reader(maxEntries = 128) {
  const readArtifact = vi.fn(readResumeArtifact);
  const readPart = vi.fn(readResumePart);
  return { read: createResumeArtifactReader({ maxEntries, readArtifact, readPart }), readArtifact, readPart };
}

describe('validated resume metadata cache', () => {
  it('shares concurrent validation and skips image reads on unchanged metadata polls', async () => {
    const { path, artifact } = await fixture();
    const cache = reader();
    const results = await Promise.all(Array.from({ length: 20 }, () => cache.read(path)));
    expect(results.every(result => JSON.stringify(result) === JSON.stringify(artifact))).toBe(true);
    await cache.read(path);
    expect(cache.readArtifact).toHaveBeenCalledTimes(1);
    expect(cache.readPart).toHaveBeenCalledTimes(2);
    results[0]!.parts[0]!.height = 1;
    expect((await cache.read(path)).parts[0]!.height).toBe(1600);
  });

  it('detects part changes even when the size and modification time are restored', async () => {
    const { path, second, image } = await fixture();
    const cache = reader();
    const timestamp = new Date('2026-09-01T00:00:00Z');
    await utimes(second, timestamp, timestamp);
    await cache.read(path);
    image.writeUInt32BE(1599, 20);
    await writeFile(second, image);
    await utimes(second, timestamp, timestamp);
    await expect(cache.read(path)).rejects.toThrow(/尺寸/);
    await expect(cache.read(path)).rejects.toThrow(/尺寸/);
  });

  it('does not hide deleted parts or a replacement symlink outside the capture directory', async () => {
    const { path, second } = await fixture();
    const elsewhere = await fixture();
    const cache = reader();
    await cache.read(path);
    await rm(second);
    await expect(cache.read(path)).rejects.toThrow();
    await symlink(elsewhere.path, second);
    await expect(cache.read(path)).rejects.toThrow(/目录/);
  });

  it('invalidates manifest changes and falls back explicitly to a legacy image when removed', async () => {
    const { path, artifact } = await fixture();
    const cache = reader();
    await cache.read(path);
    await writeFile(path + '.manifest.json', JSON.stringify({ ...artifact, contentHeight: 4000 }));
    await expect(cache.read(path)).rejects.toThrow(/BOSS_RESUME_INCOMPLETE/);
    await rm(path + '.manifest.json');
    expect(await cache.read(path)).toMatchObject({ complete: false, contentHeight: 1600 });
  });

  it('checks a manifest appearing after a legacy capture has been cached', async () => {
    const { path, artifact } = await fixture();
    await rm(path + '.manifest.json');
    const cache = reader();
    expect((await cache.read(path)).complete).toBe(false);
    await writeFile(path + '.manifest.json', JSON.stringify(artifact));
    expect((await cache.read(path)).complete).toBe(true);
  });

  it('rejects a capture changing during validation and retries without retaining the failure', async () => {
    const { path, second, image } = await fixture();
    let replace = true;
    const read = createResumeArtifactReader({
      readPart: async (...args) => {
        const bytes = await readResumePart(...args);
        if (replace && args[2] === 1) {
          replace = false;
          image.writeUInt32BE(1599, 20);
          await writeFile(second, image);
        }
        return bytes;
      },
    });
    await expect(read(path)).rejects.toThrow(/changed during validation/);
    await expect(read(path)).rejects.toThrow(/尺寸/);
    image.writeUInt32BE(1600, 20);
    await writeFile(second, image);
    expect((await read(path)).complete).toBe(true);
  });

  it('evicts the least recently used metadata at capacity', async () => {
    const first = await fixture();
    const second = await fixture();
    const third = await fixture();
    const cache = reader(2);
    await cache.read(first.path);
    await cache.read(second.path);
    await cache.read(first.path);
    await cache.read(third.path);
    await cache.read(second.path);
    expect(cache.readArtifact).toHaveBeenCalledTimes(4);
  });

  it('does not retain oversized manifest metadata', async () => {
    const { path, artifact } = await fixture();
    await writeFile(path + '.manifest.json', JSON.stringify({ ...artifact, extra: 'x'.repeat(70_000) }));
    const cache = reader();
    await cache.read(path);
    await cache.read(path);
    expect(cache.readArtifact).toHaveBeenCalledTimes(2);
  });
});
