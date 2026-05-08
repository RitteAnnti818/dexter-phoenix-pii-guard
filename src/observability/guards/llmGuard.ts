// Stage 2 — contextual PII detection with optional LLM adjudication.
//
// Targets obfuscation cases that Stage 1 regex can't handle:
//   • korean_numerals      — digits as Korean words ("공일공" = 010)
//   • reversed             — digit-reversed PII when invalid format
//   • contextual_inference — DEMOGRAPHIC clues (강남구 35세 김씨 여성)
//   • spaced (EMAIL)       — letter-by-letter spaced email
//   • encoded              — base64 / URL-encoded PII
//   • unicode              — full-width, circled, CJK digits, zero-width separators
//   • natural language     — split identifiers ("first group 110, middle 123...")
//
// LLM adjudication pattern reused from src/observability/evaluators/judge.ts:
//   - JSON mode (response_format)
//   - temperature=0 for deterministic output
//   - 1 retry on parse failure, then graceful fallback to []

import { ChatOpenAI } from '@langchain/openai';
import { dedupeOverlapping, regexDetect, type PIIDetection, type PIIType } from './regexGuard.js';

const DEFAULT_MODEL = 'gpt-4o-mini';
const FALLBACK_CONFIDENCE = 0.7;

let llm: ChatOpenAI | null = null;

function getLlm(): ChatOpenAI {
  if (llm) return llm;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('[llmGuard] OPENAI_API_KEY not set — required for Stage 2');
  }
  llm = new ChatOpenAI({
    model: process.env.PII_GUARD_MODEL ?? DEFAULT_MODEL,
    apiKey,
    temperature: 0,
    modelKwargs: { response_format: { type: 'json_object' } },
  });
  return llm;
}

