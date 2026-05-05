#!/usr/bin/env bun
/**
 * Compare two run-evals JSONL reports as a Task 1-4 A/B summary.
 *
 * Usage:
 *   bun run scripts/compare-evals.ts <baseline.jsonl> <improved.jsonl>
 *
 * Prints the metrics the PDF rubric asks for:
 *   • Baseline Hallucination Rate vs improved
 *   • Trap Refusal Rate change
 *   • Per-evaluator score deltas
 *   • Latency change (mean + p95)
 *   • Per-row regressions/wins so the report can call them out
 */

interface RowReport {
  id: string;
  level: 'easy' | 'medium' | 'hard' | 'trap';
  category: string;
  question: string;
  agentLatencySec?: number;
  promptVariant?: string;
  agent: { finalAnswer: string; toolCalls: { name: string }[]; iterations: number };
  evaluations: {
    factualAccuracy: { score: number } | null;
    groundedness: { score: number };
    toolCorrectness: { score: number };
    refusal: { score: number } | null;
    planQuality: { score: number };
  };
}

async function loadJsonl(path: string): Promise<RowReport[]> {
  const text = await Bun.file(path).text();
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((r) => r.id && r.evaluations) as RowReport[];
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

function aggregate(rows: RowReport[]) {
  const fa = rows.flatMap((r) => (r.evaluations.factualAccuracy ? [r.evaluations.factualAccuracy.score] : []));
  const gd = rows.map((r) => r.evaluations.groundedness.score);
  const tc = rows.map((r) => r.evaluations.toolCorrectness.score);
  const rf = rows.flatMap((r) => (r.evaluations.refusal ? [r.evaluations.refusal.score] : []));
  const pq = rows.map((r) => r.evaluations.planQuality.score);
  const lat = rows.flatMap((r) => (typeof r.agentLatencySec === 'number' ? [r.agentLatencySec] : []));
  return {
    n: rows.length,
    factualAccuracy: { n: fa.length, mean: mean(fa) },
    hallucinationRate: { n: fa.length, value: 1 - mean(fa) },
    groundedness: { n: gd.length, mean: mean(gd) },
    toolCorrectness: { n: tc.length, mean: mean(tc) },
    refusalRate: { n: rf.length, value: mean(rf) },
    planQuality: { n: pq.length, mean: mean(pq) },
    latencyMean: { n: lat.length, value: mean(lat) },
    latencyP95: { n: lat.length, value: percentile(lat, 0.95) },
  };
}

function fmtPct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function fmtDelta(before: number, after: number, mode: 'higher_better' | 'lower_better' = 'higher_better'): string {
  const delta = after - before;
  const sign = delta > 0 ? '+' : '';
  const arrow = (mode === 'higher_better' ? delta > 0 : delta < 0) ? '↑' : delta === 0 ? '→' : '↓';
  return `${sign}${(delta * 100).toFixed(1)}pp ${arrow}`;
}

function findRegressions(baseline: RowReport[], improved: RowReport[]) {
  const byId = new Map(improved.map((r) => [r.id, r]));
  const wins: { id: string; metric: string; from: number; to: number }[] = [];
  const losses: { id: string; metric: string; from: number; to: number }[] = [];

  const cmp = (id: string, metric: string, before: number | undefined, after: number | undefined) => {
    if (before === undefined || after === undefined) return;
    if (after > before) wins.push({ id, metric, from: before, to: after });
    else if (after < before) losses.push({ id, metric, from: before, to: after });
  };

  for (const b of baseline) {
    const i = byId.get(b.id);
    if (!i) continue;
    cmp(b.id, 'factualAccuracy', b.evaluations.factualAccuracy?.score, i.evaluations.factualAccuracy?.score);
    cmp(b.id, 'groundedness', b.evaluations.groundedness.score, i.evaluations.groundedness.score);
    cmp(b.id, 'refusal', b.evaluations.refusal?.score, i.evaluations.refusal?.score);
    cmp(b.id, 'planQuality', b.evaluations.planQuality.score, i.evaluations.planQuality.score);
  }
  return { wins, losses };
}

async function main() {
  const [baselinePath, improvedPath] = process.argv.slice(2);
  if (!baselinePath || !improvedPath) {
    console.error('Usage: bun run scripts/compare-evals.ts <baseline.jsonl> <improved.jsonl>');
    process.exit(1);
  }
  const [baseline, improved] = await Promise.all([loadJsonl(baselinePath), loadJsonl(improvedPath)]);
  const A = aggregate(baseline);
  const B = aggregate(improved);

  const baseLabel = baseline[0]?.promptVariant ?? 'baseline';
  const impLabel = improved[0]?.promptVariant ?? 'improved';

  console.log(`\n=== Task 1-4 A/B Report ===`);
  console.log(`baseline file: ${baselinePath}  (variant=${baseLabel}, n=${A.n})`);
  console.log(`improved file: ${improvedPath}  (variant=${impLabel}, n=${B.n})`);

  console.log(`\nMetric                     ${baseLabel.padEnd(12)}  ${impLabel.padEnd(12)}  Δ`);
  console.log('-'.repeat(70));
  console.log(`Hallucination Rate (1-FA)  ${fmtPct(A.hallucinationRate.value).padEnd(12)}  ${fmtPct(B.hallucinationRate.value).padEnd(12)}  ${fmtDelta(A.hallucinationRate.value, B.hallucinationRate.value, 'lower_better')}`);
  console.log(`Factual Accuracy (mean)    ${A.factualAccuracy.mean.toFixed(3).padEnd(12)}  ${B.factualAccuracy.mean.toFixed(3).padEnd(12)}  ${fmtDelta(A.factualAccuracy.mean, B.factualAccuracy.mean)}`);
  console.log(`Groundedness (mean)        ${A.groundedness.mean.toFixed(3).padEnd(12)}  ${B.groundedness.mean.toFixed(3).padEnd(12)}  ${fmtDelta(A.groundedness.mean, B.groundedness.mean)}`);
  console.log(`Tool Correctness (mean)    ${A.toolCorrectness.mean.toFixed(3).padEnd(12)}  ${B.toolCorrectness.mean.toFixed(3).padEnd(12)}  ${fmtDelta(A.toolCorrectness.mean, B.toolCorrectness.mean)}`);
  console.log(`Trap Refusal Rate          ${fmtPct(A.refusalRate.value).padEnd(12)}  ${fmtPct(B.refusalRate.value).padEnd(12)}  ${fmtDelta(A.refusalRate.value, B.refusalRate.value)}`);
  console.log(`Plan Quality (mean)        ${A.planQuality.mean.toFixed(3).padEnd(12)}  ${B.planQuality.mean.toFixed(3).padEnd(12)}  ${fmtDelta(A.planQuality.mean, B.planQuality.mean)}`);
  console.log('-'.repeat(70));
  const latDelta = B.latencyMean.value - A.latencyMean.value;
  console.log(`Agent Latency (mean, sec)  ${A.latencyMean.value.toFixed(2).padEnd(12)}  ${B.latencyMean.value.toFixed(2).padEnd(12)}  ${latDelta >= 0 ? '+' : ''}${latDelta.toFixed(2)}s`);
  const p95Delta = B.latencyP95.value - A.latencyP95.value;
  console.log(`Agent Latency (p95, sec)   ${A.latencyP95.value.toFixed(2).padEnd(12)}  ${B.latencyP95.value.toFixed(2).padEnd(12)}  ${p95Delta >= 0 ? '+' : ''}${p95Delta.toFixed(2)}s`);

  const { wins, losses } = findRegressions(baseline, improved);
  console.log(`\nPer-row movement: ${wins.length} wins, ${losses.length} losses`);
  if (losses.length > 0) {
    console.log('\nRegressions (improved scored worse than baseline):');
    losses.slice(0, 10).forEach((l) =>
      console.log(`  ${l.id} ${l.metric.padEnd(18)}  ${l.from.toFixed(2)} → ${l.to.toFixed(2)}`),
    );
    if (losses.length > 10) console.log(`  ... and ${losses.length - 10} more`);
  }
  if (wins.length > 0) {
    console.log('\nTop wins:');
    wins
      .sort((a, b) => (b.to - b.from) - (a.to - a.from))
      .slice(0, 10)
      .forEach((w) =>
        console.log(`  ${w.id} ${w.metric.padEnd(18)}  ${w.from.toFixed(2)} → ${w.to.toFixed(2)}`),
      );
  }
  console.log();
}

main().catch((err) => {
  console.error('compare-evals failed:', err);
  process.exit(1);
});
