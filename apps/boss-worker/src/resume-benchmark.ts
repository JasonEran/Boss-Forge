import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { readResumeArtifact, readResumePart } from "@boss-forge/boss-cli-adapter";
import { createDatabase, type CandidateEvaluationRecord, type RuleConfig } from "@boss-forge/data";
import type { BossRecommendationFilterPlan, ParsedCandidate } from "@boss-forge/contracts";
import { candidateRuleText, collectSemanticRules, evaluateCandidate } from "@boss-forge/m1-core";
import type { SemanticEvaluation } from "@boss-forge/semantic-engine";
import { mapWithConcurrency, recognizeResumeWithTencentOcr, type TencentOcrClient } from "./tencent-ocr.js";

export type SavedResumeBenchmarkRow = {
  state_id: string;
  eligible_count?: number;
  screenshot_path: string | null;
  resume_text_hash: string | null;
  stored_decision: CandidateEvaluationRecord["decision"];
  assessment_text: string | null;
  raw_text: string;
  source: ParsedCandidate["source"];
  display_name: string;
  source_locator: ParsedCandidate["sourceLocator"] | null;
  raw_fields: Record<string, string>;
  source_evidence: string[];
  source_reference: string;
  config: RuleConfig;
  source_boss_filters: BossRecommendationFilterPlan | null;
  semantic_evaluations: SemanticEvaluation[];
};

export type ResumeBenchmarkOptions = {
  taskIds?: string[];
  limit?: number;
  concurrency?: number;
  repetitions?: number;
  syntheticOcrMs?: number;
  syntheticLimit?: number;
  ocrConcurrency?: number;
};

type Timing = Record<string, number>;
type Parity = "matched" | "mismatched" | "text_hash_unverified" | "semantic_gap" | "no_saved_ocr" | "error";
type ReplayResult = {
  timings: Timing;
  parts: number;
  bytes: number;
  source: "ocr_cache" | "assessment_text" | "missing";
  decision: string | null;
  parity: Parity;
  gaps: string[];
  semanticCount: number;
  artifactComplete: boolean;
  error?: string;
};

const round = (value: number): number => Math.round(value * 1000) / 1000;
const hashText = (text: string): string => createHash("sha256").update(text).digest("hex");

export function summarizeTimings(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number): number => round(sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0);
  return { count: values.length, totalMs: round(values.reduce((a, b) => a + b, 0)), p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99), maxMs: round(sorted.at(-1) ?? 0) };
}

async function timed<T>(timings: Timing, name: string, fn: () => Promise<T> | T): Promise<T> {
  const start = performance.now();
  try { return await fn(); }
  finally { timings[name] = performance.now() - start; }
}

function timedSync<T>(timings: Timing, name: string, fn: () => T): T {
  const start = performance.now();
  try { return fn(); }
  finally { timings[name] = performance.now() - start; }
}

function integerOption(value: number | undefined, fallback: number, min: number, max: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error(`Invalid ${name}; expected an integer in ${min}..${max}.`);
  return result;
}

function normalizeOptions(options: ResumeBenchmarkOptions) {
  if (options.taskIds?.some(id => !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu.test(id))) throw new Error("Invalid task UUID.");
  return {
    taskIds: options.taskIds ?? [],
    limit: integerOption(options.limit, 100, 1, 10_000, "limit"),
    concurrency: integerOption(options.concurrency, 4, 1, 32, "concurrency"),
    repetitions: integerOption(options.repetitions, 2, 1, 10, "repetitions"),
    syntheticOcrMs: options.syntheticOcrMs === undefined ? null : integerOption(options.syntheticOcrMs, 0, 0, 5_000, "synthetic-ocr-ms"),
    syntheticLimit: integerOption(options.syntheticLimit, 20, 1, 100, "synthetic-limit"),
    ocrConcurrency: integerOption(options.ocrConcurrency, 4, 1, 8, "ocr-concurrency")
  };
}

