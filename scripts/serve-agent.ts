#!/usr/bin/env bun
/**
 * HTTP wrapper around Dexter Agent for IQHub + My-Own-Phenix integration.
 *
 * Endpoints:
 *   POST /chat              — IQHub REST agent protocol (SSE stream)
 *   POST /evaluate          — Run original evaluators on cached AgentRunCapture
 *   POST /pii-guard         — Run 3-stage PII guard (input or output)
 *   GET  /pii-guard/dataset — Sample PII dataset (100 samples)
 *   GET  /evals/dataset     — Hallucination eval dataset (50 questions)
 *   POST /evals/run-row     — Run agent + all evaluators on a single dataset row
 *   GET  /health            — Status check
 *
 * Usage:
 *   bun run scripts/serve-agent.ts
 *   DEXTER_MODEL=gpt-4.1-nano bun run scripts/serve-agent.ts
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

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
import {
  guardInput,
  guardOutput,
  type PiiGuardDirection,
} from '../src/observability/guards/piiGuard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATASETS_DIR = resolve(__dirname, '..', 'src', 'observability', 'datasets');
const EVAL_RUNS_DIR = resolve(__dirname, '..', '.dexter', 'evals');
const PII_RUNS_DIR = resolve(__dirname, '..', '.dexter', 'pii-evals');

// Whitelist of PII dataset variants the UI may request via /pii-guard/dataset?source=…
const PII_DATASET_SOURCES: Record<string, string[]> = {
  baseline: ['pii_100samples.json'],
  finance: ['pii_finance_170samples.json'],
  hardcase: ['pii_stage2_hardcases.json'],
  all: ['pii_100samples.json', 'pii_stage2_hardcases.json', 'pii_finance_170samples.json'],
};

async function loadJsonDataset<T>(filename: string): Promise<T> {
  const raw = await readFile(resolve(DATASETS_DIR, filename), 'utf-8');
  return JSON.parse(raw) as T;
}

async function loadPiiDataset(source: string): Promise<unknown[]> {
  const files = PII_DATASET_SOURCES[source] ?? PII_DATASET_SOURCES.baseline;
  const out: unknown[] = [];
  for (const f of files) {
    const rows = await loadJsonDataset<unknown[]>(f);
    if (Array.isArray(rows)) out.push(...rows);
  }
  return out;
}

function isSafeRunFilename(name: string): boolean {
  return /^[A-Za-z0-9._-]+\.jsonl$/.test(name);
}

async function listRunFiles(dir: string): Promise<
  { filename: string; size: number; mtime: string }[]
> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const files = await Promise.all(
    entries
      .filter((n) => n.endsWith('.jsonl') && isSafeRunFilename(n))
      .map(async (name) => {
        const s = await stat(resolve(dir, name));
        return { filename: name, size: s.size, mtime: s.mtime.toISOString() };
      }),
  );
  return files.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
}

async function readRunRows(
  dir: string,
  filename: string,
  limit: number,
): Promise<{ rows: unknown[]; total: number; truncated: boolean }> {
  if (!isSafeRunFilename(filename)) throw new Error(`unsafe filename: ${filename}`);
  const raw = await readFile(resolve(dir, filename), 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  const total = lines.length;
  const slice = lines.slice(0, limit);
  const rows: unknown[] = [];
  for (const line of slice) {
    try {
      rows.push(JSON.parse(line));
    } catch {
      // skip malformed line
    }
  }
  return { rows, total, truncated: total > slice.length };
}

const PORT = Number(process.env.PORT ?? 2024);
const MODEL = process.env.DEXTER_MODEL ?? process.env.DEXTER_EVAL_MODEL ?? 'gpt-4o-mini';
const PHOENIX_URL = process.env.PHOENIX_COLLECTOR_ENDPOINT?.replace('/v1/traces', '') ?? 'http://localhost:6006';

// ── AgentRunCapture cache (keyed by query text, TTL 30min) ───────────────────
const captureCache = new Map<string, { capture: AgentRunCapture; ts: number }>();
const CACHE_TTL_MS = 30 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of captureCache) {
    if (now - v.ts > CACHE_TTL_MS) captureCache.delete(k);
  }
}, 60_000);

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
              captureCache.set(query.trim(), { capture, ts: Date.now() });
              console.error(`[chat] cached capture for: ${query.slice(0, 50)}... (${captureCache.size} total)`);

              send({
                event: 'messages/partial',
                data: [{ type: 'ai', content: capture.finalAnswer }],
              });
              // Send capture data for DB persistence
              send({ event: 'capture', data: capture });
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
      const { evalName, query, response, context, rowData, capture: reqCapture } = await req.json() as {
        evalName: string;
        query: string;
        response: string;
        context: string;
        rowData?: Record<string, string>;
        capture?: AgentRunCapture;
      };

      // Priority: request capture (from DB) > memory cache > minimal fallback
      let capture: AgentRunCapture = reqCapture
        ?? captureCache.get(query.trim())?.capture
        ?? {
          question: query,
          finalAnswer: response,
          thinking: [],
          toolCalls: [],
          iterations: 0,
        };
      // Override finalAnswer with what IQHub stored
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

    // ── POST /pii-guard — 3-stage PII guard ──
    if (req.method === 'POST' && url.pathname === '/pii-guard') {
      try {
        const body = await req.json() as {
          text: string;
          direction?: PiiGuardDirection;
          stage2?: 'auto' | 'force' | 'skip';
        };
        if (typeof body.text !== 'string') {
          return Response.json({ error: 'text must be a string' }, { status: 400, headers: corsHeaders });
        }
        const guard = body.direction === 'output' ? guardOutput : guardInput;
        const result = await guard(body.text, {
          surface: 'eval',
          stage2: body.stage2 ?? 'auto',
        });
        return Response.json(result, { headers: corsHeaders });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return Response.json({ error: msg }, { status: 500, headers: corsHeaders });
      }
    }

    // ── GET /pii-guard/dataset?source=baseline|finance|hardcase|all ──
    // Default = baseline (pii_100samples.json). The UI uses this to populate
    // the sample picker and switch between datasets without redeploying.
    if (req.method === 'GET' && url.pathname === '/pii-guard/dataset') {
      const source = url.searchParams.get('source') ?? 'baseline';
      if (!PII_DATASET_SOURCES[source]) {
        return Response.json(
          { error: `unknown source "${source}"`, allowed: Object.keys(PII_DATASET_SOURCES) },
          { status: 400, headers: corsHeaders },
        );
      }
      try {
        const data = await loadPiiDataset(source);
        return Response.json(data, { headers: corsHeaders });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return Response.json({ error: msg }, { status: 500, headers: corsHeaders });
      }
    }

    // ── GET /pii-guard/runs — list .dexter/pii-evals/*.jsonl ──
    if (req.method === 'GET' && url.pathname === '/pii-guard/runs') {
      try {
        const files = await listRunFiles(PII_RUNS_DIR);
        return Response.json({ files }, { headers: corsHeaders });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return Response.json({ error: msg }, { status: 500, headers: corsHeaders });
      }
    }

    // ── GET /pii-guard/runs/:filename — parsed rows from a specific jsonl ──
    if (req.method === 'GET' && url.pathname.startsWith('/pii-guard/runs/')) {
      const filename = decodeURIComponent(url.pathname.slice('/pii-guard/runs/'.length));
      const limitParam = url.searchParams.get('limit');
      const limit = Math.max(1, Math.min(2000, Number(limitParam) || 500));
      try {
        const data = await readRunRows(PII_RUNS_DIR, filename, limit);
        return Response.json({ filename, ...data }, { headers: corsHeaders });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return Response.json({ error: msg }, { status: 500, headers: corsHeaders });
      }
    }

    // ── GET /evals/dataset — hallucination eval dataset ──
    if (req.method === 'GET' && url.pathname === '/evals/dataset') {
      try {
        const data = await loadJsonDataset('hallucination_50q.json');
        return Response.json(data, { headers: corsHeaders });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return Response.json({ error: msg }, { status: 500, headers: corsHeaders });
      }
    }

    // ── POST /evals/run-row — run agent + all 5 evaluators on a single row ──
    if (req.method === 'POST' && url.pathname === '/evals/run-row') {
      try {
        const { row } = await req.json() as { row: DatasetRow };
        if (!row?.question) {
          return Response.json({ error: 'row.question is required' }, { status: 400, headers: corsHeaders });
        }

        const { capture } = await runAgent(row.question);
        captureCache.set(row.question.trim(), { capture, ts: Date.now() });

        const evalNames = ['factual_accuracy', 'groundedness', 'tool_correctness', 'refusal', 'plan_quality'] as const;
        const evals: Record<string, { score: number; label: string; explanation: string }> = {};
        for (const name of evalNames) {
          evals[name] = await runEval(name, row, capture);
        }

        return Response.json({ capture, evals }, { headers: corsHeaders });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return Response.json({ error: msg }, { status: 500, headers: corsHeaders });
      }
    }

    // ── GET /evals/runs — list .dexter/evals/*.jsonl ──
    if (req.method === 'GET' && url.pathname === '/evals/runs') {
      try {
        const files = await listRunFiles(EVAL_RUNS_DIR);
        return Response.json({ files }, { headers: corsHeaders });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return Response.json({ error: msg }, { status: 500, headers: corsHeaders });
      }
    }

    // ── GET /evals/runs/:filename — parsed rows from a specific jsonl ──
    if (req.method === 'GET' && url.pathname.startsWith('/evals/runs/')) {
      const filename = decodeURIComponent(url.pathname.slice('/evals/runs/'.length));
      const limitParam = url.searchParams.get('limit');
      const limit = Math.max(1, Math.min(2000, Number(limitParam) || 200));
      try {
        const data = await readRunRows(EVAL_RUNS_DIR, filename, limit);
        return Response.json({ filename, ...data }, { headers: corsHeaders });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return Response.json({ error: msg }, { status: 500, headers: corsHeaders });
      }
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders });
  },
});

console.log(`[dexter-serve] listening on http://localhost:${server.port}`);
console.log(`[dexter-serve] model=${MODEL}`);
console.log(`[dexter-serve] POST /chat              → SSE stream + capture cache`);
console.log(`[dexter-serve] POST /evaluate          → run original evaluators`);
console.log(`[dexter-serve] POST /pii-guard         → 3-stage PII guard`);
console.log(`[dexter-serve] GET  /pii-guard/dataset → sample PII rows (?source=baseline|finance|hardcase|all)`);
console.log(`[dexter-serve] GET  /pii-guard/runs    → list .dexter/pii-evals jsonl runs`);
console.log(`[dexter-serve] GET  /pii-guard/runs/:f → parse rows from a run`);
console.log(`[dexter-serve] GET  /evals/dataset     → hallucination dataset`);
console.log(`[dexter-serve] POST /evals/run-row     → agent + 5 evaluators`);
console.log(`[dexter-serve] GET  /evals/runs        → list .dexter/evals jsonl runs`);
console.log(`[dexter-serve] GET  /evals/runs/:f     → parse rows from a run`);
console.log(`[dexter-serve] GET  /health            → status check`);

process.on('SIGINT', async () => {
  console.log('\n[dexter-serve] shutting down...');
  await flushTelemetry();
  process.exit(0);
});
