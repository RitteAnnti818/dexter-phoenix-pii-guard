// Output Guard — runs the central PII Guard on the agent's response and detects
// cross-session leaks by comparing salted fingerprints, not by returning raw
// memory_seed PII values.
//
// Two responsibilities:
//   1. Mask PII that the agent might have generated in the response itself
//      (e.g., agent quotes a partial bank number it inferred).
//   2. Block responses where memory_seed PII tokens leaked into the answer
//      (cross_session and prompt_injection categories — agent retrieved
//      stored PII and put it back in the user-visible response).

import type { PIIDetection } from './regexGuard.js';
import { guardOutput } from './piiGuard.js';

export interface OutputGuardResult {
  /** Hard-block: cross-session PII leak detected — replace output entirely */
  blocked: boolean;
  /** PII detections found in the output text */
  detections: PIIDetection[];
  /** Output with PII masked (or block placeholder if blocked=true) */
  maskedOutput: string;
  /** Backward-compatible field containing fingerprint labels, never raw tokens. */
  leakedTokens: string[];
  /** HMAC fingerprints for cross-session leaked PII. Raw values are not returned. */
  leakedFingerprints: string[];
  /** Human-readable reason if blocked */
  reason?: string;
}

export interface OutputGuardOptions {
  /** Stored memory contents — normalized PII fingerprints are compared against output. */
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
  const result = await guardOutput(output, {
    surface: 'agent',
    direction: 'output',
    memorySeed: options.memorySeed,
    blockedPlaceholder: options.blockedPlaceholder ?? DEFAULT_BLOCKED_PLACEHOLDER,
  });

  const leakedTokens = result.leakedFingerprints.map((fp) => `fp:${fp}`);

  return {
    blocked: result.action === 'block',
    detections: result.detections,
    maskedOutput: result.maskedText,
    leakedTokens,
    leakedFingerprints: result.leakedFingerprints,
    reason: result.action === 'block'
      ? `Cross-session leak: memory PII fingerprint matched (${leakedTokens.join(', ')})`
      : undefined,
  };
}