function candidateFor(row: SavedResumeBenchmarkRow): ParsedCandidate {
  return {
    index: Number(row.source_reference.match(/^[^:]+:(\d+):/u)?.[1] ?? 1),
    name: row.display_name, source: row.source,
    ...(row.source_locator ? { sourceLocator: row.source_locator } : {}),
    fields: row.raw_fields, evidence: row.source_evidence, raw: row.raw_text
  };
}

async function replay(row: SavedResumeBenchmarkRow, partConcurrency: number): Promise<ReplayResult> {
  const start = performance.now();
  const result: ReplayResult = { timings: {}, parts: 0, bytes: 0, source: "missing", decision: null, parity: "no_saved_ocr", gaps: [], semanticCount: 0, artifactComplete: false };
  let text: string | null = null;
  try {
    if (row.screenshot_path) {
      try {
        const artifact = await timed(result.timings, "artifact_manifest_ms", () => readResumeArtifact(row.screenshot_path!));
        const parts = await timed(result.timings, "artifact_parts_ms", () => mapWithConcurrency(artifact.parts, partConcurrency, async (_, i) => {
          const bytes = await readResumePart(row.screenshot_path!, artifact, i);
          result.parts++;
          result.bytes += bytes.length;
          return bytes;
        }));
        result.artifactComplete = artifact.complete;
        text = await timed(result.timings, "ocr_cache_read_verify_ms", async () => {
          let cache: { version?: number; captureHash?: string; result?: { text?: unknown } };
          try { cache = JSON.parse(await readFile(`${row.screenshot_path}.ocr.json`, "utf8")); }
          catch { result.gaps.push("ocr_cache_missing_or_invalid"); return null; }
          let manifest: Buffer;
          try { manifest = await readFile(`${row.screenshot_path}.manifest.json`); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            manifest = Buffer.from("boss-forge-legacy-capture-v1\n");
          }
          const hash = createHash("sha256").update(manifest);
          for (const part of parts) hash.update(part);
          if (cache.version !== 1 || cache.captureHash !== hash.digest("hex") || typeof cache.result?.text !== "string" || !cache.result.text.trim()) {
            result.gaps.push("ocr_cache_invalid_or_stale"); return null;
          }
          return cache.result.text;
        });
        if (text !== null) result.source = "ocr_cache";
      } catch {
        result.gaps.push("artifact_unreadable");
        result.error = "artifact_read_failed";
      }
    } else result.gaps.push("artifact_missing");

    const candidate = candidateFor(row);
    // Assessments store fullRuleText, not OCR alone. Recover it only from the
    // exact original card prefix; card text itself is never used as OCR.
    if (text === null && row.assessment_text) {
      const prefix = `${candidateRuleText(candidate)}。完整简历：`;
      if (row.assessment_text.startsWith(prefix) && row.assessment_text.slice(prefix.length).trim()) {
        text = row.assessment_text.slice(prefix.length);
        result.source = "assessment_text";
      } else result.gaps.push("assessment_prefix_mismatch");
    }
    if (text === null) return result;
    const resumeText = text;
    const resumeHash = timedSync(result.timings, "resume_text_hash_ms", () => hashText(resumeText));
    const semanticRules = collectSemanticRules(row.config);
    const semantics = row.semantic_evaluations;
    const semanticGap = semanticRules.some(rule => !semantics.some(value => value.criterionId === rule.criterionId));
    result.semanticCount = semantics.length;
    if (semanticGap) result.gaps.push("saved_semantic_evaluation_missing");
    const record = timedSync(result.timings, "rule_evaluation_ms", () => evaluateCandidate(candidate, row.config, resumeText, semantics, row.source_boss_filters));
    result.decision = record.decision;
    result.parity = resumeHash !== row.resume_text_hash ? "text_hash_unverified"
      : semanticGap ? "semantic_gap"
      : record.decision === row.stored_decision ? "matched" : "mismatched";
    return result;
  } catch {
    result.error = "replay_failed";
    result.parity = "error";
    return result;
  } finally { result.timings.total_candidate_ms = performance.now() - start; }
}

