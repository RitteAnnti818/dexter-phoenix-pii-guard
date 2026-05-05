// Evaluators #1 (Factual Accuracy) and #2 (Groundedness).
//
// 1. Factual Accuracy — deterministic. Extract numerics from the agent's
//    final answer and check whether any of them fall inside the
//    ground_truth.acceptable_range. Skipped (returns null) for trap rows.
//
// 2. Groundedness — LLM-as-Judge. Asks whether every numeric claim in the
//    answer is supported by the concatenated tool outputs.

import type {
  AgentRunCapture,
  DatasetRow,
  EvalResult,
  ToolCallCapture,
} from './types.js';
import { judgeWithLlm } from './judge.js';

// Matches a number with optional thousands separators, decimals, and
// magnitude suffixes (B/M/K/T or 억/조/만). Captures the raw token; the
// caller normalizes it to billions for comparison.
const NUMERIC_REGEX = /(-?\$?\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s*(조|억|만|[BMKT])?/gi;

const MAGNITUDE_TO_BILLIONS: Record<string, number> = {
  T: 1000,
  B: 1,
  M: 0.001,
  K: 0.000001,
  '조': 100,        // 1조원 ≈ assumes the answer normalizes to USD billions; treat 조 as 100B as a coarse hint
  '억': 0.01,
  '만': 0.0000001,
};

/**
 * Pull every number from text and convert to a canonical "billions" scale
 * when a magnitude suffix is present. Plain numbers are returned as-is so
 * raw values like "24.0%" can match a percentage acceptable_range too.
 */
export function extractNumericValues(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(NUMERIC_REGEX)) {
    const raw = m[1].replace(/[$,]/g, '');
    const n = Number.parseFloat(raw);
    if (!Number.isFinite(n)) continue;
    const suffix = m[2];
    if (suffix) {
      const factor = MAGNITUDE_TO_BILLIONS[suffix.toUpperCase()] ?? MAGNITUDE_TO_BILLIONS[suffix];
      if (factor !== undefined) out.push(n * factor);
      else out.push(n);
    } else {
      out.push(n);
    }
  }
  return out;
}

/** Evaluator #1 — deterministic numeric check against acceptable_range. */
export function evaluateFactualAccuracy(
  row: DatasetRow,
  run: AgentRunCapture,
): EvalResult | null {
  if (row.level === 'trap') return null;
  const range = row.ground_truth.acceptable_range;
  if (!range) {
    return {
      score: 0,
      label: 'incorrect',
      explanation: 'dataset row missing acceptable_range — cannot score factual accuracy',
    };
  }
  const [lo, hi] = range;
  const candidates = extractNumericValues(run.finalAnswer);
  if (candidates.length === 0) {
    return {
      score: 0,
      label: 'incorrect',
      explanation: `no numeric values found in answer; expected range [${lo}, ${hi}]`,
    };
  }
  const hit = candidates.find((n) => n >= lo && n <= hi);
  if (hit !== undefined) {
    return {
      score: 1,
      label: 'correct',
      explanation: `found ${hit} inside acceptable range [${lo}, ${hi}]`,
    };
  }
  // Closest miss helps debug whether the model was off by an order of magnitude.
  const closest = candidates.reduce((a, b) =>
    Math.abs(b - (lo + hi) / 2) < Math.abs(a - (lo + hi) / 2) ? b : a,
  );
  return {
    score: 0,
    label: 'incorrect',
    explanation: `no extracted value in [${lo}, ${hi}]; closest was ${closest} (extracted: ${candidates.join(', ')})`,
  };
}

function concatToolOutputs(toolCalls: ToolCallCapture[], maxChars = 8000): string {
  const chunks = toolCalls.map(
    (t) => `### ${t.name}(${JSON.stringify(t.args)})\n${t.result}`,
  );
  const joined = chunks.join('\n\n');
  return joined.length > maxChars ? `${joined.slice(0, maxChars)}\n...[truncated]` : joined;
}

const GROUNDEDNESS_SYSTEM_PROMPT = `You are evaluating whether a financial AI agent's answer is fully grounded in the data sources it actually retrieved.

Definition of "grounded":
- Every concrete claim in the answer (numbers, dates, segment breakdowns, growth rates) must be either present in the tool outputs OR be a straightforward arithmetic transformation of values present.
- Hedging language ("approximately", "roughly") is fine if the underlying number is grounded.
- Restating the question or generic context (industry knowledge, company description) is acceptable.

Score buckets:
- 1.0 = "correct": every concrete claim is supported by tool outputs.
- 0.5 = "partial": at least one concrete claim is grounded, but at least one is missing or fabricated. Use this only when the answer is mostly right.
- 0.0 = "incorrect": the answer's key claim has no support, or the agent never called any tool.

Return JSON ONLY in this exact shape:
{"score": <0.0-1.0>, "label": "correct"|"partial"|"incorrect", "reason": "<one sentence>"}`;

/** Evaluator #2 — LLM-as-Judge: is every claim in the answer in the tool outputs? */
export async function evaluateGroundedness(
  row: DatasetRow,
  run: AgentRunCapture,
): Promise<EvalResult> {
  if (run.toolCalls.length === 0) {
    return {
      score: 0,
      label: 'incorrect',
      explanation: 'agent answered without calling any tool — answer cannot be grounded',
    };
  }
  const toolBlock = concatToolOutputs(run.toolCalls);
  const userPrompt = `Question:
${row.question}

Agent's answer:
${run.finalAnswer}

Tool outputs the agent saw:
${toolBlock}`;

  const verdict = await judgeWithLlm(GROUNDEDNESS_SYSTEM_PROMPT, userPrompt);
  return {
    score: verdict.score,
    label: verdict.label,
    explanation: verdict.reason,
  };
}
