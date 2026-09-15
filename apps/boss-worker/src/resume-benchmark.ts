import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { readResumeArtifact, readResumePart } from "@boss-forge/boss-cli-adapter";
import { createDatabase, type RuleConfig } from "@boss-forge/data";
import type { ParsedCandidate } from "@boss-forge/contracts";
import { evaluateCandidate } from "@boss-forge/m1-core";

type SampleRow = {
  state_id: string;
  screenshot_path: string | null;
  raw_text: string | null;
  source: "recommend" | "search";
  display_name: string;
  source_locator: ParsedCandidate["sourceLocator"] | null;
  raw_fields: Record<string, string>;
  source_evidence: string[];
  source_reference: string;
  config: RuleConfig;
  source_boss_filters: unknown;
};

type Timing = Record<string, number>;

const n = (value: number): number => Math.round(value * 100) / 100;
const percentile = (values: number[], p: number): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]!;
};

async function timed<T>(timings: Timing, name: string, fn: () => Promise<T> | T): Promise<T> {
  const start = performance.now();
  try { return await fn(); }
  finally { timings[name] = n(performance.now() - start); }
}

async function processRow(row: SampleRow): Promise<{ timings: Timing; decision: string | null; error?: string }> {
  const timings: Timing = {};
  try {
    let text = row.raw_text ?? "";
    if (row.screenshot_path) {
      await timed(timings, "artifact_read_ms", async () => {
        const artifact = await readResumeArtifact(row.screenshot_path!);
        // Reading all parts mirrors the preview/communication workload. Parts
        // are independent and intentionally read in parallel.
        await Promise.all(artifact.parts.map((_, index) => readResumePart(row.screenshot_path!, artifact, index)));
      });
    }
    await timed(timings, "text_hash_ms", () => createHash("sha256").update(text).digest("hex"));
    const candidate: ParsedCandidate = {
      index: Number(String(row.source_reference).match(/^[^:]+:(\d+):/u)?.[1] ?? 1),
      name: row.display_name,
      source: row.source,
      ...(row.source_locator ? { sourceLocator: row.source_locator } : {}),
      fields: row.raw_fields ?? {}, evidence: row.source_evidence ?? [], raw: row.raw_text ?? ""
    };
    const record = await timed(timings, "rule_evaluation_ms", () =>
      evaluateCandidate(candidate, row.config, text, [], row.source_boss_filters as never));
    return { timings, decision: record.decision };
  } catch (error) {
    return { timings, decision: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Offline benchmark for saved resume evidence. It never opens a browser,
 * calls BOSS, sends contact messages, or mutates the database. */
export async function benchmarkSavedResumes(options: { taskIds?: string[]; limit?: number; concurrency?: number } = {}) {
  const sql = createDatabase();
  try {
    const limit = Math.max(1, Math.min(10_000, options.limit ?? 100));
    const taskIds = options.taskIds?.filter(id => /^[\da-f-]{36}$/iu.test(id)) ?? [];
    const rows = await sql<SampleRow[]>`
      SELECT cps.id AS state_id, cps.resume_screenshot_path AS screenshot_path,
        cs.raw_text, cs.source_reference, cs.source_locator, cs.raw_fields, cs.source_evidence,
        cs.source, c.display_name, rv.config, t.source_boss_filters
      FROM candidate_position_states cps
      JOIN candidates c ON c.id = cps.candidate_id
      JOIN candidate_snapshots cs ON cs.id = cps.latest_snapshot_id
      JOIN rule_versions rv ON rv.id = cps.rule_version_id
      JOIN tasks t ON t.id = cps.latest_task_id
      WHERE cps.resume_screening_status = 'screened'
        AND (${taskIds.length === 0} OR cps.latest_task_id = ANY(${taskIds}::uuid[]))
      ORDER BY cps.updated_at DESC
      LIMIT ${limit}`;
    const concurrency = Math.max(1, Math.min(32, options.concurrency ?? 4));
    const results: Array<{ timings: Timing; decision: string | null; error?: string }> = [];
    let cursor = 0;
    const worker = async () => { while (true) { const index = cursor++; if (index >= rows.length) return; results[index] = await processRow(rows[index]!); } };
    await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
    const stageNames = [...new Set(results.flatMap(result => Object.keys(result.timings)))];
    const stages = Object.fromEntries(stageNames.map(stage => {
      const values = results.map(result => result.timings[stage]).filter((value): value is number => value !== undefined);
      return [stage, { count: values.length, totalMs: n(values.reduce((a, b) => a + b, 0)), p50Ms: n(percentile(values, .5)), p95Ms: n(percentile(values, .95)), maxMs: n(Math.max(0, ...values)) }];
    }));
    const summary = { event: "resume_benchmark.completed", selected: rows.length, concurrency, errors: results.filter(result => result.error).length, decisions: results.reduce<Record<string, number>>((all, result) => { if (result.decision) all[result.decision] = (all[result.decision] ?? 0) + 1; return all; }, {}), stages };
    console.log(JSON.stringify(summary));
    return summary;
  } finally { await sql.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const limitArg = args.find(arg => arg.startsWith("--limit="));
  const concurrencyArg = args.find(arg => arg.startsWith("--concurrency="));
  const taskIds = args.filter(arg => /^[\da-f-]{36}$/iu.test(arg));
  benchmarkSavedResumes({ ...(taskIds.length ? { taskIds } : {}), ...(limitArg ? { limit: Number(limitArg.slice(8)) } : {}), ...(concurrencyArg ? { concurrency: Number(concurrencyArg.slice(14)) } : {}) })
    .catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
