#!/usr/bin/env bun
/**
 * HTTP wrapper around Dexter Agent for IQHub dataset integration.
 *
 * Endpoints:
 *   POST /chat      — IQHub REST agent protocol (SSE stream)
 *   POST /evaluate  — Run original evaluators on cached AgentRunCapture
 *   GET  /health    — Status check
 *
 * Usage:
 *   bun run scripts/serve-agent.ts
 *   DEXTER_MODEL=gpt-4.1-nano bun run scripts/serve-agent.ts
 */
import { initTelemetry, flushTelemetry } from '../src/observability/telemetry.js';
initTelemetry();

import { Agent } from '../src/agent/agent.js';
import {
  evaluateFactualAccuracy,
  evaluateGroundedness,
} from '../src/observability/evaluators/hallucination.js';
import { evaluateToolCorrectness } from '../src/observability/evaluators/toolCorrectness.js';
import { evaluateRefusal } from '../src/observability/evaluators/refusal.js';
import { evaluatePlanQuality } from '../src/observability/evaluators/planQuality.js';
import type {
  AgentRunCapture,
  DatasetRow,
  ToolCallCapture,
} from '../src/observability/evaluators/types.js';

const PORT = Number(process.env.PORT ?? 2024);
const MODEL = process.env.DEXTER_MODEL ?? process.env.DEXTER_EVAL_MODEL ?? 'gpt-4o-mini';
const PHOENIX_URL = process.env.PHOENIX_COLLECTOR_ENDPOINT?.replace('/v1/traces', '') ?? 'http://localhost:6006';

// ── AgentRunCapture cache (keyed by query text) ──────────────────────────────
const captureCache = new Map<string, AgentRunCapture>();

// ── Kill stale process on port ───────────────────────────────────────────────
try {
  const lsof = Bun.spawnSync(['lsof', '-ti', `:${PORT}`]);
  const pid = lsof.stdout.toString().trim();
  if (pid) {
    Bun.spawnSync(['kill', '-9', pid]);
    await Bun.sleep(1000);
    console.error(`[dexter-serve] killed stale process on port ${PORT} (pid ${pid})`);
  }
} catch { /* lsof not available */ }

// ── CORS ─────────────────────────────────────────────────────────────────────
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ── Run agent and build AgentRunCapture (same logic as run-evals.ts) ─────────
async function runAgent(query: string): Promise<{ capture: AgentRunCapture; stream: string[] }> {
  const agent = await Agent.create({
    model: MODEL,
    maxIterations: 8,
    memoryEnabled: false,
  });

  const thinking: string[] = [];
  const toolCalls: ToolCallCapture[] = [];
  const pendingTools = new Map<string, { name: string; args: Record<string, unknown> }>();
  const streamChunks: string[] = [];
  let finalAnswer = '';
  let iterations = 0;

  for await (const event of agent.run(query)) {
    switch (event.type) {
      case 'thinking':
        if (event.message?.trim()) {
          thinking.push(event.message.trim());
          streamChunks.push(event.message.trim());
        }
        break;
      case 'tool_start':
        if (event.toolCallId) {
          pendingTools.set(event.toolCallId, {
            name: event.tool,
            args: event.args as Record<string, unknown>,
          });
        }
        break;
      case 'tool_end': {
        const pending = event.toolCallId ? pendingTools.get(event.toolCallId) : undefined;
        toolCalls.push({
          name: event.tool,
          args: pending?.args ?? (event.args as Record<string, unknown>) ?? {},
          result: typeof event.result === 'string' ? event.result : JSON.stringify(event.result),
          durationMs: event.duration ?? 0,
        });
        if (event.toolCallId) pendingTools.delete(event.toolCallId);
        break;
      }
      case 'tool_error':
        toolCalls.push({
          name: event.tool,
          args: event.toolCallId ? pendingTools.get(event.toolCallId)?.args ?? {} : {},
          result: `ERROR: ${event.error}`,
          durationMs: 0,
        });
        if (event.toolCallId) pendingTools.delete(event.toolCallId);
        break;
      case 'done':
        finalAnswer = event.answer ?? '';
        iterations = event.iterations ?? 0;
        break;
    }
  }

  const capture: AgentRunCapture = { question: query, finalAnswer, thinking, toolCalls, iterations };
  return { capture, stream: streamChunks };
}

