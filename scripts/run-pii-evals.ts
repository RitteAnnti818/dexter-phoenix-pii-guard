#!/usr/bin/env bun
/**
 * Run pii_100samples.json through the 3-stage PII Guard pipeline and emit
 * OpenInference spans to Phoenix for each evaluated row.
 *
 * Usage:
 *   bun run scripts/run-pii-evals.ts                  # all 100 rows
 *   bun run scripts/run-pii-evals.ts --limit 10       # first 10
 *   bun run scripts/run-pii-evals.ts --ids P066,P081  # specific rows
 *   bun run scripts/run-pii-evals.ts --category obfuscated
 *   bun run scripts/run-pii-evals.ts --stage2-hard    # Stage 2-only hardcases
 *   bun run scripts/run-pii-evals.ts --finance        # finance benchmark rows
 *   bun run scripts/run-pii-evals.ts --all-pii        # base + hardcase + finance
 *
 * Writes JSONL report to .dexter/pii-evals/<timestamp>.jsonl.
 * Each row emits a Phoenix trace (project: dexter) tagged with category,
 * obfuscation pattern, P/R outcome, latency. Use Phoenix UI filters to slice.
 */
import 'dotenv/config';

import { initTelemetry, getTracer, flushTelemetry } from '../src/observability/telemetry.js';
initTelemetry();

import {
  OpenInferenceSpanKind,
  SemanticConventions,
  MimeType,
} from '@arizeai/openinference-semantic-conventions';
import type { PIIDetection, PIIType } from '../src/observability/guards/regexGuard.js';
import { checkOutput } from '../src/observability/guards/outputGuard.js';
import { guardInput } from '../src/observability/guards/piiGuard.js';

const DEFAULT_DATASET_PATH = 'src/observability/datasets/pii_100samples.json';
const STAGE2_HARD_DATASET_PATH = 'src/observability/datasets/pii_stage2_hardcases.json';
const FINANCE_DATASET_PATH = 'src/observability/datasets/pii_finance_170samples.json';
const ALL_PII_DATASET_PATHS = [
  DEFAULT_DATASET_PATH,
  STAGE2_HARD_DATASET_PATH,
  FINANCE_DATASET_PATH,
];
const ATTR_MAX_LEN = 4000;
const truncate = (s: string, n = ATTR_MAX_LEN) => (s.length > n ? `${s.slice(0, n)}...` : s);

interface Row {
  id: string;
  category: 'clean' | 'direct' | 'obfuscated' | 'cross_session' | 'prompt_injection';
  input: string;
  contains_pii: boolean;
  pii_types: string[];
  expected_masked: string;
  obfuscation_pattern?: string;
  requires_stage?: 1 | 2;
  trap_note?: string;
  cross_session_pii_expected?: boolean;
  memory_seed?: string;
  expected_response_blocks_pii?: boolean;
  injection_type?: string;
  stage2_only?: boolean;
  vertical?: string;
  sensitivity_class?: string;
  source_basis?: string;
  language?: string;
}

interface CliArgs {
  limit?: number;
  ids?: string[];
  category?: Row['category'];
  dataset?: string;
  datasets?: string[];
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') out.limit = Number.parseInt(argv[++i] ?? '', 10);
    else if (a === '--ids') out.ids = (argv[++i] ?? '').split(',').filter(Boolean);
    else if (a === '--category') out.category = argv[++i] as Row['category'];
    else if (a === '--dataset') {
      out.dataset = argv[++i];
      out.datasets = undefined;
    }
    else if (a === '--stage2-hard') {
      out.dataset = STAGE2_HARD_DATASET_PATH;
      out.datasets = undefined;
    }
    else if (a === '--finance') {
      out.dataset = undefined;
      out.datasets = [FINANCE_DATASET_PATH];
    }
    else if (a === '--all-pii') {
      out.dataset = undefined;
      out.datasets = ALL_PII_DATASET_PATHS;
    }
  }
  return out;
}

function selectRows(all: Row[], args: CliArgs): Row[] {
  let rows = all;
  if (args.ids?.length) {
    const set = new Set(args.ids);
    rows = rows.filter((r) => set.has(r.id));
  }
  if (args.category) rows = rows.filter((r) => r.category === args.category);
  if (args.limit && Number.isFinite(args.limit)) rows = rows.slice(0, args.limit);
  return rows;
}

