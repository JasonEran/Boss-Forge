import { realpath } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { readResumeArtifact, readResumePart } from '@boss-forge/boss-cli-adapter';
import { createResumeArtifactReader } from './resume-artifact-cache.js';

const { values } = parseArgs({ options: {
  resume: { type: 'string' },
  iterations: { type: 'string', default: '20' },
} });
const iterations = Number(values.iterations);
if (!values.resume || !Number.isSafeInteger(iterations) || iterations < 2 || iterations > 1_000)
  throw new Error('Usage: tsx apps/control-api/src/resume-metadata-benchmark.ts --resume <saved.png> [--iterations 20]');
const path = await realpath(values.resume);
let bytesRead = 0;
let partReads = 0;
const countedRead: typeof readResumePart = async (...args) => {
  const bytes = await readResumePart(...args);
  bytesRead += bytes.length;
  partReads++;
  return bytes;
};

async function measure(operation: () => Promise<unknown>, count: number) {
  const times: number[] = [];
  const startedBytes = bytesRead;
  const startedReads = partReads;
  for (let index = 0; index < count; index++) {
    const started = performance.now();
    await operation();
    times.push(performance.now() - started);
  }
  const sorted = [...times].sort((a, b) => a - b);
  const percentile = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1]!;
  return {
    iterations: count,
    totalMs: times.reduce((sum, value) => sum + value, 0),
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    imageBytesRead: bytesRead - startedBytes,
    imagePartReads: partReads - startedReads,
  };
}

const baseline = async () => {
  const artifact = await readResumeArtifact(path);
  for (let index = 0; index < artifact.parts.length; index++) await countedRead(path, artifact, index);
  return artifact;
};
// Warm the operating system's file cache equally; this is an application-cache comparison.
const artifact = await baseline();
const serial = await measure(baseline, iterations);
const read = createResumeArtifactReader({ readPart: countedRead });
const cold = await measure(() => read(path), 1);
const warm = await measure(() => read(path), iterations - 1);
const optimizedTotalMs = cold.totalMs + warm.totalMs;
console.log(JSON.stringify({
  scope: 'Saved-resume metadata polling only; excludes database, OCR, BOSS and network time.',
  parts: artifact.parts.length,
  complete: artifact.complete,
  baseline: serial,
  optimizedCold: cold,
  optimizedWarm: warm,
  optimizedTotalMs,
  speedup: serial.totalMs / optimizedTotalMs,
  durationReductionPercent: (1 - optimizedTotalMs / serial.totalMs) * 100,
}, null, 2));
