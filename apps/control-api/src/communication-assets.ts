import { isBossAssetUrl, type BossChatAsset } from '@boss-forge/contracts';
const maxBytes = 20 * 1024 * 1024;
const imageTypes = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
]);
/** No client-supplied URL or BOSS cookies are accepted. Signed native asset URLs
 * are resolved from the authorized message, with checks on every redirect. */
export async function fetchCommunicationAsset(
  asset: BossChatAsset,
  fetcher: typeof fetch = fetch,
): Promise<{ body: Buffer; contentType: string; disposition: string }> {
  let url = asset.url;
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (!isBossAssetUrl(url)) throw new Error('附件地址不受支持。');
    const response = await fetcher(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
      headers: { accept: '*/*' },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const next = response.headers.get('location');
      if (!next) throw new Error('附件地址已失效，请重新同步会话。');
      url = new URL(next, url).href;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('附件链接已失效或需要 BOSS 验证，请重新同步会话后重试。');
    }
    const contentType = (
      response.headers.get('content-type') ?? 'application/octet-stream'
    )
      .split(';')[0]!
      .trim()
      .toLowerCase();
    if (asset.kind === 'image' && !imageTypes.has(contentType)) {
      await response.body?.cancel();
      throw new Error('此图片格式暂不支持预览。');
    }
    if (
      [
        'text/html',
        'application/xhtml+xml',
        'image/svg+xml',
        'application/javascript',
        'text/javascript',
      ].includes(contentType)
    ) {
      await response.body?.cancel();
      throw new Error('附件返回了页面内容，请重新同步会话。');
    }
    if (Number(response.headers.get('content-length')) > maxBytes) {
      await response.body?.cancel();
      throw new Error('附件超过 20 MB，暂不支持下载。');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('附件内容为空。');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > maxBytes) throw new Error('附件超过 20 MB，暂不支持下载。');
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    if (!size) throw new Error('附件内容为空。');
    let name = asset.name.replace(/[\r\n/\\\x00-\x1f]/g, '_');
    const extensions: Record<string, string> = {
      'application/pdf': '.pdf',
      'application/msword': '.doc',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
        '.docx',
      'application/vnd.ms-excel': '.xls',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
        '.xlsx',
      'text/plain': '.txt',
    };
    if (asset.kind === 'file' && !/\.[a-z0-9]{1,8}$/i.test(name))
      name += extensions[contentType] ?? '';
    return {
      body: Buffer.concat(chunks),
      contentType,
      disposition: `${asset.kind === 'image' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
    };
  }
  throw new Error('附件跳转过多，请重新同步会话。');
}
