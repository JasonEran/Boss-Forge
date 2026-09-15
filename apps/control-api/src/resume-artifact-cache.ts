import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  readResumeArtifact,
  readResumePart,
  resolveResumeFile,
  type ResumeArtifact,
} from '@boss-forge/boss-cli-adapter';

type CachedArtifact = {
  artifact: ResumeArtifact;
  manifest: string | null;
  parts: string[];
};

async function signature(path: string, root: string): Promise<string> {
  const file = await resolveResumeFile(path, root);
  const info = await stat(file, { bigint: true });
  if (!info.isFile()) throw new Error('Resume artifact is not a regular file.');
  return [file, info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
}

async function manifestSignature(path: string): Promise<string | null> {
  try {
    return await signature(path + '.manifest.json', dirname(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function partSignatures(path: string, artifact: ResumeArtifact): Promise<string[]> {
  const root = dirname(path);
  const signatures: string[] = [];
  for (let start = 0; start < artifact.parts.length; start += 8) {
    signatures.push(...await Promise.all(artifact.parts.slice(start, start + 8)
      .map(part => signature(join(root, part.file), root))));
  }
  return signatures;
}

const sameParts = (left: string[], right: string[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

/** Cache file validation only. Callers must authorize every request before using it. */
export function createResumeArtifactReader(options: {
  maxEntries?: number;
  readArtifact?: typeof readResumeArtifact;
  readPart?: typeof readResumePart;
} = {}) {
  const maxEntries = options.maxEntries ?? 128;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 1_024)
    throw new Error('Resume artifact cache capacity must be between 1 and 1024.');
  const readArtifact = options.readArtifact ?? readResumeArtifact;
  const readPart = options.readPart ?? readResumePart;
  const cached = new Map<string, CachedArtifact>();
  const pending = new Map<string, Promise<ResumeArtifact>>();

  async function load(path: string): Promise<ResumeArtifact> {
    const manifest = await manifestSignature(path);
    const previous = cached.get(path);
    cached.delete(path);
    if (previous && previous.manifest === manifest) {
      const parts = await partSignatures(path, previous.artifact);
      if (sameParts(previous.parts, parts)) {
        cached.set(path, previous);
        return previous.artifact;
      }
    }

    const artifact = await readArtifact(path);
    const parts = await partSignatures(path, artifact);
    for (let index = 0; index < artifact.parts.length; index++)
      await readPart(path, artifact, index);

    // A capture changing during validation must not populate the cache.
    if (manifest !== await manifestSignature(path) ||
        !sameParts(parts, await partSignatures(path, artifact)))
      throw new Error('Resume artifact changed during validation. Please retry.');

    // Manifests can contain unrecognized fields; do not retain oversized metadata.
    if (Buffer.byteLength(JSON.stringify(artifact)) <= 64 * 1024) {
      cached.set(path, { artifact, manifest, parts });
      while (cached.size > maxEntries) cached.delete(cached.keys().next().value!);
    }
    return artifact;
  }

  return async (path: string): Promise<ResumeArtifact> => {
    let task = pending.get(path);
    if (!task) {
      task = load(path);
      // Bound retained singleflight keys even under requests for distinct files.
      if (pending.size < maxEntries) {
        pending.set(path, task);
        void task.finally(() => pending.delete(path)).catch(() => {});
      }
    }
    return structuredClone(await task);
  };
}
