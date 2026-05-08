#!/usr/bin/env bun
/**
 * Sanity check — runs the production PII Guard orchestrator against the
 * PII dataset and reports per-category / per-pattern coverage.
 *
 * Usage:
 *   bun run scripts/check-stage2.ts                  # full 100 rows
 *   bun run scripts/check-stage2.ts --limit 20       # first 20
 *   bun run scripts/check-stage2.ts --ids P066,P081  # specific rows
 *   bun run scripts/check-stage2.ts --obf            # obfuscated rows only
 *   bun run scripts/check-stage2.ts --dataset src/observability/datasets/pii_stage2_hardcases.json
 *
 * Stage 2 first runs local hardcase decoders/normalizers and only falls back
 * to LLM adjudication for residual ambiguous cases.
 */

import 'dotenv/config';

import type { PIIDetection } from '../src/observability/guards/regexGuard.js';
import { guardInput } from '../src/observability/guards/piiGuard.js';

interface Row {
  id: string;
  category: 'clean' | 'direct' | 'obfuscated' | 'cross_session' | 'prompt_injection';
  input: string;
  contains_pii: boolean;
  pii_types: string[];
  expected_masked: string;
  obfuscation_pattern?: string;
  requires_stage?: 1 | 2;
  stage2_only?: boolean;
}

interface CliArgs {
  limit?: number;
  ids?: string[];
  obfOnly?: boolean;
  dataset?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') out.limit = Number.parseInt(argv[++i] ?? '', 10);
    else if (a === '--ids') out.ids = (argv[++i] ?? '').split(',').filter(Boolean);
    else if (a === '--obf') out.obfOnly = true;
    else if (a === '--dataset') out.dataset = argv[++i];
    else if (a === '--stage2-hard') out.dataset = 'src/observability/datasets/pii_stage2_hardcases.json';
  }
  return out;
}

function selectRows(all: Row[], args: CliArgs): Row[] {
  let rows = all;
  if (args.ids && args.ids.length > 0) {
    const set = new Set(args.ids);
    rows = rows.filter((r) => set.has(r.id));
  }
  if (args.obfOnly) rows = rows.filter((r) => r.category === 'obfuscated');
  if (args.limit && Number.isFinite(args.limit)) rows = rows.slice(0, args.limit);
  return rows;
}

interface Result {
  row: Row;
  stage1: PIIDetection[];
  deterministic: PIIDetection[];
  stage2: PIIDetection[];
  combined: PIIDetection[];
  actualMasked: string;
  detected: boolean;
  maskCorrect: boolean;
  outcome: 'TP' | 'FP' | 'FN' | 'TN' | 'PARTIAL';
  latencyMs: number;
}

const args = parseArgs(process.argv);
const datasetPath = args.dataset ?? 'src/observability/datasets/pii_100samples.json';
const allRows = JSON.parse(
  await Bun.file(datasetPath).text(),
) as Row[];
const rows = selectRows(allRows, args);

console.error(`[check-stage2] dataset=${datasetPath}`);
console.error(`[check-stage2] running ${rows.length}/${allRows.length} rows...`);

function formatDetections(detections: PIIDetection[]): string {
  return detections
    .map((d) => `${d.type}="[REDACTED_${d.type.toUpperCase()}]" (${d.confidence.toFixed(2)})`)
    .join(', ');
}

const results: Result[] = [];
for (let i = 0; i < rows.length; i++) {
  const row = rows[i];
  process.stderr.write(`[${i + 1}/${rows.length}] ${row.id} (${row.category})... `);

  const result = await guardInput(row.input, { surface: 'eval', direction: 'input' });
  const stage1 = result.stageDetections.stage1;
  const deterministic = result.stageDetections.deterministic;
  const stage2 = result.stageDetections.stage2;
  const combined = result.detections;
  const actualMasked = result.maskedText;
  const latencyMs = result.stageStats.latencyMs;

  const detected = combined.length > 0;
  const maskCorrect = actualMasked === row.expected_masked;

  let outcome: Result['outcome'];
  if (row.contains_pii && detected && maskCorrect) outcome = 'TP';
  else if (row.contains_pii && detected && !maskCorrect) outcome = 'PARTIAL';
  else if (row.contains_pii && !detected) outcome = 'FN';
  else if (!row.contains_pii && detected) outcome = 'FP';
  else outcome = 'TN';

  results.push({ row, stage1, deterministic, stage2, combined, actualMasked, detected, maskCorrect, outcome, latencyMs });
  process.stderr.write(`${outcome} (${latencyMs}ms, s1=${stage1.length} det=${deterministic.length} s2=${stage2.length})\n`);
}

// ---- Summary ----------------------------------------------------------------

const counts = { TP: 0, FP: 0, FN: 0, TN: 0, PARTIAL: 0 };
for (const r of results) counts[r.outcome]++;

const tp = counts.TP + counts.PARTIAL;
const precision = tp / (tp + counts.FP) || 0;
const recall = tp / (tp + counts.FN) || 0;
const f1 = (2 * precision * recall) / (precision + recall) || 0;

const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0;
const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;

