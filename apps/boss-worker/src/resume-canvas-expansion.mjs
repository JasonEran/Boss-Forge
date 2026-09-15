import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { ocr } from 'tencentcloud-sdk-nodejs-ocr';

/** Match only visible résumé expansion labels, never VIP analysis or contact actions. */
export function resumeExpansionTarget(detection) {
  const text = (detection.DetectedText || '').replace(/\s/g, '');
  const label = ['查看全部', '展开全部', '展开更多', '显示全部', '展开'].find(value => text.endsWith(value));
  if (label === '展开' && text !== label) return null;
  const box = detection.ItemPolygon;
  if (!label || /分析|联系|招呼/.test(text) || (detection.Confidence ?? 0) < 80 || !box || !(box.Width > 0 && box.Height > 0)) return null;
  const characters = detection.Words ?? [], points = detection.WordCoordPoint ?? [];
  if (characters.length === points.length && characters.slice(-label.length).map(word => word.Character).join('') === label) {
    const vertices = points.slice(-label.length).flatMap(word => word.WordCoordinate ?? []);
    if (vertices.length && vertices.every(point => Number.isFinite(point.X) && Number.isFinite(point.Y))) {
      return { x: (Math.min(...vertices.map(p => p.X)) + Math.max(...vertices.map(p => p.X))) / 2,
        y: (Math.min(...vertices.map(p => p.Y)) + Math.max(...vertices.map(p => p.Y))) / 2, label };
    }
  }
  return { x: box.X + box.Width - Math.min(box.Width / 2, box.Height * label.length / 2), y: box.Y + box.Height / 2, label };
}

/** Read the actual captured pixels so the WASM/canvas résumé can be expanded too. */
export async function inspectResumeCapture({ page, frame, path, artifact, restoreLayout }) {
  if (!(await frame.$('canvas'))) return { expanded: false };
  const client = new ocr.v20181119.Client({
    credential: { secretId: process.env.TENCENTCLOUD_SECRET_ID, secretKey: process.env.TENCENTCLOUD_SECRET_KEY },
    region: process.env.TENCENTCLOUD_OCR_REGION || 'ap-guangzhou',
    profile: { httpProfile: { endpoint: 'ocr.tencentcloudapi.com', reqTimeout: 20 } }
  });
  const responses = [], hash = createHash('sha256');
  hash.update(await readFile(path + '.manifest.json'));
  for (const part of artifact.parts) {
    const bytes = await readFile(join(dirname(path), part.file)); hash.update(bytes);
    if (bytes.toString('base64').length > 10 * 1024 * 1024) throw new Error('TencentCloud OCR image is too large.');
    let response;
    try { response = await client.GeneralBasicOCR({ ImageBase64: bytes.toString('base64'), LanguageType: 'zh', IsWords: true }); }
    catch (error) { throw new Error('TencentCloud OCR expansion check failed.', { cause: error }); }
    responses.push(response);
    for (const detection of response.TextDetections || []) {
      const target = resumeExpansionTarget(detection); if (!target) continue;
      const scale = part.height / part.cssHeight;
      const point = { x: target.x / scale, y: part.offsetY + target.y / scale };
      await restoreLayout?.();
      await clickResumeExpansion(page, frame, point);
      return { expanded: true };
    }
  }
  const detections = responses.flatMap(response => response.TextDetections || []).filter(item => item.DetectedText?.trim());
  const confidences = detections.map(item => item.Confidence).filter(value => typeof value === 'number' && Number.isFinite(value));
  const result = {
    text: detections.map(item => item.DetectedText.trim()).join('\n'), lineCount: detections.length,
    averageConfidence: confidences.length ? confidences.reduce((sum, n) => sum + n, 0) / confidences.length : null,
    requestId: responses.map(response => response.RequestId).filter(Boolean).join(',') || null
  };
  await writeFile(path + '.ocr.json', JSON.stringify({ version: 1, captureHash: hash.digest('hex'), result }), { mode: 0o600 });
  return { expanded: false };
}

/** Let the real parent scroll containers reveal the point. BOSS's virtual
 * canvas hit testing does not support scrolling the c-resume window itself. */
export async function clickResumeExpansion(page, frame, point) {
  await frame.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }));
  await new Promise(resolve => setTimeout(resolve, 300));
  const marker = await frame.evaluateHandle(({ x, y }) => {
    const element = document.createElement('span');
    Object.assign(element.style, { position: 'absolute', left: x+'px', top: y+'px',
      width: '1px', height: '1px', pointerEvents: 'none' });
    document.body.appendChild(element);
    element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    return element;
  }, point);
  try {
    await new Promise(resolve => setTimeout(resolve, 300));
    const box = await marker.asElement()?.boundingBox();
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    if (!box || box.x < 0 || box.y < 0 || box.x > viewport.width || box.y > viewport.height) {
      throw new Error('BOSS_RESUME_INCOMPLETE：折叠内容暂未进入可点击区域。');
    }
    await page.mouse.click(box.x, box.y);
    await new Promise(resolve => setTimeout(resolve, 800));
  } finally {
    await marker.evaluate(element => element.remove()).catch(() => {});
    await marker.dispose();
  }
}