function counts(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((all, value) => { all[value] = (all[value] ?? 0) + 1; return all; }, {});
}

async function measured<T>(fn: () => Promise<T>) {
  const started = performance.now();
  const cpu = process.cpuUsage();
  const rssStart = process.memoryUsage().rss;
  let rssPeak = rssStart;
  const timer = setInterval(() => { rssPeak = Math.max(rssPeak, process.memoryUsage().rss); }, 10);
  try {
    const value = await fn();
    const rssEnd = process.memoryUsage().rss;
    const usage = process.cpuUsage(cpu);
    return { value, wallMs: round(performance.now() - started), cpuUserMs: round(usage.user / 1000), cpuSystemMs: round(usage.system / 1000), rssStartBytes: rssStart, rssEndBytes: rssEnd, rssSampledPeakBytes: Math.max(rssPeak, rssEnd) };
  } finally { clearInterval(timer); }
}

async function replayRun(rows: SavedResumeBenchmarkRow[], concurrency: number, repetition: number, mode: "sequential" | "bounded_parallel") {
  const { value: results, ...resources } = await measured(() => mapWithConcurrency(rows, concurrency, row => replay(row, concurrency)));
  const stages = [...new Set(results.flatMap(result => Object.keys(result.timings)))];
  return {
    mode, repetition, concurrency, ...resources,
    selected: rows.length, evaluated: results.filter(result => result.decision !== null).length,
    evaluatedPerSecond: resources.wallMs > 0 ? round(results.filter(result => result.decision !== null).length * 1000 / resources.wallMs) : null,
    artifactPartsRead: results.reduce((sum, result) => sum + result.parts, 0),
    artifactBytesRead: results.reduce((sum, result) => sum + result.bytes, 0),
    completeArtifacts: results.filter(result => result.artifactComplete).length,
    savedSemanticEvaluationsReused: results.reduce((sum, result) => sum + result.semanticCount, 0),
    decisions: counts(results.flatMap(result => result.decision ? [result.decision] : [])),
    parity: counts(results.map(result => result.parity)), textSources: counts(results.map(result => result.source)),
    gaps: counts(results.flatMap(result => result.gaps)), errors: counts(results.flatMap(result => result.error ? [result.error] : [])),
    stages: Object.fromEntries(stages.map(stage => [stage, summarizeTimings(results.flatMap(result => result.timings[stage] === undefined ? [] : [result.timings[stage]!]))])),
    signatures: results.map(result => JSON.stringify([result.decision, result.parity, result.source, result.gaps]))
  };
}

async function syntheticOcrBenchmark(rows: SavedResumeBenchmarkRow[], options: ReturnType<typeof normalizeOptions>) {
  const selected = rows.filter(row => row.screenshot_path).slice(0, options.syntheticLimit);
  const cacheDirectory = await mkdtemp(join(tmpdir(), "boss-forge-synthetic-ocr-"));
  try {
    const runs = [];
    let expected: Array<string | null> | null = null;
    for (const mode of ["sequential", "bounded_parallel", "cache_cold", "cache_warm"] as const) {
      let calls = 0, active = 0, peakActive = 0, cacheHits = 0;
      const concurrency = mode === "sequential" ? 1 : options.concurrency;
      const partConcurrency = mode === "sequential" ? 1 : options.ocrConcurrency;
      const { value: results, ...resources } = await measured(() => mapWithConcurrency(selected, concurrency, async (row, index) => {
        let itemCalls = 0;
        const client: TencentOcrClient = {
          async GeneralBasicOCR(input) {
            calls++; itemCalls++; active++; peakActive = Math.max(peakActive, active);
            try {
              await delay(options.syntheticOcrMs!);
              return { TextDetections: [{ DetectedText: `synthetic OCR ${hashText(input.ImageBase64)}`, Confidence: 100 }] };
            } finally { active--; }
          }
        };
        try {
          const result = await recognizeResumeWithTencentOcr(row.screenshot_path!, {
            client, concurrency: partConcurrency,
            cache: mode === "cache_cold" || mode === "cache_warm",
            cachePath: join(cacheDirectory, `${index}.json`)
          });
          if (!itemCalls) cacheHits++;
          return { signature: hashText(result.text), error: false };
        } catch { return { signature: null, error: true }; }
      }));
      const signatures = results.map(result => result.signature);
      const mismatches = expected ? signatures.filter((value, index) => value !== expected![index]).length : 0;
      expected ??= signatures;
      runs.push({ mode, ...resources, selected: selected.length, concurrency, partConcurrency, requestsToSyntheticClient: calls, peakConcurrentSyntheticRequests: peakActive, cacheHits, errors: results.filter(result => result.error).length, outputMismatchesAgainstSequential: mismatches });
    }
    return { kind: "synthetic_latency_and_text", perPartDelayMs: options.syntheticOcrMs, externalOcrRequests: 0, note: "Deterministic image-hash text and artificial delay through the production OCR adapter; these numbers are not provider latency or OCR accuracy. Cache files are isolated temporary files.", runs };
  } finally { await rm(cacheDirectory, { recursive: true, force: true }); }
}