type Outcome = 'TP' | 'FP' | 'FN' | 'TN' | 'PARTIAL';

interface RowReport {
  id: string;
  category: Row['category'];
  obfuscation_pattern?: string;
  requires_stage?: 1 | 2;
  injection_type?: string;
  stage2_only?: boolean;
  vertical?: string;
  sensitivity_class?: string;
  language?: string;
  input: string;
  expected_masked: string;
  actual_masked: string;
  expected_types: string[];
  detections: {
    stage1: { type: PIIType; match: string; confidence: number }[];
    deterministic: { type: PIIType; match: string; confidence: number }[];
    stage2: { type: PIIType; match: string; confidence: number }[];
    combined: { type: PIIType; match: string; confidence: number }[];
  };
  guard: {
    action: string;
    stage2_used: boolean;
    stage2_timed_out: boolean;
    risk_reasons: string[];
  };
  outcome: Outcome;
  latency_ms: number;
  output_guard?: {
    simulated_output: string;
    blocked: boolean;
    leaked_tokens: string[];
    leaked_fingerprints: string[];
    expected_blocked: boolean;
    outcome: Outcome;
  };
}

function classifyOutcome(row: Row, detected: boolean, maskCorrect: boolean): Outcome {
  if (row.contains_pii && detected && maskCorrect) return 'TP';
  if (row.contains_pii && detected && !maskCorrect) return 'PARTIAL';
  if (row.contains_pii && !detected) return 'FN';
  if (!row.contains_pii && detected) return 'FP';
  return 'TN';
}

function detectionSummary(d: PIIDetection): { type: PIIType; match: string; confidence: number } {
  return { type: d.type, match: `[REDACTED_${d.type.toUpperCase()}]`, confidence: d.confidence };
}

// memory_seed format: "사용자 <type>: <value>[, ...]" → return just values
function extractMemoryTokens(memorySeed: string): string[] {
  return memorySeed
    .split(',')
    .map((part) => {
      const idx = part.indexOf(':');
      return idx === -1 ? '' : part.slice(idx + 1).trim();
    })
    .filter(Boolean);
}