const SYSTEM_PROMPT = `당신은 한국어 PII(개인정보) 탐지 전문가입니다.
사용자 입력에서 개인정보를 정확히 식별하고 마스킹할 substring을 반환합니다.

탐지 대상 6종 타입:
- RRN: 주민등록번호
- BANK_ACCT: 은행 계좌번호
- PHONE_KR: 한국 휴대폰 번호 (010, 011, 016, 017, 018, 019)
- CREDIT_CARD: 신용카드 번호
- EMAIL: 이메일 주소
- DEMOGRAPHIC: 인구통계 추론 정보 (지역+나이+성+성별 조합 등)

특히 주의할 난독화 케이스:
1. 한글 수사 — "공일공"=010, "일이삼사"=1234, "팔오영육일오"=850615
2. 자모/숫자 띄어쓰기 — "9 0 1 2 3 1 - 1 2 3 4 5 6 7", "h o n g . g d @ ..."
3. 특수문자 삽입 — 110@123@456789, 010_1234_5678, 1234*5678*...
4. 역순 표기 — "역순으로", "거꾸로" 키워드 + 정상 형식과 다른 숫자 그룹
5. 맥락 추론 (DEMOGRAPHIC) — "강남구 역삼동 사는 35세 김씨 여성" 같은 식별 가능 정보

False positive 회피 (PII 아님):
- 매출/시가총액/주가 같은 금융 수치 ("3050000000000달러")
- 시스템 식별자: ISIN, CUSIP, 주문번호, 거래번호, 옵션코드
- 트위터 핸들 (@AAPL), Git URL (git@github.com)
- 메모리 참조 표현이지만 PII 토큰 자체는 없는 경우 ("지난번에 알려드린 계좌")

출력은 반드시 다음 JSON 형식 (다른 텍스트 금지):
{
  "detections": [
    {
      "type": "RRN" | "BANK_ACCT" | "PHONE_KR" | "CREDIT_CARD" | "EMAIL" | "DEMOGRAPHIC",
      "match": "입력 텍스트에 그대로 등장하는 정확한 substring",
      "confidence": 0.0-1.0,
      "reason": "판단 근거 한 문장"
    }
  ],
  "reasoning": "전체 판단 한두 문장"
}

중요 규칙:
- match 필드는 반드시 입력 텍스트에 그대로 등장하는 정확한 substring (한 글자도 다르면 안 됨).
- 조사(은/는/이/가/로/을/를/에/의 등)와 서술어(인데요/입니다/예요 등)는 match에 포함하지 마세요.
- DEMOGRAPHIC은 인구통계 명사구만 ("강남구 역삼동 사는 35세 김씨 여성"). 조사·서술어 제외.
- 같은 PII는 1번만 반환. PII 없으면 detections는 빈 배열.
- **한글 수사로 표기된 숫자 그룹은 띄어쓰기로 분리되어 있어도 한 번호의 일부**입니다. 절대 분할하지 마세요.
- **역순/거꾸로 키워드 옆 숫자는 전체 substring을 한 PII로 마스킹**합니다.
- DEMOGRAPHIC은 **직장/직업/거주지/나이/성/성별 모두 포함하는 최대 명사구**로.

예시 (반드시 따르세요):

입력: "공일공 일이삼사 오륙칠팔로 알림 보내줘"
출력: {"detections":[{"type":"PHONE_KR","match":"공일공 일이삼사 오륙칠팔","confidence":0.95,"reason":"한글 수사 010-1234-5678"}],"reasoning":"한글 수사 휴대폰"}

입력: "주민번호 팔오영육일오 - 이팔칠육오사삼 으로 분석"
출력: {"detections":[{"type":"RRN","match":"팔오영육일오 - 이팔칠육오사삼","confidence":0.95,"reason":"한글 수사 RRN 850615-2876543"}],"reasoning":"하이픈 분리된 한글 수사 RRN"}

입력: "휴대폰 8765-4321-010 (역순으로 말씀드립니다) 로 알림"
출력: {"detections":[{"type":"PHONE_KR","match":"8765-4321-010","confidence":0.95,"reason":"역순으로 표기된 휴대폰 010-1234-5678"}],"reasoning":"역순 휴대폰"}

입력: "삼성전자 다니는 25세 이씨 직장인 포트폴리오 짜줘"
출력: {"detections":[{"type":"DEMOGRAPHIC","match":"삼성전자 다니는 25세 이씨 직장인","confidence":0.85,"reason":"직장+나이+성+직업"}],"reasoning":"식별 가능 인구통계"}

입력: "내 휴대폰 공일공 구팔칠육 오사삼이로 SMS 전송"
출력: {"detections":[{"type":"PHONE_KR","match":"공일공 구팔칠육 오사삼이","confidence":0.95,"reason":"한글 수사 010-9876-5432. '로' 조사 제외."}],"reasoning":"한글 수사 휴대폰"}`;

interface RawDetection {
  type?: string;
  match?: string;
  confidence?: number;
  reason?: string;
}

interface RawResponse {
  detections?: RawDetection[];
  reasoning?: string;
}

const TYPE_LOOKUP: Record<string, PIIType> = {
  RRN: 'rrn',
  BANK_ACCT: 'bank_acct',
  PHONE_KR: 'phone_kr',
  CREDIT_CARD: 'credit_card',
  EMAIL: 'email',
  DEMOGRAPHIC: 'demographic',
};

const HIGH_CONFIDENCE_THRESHOLD = 0.85;
const KOREAN_NUMERAL_SEQUENCE_RE = /[공영령일이삼사오육륙칠팔구][공영령일이삼사오육륙칠팔구\s\-.@_*]*/g;
const ZERO_WIDTH_RE = /[\u200B-\u200D\uFEFF]/;
const URL_ENCODED_RE = /\b[A-Za-z0-9%._+-]*(?:%[0-9A-Fa-f]{2})[A-Za-z0-9%._+-]*\b/g;
const BASE64_RE = /(?<![A-Za-z0-9+/])(?:[A-Za-z0-9+/]{12,}={0,2})(?![A-Za-z0-9+/=])/g;
const UNICODE_DIGITISH_RE =
  /[0-9０-９⓪①②③④⑤⑥⑦⑧⑨零〇一二三四五六七八九][0-9０-９⓪①②③④⑤⑥⑦⑧⑨零〇一二三四五六七八九\s\-.@_*／\/·・,，、－\u200B-\u200D\uFEFF]*/g;
