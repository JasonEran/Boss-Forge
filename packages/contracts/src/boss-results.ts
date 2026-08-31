export type ParsedPosition = {
  index: number;
  name: string;
  status: string;
  raw: string;
};

export type ParsedCandidate = {
  index: number;
  name: string;
  source: "recommend" | "search" | "deep-search";
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
