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
  | { type: "recommend"; jobKeyword?: string }
  | { type: "search"; keyword?: string }
  | {
      type: "deep-search";
      jobKeyword?: string;
      core: string[];
      bonus: string[];
      match: boolean;
    }
  | { type: "preview"; candidateTarget: string }
  | { type: "greet"; candidateTarget: string; jobKeyword?: string }
  | { type: "list"; unreadOnly: boolean }
  | {
      type: "chat-by-index";
      index: number;
      unreadOnly: boolean;
      expectedName?: string;
      strict: boolean;
    }
  | { type: "send"; text: string; requestResume: boolean }
  | { type: "action"; action: BossAction; remark?: string };

export type BossCommandRisk = "read" | "quota-consuming-read" | "external-write";

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} must not be empty.`);
  }
  return normalized;
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
      return ["preview", requireText(command.candidateTarget, "candidateTarget")];
    case "greet": {
      const argv = ["greet", requireText(command.candidateTarget, "candidateTarget")];
      if (command.jobKeyword) {
        argv.push("--job", requireText(command.jobKeyword, "jobKeyword"));
      }
      return argv;
    }
    case "list":
      return command.unreadOnly ? ["list", "--unread"] : ["list"];
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
      const argv = ["send", "--text", requireText(command.text, "text")];
      if (command.requestResume) argv.push("--request-resume");
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
