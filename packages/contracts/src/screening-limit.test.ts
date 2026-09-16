import { describe, expect, it } from "vitest";
import {
  screeningChunkLimit,
  screeningChunkSizes,
  screeningCandidateLimit,
  SCREENING_CHUNK_SIZE
} from "./screening-limit.js";

describe("screening chunks", () => {
  it("keeps requests of 20 or fewer as a single chunk", () => {
    expect(screeningChunkSizes(1)).toEqual([1]);
    expect(screeningChunkSizes(20)).toEqual([20]);
    expect(screeningChunkLimit(20, 0)).toBe(20);
  });

  it("splits larger requests into waves of at most 20", () => {
    expect(SCREENING_CHUNK_SIZE).toBe(20);
    expect(screeningChunkSizes(40)).toEqual([20, 20]);
    expect(screeningChunkSizes(30)).toEqual([20, 10]);
    expect(screeningChunkSizes(45)).toEqual([20, 20, 5]);
  });

  it("recomputes the next wave from remaining work", () => {
    expect(screeningChunkLimit(40, 0)).toBe(20);
    expect(screeningChunkLimit(40, 20)).toBe(20);
    expect(screeningChunkLimit(30, 20)).toBe(10);
    expect(screeningChunkLimit(20, 20)).toBe(0);
    expect(screeningCandidateLimit(40)).toBe(40);
    expect(screeningCandidateLimit(500)).toBe(500);
    expect(screeningChunkSizes(100)).toEqual([20, 20, 20, 20, 20]);
  });
});
