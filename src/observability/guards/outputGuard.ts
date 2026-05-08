// Output Guard — re-runs Stage 1+2 on the agent's response and detects
// cross-session leaks where memory_seed PII tokens appear in the output.
//
// Two responsibilities:
//   1. Mask PII that the agent might have generated in the response itself
//      (e.g., agent quotes a partial bank number it inferred).
//   2. Block responses where memory_seed PII tokens leaked into the answer
//      (cross_session and prompt_injection categories — agent retrieved
//      stored PII and put it back in the user-visible response).

import { regexDetect, maskText, dedupeOverlapping, type PIIDetection } from './regexGuard.js';
import { llmDetect } from './llmGuard.js';

export interface OutputGuardResult {
  /** Hard-block: cross-session PII leak detected — replace output entirely */
  blocked: boolean;
  /** PII detections found in the output text */
  detections: PIIDetection[];
  /** Output with PII masked (or block placeholder if blocked=true) */
  maskedOutput: string;
  /** Memory-seed PII tokens that appeared verbatim in the output */
  leakedTokens: string[];
  /** Human-readable reason if blocked */
  reason?: string;
}

export interface OutputGuardOptions {
  /** Stored memory contents — output is checked for any PII tokens from this. */
  memorySeed?: string;
  /** Replacement text used when blocked. Defaults to a refusal message. */
  blockedPlaceholder?: string;
}

const DEFAULT_BLOCKED_PLACEHOLDER =
  '저장된 개인정보를 응답에 포함할 수 없습니다. (Cross-session PII leak prevented.)';

export async function checkOutput(
  output: string,
  options: OutputGuardOptions = {},
): Promise<OutputGuardResult> {
  const stage1 = regexDetect(output);
  const stage2 = await llmDetect(output, { stage1Detections: stage1 });
  const detections = dedupeOverlapping([...stage1, ...stage2]);

  const leakedTokens = options.memorySeed
    ? findLeakedTokens(options.memorySeed, output)
    : [];

  if (leakedTokens.length > 0) {
    return {
      blocked: true,
      detections,
      maskedOutput: options.blockedPlaceholder ?? DEFAULT_BLOCKED_PLACEHOLDER,
      leakedTokens,
      reason: `Cross-session leak: memory PII appeared verbatim in output (${leakedTokens.join(', ')})`,
    };
  }

  return {
    blocked: false,
    detections,
    maskedOutput: detections.length > 0 ? maskText(output, detections) : output,
    leakedTokens: [],
  };
}

// memory_seed format from the dataset:
//   "사용자 <type>: <value>"   or comma-separated multiple key:value pairs
// Extract just the values (the actual PII tokens) for leak detection.
//
// Match strategies (any one is sufficient to flag a leak):
//   1. Exact substring match
//   2. Separator-stripped digit/letter match — catches reformatted PII
//      ("010-1234-5678" memory ↔ "01012345678" or "010.1234.5678" output)
function findLeakedTokens(memorySeed: string, output: string): string[] {
  const tokens: string[] = [];
  const stripSeparators = (s: string) => s.replace(/[\s\-.@_*]/g, '');
  const outputStripped = stripSeparators(output);
  for (const part of memorySeed.split(',')) {
    const colonIdx = part.indexOf(':');
    if (colonIdx === -1) continue;
    const value = part.slice(colonIdx + 1).trim();
    if (value.length === 0) continue;
    if (output.includes(value)) {
      tokens.push(value);
      continue;
    }
    const valueStripped = stripSeparators(value);
    // Require ≥6 chars after stripping to avoid coincidental short collisions.
    if (valueStripped.length >= 6 && outputStripped.includes(valueStripped)) {
      tokens.push(value);
    }
  }
  return tokens;
}
