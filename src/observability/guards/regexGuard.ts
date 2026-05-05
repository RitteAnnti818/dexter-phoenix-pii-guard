// Stage 1 — Rule-based PII detection.
//
// Handles three obfuscation patterns from the dataset:
//   • direct                  — standard format (PDF Arize spec)
//   • spaced                  — inline whitespace between digits
//   • special_char_insertion  — separators @, ., _, *
//
// Does NOT handle (Stage 2 LLM territory):
//   • korean_numerals         — digits expressed as Korean words
//   • reversed                — digit-reversed PII when result is invalid format
//   • contextual_inference    — demographic clues (강남구, 35세, 김씨 등)

export type PIIType = 'rrn' | 'bank_acct' | 'phone_kr' | 'credit_card' | 'email' | 'demographic';

export interface PIIDetection {
  type: PIIType;
  /** Start offset in original text (UTF-16 index) */
  start: number;
  /** End offset (exclusive) */
  end: number;
  /** Raw matched substring */
  match: string;
  /** [0..1] — boosted by context keywords, lowered by Luhn failure / negative context */
  confidence: number;
}

// Each pattern absorbs:
//   • Optional inline whitespace between digits (handles "spaced" obfuscation)
//   • Extended group separator class [-.@_*] (handles "special_char_insertion")
// `\b` anchors keep matches token-aligned.
//
// BANK requires both group separators (not optional). Without this, plain digit
// strings like "3050000000000" (Microsoft 시가총액 trap) would falsely match.
//
// `demographic` has no regex pattern — Stage 2 LLM Guard's responsibility.
const PATTERNS: Partial<Record<PIIType, RegExp>> = {
  rrn:         /\b\d(?:\s*\d){5}\s*[-.@_*]?\s*[1-4](?:\s*\d){6}\b/g,
  bank_acct:   /\b\d(?:\s*\d){1,3}\s*[-.@_*]\s*\d(?:\s*\d){1,5}\s*[-.@_*]\s*\d(?:\s*\d){3,7}\b/g,
  phone_kr:    /\b0\s*1\s*[016789]\s*[-.@_*]?\s*\d(?:\s*\d){2,3}\s*[-.@_*]?\s*\d(?:\s*\d){3}\b/g,
  credit_card: /\b\d(?:\s*\d){3}\s*[-.@_*]?\s*\d(?:\s*\d){3}\s*[-.@_*]?\s*\d(?:\s*\d){3}\s*[-.@_*]?\s*\d(?:\s*\d){3}\b/g,
  email:       /\b[A-Za-z0-9._%+-]+\s*@\s*[A-Za-z0-9.-]+\s*\.\s*[A-Za-z]{2,}\b/g,
};

// Context keywords trigger confidence boost when present within ±20 chars.
// `demographic` has no regex stage so its keywords are unused (kept empty).
const POSITIVE_KEYWORDS: Record<PIIType, string[]> = {
  rrn:         ['주민', '주민번호', '주민등록', '신원', '인증', 'KYC', '신용평가'],
  bank_acct:   ['계좌', '입금', '송금', '잔액', '은행', '이체', '신한', '국민', '농협', '우리'],
  phone_kr:    ['휴대폰', '전화', '연락처', '번호', 'SMS', '알림', '핸드폰', '문자'],
  credit_card: ['카드', '결제', '결재', '카드번호', '신용카드', '자동결제'],
  email:       ['이메일', 'email', '메일', '주소'],
  demographic: [],
};

// Negative keywords reduce confidence — distinguishes system identifiers from
// real PII. Critical for Clean traps like "NVDA 결제 주문번호 9999-8888-..."
const NEGATIVE_KEYWORDS: Record<PIIType, string[]> = {
  rrn:         [],
  bank_acct:   ['시가총액', '매출', '영업이익', 'CUSIP', 'ISIN', '주문번호', '거래번호'],
  phone_kr:    ['시가총액', '종가', '거래번호', '체결'],
  credit_card: ['주문번호', '거래번호', '식별자', 'CUSIP', 'ISIN'],
  email:       ['github', 'git@', 'SSH', '저장소', 'repo'],
  demographic: [],
};

