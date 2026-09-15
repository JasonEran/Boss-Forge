import { describe, it, expect, vi } from 'vitest';
import { fetchCommunicationAsset } from './communication-assets.js';
const asset = {
  kind: 'file' as const,
  name: '简历.pdf',
  url: 'https://static.zhipin.com/resume.pdf',
};
describe('authorized chat attachment download', () => {
  it('downloads a native URL without forwarding authentication, and forces an attachment filename', async () => {
    const mock = vi.fn<typeof fetch>(
      async () =>
        new Response('%PDF fixture', {
          headers: { 'content-type': 'application/pdf' },
        }),
    );
    const result = await fetchCommunicationAsset(asset, mock);
    expect(result.body.toString()).toBe('%PDF fixture');
    expect(result.disposition).toContain('attachment; filename*=UTF-8');
    expect(mock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        redirect: 'manual',
        headers: { accept: '*/*' },
      }),
    );
  });
  it('blocks off-domain redirects before fetching their destination', async () => {
    const mock = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'http://127.0.0.1/private' },
        }),
    );
    await expect(fetchCommunicationAsset(asset, mock)).rejects.toThrow(
      '不受支持',
    );
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it('rejects active document content, expired links and oversized files', async () => {
    await expect(
      fetchCommunicationAsset(
        asset,
        async () =>
          new Response('<script>', {
            headers: { 'content-type': 'text/html' },
          }),
      ),
    ).rejects.toThrow('页面内容');
    await expect(
      fetchCommunicationAsset(
        asset,
        async () => new Response('', { status: 403 }),
      ),
    ).rejects.toThrow('失效');
    await expect(
      fetchCommunicationAsset(
        asset,
        async () =>
          new Response('x', {
            headers: { 'content-length': String(21 * 1024 * 1024) },
          }),
      ),
    ).rejects.toThrow('20 MB');
    await expect(
      fetchCommunicationAsset(
        { ...asset, kind: 'image' },
        async () =>
          new Response('<svg>', {
            headers: { 'content-type': 'image/svg+xml' },
          }),
      ),
    ).rejects.toThrow('格式');
  });
  it('enforces the limit during streaming even if content-length is absent', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(20 * 1024 * 1024));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    await expect(
      fetchCommunicationAsset(asset, async () => new Response(stream)),
    ).rejects.toThrow('20 MB');
  });
});
