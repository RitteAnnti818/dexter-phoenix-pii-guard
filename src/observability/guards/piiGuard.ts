import { createHmac } from 'node:crypto';
import {
  dedupeOverlapping,
  maskText,
  regexDetect,
  type PIIDetection,
  type PIIType,
} from './regexGuard.js';
import { llmDetect } from './llmGuard.js';

export type PiiGuardAction = 'allow' | 'mask' | 'block';
export type PiiGuardDirection = 'input' | 'output' | 'trace' | 'storage' | 'log';
export type PiiGuardStage2Mode = 'auto' | 'force' | 'skip';

export interface PiiGuardContext {
  direction?: PiiGuardDirection;
  surface?: 'cli' | 'gateway' | 'agent' | 'memory' | 'trace' | 'log' | 'eval';
  stage2?: PiiGuardStage2Mode;
  memorySeed?: string;
  blockedPlaceholder?: string;
  strict?: boolean;
  timeoutMs?: number;
}

export interface PiiGuardStageStats {
  stage1Count: number;
  deterministicCount: number;
  stage2Count: number;
  stage2Used: boolean;
  stage2TimedOut: boolean;
  latencyMs: number;
}

export interface PiiGuardResult {
  action: PiiGuardAction;
  maskedText: string;
  detections: PIIDetection[];
  stageStats: PiiGuardStageStats;
  leakedFingerprints: string[];
  riskReasons: string[];
}

const DEFAULT_STAGE2_TIMEOUT_MS = 450;
const DEFAULT_BLOCKED_PLACEHOLDER =
  '저장된 개인정보를 응답에 포함할 수 없습니다. (PII leak prevented.)';
const DEFAULT_FINGERPRINT_SALT = 'dexter-local-dev-pii-guard-salt';

const KOREAN_DIGITS: Record<string, string> = {
  공: '0',
  영: '0',
  령: '0',
  일: '1',
  이: '2',
  삼: '3',
  사: '4',
  오: '5',
  육: '6',
  륙: '6',
  칠: '7',
  팔: '8',
  구: '9',
};

const CONTEXT_KEYWORDS: Record<PIIType, RegExp> = {
  rrn: /주민|주민번호|주민등록|RRN|신원|KYC/i,
  bank_acct: /계좌|은행|입금|송금|이체|잔액/i,
  phone_kr: /휴대폰|핸드폰|전화|연락처|SMS|알림/i,
  credit_card: /카드|신용카드|결제|자동결제/i,
  email: /이메일|email|메일/i,
  demographic: /거주|사는|여성|남성|직장인|다니는|나이|프로필/i,
};

const REVERSED_HINT = /역순|거꾸로|뒤집/i;
const NUMBERISH_RE = /\d[\d\s\-.@_*]{7,}\d/g;
const KOREAN_NUMERAL_RE = /[공영령일이삼사오육륙칠팔구][공영령일이삼사오육륙칠팔구\s\-.@_*]*/g;
const SPACED_EMAIL_RE =
  /\b(?:[A-Za-z]\s*)+(?:\.\s*(?:[A-Za-z]\s*)+)*@\s*(?:[A-Za-z]\s*)+(?:\.\s*(?:[A-Za-z]\s*)+)+\b/g;

const DEMOGRAPHIC_PATTERNS: RegExp[] = [
  /(?:서울\s*)?강남구\s*역삼동에?\s*사는\s*\d{2}세\s*[가-힣]씨\s*(?:남성|여성)/g,
  /(?:서울\s*)?강남구\s*거주\s*\d{2}대\s*(?:초반|중반|후반)?\s*(?:남성|여성)\s*[가-힣]씨/g,
  /\d{4}년\s*\d{1,2}월생\s*(?:남성|여성)\s*[가-힣]씨/g,
  /[가-힣A-Za-z0-9]+(?:전자|은행|증권|보험|회사)?\s*다니는\s*\d{2}세\s*[가-힣]씨\s*직장인/g,
];

