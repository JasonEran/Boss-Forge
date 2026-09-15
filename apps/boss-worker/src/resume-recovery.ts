import type { ResumeScreeningErrorCode } from "@boss-forge/data";

export function resumeScreeningErrorCode(message: string): ResumeScreeningErrorCode {
  if (/BOSS_RESUME_INCOMPLETE/u.test(message)) return "content_incomplete";
  if (/风控|risk|captcha|验证/u.test(message)) return "risk_control";
  if (/BOSS_SOURCE_EXPIRED/u.test(message)) return "source_expired";
  if (/BOSS_TARGET_CHANGED/u.test(message)) return "target_changed";
  if (/BOSS_TARGET_AMBIGUOUS/u.test(message)) return "target_ambiguous";
  if (/BOSS_TARGET_MISSING|未在列表中找到该候选人/u.test(message)) {
    return "target_missing";
  }
  if (/点击未能打开简历预览|当前不在推荐列表页|点击后未出现在线简历/u.test(message)) {
    return "preview_not_opened";
  }
  if (/BOSS_RESUME_CONTENT_EMPTY|没有取得可用正文/u.test(message)) return "content_empty";
  if (/OCR|TencentCloud|ImageToText|图片识别/iu.test(message)) return "ocr_failed";
  return "worker_error";
}

/**
 * Automatic retries may reopen a BOSS resume, so keep this narrower than the
 * set an HR may explicitly retry after reviewing the failure.
 */
export function autoRetryableResumeScreeningError(
  errorCode: ResumeScreeningErrorCode,
): boolean {
  return errorCode === "content_incomplete" || errorCode === "content_empty" || errorCode === "preview_not_opened";
}

/** Bounded backoff: 5, 10, 20, then 30 minutes. */
export function resumeRetryAt(now: Date, claimAttempt: number): Date {
  const minutes = Math.min(30, 5 * 2 ** Math.max(0, claimAttempt - 1));
  return new Date(now.getTime() + minutes * 60 * 1_000);
}
