import { readFile, realpath } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';

export type ResumePart = { file: string; width: number; height: number; offsetY: number; cssHeight: number; overlapTop: number };
export type ResumeArtifact = { version: 1; complete: boolean; capturedAt: string | null; contentHeight: number; contentWidth: number; parts: ResumePart[] };

export async function readResumeArtifact(path: string): Promise<ResumeArtifact> {
  let raw: string;
  try { raw = await readFile(path + '.manifest.json', 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const bytes = await readFile(path);
    if (bytes.length < 24 || !bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('简历图片无效。');
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    return { version: 1, complete: false, capturedAt: null, contentHeight: height, contentWidth: width,
      parts: [{ file: basename(path), width, height, offsetY: 0, cssHeight: height, overlapTop: 0 }] };
  }
  const data = JSON.parse(raw) as ResumeArtifact;
  if (data.version !== 1 || data.complete !== true || !Array.isArray(data.parts) || !data.parts.length || data.parts.length > 100 ||
    !Number.isInteger(data.contentHeight) || data.contentHeight < 1 || !Number.isInteger(data.contentWidth) || data.contentWidth < 1) throw new Error('BOSS_RESUME_INCOMPLETE：简历完整性记录无效。');
  let end = 0;
  for (const [index, part] of data.parts.entries()) {
    if (typeof part.file !== 'string' || basename(part.file) !== part.file || !part.file.endsWith('.png') ||
      ![part.width,part.height,part.cssHeight].every(n => Number.isInteger(n) && n > 0) ||
      !Number.isInteger(part.offsetY) || !Number.isInteger(part.overlapTop) || part.overlapTop < 0 ||
      part.offsetY !== end - part.overlapTop || (index === 0 && (part.offsetY !== 0 || part.file !== basename(path))) || part.cssHeight <= part.overlapTop) {
      throw new Error('BOSS_RESUME_INCOMPLETE：简历分段缺失或顺序不完整。');
    }
    end = part.offsetY + part.cssHeight;
  }
  if (end !== data.contentHeight) throw new Error('BOSS_RESUME_INCOMPLETE：简历底部未完整保存。');
  return data;
}

/** Resolve only stored screenshot files inside the application's shared screenshot directory. */
export async function resolveResumeFile(path: string, root: string): Promise<string> {
  const [file, directory] = await Promise.all([realpath(path), realpath(root)]);
  const child = relative(directory, file);
  if (!child || child.startsWith('..') || resolve(directory, child) !== file) throw new Error('简历文件不在截图目录中。');
  return file;
}

export async function readResumePart(path: string, artifact: ResumeArtifact, index: number): Promise<Buffer> {
  const part = artifact.parts[index];
  if (!part) throw new Error('简历截图分段不存在。');
  const target = await resolveResumeFile(join(dirname(path), part.file), dirname(path));
  const bytes = await readFile(target);
  if (bytes.length < 24 || !bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.readUInt32BE(16) !== part.width || bytes.readUInt32BE(20) !== part.height) {
    throw new Error('BOSS_RESUME_INCOMPLETE：简历图片缺失或尺寸不一致。');
  }
  return bytes;
}
