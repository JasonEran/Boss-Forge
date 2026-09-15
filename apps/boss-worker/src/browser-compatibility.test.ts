import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getBossCliInstallation } from '@boss-forge/boss-cli-adapter';

describe('browser runtime compatibility', () => {
  it('uses the same Puppeteer version in the worker and BOSS CLI', async () => {
    const { packageRoot } = await getBossCliInstallation();
    const local = createRequire(import.meta.url), vendor = createRequire(`${packageRoot}/package.json`);
    const version = (resolve: ReturnType<typeof createRequire>) => JSON.parse(readFileSync(resolve.resolve('puppeteer-core/package.json'), 'utf8')).version;
    expect(version(vendor)).toBe(version(local));
  });
  it.runIf(existsSync('/usr/bin/chromium'))('ships a Chromium major supported by the installed Puppeteer', async () => {
    const root = dirname(createRequire(import.meta.url).resolve('puppeteer-core/package.json'));
    const { PUPPETEER_REVISIONS } = await import(pathToFileURL(join(root, 'lib/puppeteer/revisions.js')).href);
    const probe = spawnSync('/usr/bin/chromium', ['--version'], { encoding: 'utf8', timeout: 5000 });
    expect(probe.status).toBe(0);
    const major = probe.stdout.match(/Chromium (\d+)\./)?.[1];
    expect(major).toBe(PUPPETEER_REVISIONS.chrome.split('.')[0]);
  });
});