/** Uses immutable rows loaded from the database. Reports contain no names,
 * identifiers, paths, text, credentials, or raw exception messages. */
export async function benchmarkResumeRows(rows: SavedResumeBenchmarkRow[], input: ResumeBenchmarkOptions = {}) {
  const options = normalizeOptions(input);
  const started = performance.now();
  const runs = [];
  let expected: string[] | null = null;
  for (let repetition = 1; repetition <= options.repetitions; repetition++) {
    const modes = repetition % 2 ? ["sequential", "bounded_parallel"] as const : ["bounded_parallel", "sequential"] as const;
    for (const mode of modes) {
      const { signatures, ...run } = await replayRun(rows, mode === "sequential" ? 1 : options.concurrency, repetition, mode);
      const mismatches = expected ? signatures.filter((value, index) => value !== expected![index]).length : 0;
      expected ??= signatures;
      runs.push({ ...run, resultMismatchesAgainstFirstRun: mismatches });
    }
  }
  const syntheticOcr = options.syntheticOcrMs === null ? null : await syntheticOcrBenchmark(rows, options);
  const sequentialMean = runs.filter(run => run.mode === "sequential").reduce((sum, run) => sum + run.wallMs, 0) / options.repetitions;
  const parallelMean = runs.filter(run => run.mode === "bounded_parallel").reduce((sum, run) => sum + run.wallMs, 0) / options.repetitions;
  return {
    event: "resume_benchmark.completed", version: 2, selected: rows.length, totalWallMs: round(performance.now() - started),
    dataset: { uniqueStates: new Set(rows.map(row => row.state_id)).size, uniqueScreenshotPaths: new Set(rows.flatMap(row => row.screenshot_path ? [row.screenshot_path] : [])).size, uniqueStoredTextHashes: new Set(rows.flatMap(row => row.resume_text_hash ? [row.resume_text_hash] : [])).size, storedDecisions: counts(rows.map(row => row.stored_decision)) },
    externalOcrRequests: 0, semanticProviderRequests: 0, businessDatabaseWrites: 0,
    measurementNotes: ["Sequential/parallel order alternates across repetitions; filesystem/OS caches are not flushed.", "CPU is process-wide; RSS peak is sampled every 10 ms and at run boundaries.", "Rules use the original card plus verified saved OCR. Stored semantic evaluations are replayed; model execution, browser time, DB writes, and policy waits are not measured.", "Parity checks stored decisions only. Missing OCR, unverified text hashes, or missing semantic evaluations are excluded from comparable parity."],
    comparison: { sequentialMeanWallMs: round(sequentialMean), parallelMeanWallMs: round(parallelMean), parallelSpeedup: parallelMean > 0 ? round(sequentialMean / parallelMean) : null },
    runs, syntheticOcr
  };
}

