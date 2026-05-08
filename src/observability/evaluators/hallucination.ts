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
import { GROUNDEDNESS_SYSTEM_PROMPT } from './prompts.js';

// Matches a number with optional thousands separators, decimals, and
// magnitude suffixes (B/M/K/T or 억/조/만). Captures the raw token; the
// caller normalizes it to billions for comparison.
//
// The first alternative ends with `(?!\d)` so a 4+ digit token without
// thousand separators (e.g. "FY2024") doesn't degenerate into a 3-digit
// match like "202". Without this guard, "FY2024" → 202 silently passed
// for any GT range near 200B (Q019 false-positive in baseline).
const NUMERIC_REGEX = /(-?\$?\d{1,3}(?:,\d{3})*(?:\.\d+)?(?!\d)|\d+(?:\.\d+)?)\s*(조|억|만|[BMKT])?/gi;

// Mathematically correct conversion to billions of (USD-equivalent) units.
// 1조 = 10^12 = 1000B, 1억 = 10^8 = 0.1B, 1만 = 10^4 = 0.00001B.
// The original coefficients were each ~10× too small, so a Korean-unit
// answer with the right value scored as a miss (Q001 v2 etc.).
const MAGNITUDE_TO_BILLIONS: Record<string, number> = {
  T: 1000,
  B: 1,
  M: 0.001,
  K: 0.000001,
  '조': 1000,
  '억': 0.1,
  '만': 0.00001,
};

// Skip evaluation entirely when the agent never produced a real answer.
// Without this, the regex happily extracts the "8" from "Reached maximum
// iterations (8)" and matches it against any GT range covering 8 (Q026,
// Q037 baseline false-positives).
const FAILURE_PATTERNS: RegExp[] = [
  /^Reached maximum iterations/i,
  /^Error:\s/i,
  /^An error occurred/i,
];

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
  const trimmed = run.finalAnswer.trim();
  if (FAILURE_PATTERNS.some((p) => p.test(trimmed))) {
    return {
      score: 0,
      label: 'incorrect',
      explanation: `agent did not produce an answer (matched failure pattern); GT range was [${lo}, ${hi}]`,
    };
  }
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
