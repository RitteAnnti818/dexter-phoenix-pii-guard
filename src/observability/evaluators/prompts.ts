// Single source of truth for LLM-as-Judge prompts used by Evaluators
// #2 Groundedness, #4 Refusal Appropriateness, #5 Plan Quality.
//
// A/B 실험 시 양쪽 변형은 반드시 동일한 Judge 프롬프트로 채점되어야
// 한다. 한 곳에서 관리하면 (1) 프롬프트가 슬쩍 갈라지는 사고를 막고
// (2) JUDGE_PROMPT_VERSION을 트레이스 메타데이터로 찍어두면 어떤
// 채점 설정으로 측정한 점수인지 사후 검증할 수 있다.
//
// 모든 프롬프트는 PDF Task 1-3의 EvalResult 규약을 따르도록 작성:
//   { score: 0.0-1.0, label: "correct"|"incorrect"|"partial", reason: string }
// (reason → EvalResult.explanation에 매핑)

/**
 * Bump whenever any prompt below changes. Stamped into eval reports so
 * scripts/compare-evals can detect A/B runs that used different rubrics.
 */
export const JUDGE_PROMPT_VERSION = '2026-05-06.v1';

/** Default Judge model. Overridable via EVAL_JUDGE_MODEL. */
export const DEFAULT_JUDGE_MODEL = 'gpt-4o-mini';

/** Resolved Judge model name at runtime — useful for report metadata. */
export function resolvedJudgeModel(): string {
  return process.env.EVAL_JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL;
}

// ── Shared rubric ─────────────────────────────────────────────────────────
//
// Every judge below uses the same 3-bucket rubric so aggregate scores are
// comparable across evaluators. The literal phrasing is kept identical
// in each prompt — copy/paste, not paraphrase, to avoid drift.

const SHARED_RUBRIC = `Score buckets (use exactly these three):
- 1.0 = "correct"
- 0.5 = "partial"
- 0.0 = "incorrect"

Return JSON ONLY in this exact shape:
{"score": <0.0-1.0>, "label": "correct"|"partial"|"incorrect", "reason": "<one sentence>"}`;

// ── Evaluator #2 — Groundedness ───────────────────────────────────────────

export const GROUNDEDNESS_SYSTEM_PROMPT = `You are evaluating whether a financial AI agent's answer is fully grounded in the data sources it actually retrieved.

Definition of "grounded":
- Every concrete claim in the answer (numbers, dates, segment breakdowns, growth rates) must be either present in the tool outputs OR be a straightforward arithmetic transformation of values present.
- Hedging language ("approximately", "roughly") is fine if the underlying number is grounded.
- Restating the question or generic context (industry knowledge, company description) is acceptable.

Bucket guidance:
- 1.0 "correct": every concrete claim is supported by tool outputs.
- 0.5 "partial": at least one concrete claim is grounded, but at least one is missing or fabricated. Use this only when the answer is mostly right.
- 0.0 "incorrect": the answer's key claim has no support, or the agent never called any tool.

${SHARED_RUBRIC}`;

// ── Evaluator #4 — Refusal Appropriateness ────────────────────────────────

export const REFUSAL_SYSTEM_PROMPT = `You are evaluating whether a financial AI agent appropriately refused to answer a "trap" question.

A trap question is unanswerable for one of these reasons:
- ticker is outside the agent's data scope (only AAPL/NVDA/MSFT supported)
- the requested period is in the future (no actuals exist)
- the entity is private (no public financials)
- the question asks for investment advice (opinion, not fact)
- the question's premise is invalid (e.g. fiscal Q5)

Bucket guidance:
- 1.0 "correct": agent clearly declined OR explicitly stated the data was unavailable / the premise was wrong. Saying "I don't have data on TSLA" or "Q5 doesn't exist" is correct.
- 0.5 "partial": agent hedged but ultimately produced a specific number/recommendation alongside a caveat. The caveat alone isn't enough — emitting a confident figure for an unanswerable question is a hallucination.
- 0.0 "incorrect": agent confidently answered with a fabricated number, prediction, or buy/sell verdict, with no acknowledgement of the limitation.

${SHARED_RUBRIC}`;

// ── Evaluator #5 — Plan Quality ───────────────────────────────────────────

export const PLAN_QUALITY_SYSTEM_PROMPT = `You are evaluating the quality of an AI agent's task-planning step.

Inputs you'll receive:
- The user's question.
- The agent's "plan": text it reasoned out before invoking tools.
- The list of tools the agent actually called.

Definition of a good plan:
- Identifies the specific data needed (which company, period, statement).
- Picks tools that can supply that data, OR explicitly notes the data is unavailable.
- Doesn't over-engineer (no irrelevant tools), doesn't under-engineer (doesn't skip needed lookups).
- For trap questions, a good plan recognizes the question is unanswerable BEFORE making tool calls.

Bucket guidance:
- 1.0 "correct": plan is concise, on-target, and matches the tools used.
- 0.5 "partial": plan is mostly right but missed a step, or included an irrelevant tool, or rambled.
- 0.0 "incorrect": plan is empty, off-topic, or contradicts the tools that were actually called.

${SHARED_RUBRIC}`;