const ENGLISH_DIGIT_WORD_RE =
  /\b(?:zero|oh|o|one|two|three|four|five|six|seven|eight|nine)(?:[\s,.\-_/]+(?:zero|oh|o|one|two|three|four|five|six|seven|eight|nine)){9,}\b/gi;
const DOT_WORD_EMAIL_RE =
  /\b[A-Za-z0-9]+(?:\s+(?:dot|period|점|닷|쩜)\s+[A-Za-z0-9]+)*\s+(?:at|앳|골뱅이)\s+[A-Za-z0-9]+(?:\s+(?:dot|period|점|닷|쩜)\s+[A-Za-z]{2,})+\b/gi;
const CONTEXTUAL_DIGIT_PHRASE_RE =
  /(?:주민번호|주민등록|RRN|신원|KYC|생년월일|뒤\s*7\s*자리|계좌(?:번호)?|은행|카드(?:번호)?|신용카드|휴대폰|핸드폰|전화|연락처)[^\n]{0,96}/gi;

const UNICODE_DIGITS: Record<string, string> = {
  '０': '0',
  '１': '1',
  '２': '2',
  '３': '3',
  '４': '4',
  '５': '5',
  '６': '6',
  '７': '7',
  '８': '8',
  '９': '9',
  '⓪': '0',
  '①': '1',
  '②': '2',
  '③': '3',
  '④': '4',
  '⑤': '5',
  '⑥': '6',
  '⑦': '7',
  '⑧': '8',
  '⑨': '9',
  零: '0',
  〇: '0',
  一: '1',
  二: '2',
  三: '3',
  四: '4',
  五: '5',
  六: '6',
  七: '7',
  八: '8',
  九: '9',
};

const ENGLISH_DIGITS: Record<string, string> = {
  zero: '0',
  oh: '0',
  o: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
};

const TYPE_CONTEXT: Record<PIIType, RegExp> = {
  rrn: /주민|주민등록|RRN|신원|KYC|생년월일|뒤\s*7\s*자리/i,
  bank_acct: /계좌|은행|입금|송금|이체|잔액|bank|account/i,
  phone_kr: /휴대폰|핸드폰|전화|연락처|SMS|알림|phone|mobile|tel/i,
  credit_card: /카드|신용카드|결제|자동결제/i,
  email: /이메일|email|메일|주소/i,
  demographic: /거주|사는|여성|남성|직장인|다니는|나이|프로필/i,
};

export interface LlmGuardOptions {
  /** Stage 1 detections — used for escalation gating */
  stage1Detections?: PIIDetection[];
  /** Force LLM call even when gating would skip (for evaluation) */
  alwaysRun?: boolean;
}

/**
 * Decide whether Stage 2 should run.
 * Skip when:
 *   • Stage 1 already has high-confidence detection (escalation gating), OR
 *   • Input text shows no obfuscation hints (bypass heuristic)
 */
export function shouldSkipStage2(
  text: string,
  stage1: PIIDetection[] | undefined,
): boolean {
  if (stage1 && stage1.some((d) => d.confidence >= HIGH_CONFIDENCE_THRESHOLD)) {
    return true;
  }
  if (!hasStage2EscalationHint(text)) {
    return true;
  }
  return false;
}

// Patterns that hint at obfuscation requiring Stage 2 LLM. If none of these
// trigger AND Stage 1 found nothing, the input is almost certainly clean and
// we can skip the LLM call. Keep this conservative: broad Korean suffix
// matches are costly and can turn clean finance prompts into LLM timeouts.
export function hasStage2EscalationHint(text: string): boolean {
  return (
    hasKoreanNumeralSequenceHint(text) ||
    hasAdvancedEncodingHint(text) ||
    hasUnicodeDigitHint(text) ||
    hasDelimitedPiiPhraseHint(text) ||
    hasDotWordEmailHint(text) ||
    hasEnglishDigitSequenceHint(text) ||
    /역순|거꾸로|뒤집/.test(text) ||
    /(?:^|[^가-힣])[가-힣]씨(?:\s|$|[^가-힣])/.test(text) ||
    /\d+\s*(년생|세|살|대)/.test(text) ||
    hasLocationContextHint(text) ||
    /다니는|근무|거주/.test(text) ||
    /[a-zA-Z]\s[a-zA-Z]\s[a-zA-Z]\s*[.@]/.test(text)
  );
}

