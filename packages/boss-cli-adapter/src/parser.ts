import type {
  ParsedBossResult,
  ParsedCandidate,
  ParsedPosition,
  ParsedResume
} from "@boss-forge/contracts";
import type { BossCommand } from "./command.js";

export const SUPPORTED_BOSS_CLI_VERSIONS = ["0.6.6"] as const;

function assertSupportedVersion(version: string): void {
  if (!(SUPPORTED_BOSS_CLI_VERSIONS as readonly string[]).includes(version)) {
    throw new Error(
      `Unsupported boss-cli version ${version}. Supported versions: ${SUPPORTED_BOSS_CLI_VERSIONS.join(", ")}.`
    );
  }
}

function parseFields(raw: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const segment of raw.split("｜")) {
    const separator = segment.indexOf(":");
    if (separator === -1) continue;
    const key = segment.slice(0, separator).trim();
    const value = segment.slice(separator + 1).trim();
    if (key && value) fields[key] = value;
  }
  return fields;
}

const BOSS_PLATFORM_TAG_FIELD_KEYS = new Set([
  "标签",
  "boss标签",
  "平台标签",
  "院校标签",
  "学校标签",
  "boss平台标签"
]);

function normalizePlatformTagFieldKey(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[\s:_：-]/gu, "");
}

function canonicalAcademicPlatformTag(value: string): string | null {
  const normalized = value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .replace(/\s+/gu, "")
    .replace(/(?:院校|高校|大学)$/u, "");
  if (normalized === "985") return "985";
  if (normalized === "211") return "211";
  if (normalized === "双一流") return "双一流";
  return null;
}

/**
 * Promote only explicit BOSS card labels to a canonical field. Resume prose and
 * summaries are deliberately excluded: platform tags must come from BOSS, not
 * from our own school-name inference.
 */
function withBossPlatformTags(fields: Record<string, string>): Record<string, string> {
  const tags = Object.entries(fields)
    .filter(([key]) => BOSS_PLATFORM_TAG_FIELD_KEYS.has(normalizePlatformTagFieldKey(key)))
    .flatMap(([, value]) => value.split(/[,，;；/|、]/u))
    .map((value) => canonicalAcademicPlatformTag(value.trim()))
    .filter((value): value is string => value !== null);
  const uniqueTags = [...new Set(tags)];
  return uniqueTags.length > 0
    ? { ...fields, BOSS平台标签: uniqueTags.join("/") }
    : fields;
}

function deduplicateCandidates(candidates: ParsedCandidate[]): ParsedCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const fingerprint = JSON.stringify([
      candidate.source,
      candidate.name,
      Object.entries(candidate.fields).sort(([left], [right]) => left.localeCompare(right)),
      candidate.evidence
    ]);
    if (seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  });
}

function parsePositions(raw: string): ParsedPosition[] {
  const positions: ParsedPosition[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\.\s*(.+?)｜状态:([^｜]+)(?:｜|$)/);
    if (!match) continue;
    positions.push({
      index: Number(match[1]),
      name: match[2]!.trim(),
      status: match[3]!.trim(),
      raw: line.trim()
    });
  }
  return positions;
}

function parseRecommend(raw: string): ParsedCandidate[] {
  const candidates: ParsedCandidate[] = [];
  let current: ParsedCandidate | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*-\s*(\d+)\.\s*(.+?)｜(.+)$/);
    if (match) {
      const name = match[2]!.replace(/\s*\|\s*看过$/, "").trim();
      current = {
        index: Number(match[1]),
        name,
        source: "recommend",
        fields: withBossPlatformTags(parseFields(match[3]!)),
        evidence: [],
        raw: line.trim()
      };
      candidates.push(current);
      continue;
    }
    const advantage = line.match(/^\s+优势:\s*(.+)$/);
    if (advantage && current) {
      current.evidence.push(advantage[1]!.trim());
    }
  }
  return deduplicateCandidates(candidates);
}

function parseSearch(raw: string): ParsedCandidate[] {
  const candidates: ParsedCandidate[] = [];
  let current: ParsedCandidate | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^(\d+)\.\s*([^｜]+)(.*)$/);
    if (match) {
      current = {
        index: Number(match[1]),
        name: match[2]!.trim(),
        source: "search",
        fields: withBossPlatformTags(parseFields(match[3]!.replace(/^｜/, ""))),
        evidence: [],
        raw: line.trim()
      };
      candidates.push(current);
      continue;
    }
    const detail = line.match(/^\s{3,}(.+)$/);
    if (detail && current) current.evidence.push(detail[1]!.trim());
  }
  return deduplicateCandidates(candidates);
}

function parseDeepSearch(raw: string): ParsedCandidate[] {
  const candidates: ParsedCandidate[] = [];
  let current: ParsedCandidate | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^(\d+)\.\s*(.+)$/);
    if (match) {
      current = {
        index: Number(match[1]),
        name: match[2]!.trim(),
        source: "deep-search",
        fields: {},
        evidence: [],
        raw: line.trim()
      };
      candidates.push(current);
      continue;
    }
    const detail = line.match(/^\s+(概要|经历|教育|推荐)：\s*(.+)$/);
    if (detail && current) {
      current.fields[detail[1]!] = detail[2]!.trim();
      current.evidence.push(`${detail[1]}：${detail[2]!.trim()}`);
    }
  }
  return deduplicateCandidates(candidates);
}

function parseResume(raw: string): ParsedResume {
  const screenshot = raw.match(/(?:简历预览截图|截图文件)：([^\r\n]+)/);
  const ocrMarker = "在线简历 OCR 正文：";
  const ocrIndex = raw.indexOf(ocrMarker);
  const ocrText = ocrIndex === -1 ? null : raw.slice(ocrIndex + ocrMarker.length).trim() || null;
  return {
    screenshotPath: screenshot?.[1]?.trim() ?? null,
    ocrText,
    raw
  };
}

export function parseBossOutput(
  version: string,
  command: BossCommand,
  stdout: string
): ParsedBossResult {
  assertSupportedVersion(version);
  const raw = stdout.trim();
  if (!raw) throw new Error(`boss-cli ${command.type} returned empty stdout.`);

  switch (command.type) {
    case "positions":
      return { kind: "positions", positions: parsePositions(raw), raw };
    case "recommend":
      return { kind: "candidates", candidates: parseRecommend(raw), raw };
    case "search":
      return { kind: "candidates", candidates: parseSearch(raw), raw };
    case "deep-search":
      return command.match
        ? { kind: "candidates", candidates: parseDeepSearch(raw), raw }
        : { kind: "text", text: raw, raw };
    case "preview":
      return { kind: "resume", resume: parseResume(raw), raw };
    case "action":
      if (command.action === "resume") {
        return { kind: "resume", resume: parseResume(raw), raw };
      }
      return { kind: "action", succeeded: true, message: raw, raw };
    case "greet":
    case "send":
      return { kind: "action", succeeded: true, message: raw, raw };
    default:
      return { kind: "text", text: raw, raw };
  }
}
