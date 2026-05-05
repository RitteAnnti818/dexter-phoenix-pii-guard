// PII Redacting Span Processor — TypeScript port of Arize's official
// PIIRedactingSpanProcessor pattern (Python example in the assignment PDF
// 6.2 절). Wraps an inner SpanProcessor and rewrites sensitive attributes
// (input.value, output.value, llm.input_messages, llm.output_messages) on
// span end so PII never reaches Phoenix UI.
//
// The Span Processor is the *last line of defense*. Upstream guards (input
// regexGuard + llmGuard, output checkOutput) should already have masked PII
// before traces are emitted. This processor catches anything that slipped
// through — tool results, model raw outputs, intermediate reasoning text.
//
// Set PII_GUARD_DISABLED=1 to bypass entirely. Useful for Week 1 evaluation
// runs where 12-digit revenue numbers might be misread as BANK_ACCT.

import type { Context } from '@opentelemetry/api';
import type { Span, ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { regexDetect, maskText } from './guards/regexGuard.js';

// OpenInference semantic convention keys that may carry user-facing text.
const SENSITIVE_ATTR_KEYS: readonly string[] = [
  'input.value',
  'output.value',
];

// Prefix-match keys for grouped attrs like llm.input_messages.0.message.content
const SENSITIVE_ATTR_PREFIXES: readonly string[] = [
  'llm.input_messages',
  'llm.output_messages',
  'tool.parameters',
  'retrieval.documents',
];

function isSensitiveKey(key: string): boolean {
  if (SENSITIVE_ATTR_KEYS.includes(key)) return true;
  return SENSITIVE_ATTR_PREFIXES.some((p) => key.startsWith(p));
}

export class PIIRedactingSpanProcessor implements SpanProcessor {
  constructor(private readonly inner: SpanProcessor) {}

  onStart(span: Span, parentContext: Context): void {
    this.inner.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    if (process.env.PII_GUARD_DISABLED === '1') {
      this.inner.onEnd(span);
      return;
    }
    this.inner.onEnd(this.redactSpan(span));
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  // Build a Proxy that replaces span.attributes with a redacted copy without
  // mutating the original SDK object (some implementations freeze attrs).
  private redactSpan(span: ReadableSpan): ReadableSpan {
    const original = span.attributes;
    let redactedCount = 0;
    const redacted: Record<string, unknown> = { ...(original as Record<string, unknown>) };

    for (const key of Object.keys(redacted)) {
      if (!isSensitiveKey(key)) continue;
      const value = redacted[key];
      if (typeof value !== 'string') continue;
      const detections = regexDetect(value);
      if (detections.length === 0) continue;
      redacted[key] = maskText(value, detections);
      redactedCount += detections.length;
    }

    if (redactedCount > 0) {
      redacted['pii.redacted.count'] = redactedCount;
    }

    return new Proxy(span, {
      get(target, prop, receiver) {
        if (prop === 'attributes') return redacted;
        return Reflect.get(target, prop, receiver);
      },
    });
  }
}