// ── Evaluate one row ─────────────────────────────────────────────────────────
async function runEval(
  evalName: string,
  row: DatasetRow,
  capture: AgentRunCapture,
): Promise<{ score: number; label: string; explanation: string }> {
  let result;
  switch (evalName) {
    case 'factual_accuracy':
      result = evaluateFactualAccuracy(row, capture);
      break;
    case 'groundedness':
      result = await evaluateGroundedness(row, capture);
      break;
    case 'tool_correctness':
      result = evaluateToolCorrectness(row, capture);
      break;
    case 'refusal':
      result = await evaluateRefusal(row, capture);
      break;
    case 'plan_quality':
      result = await evaluatePlanQuality(row, capture);
      break;
    default:
      return { score: 0, label: 'error', explanation: `unknown eval: ${evalName}` };
  }
  // null means "not applicable" (e.g. factualAccuracy for traps, refusal for non-traps)
  if (!result) return { score: 1, label: 'skipped', explanation: 'not applicable for this row type' };
  return { score: result.score, label: result.label, explanation: result.explanation };
}

// ── Build DatasetRow from request data ────────────────────────────────────────
function buildDatasetRow(query: string, context: string, rowData?: Record<string, string>): DatasetRow {
  let gt: DatasetRow['ground_truth'];
  try { gt = JSON.parse(context); } catch { gt = { answer: context }; }

  const isTrap = gt.answer?.startsWith('조회 불가');

  // Use rowData fields if available (sent by IQHub with full dataset row)
  const level = (rowData?.level as DatasetRow['level']) ?? (isTrap ? 'trap' : 'easy');
  const requiredTool = rowData?.required_tool;

  return {
    id: rowData?.id ?? '',
    level,
    category: rowData?.category ?? '',
    question: query,
    ground_truth: gt,
    required_tool: requiredTool === 'null' || !requiredTool ? null : requiredTool,
    expected_ticker: rowData?.expected_ticker || undefined,
  };
}

// ── Server ───────────────────────────────────────────────────────────────────
const server = Bun.serve({
  port: PORT,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // ── Health ──
    if (url.pathname === '/health') {
      return Response.json(
        { status: 'ok', model: MODEL, cached: captureCache.size },
        { headers: corsHeaders },
      );
    }

    // ── POST /chat — Generate (SSE stream + cache capture) ──
    if (req.method === 'POST' && url.pathname === '/chat') {
      const { messages } = await req.json() as {
        messages: { role: string; content: string }[];
      };
      const query = messages.at(-1)?.content ?? '';
      if (!query) return Response.json({ error: 'empty query' }, { status: 400, headers: corsHeaders });

      return new Response(
        new ReadableStream({
          async start(controller) {
            const enc = new TextEncoder();
            const send = (obj: unknown) =>
              controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));

            try {
              const { capture } = await runAgent(query);
              // Cache for later evaluation
              captureCache.set(query.trim(), capture);
              console.error(`[chat] cached capture for: ${query.slice(0, 50)}... (${captureCache.size} total)`);

              send({
                event: 'messages/partial',
                data: [{ type: 'ai', content: capture.finalAnswer }],
              });
              send('[DONE]');
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              send({
                event: 'messages/partial',
                data: [{ type: 'ai', content: `Error: ${msg}` }],
              });
              send('[DONE]');
            }
            controller.close();
          },
        }),
        {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            ...corsHeaders,
          },
        },
      );
    }

    // ── POST /evaluate — Run original evaluator on cached capture ──
    if (req.method === 'POST' && url.pathname === '/evaluate') {
      const { evalName, query, response, context, rowData } = await req.json() as {
        evalName: string;
        query: string;
        response: string;
        context: string;
        rowData?: Record<string, string>;
      };

      // Look up cached capture
      let capture = captureCache.get(query.trim());
      if (!capture) {
        // Fallback: build minimal capture from response only
        capture = {
          question: query,
          finalAnswer: response,
          thinking: [],
          toolCalls: [],
          iterations: 0,
        };
      }
      // Override finalAnswer with what IQHub stored (in case of mismatch)
      capture = { ...capture, finalAnswer: response };

      const row = buildDatasetRow(query, context, rowData);
      try {
        const result = await runEval(evalName, row, capture);
        console.error(`[eval] ${evalName} → ${result.label} (${result.score})`);
        return Response.json(result, { headers: corsHeaders });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return Response.json(
          { score: 0, label: 'error', explanation: msg },
          { status: 500, headers: corsHeaders },
        );
      }
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders });
  },
});

console.log(`[dexter-serve] listening on http://localhost:${server.port}`);
console.log(`[dexter-serve] model=${MODEL}`);
console.log(`[dexter-serve] POST /chat     → SSE stream + capture cache`);
console.log(`[dexter-serve] POST /evaluate → run original evaluators`);
console.log(`[dexter-serve] GET  /health   → status check`);

process.on('SIGINT', async () => {
  console.log('\n[dexter-serve] shutting down...');
  await flushTelemetry();
  process.exit(0);
});