/** Snapshot-only SQL and local files. No browser, network OCR, model call, or
 * business-data write is available from this command. */
export async function benchmarkSavedResumes(input: ResumeBenchmarkOptions = {}) {
  const options = normalizeOptions(input);
  const started = performance.now();
  const sql = createDatabase();
  try {
    const queryStarted = performance.now();
    const rows = await sql<SavedResumeBenchmarkRow[]>`
      SELECT count(*) OVER()::integer AS eligible_count,
        cps.id AS state_id, cps.resume_screenshot_path AS screenshot_path, cps.resume_text_hash,
        cps.rule_decision AS stored_decision, ra.resume_text AS assessment_text,
        cs.raw_text, cs.source_reference, cs.source_locator, cs.raw_fields, cs.source_evidence,
        cs.source, c.display_name, rv.config, t.source_boss_filters,
        COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'criterionId', se.criterion_id, 'factType', se.fact_type, 'executionMode', se.execution_mode,
          'result', se.result, 'normalizedValue', se.normalized_value, 'qualifier', se.qualifier,
          'evidence', se.evidence, 'confidence', se.confidence, 'extractor', se.extractor,
          'modelVersion', se.model_version, 'promptVersion', se.prompt_version, 'catalogVersion', se.catalog_version,
          'rubricVersion', se.rubric_version, 'runtimeMode', se.runtime_mode, 'reasonCodes', se.reason_codes
        ) ORDER BY se.criterion_id) FROM semantic_evaluations se
          WHERE se.candidate_position_state_id = cps.id AND se.source_snapshot_id = cps.latest_snapshot_id
            AND se.rule_version_id = cps.rule_version_id), '[]'::jsonb) AS semantic_evaluations
      FROM candidate_position_states cps
      JOIN candidates c ON c.id = cps.candidate_id
      JOIN candidate_snapshots cs ON cs.id = cps.latest_snapshot_id
      JOIN rule_versions rv ON rv.id = cps.rule_version_id
      JOIN tasks t ON t.id = cps.latest_task_id
      LEFT JOIN recruitment_assessments ra ON ra.candidate_position_state_id = cps.id
        AND ra.task_id = cps.latest_task_id AND ra.rule_version_id = cps.rule_version_id
      WHERE cps.resume_screening_status = 'screened'
        AND (${options.taskIds.length === 0} OR cps.latest_task_id = ANY(${options.taskIds}::uuid[]))
      ORDER BY cps.updated_at DESC, cps.id
      LIMIT ${options.limit}`;
    const databaseReadMs = round(performance.now() - queryStarted);
    const report = { ...await benchmarkResumeRows(rows, input), eligibleRows: rows[0]?.eligible_count ?? 0, databaseReadMs, commandWallMs: round(performance.now() - started) };
    console.log(JSON.stringify(report));
    return report;
  } finally { await sql.end(); }
}

export function parseBenchmarkArguments(args: string[]): ResumeBenchmarkOptions {
  const options: ResumeBenchmarkOptions = { taskIds: [] };
  const names = { limit: "limit", concurrency: "concurrency", repetitions: "repetitions", "synthetic-ocr-ms": "syntheticOcrMs", "synthetic-limit": "syntheticLimit", "ocr-concurrency": "ocrConcurrency" } as const;
  for (const arg of args) {
    if (!arg.startsWith("--")) { options.taskIds!.push(arg); continue; }
    const match = /^--([^=]+)=(\d+)$/u.exec(arg);
    if (!match || !Object.hasOwn(names, match[1]!)) throw new Error("Unknown or invalid benchmark option; use --name=integer.");
    options[names[match[1] as keyof typeof names]] = Number(match[2]);
  }
  normalizeOptions(options);
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  Promise.resolve().then(() => benchmarkSavedResumes(parseBenchmarkArguments(process.argv.slice(2))))
    .catch(() => { console.error(JSON.stringify({ event: "resume_benchmark.failed", error: "invalid_arguments_or_benchmark_failed" })); process.exitCode = 1; });
}
