import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  recognizeImageWithTencentOcr,
  type TencentOcrClient
} from "./tencent-ocr.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("Tencent Cloud GeneralBasicOCR adapter", () => {
  it("sends image Base64 and returns only recognized non-empty lines", async () => {
    const directory = await mkdtemp(join(tmpdir(), "boss-forge-tencent-ocr-"));
    directories.push(directory);
    const imagePath = join(directory, "resume.png");
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const inputs: Array<{ ImageBase64: string; LanguageType: string }> = [];
    const client: TencentOcrClient = {
      async GeneralBasicOCR(value) {
        inputs.push(value);
        return {
          TextDetections: [
            { DetectedText: "英语专业四级", Confidence: 98 },
            { DetectedText: "  ", Confidence: 20 },
            { DetectedText: "CET-6 560分", Confidence: 96 }
          ],
          RequestId: "request-test-1"
        };
      }
    };

    const result = await recognizeImageWithTencentOcr(imagePath, { client });

    expect(inputs[0]?.LanguageType).toBe("zh");
    expect(inputs[0]?.ImageBase64).toBe("iVBORw==");
    expect(result).toEqual({
      text: "英语专业四级\nCET-6 560分",
      lineCount: 2,
      averageConfidence: 97,
      requestId: "request-test-1"
    });
  });

  it("fails without reading any remote service when the screenshot is missing", async () => {
    await expect(
      recognizeImageWithTencentOcr("/path/that/does/not/exist.png", {
        client: { async GeneralBasicOCR() { return {}; } }
      })
    ).rejects.toThrow();
  });
});