function hasAdvancedEncodingHint(text: string): boolean {
  URL_ENCODED_RE.lastIndex = 0;
  return ZERO_WIDTH_RE.test(text) || hasPlausibleBase64Token(text) || URL_ENCODED_RE.test(text);
}

function hasPlausibleBase64Token(text: string): boolean {
  BASE64_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BASE64_RE.exec(text)) !== null) {
    const raw = match[0];
    if (!looksLikeBase64(raw)) continue;
    const decoded = decodeBase64(raw);
    if (decoded && firstDetectedType(decoded)) return true;
  }
  return false;
}

function hasUnicodeDigitHint(text: string): boolean {
  return /[０-９⓪①②③④⑤⑥⑦⑧⑨零〇一二三四五六七八九]/.test(text);
}

function hasDelimitedPiiPhraseHint(text: string): boolean {
  CONTEXTUAL_DIGIT_PHRASE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CONTEXTUAL_DIGIT_PHRASE_RE.exec(text)) !== null) {
    if ((match[0].match(/\d/g) ?? []).length >= 2) return true;
  }
  return false;
}

function hasDotWordEmailHint(text: string): boolean {
  DOT_WORD_EMAIL_RE.lastIndex = 0;
  return DOT_WORD_EMAIL_RE.test(text);
}

function hasEnglishDigitSequenceHint(text: string): boolean {
  ENGLISH_DIGIT_WORD_RE.lastIndex = 0;
  return ENGLISH_DIGIT_WORD_RE.test(text);
}

function hasKoreanNumeralSequenceHint(text: string): boolean {
  KOREAN_NUMERAL_SEQUENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = KOREAN_NUMERAL_SEQUENCE_RE.exec(text)) !== null) {
    const koreanDigitCount = match[0].replace(/[^공영령일이삼사오육륙칠팔구]/g, '').length;
    if (koreanDigitCount >= 3) return true;
  }
  return false;
}

function hasLocationContextHint(text: string): boolean {
  const location = '[가-힣]{2,}(?:구|동)';
  const context = '(?:거주|사는|주소|프로필|주민|신원)';
  return new RegExp(`${context}.{0,12}${location}|${location}.{0,12}${context}`).test(text);
}

export async function llmDetect(
  text: string,
  options: LlmGuardOptions = {},
): Promise<PIIDetection[]> {
  if (!options.alwaysRun && shouldSkipStage2(text, options.stage1Detections)) {
    return [];
  }

  const contextual = localContextualDetect(text);
  if (contextual.length > 0 && process.env.PII_GUARD_STAGE2_LLM_ALWAYS !== '1') {
    return contextual;
  }

  let model: ChatOpenAI;
  try {
    model = getLlm();
  } catch {
    return contextual;
  }
  let raw: string | null = null;

  for (let attempt = 0; attempt < 2 && raw === null; attempt++) {
    try {
      const response = await model.invoke([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `입력 텍스트:\n${text}` },
      ]);
      raw = typeof response.content === 'string'
        ? response.content
        : JSON.stringify(response.content);
    } catch {
      if (attempt === 1) return [];
    }
  }
  if (raw === null) return [];

  let parsed: RawResponse;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed.detections || !Array.isArray(parsed.detections)) return [];

  const out: PIIDetection[] = [];
  const seenSpans = new Set<string>();

  for (const det of parsed.detections) {
    const type = normalizeType(det.type);
    if (!type) continue;
    if (typeof det.match !== 'string' || det.match.length === 0) continue;

    // LLM-reported indices are unreliable. Find span ourselves.
    const start = text.indexOf(det.match);
    if (start === -1) continue; // hallucinated match — skip

    const end = start + det.match.length;
    const spanKey = `${type}:${start}:${end}`;
    if (seenSpans.has(spanKey)) continue;
    seenSpans.add(spanKey);

    out.push({
      type,
      start,
      end,
      match: det.match,
      confidence: clampNumber(det.confidence ?? FALLBACK_CONFIDENCE),
    });
  }

  return dedupeOverlapping([...contextual, ...out]);
}

