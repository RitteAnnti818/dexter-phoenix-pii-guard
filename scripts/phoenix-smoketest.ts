#!/usr/bin/env bun
/**
 * Standalone Phoenix connectivity check.
 *   bun run scripts/phoenix-smoketest.ts
 *
 * Sends one synthetic AGENT > CHAIN > LLM > TOOL trace and force-flushes,
 * so you can verify that Phoenix is receiving spans without launching
 * the full Dexter agent.
 */
import 'dotenv/config';
import { context as otelContext, trace } from '@opentelemetry/api';
import {
  OpenInferenceSpanKind,
  SemanticConventions,
  MimeType,
} from '@arizeai/openinference-semantic-conventions';
import { initTelemetry, getTracer, flushTelemetry } from '../src/observability/telemetry.js';

initTelemetry();
const tracer = getTracer();

const agent = tracer.startSpan('Agent.run', {
  attributes: {
    [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.AGENT,
    [SemanticConventions.INPUT_VALUE]: 'smoketest query',
    [SemanticConventions.INPUT_MIME_TYPE]: MimeType.TEXT,
  },
});
const agentCtx = trace.setSpan(otelContext.active(), agent);

const chain = tracer.startSpan(
  'planning',
  { attributes: { [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.CHAIN } },
  agentCtx,
);
const chainCtx = trace.setSpan(agentCtx, chain);

const llm = tracer.startSpan(
  'llm.chat',
  {
    attributes: {
      [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.LLM,
      [SemanticConventions.LLM_MODEL_NAME]: 'gpt-4o-mini',
      [SemanticConventions.OUTPUT_VALUE]: 'hello from smoketest',
    },
  },
  chainCtx,
);
llm.end();
chain.end();

const tool = tracer.startSpan(
  'tool.get_income_statements',
  {
    attributes: {
      [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.TOOL,
      [SemanticConventions.TOOL_NAME]: 'get_income_statements',
      [SemanticConventions.INPUT_VALUE]: '{"ticker":"AAPL"}',
      [SemanticConventions.INPUT_MIME_TYPE]: MimeType.JSON,
      [SemanticConventions.OUTPUT_VALUE]: '{"revenue":391040000000}',
      [SemanticConventions.OUTPUT_MIME_TYPE]: MimeType.JSON,
    },
  },
  agentCtx,
);
tool.end();

agent.setAttribute(SemanticConventions.OUTPUT_VALUE, 'AAPL FY2024 revenue: $391.04B');
agent.end();

console.error('[smoketest] flushing spans...');
await flushTelemetry();
console.error('[smoketest] done — check Phoenix UI (project: dexter)');
