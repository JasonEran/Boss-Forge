import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { candidateRuleText } from "@boss-forge/m1-core";
import { benchmarkResumeRows, parseBenchmarkArguments, summarizeTimings, type SavedResumeBenchmarkRow } from "./resume-benchmark.js";

const directories: string[] = [];
const text = "教育经历：示例大学英语专业本科。资格证书：已取得英语专业八级证书。工作经历：负责英文内容运营。";
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const semanticConfig: SavedResumeBenchmarkRow["config"] = {
  schemaVersion: "1.1", root: { operator: "AND", children: [{
    type: "semantic", criterionId: "skill.test", label: "Skill", executionMode: "normalized_entity",
    factType: "skill", expectedValues: ["test"], valueMode: "any", minimumConfidence: .8, unknownPolicy: "manual_review"
  }] }
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function row(overrides: Partial<SavedResumeBenchmarkRow> = {}): SavedResumeBenchmarkRow {
  return {
    state_id: "private-state-identifier", screenshot_path: null, resume_text_hash: hash(text),
    stored_decision: "matched", assessment_text: null, raw_text: "private-card-only", source: "recommend",
    display_name: "private-candidate-name", source_locator: null, raw_fields: {}, source_evidence: [], source_reference: "recommend:1:private-reference",
    config: { schemaVersion: "1.0", root: { operator: "AND", children: [{ type: "english_credential", accepted: ["tem8"], mode: "any", minimumConfidence: .85, unknownPolicy: "manual_review" }] } },
    source_boss_filters: null, semantic_evaluations: [], ...overrides
  };
}

function withAssessment(value: SavedResumeBenchmarkRow): SavedResumeBenchmarkRow {
  const candidate = { index: 1, name: value.display_name, source: value.source, fields: value.raw_fields, evidence: value.source_evidence, raw: value.raw_text };
  return { ...value, assessment_text: `${candidateRuleText(candidate)}。完整简历：${text}` };
}

async function capture(partCount = 3): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "resume-benchmark-test-"));
  directories.push(directory);
  const path = join(directory, "private-capture.png");
  const buffers = [];
  const parts = [];
  for (let index = 0; index < partCount; index++) {
    const png = Buffer.alloc(32);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    png.writeUInt32BE(100, 16); png.writeUInt32BE(100, 20); png.writeUInt32BE(index, 28);
    const file = index ? `part-${index}.png` : "private-capture.png";
    await writeFile(join(directory, file), png);
    buffers.push(png);
    parts.push({ file, width: 100, height: 100, cssHeight: 100, offsetY: index * 100, overlapTop: 0 });
  }
  const manifest = JSON.stringify({ version: 1, complete: true, contentHeight: 100 * partCount, contentWidth: 100, parts });
  await writeFile(`${path}.manifest.json`, manifest);
  const captureHash = createHash("sha256").update(manifest);
  for (const png of buffers) captureHash.update(png);
  await writeFile(`${path}.ocr.json`, JSON.stringify({ version: 1, captureHash: captureHash.digest("hex"), result: { text, lineCount: 1, averageConfidence: 99, requestId: "private-provider-id" } }));
  return path;
}

