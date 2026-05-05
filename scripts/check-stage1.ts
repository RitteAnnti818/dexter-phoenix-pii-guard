#!/usr/bin/env bun
/**
 * Sanity check — runs Stage 1 regexGuard against the 100-sample PII dataset
 * and reports per-category / per-pattern coverage.
 *
 * Not a final evaluator (that's Day 12's run-pii-evals.ts). This is a quick
 * "did Stage 1 implementation cover what we expected from week2-progress.md?"
 * verification.
 */

import { regexDetect, maskText, type PIIType } from '../src/observability/guards/regexGuard.js';

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
}

const rows = JSON.parse(
  await Bun.file('src/observability/datasets/pii_100samples.json').text(),
) as Row[];

interface Result {
  row: Row;
  detections: ReturnType<typeof regexDetect>;
  actualMasked: string;
  // Truth labels from the dataset
  shouldDetect: boolean;
  // Stage 1 outcome
  detected: boolean;
  maskCorrect: boolean;
  // Classification
  outcome: 'TP' | 'FP' | 'FN' | 'TN' | 'PARTIAL';
}

const results: Result[] = rows.map((row) => {
  const detections = regexDetect(row.input);
  const actualMasked = maskText(row.input, detections);
  const detected = detections.length > 0;
  const maskCorrect = actualMasked === row.expected_masked;

  // Stage 1 truth: should detect IF dataset says contains_pii AND requires_stage===1
  // (requires_stage===2 cases are Stage 2's responsibility; Stage 1 missing them is OK)
  const shouldDetect =
    row.contains_pii && (row.requires_stage === undefined || row.requires_stage === 1);

  let outcome: Result['outcome'];
  if (shouldDetect && detected && maskCorrect) outcome = 'TP';
  else if (shouldDetect && detected && !maskCorrect) outcome = 'PARTIAL';
  else if (shouldDetect && !detected) outcome = 'FN';
  else if (!shouldDetect && detected) outcome = 'FP';
  else outcome = 'TN';

  return { row, detections, actualMasked, shouldDetect, detected, maskCorrect, outcome };
});

// ---- Summary ----------------------------------------------------------------

const counts = { TP: 0, FP: 0, FN: 0, TN: 0, PARTIAL: 0 };
for (const r of results) counts[r.outcome]++;

const tp = counts.TP + counts.PARTIAL;  // count partials as detection success
const precision = tp / (tp + counts.FP) || 0;
const recall = tp / (tp + counts.FN) || 0;
const f1 = (2 * precision * recall) / (precision + recall) || 0;

console.log('─── Stage 1 Sanity Report ───────────────────────────────────────────');
console.log(`Total rows:    ${rows.length}`);
console.log(`TP (caught):   ${counts.TP}     PARTIAL (caught but mask off): ${counts.PARTIAL}`);
console.log(`FP (false +):  ${counts.FP}     FN (missed):                   ${counts.FN}`);
console.log(`TN (correctly ignored): ${counts.TN}`);
console.log(`Precision: ${precision.toFixed(3)}   Recall: ${recall.toFixed(3)}   F1: ${f1.toFixed(3)}`);
console.log('');

// ---- Per-category breakdown ------------------------------------------------

const categories = ['clean', 'direct', 'obfuscated', 'cross_session', 'prompt_injection'] as const;
console.log('Category         n   TP   PART  FN   FP   TN');
for (const cat of categories) {
  const subset = results.filter((r) => r.row.category === cat);
  const c = { TP: 0, FP: 0, FN: 0, TN: 0, PARTIAL: 0 };
  for (const r of subset) c[r.outcome]++;
  console.log(
    `${cat.padEnd(16)} ${String(subset.length).padStart(2)}  ${String(c.TP).padStart(3)}  ${String(c.PARTIAL).padStart(4)}  ${String(c.FN).padStart(3)}  ${String(c.FP).padStart(3)}  ${String(c.TN).padStart(3)}`,
  );
}
console.log('');

// ---- Per-obfuscation_pattern breakdown -------------------------------------

const obfRows = results.filter((r) => r.row.category === 'obfuscated');
const obfPatterns = ['korean_numerals', 'spaced', 'special_char_insertion', 'reversed', 'contextual_inference'];
console.log('Obfuscation pattern        n   stage   TP/PART   FN');
for (const pat of obfPatterns) {
  const subset = obfRows.filter((r) => r.row.obfuscation_pattern === pat);
  const stage = subset[0]?.row.requires_stage;
  const tpPart = subset.filter((r) => r.outcome === 'TP' || r.outcome === 'PARTIAL').length;
  const fn = subset.filter((r) => r.outcome === 'FN').length;
  console.log(
    `${pat.padEnd(26)} ${String(subset.length).padStart(2)}  stage ${stage}  ${String(tpPart).padStart(7)}   ${String(fn).padStart(2)}`,
  );
}
console.log('');

// ---- Failure detail --------------------------------------------------------

const failures = results.filter((r) => r.outcome === 'FP' || r.outcome === 'PARTIAL');
if (failures.length > 0) {
  console.log(`─── Failures (${failures.length}) ───────────────────────────────────────`);
  for (const f of failures.slice(0, 20)) {
    console.log(`[${f.outcome}] ${f.row.id} (${f.row.category}${f.row.obfuscation_pattern ? '/' + f.row.obfuscation_pattern : ''})`);
    console.log(`  input:    ${f.row.input}`);
    console.log(`  expected: ${f.row.expected_masked}`);
    console.log(`  actual:   ${f.actualMasked}`);
    if (f.detections.length > 0) {
      console.log(`  detected: ${f.detections.map((d) => `${d.type}=${JSON.stringify(d.match)} (${d.confidence.toFixed(2)})`).join(', ')}`);
    }
    console.log('');
  }
}

// ---- Stage-1-expected misses (FN among requires_stage:1 + direct) ----------

const stage1Misses = results.filter((r) => r.outcome === 'FN');
if (stage1Misses.length > 0) {
  console.log(`─── Stage 1 misses on rows that Stage 1 should have caught (${stage1Misses.length}) ──`);
  for (const f of stage1Misses.slice(0, 20)) {
    console.log(`[FN] ${f.row.id} (${f.row.category}${f.row.obfuscation_pattern ? '/' + f.row.obfuscation_pattern : ''})`);
    console.log(`  input: ${f.row.input}`);
    console.log(`  expected_masked: ${f.row.expected_masked}`);
    console.log('');
  }
}
