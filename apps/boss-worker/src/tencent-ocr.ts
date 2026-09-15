import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { readResumeArtifact, readResumePart } from "@boss-forge/boss-cli-adapter";
import { ocr } from "tencentcloud-sdk-nodejs-ocr";

const MAX_IMAGE_BASE64_BYTES = 10 * 1024 * 1024;
const DEFAULT_REGION = "ap-guangzhou";
const DEFAULT_OCR_CONCURRENCY = 1;

function ocrConcurrency(): number {
  const value = Number.parseInt(process.env.BOSS_FORGE_OCR_CONCURRENCY ?? `${DEFAULT_OCR_CONCURRENCY}`, 10);
  return Number.isFinite(value) ? Math.max(1, Math.min(8, value)) : DEFAULT_OCR_CONCURRENCY;
}

function boundedOcrConcurrency(value: number): number {
  return Number.isSafeInteger(value) ? Math.max(1, Math.min(8, value)) : DEFAULT_OCR_CONCURRENCY;
}

/**
 * Run work with a bounded number of workers while preserving input order. Once
 * one item fails, workers already in flight are allowed to finish, but no
 * worker claims another item. This prevents a failed OCR batch from silently
 * continuing to consume API quota.
 */
export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  let failure: unknown;
  async function worker(): Promise<void> {
    while (true) {
      if (failed) return;
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index]!, index);
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
        return;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  if (failed) throw failure;
  return results;
}

export type TencentOcrResult = {
  text: string;
  lineCount: number;
  averageConfidence: number | null;
  requestId: string | null;
};

export type TencentOcrClient = {
  GeneralBasicOCR(input: { ImageBase64: string; LanguageType: string }): Promise<{
    TextDetections?: Array<{ DetectedText?: string; Confidence?: number }>;
    RequestId?: string;
  }>;
};

const RESUME_CONTENT_MARKER =
  /教育经历|工作经历|项目经历|实习经历|求职期望|个人优势|专业技能|语言能力|资格证书|学历|专业|毕业|学校|大学|学院|本科|硕士|博士|职位|公司|工作|education|experience|university|college|skills?|employment|projects?|degree|profile/iu;

/** Reject a rendered login/skeleton/watermark image that OCR happens to read as text. */
export function resumeOcrLooksUsable(text: string): boolean {
  const normalized = text.normalize("NFKC").replace(/\s+/gu, " ").trim();
  return normalized.length >= 30 && RESUME_CONTENT_MARKER.test(normalized);
}

export type TencentOcrOptions = {
  client?: TencentOcrClient;
  secretId?: string;
  secretKey?: string;
  region?: string;
  /** Enable/disable the on-disk OCR cache. Defaults to enabled for SDK calls. */
  cache?: boolean;
  /** Override the cache file location (useful for tests and isolated workers). */
  cachePath?: string;
  /** Override concurrency; otherwise BOSS_FORGE_OCR_CONCURRENCY is used. */
  concurrency?: number;
  /** Receives duration only; no image path or candidate data is emitted. */
  onTiming?: (elapsedMs: number) => void;
};

