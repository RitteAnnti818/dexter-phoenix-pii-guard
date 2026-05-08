#!/usr/bin/env bun
/**
 * Run hallucination_50q.json through Dexter and apply the 5 evaluators.
 *
 * Usage:
 *   bun run scripts/run-evals.ts                  # all 50 questions
 *   bun run scripts/run-evals.ts --limit 5        # first 5 only (smoke test)
 *   bun run scripts/run-evals.ts --ids Q001,Q045  # specific rows
 *   bun run scripts/run-evals.ts --level trap     # one level
 *
 * Writes a JSONL report to .dexter/evals/<timestamp>.jsonl and prints
 * an aggregate summary. Each query also emits an OpenInference trace to
 * Phoenix (project: dexter), so per-row scores can be cross-referenced
 * with the original AGENT spans.
 */
import 'dotenv/config';

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
import {
  JUDGE_PROMPT_VERSION,
  resolvedJudgeModel,
} from '../src/observability/evaluators/prompts.js';
import {
  buildAnnotations,
  postSpanAnnotations,
} from '../src/observability/phoenixClient.js';
import type {
  AgentRunCapture,
  DatasetRow,
  EvalResult,
  ToolCallCapture,
} from '../src/observability/evaluators/types.js';

const DATASET_PATH = 'src/observability/datasets/hallucination_50q.json';

interface CliArgs {
  limit?: number;
  ids?: string[];
  level?: DatasetRow['level'];
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--limit') out.limit = Number.parseInt(argv[++i] ?? '', 10);
    else if (arg === '--ids') out.ids = (argv[++i] ?? '').split(',').filter(Boolean);
    else if (arg === '--level') out.level = argv[++i] as DatasetRow['level'];
  }
  return out;
}

function selectRows(all: DatasetRow[], args: CliArgs): DatasetRow[] {
  let rows = all;
  if (args.ids && args.ids.length > 0) {
    const set = new Set(args.ids);
    rows = rows.filter((r) => set.has(r.id));
  }
  if (args.level) rows = rows.filter((r) => r.level === args.level);
  if (args.limit && Number.isFinite(args.limit)) rows = rows.slice(0, args.limit);
  return rows;
}

async function runOne(row: DatasetRow): Promise<AgentRunCapture> {
  const agent = await Agent.create({
    model: process.env.DEXTER_EVAL_MODEL ?? 'gpt-4o-mini',
    maxIterations: 8,
    memoryEnabled: false,
  });

  const thinking: string[] = [];
  const toolCalls: ToolCallCapture[] = [];
  const pendingTools = new Map<string, { name: string; args: Record<string, unknown> }>();
  let finalAnswer = '';
  let iterations = 0;
  let agentSpanId: string | undefined;
  let traceId: string | undefined;

  for await (const event of agent.run(row.question)) {
    switch (event.type) {
      case 'thinking':
        if (event.message?.trim()) thinking.push(event.message.trim());
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
        agentSpanId = event.agentSpanId;
        traceId = event.traceId;
        break;
    }
  }

  return {
    question: row.question,
    finalAnswer,
    thinking,
    toolCalls,
    iterations,
    agentSpanId,
    traceId,
  };
}

interface RowReport {
  id: string;
  level: DatasetRow['level'];
  category: string;
  question: string;
  /** Wall-clock seconds for the agent run (excludes evaluator latency). */
  agentLatencySec: number;
  /** Prompt variant used by the agent — for A/B labeling in compare-evals. */
  promptVariant: string;
  /** Judge model that scored this row — A/B runs must match. */
  judgeModel: string;
  /** Judge prompt rubric version — bumps when prompts.ts changes. */
  judgePromptVersion: string;
  agent: AgentRunCapture;
  evaluations: {
    factualAccuracy: EvalResult | null;
    groundedness: EvalResult;
    toolCorrectness: EvalResult;
    refusal: EvalResult | null;
    planQuality: EvalResult;
  };
}

async function evaluateOne(row: DatasetRow, run: AgentRunCapture): Promise<RowReport['evaluations']> {
  // Run the deterministic evaluators in parallel with the LLM ones for speed.
  const [groundedness, refusal, planQuality] = await Promise.all([
    evaluateGroundedness(row, run),
    evaluateRefusal(row, run),
    evaluatePlanQuality(row, run),
  ]);
  return {
    factualAccuracy: evaluateFactualAccuracy(row, run),
    groundedness,
    toolCorrectness: evaluateToolCorrectness(row, run),
    refusal,
    planQuality,
  };
}

