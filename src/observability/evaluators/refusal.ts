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
import { REFUSAL_SYSTEM_PROMPT } from './prompts.js';

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