// Higher priority wins overlap conflicts. CARD > BANK so e.g. P044
// "1234-5678-9012-3456" gets caught as CARD, not as BANK partial match.
// DEMOGRAPHIC is lowest — when it overlaps a token PII, the token wins.
const TYPE_PRIORITY: Record<PIIType, number> = {
  rrn: 5,
  credit_card: 4,
  phone_kr: 3,
  email: 3,
  bank_acct: 2,
  demographic: 1,
};

const CONTEXT_WINDOW = 20;
const STRICT_BASE_CONFIDENCE = 0.85;
const KEYWORD_BOOST = 0.10;
const NEGATIVE_KEYWORD_PENALTY = 0.40;
const LUHN_FAILURE_PENALTY = 0.40;
const MIN_CONFIDENCE_THRESHOLD = 0.50;

export function regexDetect(text: string): PIIDetection[] {
  const detections: PIIDetection[] = [];

  for (const [type, pattern] of Object.entries(PATTERNS) as [PIIType, RegExp][]) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      const match = m[0];
      const start = m.index;
      const end = start + match.length;

      const confidence = computeConfidence(text, type, start, end, match);
      if (confidence < MIN_CONFIDENCE_THRESHOLD) continue;

      detections.push({ type, start, end, match, confidence });
    }
  }

  return dedupeOverlapping(detections);
}

export function maskText(text: string, detections: PIIDetection[]): string {
  // Replace right-to-left so earlier match offsets stay valid.
  const sorted = [...detections].sort((a, b) => b.start - a.start);
  let result = text;
  for (const det of sorted) {
    const tag = `[REDACTED_${det.type.toUpperCase()}]`;
    result = result.slice(0, det.start) + tag + result.slice(det.end);
  }
  return result;
}

function computeConfidence(
  text: string,
  type: PIIType,
  start: number,
  end: number,
  match: string,
): number {
  let confidence = STRICT_BASE_CONFIDENCE;
  if (hasKeyword(text, POSITIVE_KEYWORDS[type], start, end)) {
    confidence += KEYWORD_BOOST;
  }
  if (hasKeyword(text, NEGATIVE_KEYWORDS[type], start, end)) {
    confidence -= NEGATIVE_KEYWORD_PENALTY;
  }
  if (type === 'credit_card' && !luhnCheck(match)) {
    confidence -= LUHN_FAILURE_PENALTY;
  }
  return clamp(confidence, 0, 1);
}

function hasKeyword(text: string, keywords: string[], start: number, end: number): boolean {
  if (keywords.length === 0) return false;
  const windowStart = Math.max(0, start - CONTEXT_WINDOW);
  const windowEnd = Math.min(text.length, end + CONTEXT_WINDOW);
  const window = text.slice(windowStart, windowEnd);
  return keywords.some((kw) => window.includes(kw));
}

function luhnCheck(cardLike: string): boolean {
  const digits = cardLike.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// When two patterns match overlapping spans, keep the higher-priority type.
// Ties broken by confidence, then by length.
// Exported so Stage 2 can reuse for Stage 1+2 combined detections.
export function dedupeOverlapping(detections: PIIDetection[]): PIIDetection[] {
  const sorted = [...detections].sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: PIIDetection[] = [];
  for (const det of sorted) {
    const overlap = kept.find((k) => det.start < k.end && det.end > k.start);
    if (!overlap) {
      kept.push(det);
      continue;
    }
    if (shouldReplace(det, overlap)) {
      kept[kept.indexOf(overlap)] = det;
    }
  }
  return kept;
}

function shouldReplace(newer: PIIDetection, older: PIIDetection): boolean {
  const np = TYPE_PRIORITY[newer.type];
  const op = TYPE_PRIORITY[older.type];
  if (np !== op) return np > op;
  if (newer.confidence !== older.confidence) return newer.confidence > older.confidence;
  return newer.end - newer.start > older.end - older.start;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