export async function guardInput(
  text: string,
  context: PiiGuardContext = {},
): Promise<PiiGuardResult> {
  return guardText(text, { ...context, direction: context.direction ?? 'input' });
}

export async function guardOutput(
  text: string,
  context: PiiGuardContext = {},
): Promise<PiiGuardResult> {
  return guardText(text, { ...context, direction: context.direction ?? 'output' });
}

export async function guardText(
  text: string,
  context: PiiGuardContext = {},
): Promise<PiiGuardResult> {
  const startedAt = Date.now();
  if (isGuardDisabled()) {
    return buildResult('allow', text, [], startedAt, {
      deterministicCount: 0,
      stage1Count: 0,
      stage2Count: 0,
      stage2TimedOut: false,
      stage2Used: false,
    });
  }

  const stage1 = regexDetect(text);
  const deterministic = deterministicDetect(text);
  let combined = dedupeOverlapping([...stage1, ...deterministic]);

  const stage2Mode = context.stage2 ?? 'auto';
  const shouldRunStage2 = stage2Mode === 'force' || (stage2Mode === 'auto' && combined.length === 0);
  let stage2: PIIDetection[] = [];
  let stage2TimedOut = false;

  if (shouldRunStage2) {
    const stage2Result = await runStage2(text, combined, context.timeoutMs ?? DEFAULT_STAGE2_TIMEOUT_MS);
    stage2 = stage2Result.detections;
    stage2TimedOut = stage2Result.timedOut;
    combined = dedupeOverlapping([...combined, ...stage2]);
  }

  const leakedFingerprints = context.memorySeed
    ? findLeakedFingerprints(context.memorySeed, text, combined)
    : [];

  const riskReasons: string[] = [];
  if (combined.length > 0) {
    riskReasons.push(`detected:${combined.map((d) => d.type).join(',')}`);
  }
  if (leakedFingerprints.length > 0) {
    riskReasons.push('cross-session-fingerprint-match');
  }
  if (stage2TimedOut && hasHighRiskHint(text)) {
    riskReasons.push('stage2-timeout-high-risk');
  }

  let action: PiiGuardAction = 'allow';
  let maskedText = text;

  if (leakedFingerprints.length > 0 || (stage2TimedOut && context.strict && hasHighRiskHint(text))) {
    action = 'block';
    maskedText = context.blockedPlaceholder ?? DEFAULT_BLOCKED_PLACEHOLDER;
  } else if (combined.length > 0) {
    action = 'mask';
    maskedText = maskText(text, combined);
  }

  return {
    action,
    maskedText,
    detections: combined,
    leakedFingerprints,
    riskReasons,
    stageStats: {
      stage1Count: stage1.length,
      deterministicCount: deterministic.length,
      stage2Count: stage2.length,
      stage2Used: shouldRunStage2,
      stage2TimedOut,
      latencyMs: Date.now() - startedAt,
    },
  };
}

export function detectPiiSync(text: string): PIIDetection[] {
  if (isGuardDisabled()) return [];
  return dedupeOverlapping([...regexDetect(text), ...deterministicDetect(text)]);
}

export function maskSensitiveTextSync(text: string): string {
  const detections = detectPiiSync(text);
  return detections.length > 0 ? maskText(text, detections) : text;
}

export function sanitizeForTrace(text: string): string {
  return maskSensitiveTextSync(text);
}

export function sanitizeForStorage(text: string): string {
  return maskSensitiveTextSync(text);
}

export function sanitizeValueForStorage<T>(value: T): T {
  return sanitizeUnknown(value) as T;
}

export function fingerprintPii(value: string): string {
  const normalized = normalizePii(value);
  if (!normalized) return '';
  const salt = process.env.PII_GUARD_FINGERPRINT_SALT || DEFAULT_FINGERPRINT_SALT;
  return createHmac('sha256', salt).update(normalized).digest('hex').slice(0, 16);
}

