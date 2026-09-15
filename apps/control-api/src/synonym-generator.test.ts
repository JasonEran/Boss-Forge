import { describe, expect, it, vi } from 'vitest';

import {
  generateSynonyms,
  SynonymModelUnavailableError,
} from './synonym-generator.js';

const configured = {
  BOSS_FORGE_SEMANTIC_ENABLED: '1',
  BOSS_FORGE_SEMANTIC_BASE_URL: 'https://model.internal/v1/',
  BOSS_FORGE_SEMANTIC_MODEL: 'local-model-v1',
  BOSS_FORGE_SEMANTIC_API_KEY: 'test-key',
  BOSS_FORGE_SEMANTIC_TIMEOUT_MS: '5000',
};

describe('generateSynonyms', () => {
  it('requires a configured model', async () => {
    await expect(
      generateSynonyms({ term: '跨境电商' }, { BOSS_FORGE_SEMANTIC_ENABLED: '0' }),
    ).rejects.toBeInstanceOf(SynonymModelUnavailableError);
  });

  it('does not call the provider without a fresh credential or with an insecure endpoint', async () => {
    const fetchImpl = vi.fn();
    await expect(
      generateSynonyms(
        { term: '跨境电商' },
        { ...configured, BOSS_FORGE_SEMANTIC_API_KEY: '' },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toBeInstanceOf(SynonymModelUnavailableError);
    await expect(
      generateSynonyms(
        { term: '跨境电商' },
        { ...configured, BOSS_FORGE_SEMANTIC_BASE_URL: 'http://model.internal/v1' },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toBeInstanceOf(SynonymModelUnavailableError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns a deduplicated preview without the original term', async () => {
    let authorization: string | null = null;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get('authorization');
      const request = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      expect(JSON.parse(request.messages[1]!.content)).toMatchObject({
        term: '跨境电商',
        positionName: '海外运营专员',
      });
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  aliases: ['海外电商', '出海电商', '跨境电商', '海外电商'],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    await expect(
      generateSynonyms(
        { term: '跨境电商', positionName: '海外运营专员' },
        configured,
        fetchImpl,
      ),
    ).resolves.toEqual({
      term: '跨境电商',
      aliases: ['海外电商', '出海电商'],
      model: 'local-model-v1',
    });
    expect(authorization).toBe('Bearer test-key');
  });
});