describe("offline saved resume benchmark", () => {
  it("evaluates verified OCR rather than card-only text and reports wall, percentiles, CPU and RSS without PII", async () => {
    const path = await capture();
    const report = await benchmarkResumeRows([row({ screenshot_path: path })], { repetitions: 2, concurrency: 3 });
    expect(report.runs.map(run => run.mode)).toEqual(["sequential", "bounded_parallel", "bounded_parallel", "sequential"]);
    for (const run of report.runs) {
      expect(run.evaluated).toBe(1);
      expect(run.parity).toEqual({ matched: 1 });
      expect(run.textSources).toEqual({ ocr_cache: 1 });
      expect(run.decisions).toEqual({ matched: 1 });
      expect(run.artifactPartsRead).toBe(3);
      expect(run.artifactBytesRead).toBe(96);
      expect(run.stages.rule_evaluation_ms?.p99Ms).toBeGreaterThanOrEqual(0);
      expect(run.wallMs).toBeGreaterThan(0);
      expect(run.cpuUserMs + run.cpuSystemMs).toBeGreaterThanOrEqual(0);
      expect(run.rssSampledPeakBytes).toBeGreaterThan(0);
      expect(run.resultMismatchesAgainstFirstRun).toBe(0);
    }
    expect(report.totalWallMs).toBeGreaterThan(0);
    const serialized = JSON.stringify(report);
    for (const privateValue of [text, path, "private-candidate-name", "private-card-only", "private-state-identifier", "private-provider-id"]) expect(serialized).not.toContain(privateValue);
    expect(report.externalOcrRequests).toBe(0);
    expect(report.syntheticOcr).toBeNull();
  });

  it("never treats the original card or an unrelated assessment as complete OCR", async () => {
    const missing = row({ raw_text: text });
    const wrongPrefix = row({ assessment_text: `different-card。完整简历：${text}` });
    const report = await benchmarkResumeRows([missing, wrongPrefix, withAssessment(row())], { repetitions: 1 });
    const run = report.runs[0]!;
    expect(run.selected).toBe(3);
    expect(run.evaluated).toBe(1);
    expect(run.parity).toEqual({ no_saved_ocr: 2, matched: 1 });
    expect(run.textSources).toEqual({ missing: 2, assessment_text: 1 });
    expect(run.gaps.assessment_prefix_mismatch).toBe(1);
  });

  it("rejects stale caches and separates unmatched decisions, unverified hashes and semantic gaps", async () => {
    const path = await capture();
    const cached = JSON.parse(await readFile(`${path}.ocr.json`, "utf8"));
    cached.captureHash = "stale";
    await writeFile(`${path}.ocr.json`, JSON.stringify(cached));
    const semantic = withAssessment(row({ config: semanticConfig }));
    const report = await benchmarkResumeRows([
      row({ screenshot_path: path }),
      withAssessment(row({ stored_decision: "not_matched" })),
      withAssessment(row({ resume_text_hash: "unverified" })),
      semantic
    ], { repetitions: 1 });
    expect(report.runs[0]!.parity).toEqual({ no_saved_ocr: 1, mismatched: 1, text_hash_unverified: 1, semantic_gap: 1 });
    expect(report.runs[0]!.gaps).toMatchObject({ ocr_cache_invalid_or_stale: 1, saved_semantic_evaluation_missing: 1 });
  });

  it("reuses recorded semantic results without a provider call", async () => {
    const semantic = withAssessment(row({ config: semanticConfig, semantic_evaluations: [{ criterionId: "skill.test", factType: "skill", executionMode: "normalized_entity", result: "matched", normalizedValue: ["test"], qualifier: null, evidence: ["private-semantic-evidence"], confidence: 1, extractor: "alias", modelVersion: null, promptVersion: "test", catalogVersion: "test", rubricVersion: null, runtimeMode: "active", reasonCodes: [] }] }));
    const report = await benchmarkResumeRows([semantic], { repetitions: 1 });
    expect(report.runs[0]!.parity).toEqual({ matched: 1 });
    expect(report.runs[0]!.savedSemanticEvaluationsReused).toBe(1);
    expect(report.semanticProviderRequests).toBe(0);
    expect(JSON.stringify(report)).not.toContain("private-semantic-evidence");
  });

  it("runs synthetic OCR through the real adapter with bounded concurrency and isolated cache hits", async () => {
    const path = await capture(4);
    const cacheBefore = await readFile(`${path}.ocr.json`, "utf8");
    const report = await benchmarkResumeRows([row({ screenshot_path: path })], { repetitions: 1, concurrency: 2, ocrConcurrency: 2, syntheticOcrMs: 5 });
    const synthetic = report.syntheticOcr!;
    expect(synthetic.kind).toBe("synthetic_latency_and_text");
    expect(synthetic.externalOcrRequests).toBe(0);
    expect(synthetic.runs.map(run => run.requestsToSyntheticClient)).toEqual([4, 4, 4, 0]);
    expect(synthetic.runs.map(run => run.peakConcurrentSyntheticRequests)).toEqual([1, 2, 2, 0]);
    expect(synthetic.runs.at(-1)!.cacheHits).toBe(1);
    expect(synthetic.runs.every(run => run.outputMismatchesAgainstSequential === 0 && run.errors === 0)).toBe(true);
    expect(await readFile(`${path}.ocr.json`, "utf8")).toBe(cacheBefore);
  });

  it("reports missing segments as artifact errors without hiding assessment coverage", async () => {
    const path = await capture();
    await rm(join(path, "..", "part-2.png"));
    const report = await benchmarkResumeRows([withAssessment(row({ screenshot_path: path }))], { repetitions: 1 });
    expect(report.runs[0]!.errors).toEqual({ artifact_read_failed: 1 });
    expect(report.runs[0]!.completeArtifacts).toBe(0);
    expect(report.runs[0]!.parity).toEqual({ matched: 1 });
  });

  it("rejects malformed limits, unknown arguments and invalid task filters", () => {
    expect(() => parseBenchmarkArguments(["--concurrency=0"])).toThrow();
    expect(() => parseBenchmarkArguments(["--limit=NaN"])).toThrow();
    expect(() => parseBenchmarkArguments(["--synthetic-ocr-ms=-1"])).toThrow();
    expect(() => parseBenchmarkArguments(["--apply"])).toThrow();
    expect(() => parseBenchmarkArguments(["invalid-id"])).toThrow();
    expect(parseBenchmarkArguments(["--concurrency=4", "--synthetic-ocr-ms=0"])).toMatchObject({ concurrency: 4, syntheticOcrMs: 0 });
  });

  it("uses nearest-rank percentiles and represents an empty sample without NaN", async () => {
    expect(summarizeTimings([1, 100])).toEqual({ count: 2, totalMs: 101, p50Ms: 1, p95Ms: 100, p99Ms: 100, maxMs: 100 });
    const report = await benchmarkResumeRows([], { repetitions: 1 });
    expect(report.selected).toBe(0);
    expect(report.runs[0]!.evaluated).toBe(0);
    expect(JSON.stringify(report)).not.toMatch(/NaN|undefined/);
  });
});