export function normalizePii(value: string): string {
  let out = '';
  for (const ch of value) {
    if (KOREAN_DIGITS[ch] !== undefined) {
      out += KOREAN_DIGITS[ch];
    } else if (/[A-Za-z0-9]/.test(ch)) {
      out += ch.toLowerCase();
    }
  }
  return out;
}

function deterministicDetect(text: string): PIIDetection[] {
  return dedupeOverlapping([
    ...detectKoreanNumerals(text),
    ...detectSpacedEmail(text),
    ...detectReversedNumbers(text),
    ...detectDemographic(text),
  ]);
}

function detectKoreanNumerals(text: string): PIIDetection[] {
  const out: PIIDetection[] = [];
  KOREAN_NUMERAL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = KOREAN_NUMERAL_RE.exec(text)) !== null) {
    const raw = trimTrailingSeparators(match[0]);
    if (!raw) continue;
    const digits = koreanDigitsToAscii(raw);
    if (digits.length < 10) continue;
    const type = classifyDigits(digits, contextWindow(text, match.index, match.index + raw.length), raw);
    if (!type) continue;
    out.push({
      type,
      start: match.index,
      end: match.index + raw.length,
      match: raw,
      confidence: 0.92,
    });
  }
  return out;
}

function detectSpacedEmail(text: string): PIIDetection[] {
  const out: PIIDetection[] = [];
  SPACED_EMAIL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SPACED_EMAIL_RE.exec(text)) !== null) {
    if (!/\s/.test(match[0])) continue;
    out.push({
      type: 'email',
      start: match.index,
      end: match.index + match[0].length,
      match: match[0],
      confidence: 0.9,
    });
  }
  return out;
}

function detectReversedNumbers(text: string): PIIDetection[] {
  if (!REVERSED_HINT.test(text)) return [];
  const out: PIIDetection[] = [];
  NUMBERISH_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = NUMBERISH_RE.exec(text)) !== null) {
    const raw = trimTrailingSeparators(match[0]);
    const digits = raw.replace(/\D/g, '');
    if (digits.length < 10) continue;
    const reversed = [...digits].reverse().join('');
    const ctx = contextWindow(text, match.index, match.index + raw.length);
    const type = classifyReversedDigits(reversed, ctx, raw);
    if (!type) continue;
    out.push({
      type,
      start: match.index,
      end: match.index + raw.length,
      match: raw,
      confidence: 0.9,
    });
  }
  return out;
}

function detectDemographic(text: string): PIIDetection[] {
  const out: PIIDetection[] = [];
  for (const pattern of DEMOGRAPHIC_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      out.push({
        type: 'demographic',
        start: match.index,
        end: match.index + match[0].length,
        match: match[0],
        confidence: 0.86,
      });
    }
  }
  return out;
}

function classifyReversedDigits(digits: string, ctx: string, raw: string): PIIType | null {
  if (CONTEXT_KEYWORDS.credit_card.test(ctx) && digits.length >= 13 && digits.length <= 19) {
    return 'credit_card';
  }
  if (CONTEXT_KEYWORDS.phone_kr.test(ctx) && digits.length >= 10 && digits.length <= 11) {
    return 'phone_kr';
  }
  if (CONTEXT_KEYWORDS.rrn.test(ctx) && digits.length === 13) {
    return 'rrn';
  }
  if (CONTEXT_KEYWORDS.bank_acct.test(ctx) && digits.length >= 10 && digits.length <= 14) {
    return 'bank_acct';
  }
  return classifyDigits(digits, ctx, raw);
}

