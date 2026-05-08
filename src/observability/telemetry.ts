// Phoenix OTLP exporter + OpenInference instrumentation.
// Initialize once at process startup BEFORE any LangChain/openai modules load,
// so the auto-instrumentation can wrap the openai SDK as it is imported.

import { NodeSDK } from '@opentelemetry/sdk-node';
// Phoenix only accepts OTLP/Protobuf over HTTP (returns 415 for JSON), so we
// use the -proto exporter instead of -http (which defaults to JSON).
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { trace, diag, DiagConsoleLogger, DiagLogLevel, type Tracer } from '@opentelemetry/api';
import { OpenAIInstrumentation } from '@arizeai/openinference-instrumentation-openai';
import { OITracer } from '@arizeai/openinference-core';
import { SEMRESATTRS_PROJECT_NAME } from '@arizeai/openinference-semantic-conventions';
import { PIIRedactingSpanProcessor } from './spanProcessors.js';

const TRACER_NAME = 'dexter-observability';

let sdk: NodeSDK | null = null;
let oiTracer: OITracer | null = null;

export function initTelemetry(projectName?: string): void {
  if (sdk) return;
  if (process.env.PHOENIX_DISABLED === '1') {
    return;
  }

  // Surface OTLP exporter errors to stderr so silent network/auth failures
  // don't disguise themselves as "no traces showing up". Set
  // PHOENIX_DEBUG=1 to also see verbose batch/flush logs.
  diag.setLogger(
    new DiagConsoleLogger(),
    process.env.PHOENIX_DEBUG === '1' ? DiagLogLevel.DEBUG : DiagLogLevel.ERROR,
  );

  const resolvedProject =
    projectName ?? process.env.PHOENIX_PROJECT_NAME ?? 'dexter';

  const endpoint =
    process.env.PHOENIX_COLLECTOR_ENDPOINT ?? 'http://localhost:6006/v1/traces';

  const headers: Record<string, string> = {};
  if (process.env.PHOENIX_API_KEY) {
    headers.authorization = `Bearer ${process.env.PHOENIX_API_KEY}`;
  }

  const traceExporter = new OTLPTraceExporter({ url: endpoint, headers });

  // PII Redacting Span Processor wraps BatchSpanProcessor so PII is masked
  // before traces leave the process. Set PII_GUARD_DISABLED=1 to bypass
  // (e.g., Week 1 hallucination evaluation where 12-digit revenue numbers
  // could be misclassified as BANK_ACCT).
  const batchProcessor = new BatchSpanProcessor(traceExporter);
  const piiProcessor = new PIIRedactingSpanProcessor(batchProcessor);

  sdk = new NodeSDK({
    spanProcessor: piiProcessor,
    resource: resourceFromAttributes({
      [SEMRESATTRS_PROJECT_NAME]: resolvedProject,
    }),
    instrumentations: [new OpenAIInstrumentation()],
  });

  sdk.start();

  oiTracer = new OITracer({ tracer: trace.getTracer(TRACER_NAME) });

  // Visible confirmation so users know telemetry is alive and where traces go.
  // eslint-disable-next-line no-console
  console.error(
    `[phoenix] telemetry initialized → project="${resolvedProject}" endpoint=${endpoint}${
      process.env.PHOENIX_API_KEY ? ' (auth)' : ''
    }`,
  );

  const shutdown = async () => {
    try {
      await sdk?.shutdown();
    } catch {
      // ignore shutdown errors
    }
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  process.once('beforeExit', shutdown);
}

/**
 * Force the BatchSpanProcessor to flush queued spans immediately.
 * Useful after a single query when running outside the long-lived TUI
 * (e.g., one-shot evaluation scripts) — spans otherwise wait up to 5s.
 */
export async function flushTelemetry(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
    sdk = null;
  } catch {
    // ignore
  }
}

export function getTracer(): OITracer {
  if (!oiTracer) {
    // Lazy fallback — returns a no-op-equivalent tracer if initTelemetry()
    // was never called (e.g., tests). Manual spans become harmless inert ops.
    oiTracer = new OITracer({ tracer: trace.getTracer(TRACER_NAME) });
  }
  return oiTracer;
}

export function getRawTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}