console.log('\n─── Stage 1+2 Combined Sanity Report ──────────────────────────────');
console.log(`Total rows:    ${rows.length}`);
console.log(`TP (caught):   ${counts.TP}     PARTIAL (caught but mask off): ${counts.PARTIAL}`);
console.log(`FP (false +):  ${counts.FP}     FN (missed):                   ${counts.FN}`);
console.log(`TN (correctly ignored): ${counts.TN}`);
console.log(`Precision: ${precision.toFixed(3)}   Recall: ${recall.toFixed(3)}   F1: ${f1.toFixed(3)}`);
console.log(`Latency: median=${p50}ms  p95=${p95}ms`);

// ---- Per-category breakdown ------------------------------------------------

const categories = ['clean', 'direct', 'obfuscated', 'cross_session', 'prompt_injection'] as const;
console.log('\nCategory         n   TP   PART  FN   FP   TN');
for (const cat of categories) {
  const subset = results.filter((r) => r.row.category === cat);
  if (subset.length === 0) continue;
  const c = { TP: 0, FP: 0, FN: 0, TN: 0, PARTIAL: 0 };
  for (const r of subset) c[r.outcome]++;
  console.log(
    `${cat.padEnd(16)} ${String(subset.length).padStart(2)}  ${String(c.TP).padStart(3)}  ${String(c.PARTIAL).padStart(4)}  ${String(c.FN).padStart(3)}  ${String(c.FP).padStart(3)}  ${String(c.TN).padStart(3)}`,
  );
}

// ---- Per-obfuscation pattern -----------------------------------------------

const obfRows = results.filter((r) => r.row.category === 'obfuscated');
if (obfRows.length > 0) {
  const dynamicPatterns = [...new Set(obfRows.map((r) => r.row.obfuscation_pattern).filter(Boolean))] as string[];
  const obfPatterns = dynamicPatterns.length > 0
    ? dynamicPatterns
    : ['korean_numerals', 'spaced', 'special_char_insertion', 'reversed', 'contextual_inference'];
  console.log('\nObfuscation pattern        n   stage   TP/PART  FN  PARTIAL detail');
  for (const pat of obfPatterns) {
    const subset = obfRows.filter((r) => r.row.obfuscation_pattern === pat);
    if (subset.length === 0) continue;
    const stage = subset[0].row.requires_stage;
    const tpPart = subset.filter((r) => r.outcome === 'TP' || r.outcome === 'PARTIAL').length;
    const fn = subset.filter((r) => r.outcome === 'FN').length;
    const part = subset.filter((r) => r.outcome === 'PARTIAL').length;
    console.log(
      `${pat.padEnd(26)} ${String(subset.length).padStart(2)}  stage ${stage}  ${String(tpPart).padStart(7)}  ${String(fn).padStart(2)}  ${part > 0 ? part : ''}`,
    );
  }
}

// ---- Stage 1 vs Stage 2 contribution ---------------------------------------

const totalDetections = results.reduce((sum, r) => sum + r.combined.length, 0);
const stage1Only = results.reduce((sum, r) => {
  const stage2Spans = new Set(r.stage2.map((d) => `${d.start}:${d.end}`));
  return sum + r.combined.filter((d) => !stage2Spans.has(`${d.start}:${d.end}`)).length;
}, 0);
const stage2Contrib = totalDetections - stage1Only;
console.log(`\nDetection contribution:  Stage 1 = ${stage1Only}, Stage 2 added = ${stage2Contrib}, total = ${totalDetections}`);

const stage2OnlyRows = results.filter((r) => r.row.stage2_only);
if (stage2OnlyRows.length > 0) {
  const caught = stage2OnlyRows.filter((r) =>
    (r.outcome === 'TP' || r.outcome === 'PARTIAL') &&
    r.stage1.length === 0 &&
    r.deterministic.length === 0 &&
    r.stage2.length > 0
  );
  const missed = stage2OnlyRows.filter((r) => r.outcome === 'FN');
  const leakedToEarlierStages = stage2OnlyRows.filter((r) => r.stage1.length > 0 || r.deterministic.length > 0);
  const recall = caught.length / (caught.length + missed.length) || 0;
  console.log(
    `Stage2-only hardcases: caught=${caught.length}/${stage2OnlyRows.length} ` +
    `recall=${recall.toFixed(3)} earlier-stage-leak=${leakedToEarlierStages.length}`,
  );
}

// ---- Failure detail --------------------------------------------------------

const failures = results.filter((r) => r.outcome === 'FP' || r.outcome === 'PARTIAL' || r.outcome === 'FN');
if (failures.length > 0) {
  console.log(`\n─── Failures (${failures.length}) ───────────────────────────────────────`);
  for (const f of failures.slice(0, 20)) {
    console.log(`[${f.outcome}] ${f.row.id} (${f.row.category}${f.row.obfuscation_pattern ? '/' + f.row.obfuscation_pattern : ''})`);
    console.log(`  input:    ${f.actualMasked}`);
    console.log(`  expected: ${f.row.expected_masked}`);
    console.log(`  actual:   ${f.actualMasked}`);
    if (f.stage1.length > 0) {
      console.log(`  stage1:   ${formatDetections(f.stage1)}`);
    }
    if (f.deterministic.length > 0) {
      console.log(`  det:      ${formatDetections(f.deterministic)}`);
    }
    if (f.stage2.length > 0) {
      console.log(`  stage2:   ${formatDetections(f.stage2)}`);
    }
    console.log('');
  }
  if (failures.length > 20) console.log(`... and ${failures.length - 20} more`);
}
