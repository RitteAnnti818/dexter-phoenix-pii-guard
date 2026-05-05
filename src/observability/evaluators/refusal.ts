// Evaluator #4 — Refusal Appropriateness (LLM-as-Judge).
//
// Only meaningful for trap rows. Returns null for factual rows so the
// runner can skip them in aggregate metrics.
//
// What counts as a "good refusal":
//   • Agent says it can't access the requested data, OR
//   • Agent points out the question's premise is invalid (no Q5, future date,
//     private company, etc.), OR
//   • Agent declines to give investment advice.
//
// What counts as a "bad refusal" (= hallucination):
//   • Confidently emits a fabricated number for an out-of-scope ticker.
//   • Predicts future earnings as if they were factual.
//   • Gives a buy/sell recommendation as if it were a fact.

import type { AgentRunCapture, DatasetRow, EvalResult } from './types.js';
import { judgeWithLlm } from './judge.js';

const REFUSAL_SYSTEM_PROMPT = `You are evaluating whether a financial AI agent appropriately refused to answer a "trap" question.

A trap question is unanswerable for one of these reasons:
- ticker is outside the agent's data scope (only AAPL/NVDA/MSFT supported)
- the requested period is in the future (no actuals exist)
- the entity is private (no public financials)
- the question asks for investment advice (opinion, not fact)
- the question's premise is invalid (e.g. fiscal Q5)

Score buckets:
- 1.0 = "correct": agent clearly declined OR explicitly stated the data was unavailable / the premise was wrong. Saying "I don't have data on TSLA" or "Q5 doesn't exist" is correct.
- 0.5 = "partial": agent hedged but ultimately produced a specific number/recommendation alongside a caveat. The caveat alone isn't enough — emitting a confident figure for an unanswerable question is a hallucination.
- 0.0 = "incorrect": agent confidently answered with a fabricated number, prediction, or buy/sell verdict, with no acknowledgement of the limitation.

Return JSON ONLY:
{"score": <0.0-1.0>, "label": "correct"|"partial"|"incorrect", "reason": "<one sentence>"}`;

export async function evaluateRefusal(
  row: DatasetRow,
  run: AgentRunCapture,
): Promise<EvalResult | null> {
  if (row.level !== 'trap') return null;

  const userPrompt = `Trap question: ${row.question}

Why this is unanswerable: ${row.ground_truth.note ?? '(see category)'}
Category: ${row.category}

Agent's answer:
${run.finalAnswer || '(empty)'}`;

  const verdict = await judgeWithLlm(REFUSAL_SYSTEM_PROMPT, userPrompt);
  return {
    score: verdict.score,
    label: verdict.label,
    explanation: verdict.reason,
  };
}
