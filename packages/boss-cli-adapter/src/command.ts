import type { CandidateSourceLocator } from "@boss-forge/contracts";

export type BossAction =
  | "resume"
  | "not-fit"
  | "remark"
  | "agree-resume"
  | "request-attachment-resume"
  | "history"
  | "wechat";

export type BossCommand =
  | { type: "help" }
  | { type: "version" }
  | { type: "login" }
  | { type: "positions" }
  | { type: "jd"; positionName: string }
  | { type: "greeting-preview"; jobKeyword: string }
  | { type: "recommend"; jobKeyword?: string }
  | { type: "search"; keyword?: string }
  | {
      type: "deep-search";
      jobKeyword?: string;
      core: string[];
      bonus: string[];
      match: boolean;
    }
  | {
      type: "preview";
      candidateTarget: string;
      sourceLocator?: CandidateSourceLocator;
    }
  | {
      type: "greet";
      candidateTarget: string;
      sourceLocator?: CandidateSourceLocator;
      jobKeyword: string;
      expectedJobId: string;
      expectedGreetingId: string;
      expectedMessageSha256: string;
    }
  | { type: "list"; unreadOnly: boolean }
  | {
      type: "chat-by-name";
      candidateName: string;
      sourceLocator?: CandidateSourceLocator;
      strict: boolean;
    }
  | {
      type: "chat-by-index";
      index: number;
      unreadOnly: boolean;
      expectedName?: string;
      strict: boolean;
    }
  | {
      type: "send";
      text: string;
      candidateTarget: string;
      sourceLocator?: CandidateSourceLocator;
    }
  | { type: "action"; action: BossAction; remark?: string };

export type BossCommandRisk = "read" | "quota-consuming-read" | "external-write";

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} must not be empty.`);
  }
  return normalized;
}

function requireProviderIdentifier(value: string, field: string): string {
  const normalized = requireText(value, field);
  if (normalized.length > 256 || !/^[A-Za-z0-9_~=-]+$/u.test(normalized)) {
    throw new Error(`${field} is not a valid BOSS provider identifier.`);
  }
  return normalized;
}

function requireSha256(value: string, field: string): string {
  const normalized = requireText(value, field);
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw new Error(`${field} must be a lowercase SHA-256 hex digest.`);
  }
  return normalized;
}

export const BOSS_GEEK_ID_TARGET_PREFIX = "__boss_geek_id__:";

function exactCandidateTarget(
  fallback: string,
  sourceLocator?: CandidateSourceLocator
): string {
  if (sourceLocator?.kind === "boss_geek_id") {
    const value = requireText(sourceLocator.value, "sourceLocator.value");
    if (!/^[A-Za-z0-9_~-]{8,160}$/u.test(value)) {
      throw new Error("sourceLocator.value is not a valid BOSS candidate ID.");
    }
    return `${BOSS_GEEK_ID_TARGET_PREFIX}${encodeURIComponent(value)}`;
  }
  return requireText(fallback, "candidateTarget");
}
export function commandRisk(command: BossCommand): BossCommandRisk {
  switch (command.type) {
    case "preview":
      return "quota-consuming-read";
    case "greet":
    case "send":
      return "external-write";
    case "action":
      return command.action === "resume" || command.action === "history"
        ? "quota-consuming-read"
        : "external-write";
    case "deep-search":
      return command.match ? "quota-consuming-read" : "read";
    default:
      return "read";
  }
}

export function buildBossArgv(command: BossCommand): string[] {
  switch (command.type) {
    case "help":
      return ["help"];
    case "version":
      return ["version"];
    case "login":
      return ["login"];
    case "positions":
      return ["positions"];
    case "jd":
      return ["jd", requireText(command.positionName, "positionName")];
    case "greeting-preview":
      return [
        "greeting-preview",
        "--job",
        requireText(command.jobKeyword, "jobKeyword")
      ];
    case "recommend":
      return command.jobKeyword
        ? ["recommend", requireText(command.jobKeyword, "jobKeyword")]
        : ["recommend"];
    case "search":
      return command.keyword
        ? ["search", requireText(command.keyword, "keyword")]
        : ["search"];
    case "deep-search": {
      const argv = ["deep-search"];
      if (command.jobKeyword) {
        argv.push(requireText(command.jobKeyword, "jobKeyword"));
      }
      for (const requirement of command.core) {
        argv.push("--core", requireText(requirement, "core requirement"));
      }
      for (const requirement of command.bonus) {
        argv.push("--bonus", requireText(requirement, "bonus requirement"));
      }
      if (command.match) {
        argv.push("--match");
      }
      return argv;
    }
    case "preview":
      return [
        "preview",
        exactCandidateTarget(command.candidateTarget, command.sourceLocator)
      ];
    case "greet": {
      return [
        "greet",
        exactCandidateTarget(command.candidateTarget, command.sourceLocator),
        "--job",
        requireText(command.jobKeyword, "jobKeyword"),
        "--expected-job-id",
        requireProviderIdentifier(command.expectedJobId, "expectedJobId"),
        "--expected-greeting-id",
        requireProviderIdentifier(command.expectedGreetingId, "expectedGreetingId"),
        "--expected-message-sha256",
        requireSha256(command.expectedMessageSha256, "expectedMessageSha256")
      ];
    }
    case "list":
      return command.unreadOnly ? ["list", "--unread"] : ["list"];
    case "chat-by-name": {
      const argv = [
        "chat",
        exactCandidateTarget(command.candidateName, command.sourceLocator)
      ];
      if (command.strict) argv.push("--strict");
      return argv;
    }
    case "chat-by-index": {
      if (!Number.isInteger(command.index) || command.index < 1) {
        throw new Error("index must be a positive integer.");
      }
      const argv = ["chat"];
      if (command.expectedName) {
        argv.push(requireText(command.expectedName, "expectedName"));
      }
      argv.push("--index", String(command.index));
      if (command.unreadOnly) argv.push("--unread");
      if (command.strict) argv.push("--strict");
      return argv;
    }
    case "send": {
      const argv = [
        "send",
        "--text",
        requireText(command.text, "text"),
        "--candidate",
        exactCandidateTarget(command.candidateTarget, command.sourceLocator)
      ];
      return argv;
    }
    case "action": {
      const argv = ["action", command.action];
      if (command.action === "remark") {
        argv.push("--remark", requireText(command.remark ?? "", "remark"));
      } else if (command.remark !== undefined) {
        throw new Error("remark is only valid for the remark action.");
      }
      return argv;
    }
  }
}
