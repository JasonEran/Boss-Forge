import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  recognizeResumeWithTencentOcr,
  recognizeImageWithTencentOcr,
  resumeOcrLooksUsable,
  type TencentOcrClient
} from "./tencent-ocr.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("Tencent Cloud GeneralBasicOCR adapter", () => {
  it("distinguishes resume content from a rendered placeholder or login watermark", () => {
    expect(
      resumeOcrLooksUsable(
        "教育经历：珠海大学 国际贸易专业 本科；工作经历：跨境电商运营两年，负责海外市场"
      )
    ).toBe(true);
    expect(resumeOcrLooksUsable("BOSS直聘 安全验证 请稍后重试")).toBe(false);
    expect(resumeOcrLooksUsable("正在加载中 请稍候 正在加载中 请稍候")).toBe(false);
  });

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

  it("treats Tencent's ImageNoText response as a normal empty OCR result", async () => {
    const directory = await mkdtemp(join(tmpdir(), "boss-forge-tencent-ocr-"));
    directories.push(directory);
    const imagePath = join(directory, "resume.png");
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const client: TencentOcrClient = {
      async GeneralBasicOCR() {
        throw Object.assign(new Error("照片中未检测到文本"), {
          code: "FailedOperation.ImageNoText"
        });
      }
    };

    await expect(recognizeImageWithTencentOcr(imagePath, { client })).resolves.toEqual({
      text: "",
      lineCount: 0,
      averageConfidence: null,
      requestId: null
    });
  });

  it("wraps opaque SDK failures in a stable OCR error without persisting their details", async () => {
    const directory = await mkdtemp(join(tmpdir(), "boss-forge-tencent-ocr-"));
    directories.push(directory);
    const imagePath = join(directory, "resume.png");
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const client: TencentOcrClient = {
      async GeneralBasicOCR() {
        throw Object.assign(new Error("credential detail that must stay internal"), {
          code: "AuthFailure.SecretIdNotFound"
        });
      }
    };

    await expect(recognizeImageWithTencentOcr(imagePath, { client })).rejects.toThrow(
      "TencentCloud OCR request failed."
    );
  });
});


describe("full résumé OCR", () => {
  it("reads the bottom segment and rejects a failed middle segment", async () => {
    const directory = await mkdtemp(join(tmpdir(), "boss-full-ocr-test-")); directories.push(directory);
    const path = join(directory, "resume.png");
    const png = Buffer.alloc(32); Buffer.from([137,80,78,71,13,10,26,10]).copy(png); png.writeUInt32BE(900,16); png.writeUInt32BE(1600,20);
    const parts = Array.from({ length: 3 }, (_, i) => ({ file: i ? `resume-part-${i + 1}.png` : 'resume.png', width: 900, height: 1600, offsetY: i * 1520, cssHeight: 1600, overlapTop: i ? 80 : 0 }));
    for (const part of parts) await writeFile(join(directory, part.file), png);
    await writeFile(path + '.manifest.json', JSON.stringify({ version: 1, complete: true, contentHeight: 4640, contentWidth: 900, parts }));
    let calls = 0;
    const client: TencentOcrClient = { async GeneralBasicOCR() { return { TextDetections: [{ DetectedText: ['教育经历', '海外运营项目经历', '末尾资格证书：英语专业八级'][calls++]!, Confidence: 98 }] }; } };
    const result = await recognizeResumeWithTencentOcr(path, { client });
    expect(calls).toBe(3); expect(result.text).toContain('末尾资格证书：英语专业八级'); expect(result.lineCount).toBe(3);
    calls = 0;
    await expect(recognizeResumeWithTencentOcr(path, { client: { async GeneralBasicOCR() { if (++calls === 2) throw new Error('service failed'); return { TextDetections: [{ DetectedText: '教育经历' }] }; } } })).rejects.toThrow('OCR request failed');
    expect(calls).toBe(2);
  });
});


it("reuses visually checked OCR only when every captured byte is unchanged", async () => {
  const directory = await mkdtemp(join(tmpdir(), "boss-ocr-cache-test-")); directories.push(directory);
  const path = join(directory, "resume.png");
  const png = Buffer.alloc(32); Buffer.from([137,80,78,71,13,10,26,10]).copy(png); png.writeUInt32BE(900,16); png.writeUInt32BE(1600,20);
  await writeFile(path,png);
  await writeFile(path+'.manifest.json',JSON.stringify({version:1,complete:true,contentHeight:1600,contentWidth:900,parts:[{file:'resume.png',width:900,height:1600,offsetY:0,cssHeight:1600,overlapTop:0}]}));
  const hash=createHash('sha256').update(await readFile(path+'.manifest.json')).update(png).digest('hex');
  const result={text:'Expanded resume final certificate',lineCount:1,averageConfidence:99,requestId:'cached-request'};
  await writeFile(path+'.ocr.json',JSON.stringify({version:1,captureHash:hash,result}));
  await expect(recognizeResumeWithTencentOcr(path,{secretId:'',secretKey:''})).resolves.toEqual(result);
  png[31]=1;await writeFile(path,png);
  await expect(recognizeResumeWithTencentOcr(path,{secretId:'',secretKey:''})).rejects.toThrow('TENCENTCLOUD_SECRET_ID');
});
