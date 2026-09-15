/**
 * Semantic results remain observational until the evaluation path uses the
 * same criterion-scoped evaluator/model, prompt and catalog as production.
 * The previous alias-substring score could be passed by one unrelated sample,
 * so an environment variable must never be able to promote it to a hiring
 * decision. Re-enabling this requires a separate product acceptance review.
 */
export const SEMANTIC_ACTIVE_DECISIONS_AVAILABLE = false;

