import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readResumeArtifact, readResumePart } from "@boss-forge/boss-cli-adapter";
import { ocr } from "tencentcloud-sdk-nodejs-ocr";

const MAX_IMAGE_BASE64_BYTES = 10 * 1024 * 1024;
const DEFAULT_REGION = "ap-guangzhou";

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

type TencentOcrOptions = {
  client?: TencentOcrClient;
  secretId?: string;
  secretKey?: string;
  region?: string;
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

/** Every captured segment participates; a failed segment invalidates the OCR result. */
export async function recognizeResumeWithTencentOcr(
  imagePath: string, options: TencentOcrOptions = {}
): Promise<TencentOcrResult> {
  const artifact = await readResumeArtifact(imagePath);
  if (!options.client) {
    try {
      const cached = JSON.parse(await readFile(imagePath + '.ocr.json', 'utf8')) as { version: number; captureHash: string; result: TencentOcrResult };
      const hash = createHash('sha256').update(await readFile(imagePath + '.manifest.json'));
      for (let index = 0; index < artifact.parts.length; index++) hash.update(await readResumePart(imagePath, artifact, index));
      if (cached.version === 1 && cached.captureHash === hash.digest('hex') && typeof cached.result?.text === 'string' && Number.isInteger(cached.result.lineCount)) return cached.result;
    } catch { /* Older captures have no cached OCR. Read them normally. */ }
  }
  const results: TencentOcrResult[] = [];
  const client = options.client ?? createTencentOcrClient(options);
  for (let index = 0; index < artifact.parts.length; index++) {
    results.push(await recognizeBufferWithTencentOcr(await readResumePart(imagePath, artifact, index), { ...options, client }));
  }
  // Keep boundary text rather than guessing whether repeated lines are duplicate facts.
  const lineCount = results.reduce((sum, result) => sum + result.lineCount, 0);
  const confident = results.filter(result => result.averageConfidence !== null && result.lineCount > 0);
  const confidenceLines = confident.reduce((sum, result) => sum + result.lineCount, 0);
  return {
    text: results.map(result => result.text).filter(Boolean).join('\n'),
    lineCount,
    averageConfidence: confidenceLines ? confident.reduce((sum, result) => sum + result.averageConfidence! * result.lineCount, 0) / confidenceLines : null,
    requestId: results.map(result => result.requestId).filter(Boolean).join(',') || null
  };
}
