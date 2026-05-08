// Stage 2 — LLM-based contextual PII detection.
//
// Targets obfuscation cases that Stage 1 regex can't handle:
//   • korean_numerals      — digits as Korean words ("공일공" = 010)
//   • reversed             — digit-reversed PII when invalid format
//   • contextual_inference — DEMOGRAPHIC clues (강남구 35세 김씨 여성)
//   • spaced (EMAIL)       — letter-by-letter spaced email
//
// Pattern reused from src/observability/evaluators/judge.ts:
//   - JSON mode (response_format)
//   - temperature=0 for deterministic output
//   - 1 retry on parse failure, then graceful fallback to []

import { ChatOpenAI } from '@langchain/openai';
import type { PIIDetection, PIIType } from './regexGuard.js';

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

// Patterns that hint at obfuscation requiring Stage 2 LLM. If none of these
// trigger AND Stage 1 found nothing, the input is almost certainly clean and
// we can skip the LLM call.
const OBFUSCATION_HINTS: RegExp[] = [
  /[공일이삼사오육칠팔구영]\s*[공일이삼사오육칠팔구영]/,  // korean numerals (consecutive)
  /역순|거꾸로|뒤집/,                                      // reversed PII keywords
  /[가-힣]씨/,                                             // 성씨 (DEMOGRAPHIC)
  /\d+\s*(년생|세|살|대)/,                                 // age / 출생연도
  /[가-힣]+(구|동)/,                                       // 거주지 (구/동)
  /다니는|근무|거주/,                                      // 직장/거주
  /[a-zA-Z]\s[a-zA-Z]\s[a-zA-Z]\s*[.@]/,                   // letter-spaced email
];

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
  if (!OBFUSCATION_HINTS.some((re) => re.test(text))) {
    return true;
  }
  return false;
}

export async function llmDetect(
  text: string,
  options: LlmGuardOptions = {},
): Promise<PIIDetection[]> {
  if (!options.alwaysRun && shouldSkipStage2(text, options.stage1Detections)) {
    return [];
  }

  const model = getLlm();
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

    // LLM-reported indices are unreliable. Find spans ourselves — every
    // occurrence, since the same PII can repeat (e.g. "주민번호 X 입니다.
    // 다시 X 확인 부탁드립니다.").
    let from = 0;
    while (from <= text.length) {
      const start = text.indexOf(det.match, from);
      if (start === -1) break; // hallucinated or no further match
      const end = start + det.match.length;
      const spanKey = `${type}:${start}:${end}`;
      if (!seenSpans.has(spanKey)) {
        seenSpans.add(spanKey);
        out.push({
          type,
          start,
          end,
          match: det.match,
          confidence: clampNumber(det.confidence ?? FALLBACK_CONFIDENCE),
        });
      }
      from = end;
    }
  }

  return out;
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
