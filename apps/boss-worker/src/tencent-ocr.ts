import { readFile } from "node:fs/promises";
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

export async function recognizeImageWithTencentOcr(
  imagePath: string,
  options: TencentOcrOptions = {}
): Promise<TencentOcrResult> {
  const image = await readFile(imagePath);
  const imageBase64 = image.toString("base64");
  if (Buffer.byteLength(imageBase64, "utf8") > MAX_IMAGE_BASE64_BYTES) {
    throw new Error("Resume screenshot exceeds Tencent Cloud OCR's 10 MiB Base64 limit.");
  }
  const response = await (options.client ?? createTencentOcrClient(options)).GeneralBasicOCR({
    ImageBase64: imageBase64,
    LanguageType: "zh"
  });
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