export function contextualDetectSync(text: string): PIIDetection[] {
  if (!hasStage2EscalationHint(text)) return [];
  return localContextualDetect(text);
}

function localContextualDetect(text: string): PIIDetection[] {
  return dedupeOverlapping([
    ...detectEncodedTokens(text),
    ...detectUnicodeDigitSequences(text),
    ...detectDelimitedPiiPhrases(text),
    ...detectDotWordEmails(text),
    ...detectEnglishDigitSequences(text),
  ]);
}

function detectEncodedTokens(text: string): PIIDetection[] {
  return dedupeOverlapping([
    ...detectBase64Tokens(text),
    ...detectUrlEncodedTokens(text),
  ]);
}

function detectBase64Tokens(text: string): PIIDetection[] {
  const out: PIIDetection[] = [];
  BASE64_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BASE64_RE.exec(text)) !== null) {
    const raw = match[0];
    if (!looksLikeBase64(raw)) continue;
    if (raw.length % 4 === 1) continue;
    const decoded = decodeBase64(raw);
    if (!decoded) continue;
    const type =
      classifyDigits(decoded.replace(/\D/g, ''), contextWindow(text, match.index, match.index + raw.length)) ??
      firstDetectedType(decoded);
    if (!type) continue;
    out.push(buildDetection(type, match.index, match.index + raw.length, raw, 0.94));
  }
  return out;
}

function detectUrlEncodedTokens(text: string): PIIDetection[] {
  const out: PIIDetection[] = [];
  URL_ENCODED_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = URL_ENCODED_RE.exec(text)) !== null) {
    const raw = match[0];
    const decoded = safeDecodeURIComponent(raw);
    if (!decoded || decoded === raw) continue;
    const type =
      classifyDigits(decoded.replace(/\D/g, ''), contextWindow(text, match.index, match.index + raw.length)) ??
      firstDetectedType(decoded);
    if (!type) continue;
    out.push(buildDetection(type, match.index, match.index + raw.length, raw, 0.94));
  }
  return out;
}

function detectUnicodeDigitSequences(text: string): PIIDetection[] {
  const out: PIIDetection[] = [];
  UNICODE_DIGITISH_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = UNICODE_DIGITISH_RE.exec(text)) !== null) {
    const raw = trimDecorativeSeparators(match[0]);
    if (!raw) continue;
    const digits = normalizeUnicodeDigits(raw);
    if (digits.length < 10) continue;
    const ctx = contextWindow(text, match.index, match.index + raw.length);
    const type = classifyDigits(digits, ctx);
    if (!type) continue;
    out.push(buildDetection(type, match.index, match.index + raw.length, raw, 0.92));
  }
  return out;
}

function detectDelimitedPiiPhrases(text: string): PIIDetection[] {
  const out: PIIDetection[] = [];
  CONTEXTUAL_DIGIT_PHRASE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CONTEXTUAL_DIGIT_PHRASE_RE.exec(text)) !== null) {
    const segment = match[0];
    const digitMatches = [...segment.matchAll(/\d{2,}/g)];
    if (digitMatches.length === 0) continue;
    const digits = digitMatches.map((m) => m[0]).join('');
    if (digits.length < 10) continue;
    const type = classifyDigits(digits, segment);
    if (!type) continue;

    const first = digitMatches[0];
    const last = digitMatches[digitMatches.length - 1];
    const firstIndex = first.index;
    const lastIndex = last.index;
    if (firstIndex === undefined || lastIndex === undefined) continue;
    const start = match.index + firstIndex;
    const end = match.index + lastIndex + last[0].length;
    const raw = trimDecorativeSeparators(text.slice(start, end));
    out.push(buildDetection(type, start, start + raw.length, raw, 0.9));
  }
  return out;
}

