// Minimal Phoenix REST client for span annotations.
// Used by scripts/run-evals.ts to attach Evaluator 5종 scores to the AGENT span
// so they show up alongside the trace in Phoenix UI.

import type { EvalResult } from './evaluators/types.js';

export interface SpanAnnotation {
  span_id: string;
  name: string;
  annotator_kind: 'LLM' | 'HUMAN' | 'CODE';
  result: {
    label?: string;
    score?: number;
    explanation?: string;
  };
  metadata?: Record<string, unknown>;
}

function annotationsBaseUrl(): string {
  // PHOENIX_COLLECTOR_ENDPOINT is the OTLP traces URL
  // (e.g. http://localhost:6006/v1/traces). Strip the /v1/traces suffix
  // to get the API base; allow overriding via PHOENIX_BASE_URL.
  if (process.env.PHOENIX_BASE_URL) return process.env.PHOENIX_BASE_URL.replace(/\/$/, '');
  const endpoint = process.env.PHOENIX_COLLECTOR_ENDPOINT ?? 'http://localhost:6006/v1/traces';
  return endpoint.replace(/\/v1\/traces\/?$/, '').replace(/\/$/, '');
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (process.env.PHOENIX_API_KEY) headers.authorization = `Bearer ${process.env.PHOENIX_API_KEY}`;
  return headers;
}

export async function postSpanAnnotations(annotations: SpanAnnotation[]): Promise<void> {
  if (annotations.length === 0) return;
  const url = `${annotationsBaseUrl()}/v1/span_annotations`;
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ data: annotations }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Phoenix annotation POST failed (${res.status}): ${text.slice(0, 300)}`);
  }
}

const ANNOTATOR_KIND: Record<string, 'LLM' | 'CODE'> = {
  factual_accuracy: 'CODE',
  groundedness: 'LLM',
  tool_call_correctness: 'CODE',
  refusal_appropriateness: 'LLM',
  plan_quality: 'LLM',
};

/** Convert one row's evaluator outputs into Phoenix annotations for a span. */
export function buildAnnotations(
  spanId: string,
  evaluations: Record<string, EvalResult | null>,
): SpanAnnotation[] {
  const out: SpanAnnotation[] = [];
  for (const [name, result] of Object.entries(evaluations)) {
    if (!result) continue;
    out.push({
      span_id: spanId,
      name,
      annotator_kind: ANNOTATOR_KIND[name] ?? 'LLM',
      result: {
        label: result.label,
        score: result.score,
        explanation: result.explanation,
      },
    });
  }
  return out;
}