async function evaluateRow(row: Row, tracer: ReturnType<typeof getTracer>): Promise<RowReport> {
  const guardResult = await guardInput(row.input, { surface: 'eval', direction: 'input' });
  const actualMasked = guardResult.maskedText;
  const stage1 = guardResult.stageDetections.stage1;
  const deterministic = guardResult.stageDetections.deterministic;
  const stage2 = guardResult.stageDetections.stage2;
  const combined = guardResult.detections;
  const latencyMs = guardResult.stageStats.latencyMs;

  const span = tracer.startSpan('pii_guard.evaluate', {
    attributes: {
      [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.CHAIN,
      [SemanticConventions.INPUT_VALUE]: truncate(actualMasked),
      [SemanticConventions.INPUT_MIME_TYPE]: MimeType.TEXT,
      'pii.dataset.id': row.id,
      'pii.dataset.category': row.category,
      'pii.dataset.contains_pii': row.contains_pii,
      'pii.expected_types': row.pii_types.join(','),
      ...(row.obfuscation_pattern && { 'pii.obfuscation_pattern': row.obfuscation_pattern }),
      ...(row.requires_stage && { 'pii.requires_stage': row.requires_stage }),
      ...(row.injection_type && { 'pii.injection_type': row.injection_type }),
      ...(row.vertical && { 'pii.finance.vertical': row.vertical }),
      ...(row.sensitivity_class && { 'pii.sensitivity_class': row.sensitivity_class }),
      ...(row.language && { 'pii.dataset.language': row.language }),
    },
  });

  const detected = combined.length > 0;
  const maskCorrect = actualMasked === row.expected_masked;
  const outcome = classifyOutcome(row, detected, maskCorrect);

  span.setAttribute(SemanticConventions.OUTPUT_VALUE, truncate(actualMasked));
  span.setAttribute(SemanticConventions.OUTPUT_MIME_TYPE, MimeType.TEXT);
  span.setAttribute('pii.stage1.count', stage1.length);
  span.setAttribute('pii.deterministic.count', deterministic.length);
  span.setAttribute('pii.stage2.count', stage2.length);
  span.setAttribute('pii.stage2.used', guardResult.stageStats.stage2Used);
  span.setAttribute('pii.stage2.timed_out', guardResult.stageStats.stage2TimedOut);
  span.setAttribute('pii.combined.count', combined.length);
  span.setAttribute('pii.combined.types', combined.map((d) => d.type).join(','));
  span.setAttribute('pii.decision', guardResult.action);
  span.setAttribute('pii.outcome', outcome);
  span.setAttribute('pii.mask_correct', maskCorrect);
  span.setAttribute('pii.latency_ms', latencyMs);

  const report: RowReport = {
    id: row.id,
    category: row.category,
    obfuscation_pattern: row.obfuscation_pattern,
    requires_stage: row.requires_stage,
    injection_type: row.injection_type,
    stage2_only: row.stage2_only,
    vertical: row.vertical,
    sensitivity_class: row.sensitivity_class,
    language: row.language,
    input: actualMasked,
    expected_masked: row.expected_masked,
    actual_masked: actualMasked,
    expected_types: row.pii_types,
    detections: {
      stage1: [...stage1, ...deterministic].map(detectionSummary),
      deterministic: deterministic.map(detectionSummary),
      stage2: stage2.map(detectionSummary),
      combined: combined.map(detectionSummary),
    },
    guard: {
      action: guardResult.action,
      stage2_used: guardResult.stageStats.stage2Used,
      stage2_timed_out: guardResult.stageStats.stage2TimedOut,
      risk_reasons: guardResult.riskReasons,
    },
    outcome,
    latency_ms: latencyMs,
  };

  // For cross_session and prompt_injection rows, simulate a hypothetical
  // agent leak (where the agent puts memory PII tokens directly into its
  // response) and verify Output Guard blocks it.
  if (row.memory_seed && row.expected_response_blocks_pii) {
    const tokens = extractMemoryTokens(row.memory_seed);
    const simulatedOutput = `요청을 처리했습니다. 등록된 정보: ${tokens.join(', ')}`;
    const guardResult = await checkOutput(simulatedOutput, { memorySeed: row.memory_seed });
    const guardOutcome: Outcome = guardResult.blocked ? 'TP' : 'FN';

    span.setAttribute('pii.output_guard.tested', true);
    span.setAttribute('pii.output_guard.blocked', guardResult.blocked);
    span.setAttribute('pii.output_guard.leaked_count', guardResult.leakedTokens.length);
    span.setAttribute('pii.output_guard.outcome', guardOutcome);

    report.output_guard = {
      simulated_output: guardResult.maskedOutput,
      blocked: guardResult.blocked,
      leaked_tokens: guardResult.leakedTokens,
      leaked_fingerprints: guardResult.leakedFingerprints,
      expected_blocked: true,
      outcome: guardOutcome,
    };
  }

  span.end();
  return report;
}

// Aggregate per dimension.
function summarize(reports: RowReport[]) {
  const counts = { TP: 0, FP: 0, FN: 0, TN: 0, PARTIAL: 0 };
  for (const r of reports) counts[r.outcome]++;

  const tp = counts.TP + counts.PARTIAL;
  const precision = tp + counts.FP === 0 ? 1 : tp / (tp + counts.FP);
  const recall = tp + counts.FN === 0 ? 1 : tp / (tp + counts.FN);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  const lats = reports.map((r) => r.latency_ms).sort((a, b) => a - b);
  const p50 = lats[Math.floor(lats.length * 0.5)] ?? 0;
  const p95 = lats[Math.floor(lats.length * 0.95)] ?? 0;
  const mean = lats.reduce((s, n) => s + n, 0) / (lats.length || 1);

  return { counts, precision, recall, f1, p50, p95, mean };
}

function categoryBreakdown(reports: RowReport[]) {
  const cats = ['clean', 'direct', 'obfuscated', 'cross_session', 'prompt_injection'] as const;
  return cats.map((cat) => {
    const subset = reports.filter((r) => r.category === cat);
    if (subset.length === 0) return { cat, n: 0 };
    const c = { TP: 0, FP: 0, FN: 0, TN: 0, PARTIAL: 0 };
    for (const r of subset) c[r.outcome]++;
    return { cat, n: subset.length, ...c };
  });
}

function obfuscationBreakdown(reports: RowReport[]) {
  const dynamicPatterns = [...new Set(reports.map((r) => r.obfuscation_pattern).filter(Boolean))] as string[];
  const patterns = dynamicPatterns.length > 0
    ? dynamicPatterns
    : ['korean_numerals', 'spaced', 'special_char_insertion', 'reversed', 'contextual_inference'];
  return patterns.map((p) => {
    const subset = reports.filter((r) => r.obfuscation_pattern === p);
    if (subset.length === 0) return { pattern: p, n: 0 };
    const tp = subset.filter((r) => r.outcome === 'TP').length;
    const partial = subset.filter((r) => r.outcome === 'PARTIAL').length;
    const fn = subset.filter((r) => r.outcome === 'FN').length;
    const stage = subset[0]?.requires_stage;
    return { pattern: p, n: subset.length, stage, tp, partial, fn };
  });
}

function outputGuardBreakdown(reports: RowReport[]) {
  const tested = reports.filter((r) => r.output_guard);
  if (tested.length === 0) return null;
  const blocked = tested.filter((r) => r.output_guard!.blocked).length;
  const leaked = tested.filter((r) => !r.output_guard!.blocked).length;
  return { n: tested.length, blocked, leaked };
}

function optionalFieldBreakdown(reports: RowReport[], field: 'vertical' | 'sensitivity_class') {
  const keys = [...new Set(reports.map((r) => r[field]).filter(Boolean))] as string[];
  return keys.sort().map((key) => {
    const subset = reports.filter((r) => r[field] === key);
    const c = { TP: 0, FP: 0, FN: 0, TN: 0, PARTIAL: 0 };
    for (const r of subset) c[r.outcome]++;
    return { key, n: subset.length, ...c };
  });
}

function expectedTypeBreakdown(reports: RowReport[]) {
  const types = [...new Set(reports.flatMap((r) => r.expected_types))].sort();
  return types.map((type) => {
    const subset = reports.filter((r) => r.expected_types.includes(type));
    const c = { TP: 0, FP: 0, FN: 0, TN: 0, PARTIAL: 0 };
    for (const r of subset) c[r.outcome]++;
    return { type, n: subset.length, ...c };
  });
}

function pad(n: number | string, w: number): string {
  return String(n).padStart(w);
}

async function main() {
  const args = parseArgs(process.argv);
  const datasetPaths = args.datasets ?? [args.dataset ?? DEFAULT_DATASET_PATH];
  const all = (
    await Promise.all(
      datasetPaths.map(async (path) => JSON.parse(await Bun.file(path).text()) as Row[]),
    )
  ).flat();
  const rows = selectRows(all, args);

  console.error(`[pii-evals] dataset=${datasetPaths.join(',')}`);
  console.error(`[pii-evals] running ${rows.length}/${all.length} rows...`);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = '.dexter/pii-evals';
  await Bun.$`mkdir -p ${outDir}`.quiet();
  const outPath = `${outDir}/${stamp}.jsonl`;
  const writer = Bun.file(outPath).writer();

  const tracer = getTracer();
  const reports: RowReport[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    process.stderr.write(`[${pad(i + 1, 3)}/${rows.length}] ${row.id} (${row.category})... `);
    try {
      const report = await evaluateRow(row, tracer);
      reports.push(report);
      writer.write(`${JSON.stringify(report)}\n`);
      const og = report.output_guard ? ` [OG=${report.output_guard.outcome}]` : '';
      process.stderr.write(`${report.outcome} (${report.latency_ms}ms)${og}\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`FAILED: ${msg}\n`);
      writer.write(`${JSON.stringify({ id: row.id, error: msg })}\n`);
    }
  }
  writer.end();

  // ---- Summary ----
  const s = summarize(reports);
  console.log('\n─── PII Guard Evaluation Summary ──────────────────────────────────');
  console.log(`Total rows: ${reports.length}`);
  console.log(`TP: ${s.counts.TP}  PARTIAL: ${s.counts.PARTIAL}  FN: ${s.counts.FN}  FP: ${s.counts.FP}  TN: ${s.counts.TN}`);
  console.log(`Precision: ${s.precision.toFixed(3)}  Recall: ${s.recall.toFixed(3)}  F1: ${s.f1.toFixed(3)}`);
  console.log(`Latency: mean=${s.mean.toFixed(0)}ms  p50=${s.p50}ms  p95=${s.p95}ms`);

  console.log('\nCategory         n   TP  PART  FN  FP  TN');
  for (const b of categoryBreakdown(reports)) {
    if (b.n === 0) continue;
    console.log(`${b.cat.padEnd(16)} ${pad(b.n, 2)}  ${pad(b.TP ?? 0, 2)}  ${pad(b.PARTIAL ?? 0, 4)}  ${pad(b.FN ?? 0, 2)}  ${pad(b.FP ?? 0, 2)}  ${pad(b.TN ?? 0, 2)}`);
  }

  const verticalBreakdown = optionalFieldBreakdown(reports, 'vertical');
  if (verticalBreakdown.length > 0) {
    console.log('\nFinance vertical       n   TP  PART  FN  FP  TN');
    for (const b of verticalBreakdown) {
      console.log(`${b.key.padEnd(22)} ${pad(b.n, 2)}  ${pad(b.TP, 2)}  ${pad(b.PARTIAL, 4)}  ${pad(b.FN, 2)}  ${pad(b.FP, 2)}  ${pad(b.TN, 2)}`);
    }
  }

  const typeBreakdown = expectedTypeBreakdown(reports);
  if (typeBreakdown.length > 0) {
    console.log('\nExpected PII type       n   TP  PART  FN');
    for (const b of typeBreakdown) {
      console.log(`${b.type.padEnd(22)} ${pad(b.n, 2)}  ${pad(b.TP, 2)}  ${pad(b.PARTIAL, 4)}  ${pad(b.FN, 2)}`);
    }
  }

  const obfRows = reports.filter((r) => r.category === 'obfuscated');
  if (obfRows.length > 0) {
    console.log('\nObfuscation pattern        n   stage   TP  PART  FN');
    for (const b of obfuscationBreakdown(reports)) {
      if (b.n === 0) continue;
      console.log(`${b.pattern.padEnd(26)} ${pad(b.n, 2)}  stage ${b.stage}  ${pad(b.tp ?? 0, 2)}  ${pad(b.partial ?? 0, 4)}  ${pad(b.fn ?? 0, 2)}`);
    }
  }

  const og = outputGuardBreakdown(reports);
  if (og) {
    console.log(`\nOutput Guard (simulated leak): tested=${og.n}, blocked=${og.blocked}, leaked=${og.leaked}`);
  }

  // Detection contribution
  const stage1Total = reports.reduce((sum, r) => sum + r.detections.stage1.length, 0);
  const stage2Total = reports.reduce((sum, r) => sum + r.detections.stage2.length, 0);
  const combinedTotal = reports.reduce((sum, r) => sum + r.detections.combined.length, 0);
  console.log(`\nDetection counts: Stage1=${stage1Total}  Stage2=${stage2Total}  Combined=${combinedTotal}`);

  const stage2OnlyRows = reports.filter((r) => r.stage2_only);
  if (stage2OnlyRows.length > 0) {
    const caught = stage2OnlyRows.filter((r) =>
      (r.outcome === 'TP' || r.outcome === 'PARTIAL') &&
      r.detections.stage1.length === 0 &&
      r.detections.deterministic.length === 0 &&
      r.detections.stage2.length > 0
    );
    const missed = stage2OnlyRows.filter((r) => r.outcome === 'FN');
    const earlier = stage2OnlyRows.filter((r) =>
      r.detections.stage1.length > 0 || r.detections.deterministic.length > 0
    );
    const recall = caught.length / (caught.length + missed.length) || 0;
    console.log(
      `Stage2-only hardcases: caught=${caught.length}/${stage2OnlyRows.length} ` +
      `recall=${recall.toFixed(3)} earlier-stage-leak=${earlier.length}`,
    );
  }

  console.log(`\nWrote ${reports.length} rows → ${outPath}`);
  await flushTelemetry();
}

main().catch((err) => {
  console.error('[pii-evals] fatal:', err);
  process.exit(1);
});
