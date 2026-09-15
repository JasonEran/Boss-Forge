import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('container browser launch', () => {
  it('runs BOSS in a fixed headed X display instead of Chromium headless mode', () => {
    const dockerfile = source('deploy/docker/Dockerfile.boss-forge');
    const compose = source('deploy/compose.intranet.yaml');
    const login = compose.slice(
      compose.indexOf('  boss-login:'),
      compose.indexOf('  boss-worker:'),
    );
    const worker = compose.slice(compose.indexOf('  boss-worker:'));

    expect(dockerfile).toContain('xauth xvfb');
    expect(login).toContain('xvfb-run --auto-servernum');
    expect(login).toContain('--window-size=1100,820');
    expect(login).not.toContain('chromium --headless');
    expect(login).toContain('BOSS_BROWSER_HEADLESS: "false"');
    expect(login).toContain('BOSS_BROWSER_HEADLESS_LOGIN: "false"');
    expect(worker).toContain('- xvfb-run');
    expect(worker).toContain('BOSS_BROWSER_HEADLESS: "false"');
  });

  it('does not resize the login page through CDP after Chromium starts', () => {
    expect(source('apps/boss-worker/src/login-relay.ts')).not.toContain('.setViewport(');
  });

  it('passes the explicit no-sandbox setting to boss-cli', () => {
    expect(source('packages/boss-cli-adapter/src/runner.ts')).toContain(
      '"BOSS_BROWSER_NO_SANDBOX"',
    );
    expect(source('patches/@joohw__boss-cli@0.6.6.patch')).toContain(
      "...(noSandbox ? ['--no-sandbox'] : [])",
    );
  });

  it('constrains the worker container when Chromium sandboxing is unavailable', () => {
    const compose = source('deploy/compose.intranet.yaml');
    const worker = compose.slice(compose.indexOf('  boss-worker:'));

    expect(worker).toContain('BOSS_BROWSER_NO_SANDBOX: "true"');
    expect(worker).toContain('no-new-privileges:true');
    expect(worker).toContain('cap_drop:');
    expect(worker).toContain('- ALL');
  });
});
