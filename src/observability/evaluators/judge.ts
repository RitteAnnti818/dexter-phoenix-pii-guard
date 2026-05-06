// LLM-as-Judge helper used by Groundedness, Refusal, and Plan Quality.
// Default model: gpt-4o-mini (cheap, consistent). Override with EVAL_JUDGE_MODEL.
//
// Returns parsed JSON of shape { score, label, reason }. If the judge model
// returns malformed JSON we retry once, then fall back to a low-confidence
// "incorrect" rather than throwing — evaluators must always produce a result.

import { ChatOpenAI } from '@langchain/openai';
import type { EvalLabel } from './types.js';
import { DEFAULT_JUDGE_MODEL } from './prompts.js';

export interface JudgeVerdict {
  score: number;
  label: EvalLabel;
  reason: string;
}

let judge: ChatOpenAI | null = null;

function getJudge(): ChatOpenAI {
  if (judge) return judge;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('[evaluator] OPENAI_API_KEY not set — required for LLM-as-Judge');
  }
  judge = new ChatOpenAI({
    model: process.env.EVAL_JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL,
    apiKey,
    temperature: 0,
    // Force JSON output so we never have to scrape markdown fences.
    modelKwargs: { response_format: { type: 'json_object' } },
  });
  return judge;
}

function parseVerdict(raw: string): JudgeVerdict | null {
  try {
    const obj = JSON.parse(raw);
    const score = typeof obj.score === 'number' ? obj.score : Number(obj.score);
    if (!Number.isFinite(score)) return null;
    const label = (obj.label as string)?.toLowerCase();
    if (label !== 'correct' && label !== 'incorrect' && label !== 'partial') return null;
    const reason = typeof obj.reason === 'string' ? obj.reason : '';
    return { score: Math.max(0, Math.min(1, score)), label: label as EvalLabel, reason };
  } catch {
    return null;
  }
}

/**
 * Run an LLM-as-Judge prompt and return a parsed verdict.
 * The prompt MUST instruct the model to return JSON of shape:
 *   { "score": 0.0-1.0, "label": "correct|incorrect|partial", "reason": "..." }
 */
export async function judgeWithLlm(systemPrompt: string, userPrompt: string): Promise<JudgeVerdict> {
  const llm = getJudge();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await llm.invoke([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ]);
      const text = typeof response.content === 'string'
        ? response.content
        : JSON.stringify(response.content);
      const verdict = parseVerdict(text);
      if (verdict) return verdict;
    } catch (err) {
      if (attempt === 1) {
        return {
          score: 0,
          label: 'incorrect',
          reason: `judge call failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
  }
  return { score: 0, label: 'incorrect', reason: 'judge returned malformed JSON twice' };
}