function summarize(reports: RowReport[]) {
  const buckets = { factualAccuracy: [] as number[], groundedness: [] as number[],
    toolCorrectness: [] as number[], refusal: [] as number[], planQuality: [] as number[] };
  for (const r of reports) {
    if (r.evaluations.factualAccuracy) buckets.factualAccuracy.push(r.evaluations.factualAccuracy.score);
    buckets.groundedness.push(r.evaluations.groundedness.score);
    buckets.toolCorrectness.push(r.evaluations.toolCorrectness.score);
    if (r.evaluations.refusal) buckets.refusal.push(r.evaluations.refusal.score);
    buckets.planQuality.push(r.evaluations.planQuality.score);
  }
  const mean = (xs: number[]) => xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
  return {
    factualAccuracy: { n: buckets.factualAccuracy.length, mean: mean(buckets.factualAccuracy) },
    groundedness: { n: buckets.groundedness.length, mean: mean(buckets.groundedness) },
    toolCorrectness: { n: buckets.toolCorrectness.length, mean: mean(buckets.toolCorrectness) },
    refusal: { n: buckets.refusal.length, mean: mean(buckets.refusal) },
    planQuality: { n: buckets.planQuality.length, mean: mean(buckets.planQuality) },
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const all = JSON.parse(await Bun.file(DATASET_PATH).text()) as DatasetRow[];
  const rows = selectRows(all, args);
  console.error(`[evals] running ${rows.length}/${all.length} questions...`);
  console.error(
    `[evals] judge=${resolvedJudgeModel()} prompts=${JUDGE_PROMPT_VERSION} ` +
    `agentVariant=${process.env.DEXTER_PROMPT_VARIANT ?? 'baseline'}`,
  );

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = '.dexter/evals';
  await Bun.$`mkdir -p ${outDir}`.quiet();
  const outPath = `${outDir}/${stamp}.jsonl`;
  const writer = Bun.file(outPath).writer();

  const reports: RowReport[] = [];
  const pendingAnnotations: ReturnType<typeof buildAnnotations> = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    process.stderr.write(`[${i + 1}/${rows.length}] ${row.id} (${row.level}) — running... `);
    const t0 = Date.now();
    try {
      const run = await runOne(row);
      const agentLatencySec = (Date.now() - t0) / 1000;
      const evaluations = await evaluateOne(row, run);
      const report: RowReport = {
        id: row.id,
        level: row.level,
        category: row.category,
        question: row.question,
        agentLatencySec,
        promptVariant: process.env.DEXTER_PROMPT_VARIANT ?? 'baseline',
        judgeModel: resolvedJudgeModel(),
        judgePromptVersion: JUDGE_PROMPT_VERSION,
        agent: run,
        evaluations,
      };
      reports.push(report);
      writer.write(`${JSON.stringify(report)}\n`);
      // Stash annotations for a post-flush batch POST. Skip if the agent
      // run produced no AGENT span (telemetry disabled, error before span
      // start, etc.) — Phoenix rejects annotations without a span_id.
      if (run.agentSpanId) {
        pendingAnnotations.push(
          ...buildAnnotations(run.agentSpanId, {
            factual_accuracy: evaluations.factualAccuracy,
            groundedness: evaluations.groundedness,
            tool_call_correctness: evaluations.toolCorrectness,
            refusal_appropriateness: evaluations.refusal,
            plan_quality: evaluations.planQuality,
          }),
        );
      }
      const fa = evaluations.factualAccuracy?.score;
      const gd = evaluations.groundedness.score;
      const tc = evaluations.toolCorrectness.score;
      const rf = evaluations.refusal?.score;
      const pq = evaluations.planQuality.score;
      const cells = [
        fa === undefined ? '  -' : fa.toFixed(2),
        gd.toFixed(2),
        tc.toFixed(2),
        rf === undefined ? '  -' : rf.toFixed(2),
        pq.toFixed(2),
      ].join(' ');
      process.stderr.write(`${cells}  (${((Date.now() - t0) / 1000).toFixed(1)}s)\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`FAILED: ${msg}\n`);
      writer.write(`${JSON.stringify({ id: row.id, error: msg })}\n`);
    }
  }
  writer.end();

  const summary = summarize(reports);
  console.error('\n[evals] summary (mean score per evaluator):');
  for (const [k, v] of Object.entries(summary)) {
    console.error(`  ${k.padEnd(20)} n=${String(v.n).padStart(2)}  mean=${v.mean.toFixed(3)}`);
  }
  console.error(`\n[evals] wrote ${reports.length} rows → ${outPath}`);

  // Flush spans BEFORE posting annotations — Phoenix rejects span_ids it
  // hasn't ingested yet. flushTelemetry() shuts down the SDK so the OTLP
  // batch goes out synchronously.
  await flushTelemetry();

  if (process.env.PHOENIX_DISABLE_ANNOTATIONS === '1') {
    console.error('[evals] PHOENIX_DISABLE_ANNOTATIONS=1 → skipping annotation POST');
  } else if (pendingAnnotations.length === 0) {
    console.error('[evals] no annotations to post (no agent span IDs captured)');
  } else {
    try {
      await postSpanAnnotations(pendingAnnotations);
      console.error(
        `[evals] posted ${pendingAnnotations.length} annotations to Phoenix ` +
        `(${reports.filter((r) => r.agent.agentSpanId).length} traces)`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[evals] WARNING: annotation POST failed — ${msg}`);
      console.error('[evals] scores still saved to JSONL; Phoenix UI will not show them');
    }
  }
}

main().catch((err) => {
  console.error('[evals] fatal:', err);
  process.exit(1);
});