function detectDotWordEmails(text: string): PIIDetection[] {
  const out: PIIDetection[] = [];
  DOT_WORD_EMAIL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DOT_WORD_EMAIL_RE.exec(text)) !== null) {
    const raw = match[0];
    const normalized = raw
      .replace(/\s+(?:at|앳|골뱅이)\s+/gi, '@')
      .replace(/\s+(?:dot|period|점|닷|쩜)\s+/gi, '.')
      .replace(/\s+/g, '');
    if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(normalized)) continue;
    out.push(buildDetection('email', match.index, match.index + raw.length, raw, 0.93));
  }
  return out;
}

function detectEnglishDigitSequences(text: string): PIIDetection[] {
  const out: PIIDetection[] = [];
  ENGLISH_DIGIT_WORD_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ENGLISH_DIGIT_WORD_RE.exec(text)) !== null) {
    const raw = match[0];
    const digits = raw
      .toLowerCase()
      .split(/[\s,.\-_/]+/)
      .map((token) => ENGLISH_DIGITS[token] ?? '')
      .join('');
    if (digits.length < 10) continue;
    const ctx = contextWindow(text, match.index, match.index + raw.length);
    const type = classifyDigits(digits, ctx);
    if (!type) continue;
    out.push(buildDetection(type, match.index, match.index + raw.length, raw, 0.91));
  }
  return out;
}

function firstDetectedType(decoded: string): PIIType | null {
  const regex = regexDetect(decoded);
  if (regex.length > 0) return regex[0].type;
  const digits = decoded.replace(/\D/g, '');
  return classifyDigits(digits, decoded);
}

function classifyDigits(digits: string, ctx: string): PIIType | null {
  if (/^01[016789]\d{7,8}$/.test(digits)) return 'phone_kr';
  if (/^\d{6}[1-4]\d{6}$/.test(digits)) return 'rrn';
  if (TYPE_CONTEXT.rrn.test(ctx) && digits.length === 13) return 'rrn';
  if (TYPE_CONTEXT.phone_kr.test(ctx) && digits.length >= 10 && digits.length <= 11) return 'phone_kr';
  if (TYPE_CONTEXT.bank_acct.test(ctx) && digits.length >= 10 && digits.length <= 14) return 'bank_acct';
  if (TYPE_CONTEXT.credit_card.test(ctx) && digits.length >= 13 && digits.length <= 19) return 'credit_card';
  return null;
}

function normalizeUnicodeDigits(value: string): string {
  let out = '';
  for (const ch of value) {
    if (UNICODE_DIGITS[ch] !== undefined) out += UNICODE_DIGITS[ch];
    else if (/\d/.test(ch)) out += ch;
  }
  return out;
}

function decodeBase64(value: string): string | null {
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    if (!decoded || /[\u0000-\u0008\u000E-\u001F]/.test(decoded)) return null;
    return decoded;
  } catch {
    return null;
  }
}

function looksLikeBase64(value: string): boolean {
  return /[A-Za-z+/]/.test(value) && value.length >= 12;
}

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function buildDetection(
  type: PIIType,
  start: number,
  end: number,
  match: string,
  confidence: number,
): PIIDetection {
  return { type, start, end, match, confidence };
}

function contextWindow(text: string, start: number, end: number): string {
  return text.slice(Math.max(0, start - 32), Math.min(text.length, end + 32));
}

function trimDecorativeSeparators(value: string): string {
  return value.replace(/^[\s,，、.:：;；/／·・－-]+|[\s,，、.:：;；/／·・－-]+$/g, '');
}

function normalizeType(raw: string | undefined): PIIType | null {
  if (typeof raw !== 'string') return null;
  return TYPE_LOOKUP[raw.toUpperCase().trim()] ?? null;
}

function clampNumber(n: unknown): number {
  const num = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(num)) return FALLBACK_CONFIDENCE;
  return Math.min(1, Math.max(0, num));
}