function classifyDigits(digits: string, ctx: string, raw: string): PIIType | null {
  if (/^01[016789]\d{7,8}$/.test(digits)) return 'phone_kr';
  if (/^\d{6}[1-4]\d{6}$/.test(digits)) return 'rrn';
  if (CONTEXT_KEYWORDS.credit_card.test(ctx) && digits.length >= 13 && digits.length <= 19) {
    return 'credit_card';
  }
  if (CONTEXT_KEYWORDS.bank_acct.test(ctx) && digits.length >= 10 && digits.length <= 14) {
    return 'bank_acct';
  }
  if (CONTEXT_KEYWORDS.rrn.test(ctx) && digits.length === 13) return 'rrn';
  if (CONTEXT_KEYWORDS.phone_kr.test(ctx) && digits.length >= 10 && digits.length <= 11) {
    return 'phone_kr';
  }
  if (CONTEXT_KEYWORDS.credit_card.test(raw) && digits.length >= 13 && digits.length <= 19) {
    return 'credit_card';
  }
  return null;
}

function findLeakedFingerprints(
  memorySeed: string,
  output: string,
  outputDetections: PIIDetection[],
): string[] {
  const seedValues = extractSeedValues(memorySeed);
  if (seedValues.length === 0) return [];

  const outputFingerprints = new Set(
    outputDetections.map((d) => fingerprintPii(d.match)).filter(Boolean),
  );
  const leaked = new Set<string>();

  for (const seed of seedValues) {
    const fp = fingerprintPii(seed);
    if (!fp) continue;
    if (output.includes(seed) || outputFingerprints.has(fp)) {
      leaked.add(fp);
    }
  }

  return [...leaked];
}

function extractSeedValues(memorySeed: string): string[] {
  const values: string[] = [];
  for (const part of memorySeed.split(',')) {
    const idx = part.indexOf(':');
    const value = idx === -1 ? part.trim() : part.slice(idx + 1).trim();
    if (value) values.push(value);
  }

  const detections = detectPiiSync(memorySeed);
  for (const detection of detections) {
    values.push(detection.match);
  }

  return [...new Set(values)];
}

async function runStage2(
  text: string,
  stage1: PIIDetection[],
  timeoutMs: number,
): Promise<{ detections: PIIDetection[]; timedOut: boolean }> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      llmDetect(text, { stage1Detections: stage1 }).then((detections) => ({
        detections,
        timedOut: false,
      })),
      new Promise<{ detections: PIIDetection[]; timedOut: boolean }>((resolve) => {
        timeout = setTimeout(() => resolve({ detections: [], timedOut: true }), timeoutMs);
      }),
    ]);
  } catch {
    return { detections: [], timedOut: false };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function sanitizeUnknown(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeForStorage(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeUnknown(item));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = sanitizeUnknown(item);
    }
    return out;
  }
  return value;
}

function koreanDigitsToAscii(value: string): string {
  let digits = '';
  for (const ch of value) {
    if (KOREAN_DIGITS[ch] !== undefined) digits += KOREAN_DIGITS[ch];
  }
  return digits;
}

function trimTrailingSeparators(value: string): string {
  return value.replace(/[\s\-.@_*]+$/g, '');
}

function contextWindow(text: string, start: number, end: number): string {
  return text.slice(Math.max(0, start - 24), Math.min(text.length, end + 24));
}

function hasHighRiskHint(text: string): boolean {
  return /주민|계좌|카드|휴대폰|전화|이메일|PII|개인정보|memory\.dump|저장된|아까|이전|그대로 출력/i.test(text);
}

function isGuardDisabled(): boolean {
  return process.env.PII_GUARD_DISABLED === '1';
}

function buildResult(
  action: PiiGuardAction,
  maskedText: string,
  detections: PIIDetection[],
  startedAt: number,
  stats: Omit<PiiGuardStageStats, 'latencyMs'>,
): PiiGuardResult {
  return {
    action,
    maskedText,
    detections,
    leakedFingerprints: [],
    riskReasons: [],
    stageStats: { ...stats, latencyMs: Date.now() - startedAt },
  };
}