function requiredSecret(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required for Tencent Cloud OCR.`);
  return normalized;
}

export function tencentOcrConfigured(): boolean {
  return Boolean(
    process.env.TENCENTCLOUD_SECRET_ID?.trim() &&
      process.env.TENCENTCLOUD_SECRET_KEY?.trim()
  );
}

function createTencentOcrClient(options: TencentOcrOptions): TencentOcrClient {
  const Client = ocr.v20181119.Client;
  return new Client({
    credential: {
      secretId: requiredSecret(
        options.secretId ?? process.env.TENCENTCLOUD_SECRET_ID,
        "TENCENTCLOUD_SECRET_ID"
      ),
      secretKey: requiredSecret(
        options.secretKey ?? process.env.TENCENTCLOUD_SECRET_KEY,
        "TENCENTCLOUD_SECRET_KEY"
      )
    },
    region: options.region ?? process.env.TENCENTCLOUD_OCR_REGION?.trim() ?? DEFAULT_REGION,
    profile: {
      httpProfile: {
        endpoint: "ocr.tencentcloudapi.com",
        reqTimeout: 60
      }
    }
  });
}

function tencentImageHasNoText(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as { code?: unknown; message?: unknown };
  const code = typeof value.code === "string" ? value.code : "";
  const message = typeof value.message === "string" ? value.message : "";
  return code === "FailedOperation.ImageNoText" || message.includes("照片中未检测到文本");
}

function emptyOcrResult(): TencentOcrResult {
  return {
    text: "",
    lineCount: 0,
    averageConfidence: null,
    requestId: null
  };
}

export async function recognizeImageWithTencentOcr(
  imagePath: string,
  options: TencentOcrOptions = {}
): Promise<TencentOcrResult> {
  return recognizeBufferWithTencentOcr(await readFile(imagePath), options);
}

async function recognizeBufferWithTencentOcr(image: Buffer, options: TencentOcrOptions): Promise<TencentOcrResult> {
  const imageBase64 = image.toString("base64");
  if (Buffer.byteLength(imageBase64, "utf8") > MAX_IMAGE_BASE64_BYTES) {
    throw new Error("Resume screenshot exceeds Tencent Cloud OCR's 10 MiB Base64 limit.");
  }
  let response: Awaited<ReturnType<TencentOcrClient["GeneralBasicOCR"]>>;
  try {
    response = await (options.client ?? createTencentOcrClient(options)).GeneralBasicOCR({
      ImageBase64: imageBase64,
      LanguageType: "zh"
    });
  } catch (error) {
    // Tencent reports a valid image with no detectable text as an API error. It is
    // a normal OCR outcome, so let the worker record `no_text` instead of `failed`.
    if (tencentImageHasNoText(error)) return emptyOcrResult();
    // Keep the persisted/UI classification stable even when the SDK only exposes
    // opaque codes such as `AuthFailure.SecretIdNotFound`. The original error is
    // retained as a cause for local diagnostics but is not persisted verbatim.
    throw new Error("TencentCloud OCR request failed.", { cause: error });
  }
  const detections = (response.TextDetections ?? []).filter((item) =>
    Boolean(item.DetectedText?.trim())
  );
  const confidences = detections
    .map((item) => item.Confidence)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return {
    text: detections.map((item) => item.DetectedText!.trim()).join("\n"),
    lineCount: detections.length,
    averageConfidence:
      confidences.length > 0
        ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
        : null,
    requestId: response.RequestId?.trim() || null
  };
}

function validCachedResult(value: unknown): value is TencentOcrResult {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Partial<TencentOcrResult>;
  const lineCount = result.lineCount;
  return typeof result.text === "string" && typeof lineCount === "number" && Number.isInteger(lineCount) && lineCount >= 0 &&
    (result.averageConfidence === null || (typeof result.averageConfidence === "number" && Number.isFinite(result.averageConfidence))) &&
    (result.requestId === null || typeof result.requestId === "string");
}

function captureHash(manifest: Buffer | null, parts: readonly Buffer[]): string {
  const hash = createHash("sha256");
  // Preserve the established manifest key format for compatibility with
  // existing caches. The marker keeps legacy captures in a separate key space.
  hash.update(manifest ?? Buffer.from("boss-forge-legacy-capture-v1\n"));
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
}

/** Every captured segment participates; a failed segment invalidates the OCR result. */
export async function recognizeResumeWithTencentOcr(
  imagePath: string, options: TencentOcrOptions = {}
): Promise<TencentOcrResult> {
  const artifact = await readResumeArtifact(imagePath);
  const cacheEnabled = options.cache ?? !options.client;
  const cachePath = options.cachePath ?? `${imagePath}.ocr.json`;
  let manifest: Buffer | null = null;
  try { manifest = await readFile(`${imagePath}.manifest.json`); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const partBuffers = await Promise.all(
    artifact.parts.map((_, index) => readResumePart(imagePath, artifact, index))
  );
  const hash = captureHash(manifest, partBuffers);
  if (cacheEnabled) {
    try {
      const cached = JSON.parse(await readFile(cachePath, "utf8")) as { version?: number; captureHash?: string; result?: unknown };
      if (cached.version === 1 && cached.captureHash === hash && validCachedResult(cached.result)) return cached.result;
    } catch { /* Older captures have no cached OCR. Read them normally. */ }
  }
  const results: TencentOcrResult[] = [];
  const client = options.client ?? createTencentOcrClient(options);
  const startedAt = Date.now();
  const limit = options.concurrency === undefined ? ocrConcurrency() : boundedOcrConcurrency(options.concurrency);
  const partResults = await mapWithConcurrency(partBuffers, limit, async (part) =>
    recognizeBufferWithTencentOcr(part, { ...options, client })
  );
  results.push(...partResults);
  // Keep boundary text rather than guessing whether repeated lines are duplicate facts.
  const lineCount = results.reduce((sum, result) => sum + result.lineCount, 0);
  const confident = results.filter(result => result.averageConfidence !== null && result.lineCount > 0);
  const confidenceLines = confident.reduce((sum, result) => sum + result.lineCount, 0);
  const result = {
    text: results.map(result => result.text).filter(Boolean).join('\n'),
    lineCount,
    averageConfidence: confidenceLines ? confident.reduce((sum, result) => sum + result.averageConfidence! * result.lineCount, 0) / confidenceLines : null,
    requestId: results.map(result => result.requestId).filter(Boolean).join(',') || null
  };
  const elapsedMs = Date.now() - startedAt;
  options.onTiming?.(elapsedMs);
  if (cacheEnabled) {
    const temporaryPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, JSON.stringify({ version: 1, captureHash: hash, result, elapsedMs }) + "\n", { mode: 0o600 });
      await rename(temporaryPath, cachePath);
    } catch {
      // Cache is an optimization. A read-only directory or concurrent writer
      // must never turn an otherwise successful OCR request into a failure.
      try { await unlink(temporaryPath); } catch { /* ignore cleanup failure */ }
    }
  }
  return result;
}
