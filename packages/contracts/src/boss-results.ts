export type ParsedPosition = {
  index: number;
  name: string;
  status: string;
  raw: string;
};

/** Stable, platform-provided identity used only to reopen the exact BOSS card. */
export type CandidateSourceLocator = {
  kind: "boss_geek_id";
  value: string;
};

export type ParsedCandidate = {
  index: number;
  name: string;
  source: "recommend" | "search" | "deep-search";
  sourceLocator?: CandidateSourceLocator;
  fields: Record<string, string>;
  evidence: string[];
  raw: string;
};

export type ParsedResume = {
  screenshotPath: string | null;
  ocrText: string | null;
  raw: string;
};

export type ParsedBossResult =
  | { kind: "positions"; positions: ParsedPosition[]; raw: string }
  | { kind: "candidates"; candidates: ParsedCandidate[]; raw: string }
  | { kind: "resume"; resume: ParsedResume; raw: string }
  | { kind: "action"; succeeded: boolean; message: string; raw: string }
  | { kind: "text"; text: string; raw: string };
