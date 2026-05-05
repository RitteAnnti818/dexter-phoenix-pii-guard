// Evaluator #5 — Plan Quality (LLM-as-Judge).
//
// "Plan" here is the concatenation of CHAIN-level reasoning (the text the
// agent emits before tool calls). The judge asks: given the question, was
// the plan a sensible decomposition that lined up with the tools that were
// actually invoked?

import type { AgentRunCapture, DatasetRow, EvalResult } from './types.js';
import { judgeWithLlm } from './judge.js';

const PLAN_SYSTEM_PROMPT = `You are evaluating the quality of an AI agent's task-planning step.

Inputs you'll receive:
- The user's question.
- The agent's "plan": text it reasoned out before invoking tools.
- The list of tools the agent actually called.

Definition of a good plan:
- Identifies the specific data needed (which company, period, statement).
- Picks tools that can supply that data, OR explicitly notes the data is unavailable.
- Doesn't over-engineer (no irrelevant tools), doesn't under-engineer (doesn't skip needed lookups).
- For trap questions, a good plan recognizes the question is unanswerable BEFORE making tool calls.

Score buckets:
- 1.0 = "correct": plan is concise, on-target, and matches the tools used.
- 0.5 = "partial": plan is mostly right but missed a step, or included an irrelevant tool, or rambled.
- 0.0 = "incorrect": plan is empty, off-topic, or contradicts the tools that were actually called.

Return JSON ONLY:
{"score": <0.0-1.0>, "label": "correct"|"partial"|"incorrect", "reason": "<one sentence>"}`;

export async function evaluatePlanQuality(
  row: DatasetRow,
  run: AgentRunCapture,
): Promise<EvalResult> {
  const planText = run.thinking.join('\n---\n').trim();
  if (!planText) {
    // No reasoning emitted before tool calls. Could be a fast-path single
    // tool call where the model went straight to action — penalize lightly.
    return {
      score: 0.5,
      label: 'partial',
      explanation: 'agent emitted no plan/reasoning text before acting',
    };
  }

  const toolList = run.toolCalls.length === 0
    ? '(none)'
    : run.toolCalls.map((t) => `${t.name}(${JSON.stringify(t.args)})`).join('; ');

  const userPrompt = `Question (level=${row.level}, category=${row.category}):
${row.question}

Agent plan / reasoning:
${planText.slice(0, 4000)}

Tools actually called: ${toolList}`;

  const verdict = await judgeWithLlm(PLAN_SYSTEM_PROMPT, userPrompt);
  return {
    score: verdict.score,
    label: verdict.label,
    explanation: verdict.reason,
  };
}
