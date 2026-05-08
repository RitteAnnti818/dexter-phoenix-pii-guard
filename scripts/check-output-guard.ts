#!/usr/bin/env bun
/**
 * Sanity check for Output Guard.
 *
 * Simulates agent responses and verifies that:
 *   1. Clean responses pass through unchanged.
 *   2. Memory-seed PII appearing verbatim in response → blocked.
 *   3. Direct PII in response (not from memory) → masked but not blocked.
 *   4. Different PII tokens than memory seed → masked, not blocked.
 *
 * Not a full agent integration test — that's Day 12's run-pii-evals.ts job.
 * This isolates Output Guard behavior on hand-crafted scenarios.
 */
import 'dotenv/config';
import { checkOutput } from '../src/observability/guards/outputGuard.js';
import { maskSensitiveTextSync } from '../src/observability/guards/piiGuard.js';

interface Test {
  name: string;
  output: string;
  memorySeed?: string;
  expectBlocked: boolean;
  expectLeakedAtLeast?: number;
}

const tests: Test[] = [
  {
    name: 'clean response (no PII)',
    output: 'AAPL 2024 회계연도 총매출은 약 $391.04B 달러입니다.',
    expectBlocked: false,
  },
  {
    name: 'cross-session leak — bank account from memory appears in output',
    output: '지난번 입력하신 110-123-456789 계좌로 매수 진행하겠습니다.',
    memorySeed: '사용자 계좌: 110-123-456789',
    expectBlocked: true,
    expectLeakedAtLeast: 1,
  },
  {
    name: 'cross-session leak — RRN from memory appears in output',
    output: '신용평가 결과: 901231-1234567 보유자 점수 720점.',
    memorySeed: '사용자 주민번호: 901231-1234567',
    expectBlocked: true,
    expectLeakedAtLeast: 1,
  },
  {
    name: 'cross-session leak — multi-value memory seed',
    output: '등록된 휴대폰 010-1234-5678로 알림 보냈습니다. 계좌: 110-123-456789.',
    memorySeed: '사용자 휴대폰: 010-1234-5678, 사용자 계좌: 110-123-456789',
    expectBlocked: true,
    expectLeakedAtLeast: 2,
  },
  {
    name: 'PII in response but no memory_seed → mask only, not block',
    output: '확인 번호 010-9999-8888 로 발송됐습니다.',
    expectBlocked: false,
  },
  {
    name: 'PII in response but different from memory → mask only',
    output: '다른 계좌 333-25-1234567 으로 처리하시겠어요?',
    memorySeed: '사용자 계좌: 110-123-456789',
    expectBlocked: false,
  },
  {
    name: 'agent refused gracefully — no PII in output',
    output: '죄송합니다. 저장된 개인정보는 응답에 포함할 수 없습니다.',
    memorySeed: '사용자 카드: 1234-5678-9012-3456',
    expectBlocked: false,
  },
];

let passed = 0;
let failed = 0;

console.log('─── Output Guard Sanity Check ────────────────────────────────────');
for (const t of tests) {
  const result = await checkOutput(t.output, { memorySeed: t.memorySeed });
  const blockOk = result.blocked === t.expectBlocked;
  const leakOk =
    t.expectLeakedAtLeast === undefined ||
    result.leakedTokens.length >= t.expectLeakedAtLeast;
  const ok = blockOk && leakOk;
  const mark = ok ? '✓' : '✗';
  if (ok) passed++;
  else failed++;

  console.log(`${mark} ${t.name}`);
  console.log(`  output:        ${maskSensitiveTextSync(t.output)}`);
  console.log(`  blocked:       ${result.blocked} (expected ${t.expectBlocked})`);
  if (result.leakedTokens.length > 0) {
    console.log(`  leakedTokens:  [${result.leakedTokens.join(', ')}]`);
  }
  if (result.detections.length > 0) {
    console.log(`  detections:    ${result.detections.map((d) => `${d.type}="[REDACTED_${d.type.toUpperCase()}]"`).join(', ')}`);
  }
  console.log(`  maskedOutput:  ${result.maskedOutput}`);
  if (result.reason) console.log(`  reason:        ${result.reason}`);
  console.log('');
}

console.log(`Result: ${passed}/${tests.length} passed${failed > 0 ? ` (${failed} failed)` : ''}`);
if (failed > 0) process.exit(1);
