// Evaluator #5 — Plan Quality (LLM-as-Judge).
//
// "Plan" here is the concatenation of CHAIN-level reasoning (the text the
// agent emits before tool calls). The judge asks: given the question, was
// the plan a sensible decomposition that lined up with the tools that were
// actually invoked?

import type { AgentRunCapture, DatasetRow, EvalResult } from './types.js';
import { judgeWithLlm } from './judge.js';
import { PLAN_QUALITY_SYSTEM_PROMPT } from './prompts.js';

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

  const verdict = await judgeWithLlm(PLAN_QUALITY_SYSTEM_PROMPT, userPrompt);
  return {
    score: verdict.score,
    label: verdict.label,
    explanation: verdict.reason,
  };
}
