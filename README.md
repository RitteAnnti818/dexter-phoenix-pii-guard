# Dexter × Phoenix — AI Observability + PII Guard

> 오픈소스 금융 리서치 에이전트 [Dexter](https://github.com/virattt/dexter)에 **엔터프라이즈급 AI Observability**와 **한국어 PII 3-Stage Guard**를 붙인 모듈입니다.

[![Stack](https://img.shields.io/badge/stack-TypeScript%20%2B%20Bun-blue)]()
[![Phoenix](https://img.shields.io/badge/Phoenix-trace%20%26%20eval-purple)]()
[![Status](https://img.shields.io/badge/Week_1-Hallucination_55%2F55-green)]()
[![Status](https://img.shields.io/badge/Week_2-PII_Guard_P%2FR%2FF1=1.000-green)]()
[![Status](https://img.shields.io/badge/Finance_PII_Benchmark-170_synthetic_rows-blue)]()

---

## TL;DR

| Week | 목표 | 결과 |
|------|------|------|
| **Week 1** | LLM agent의 환각률을 정량 측정 | 50문항 평가 + 5종 Evaluator + A/B 실험 → trade-off 정량 발견 |
| **Week 2** | 한국어 PII 자동 탐지·마스킹 | 100건 데이터셋 P/R/F1 = **1.000** + Output Guard 15/15 차단 |
| **Finance Benchmark** | 금융 서비스 PII/민감정보 실효성 평가 | 공개 금융 문맥 기반 synthetic 170건 + 세분 타입 baseline gap 측정 |

---

## Quick Start

### 사전 요구사항
- Bun ≥ 1.0
- Docker (Phoenix 로컬 실행)
- OpenAI API Key + Financial Datasets API Key

### 5분 셋업

```bash
# 1. Phoenix Docker
docker run -d -p 6006:6006 -p 4317:4317 arizephoenix/phoenix:latest

# 2. 의존성 설치
bun install

# 3. 환경변수
cp env.example .env
# OPENAI_API_KEY=...
# FINANCIAL_DATASETS_API_KEY=...

# 4. Phoenix 연결 검증
bun run scripts/phoenix-smoketest.ts

# 5. Dexter 실행
bun start
```

→ http://localhost:6006 → `dexter` 프로젝트에서 trace 확인.

---

## 핵심 기능

### 🔍 Week 1 — Hallucination 측정 파이프라인

```
사용자 질의
   │
   ▼
Dexter Agent ───► AGENT > CHAIN > LLM > TOOL span tree (Phoenix UI)
   │
   └─► 답변 ───► 5종 Evaluator ───► 점수 + JSONL
                  ├─ Factual Accuracy   (수치 정확도)
                  ├─ Groundedness       (tool 출처 일치)
                  ├─ Tool Correctness   (도구 선택 정확)
                  ├─ Refusal            (모르면 거절)
                  └─ Plan Quality       (reasoning 품질)
```


### 🛡️ Week 2 — PII 3-Stage Guard

```
사용자 입력
   │
   ▼
Stage 1 — Regex      (deterministic, ~1ms)
   │ 5종 정규식 + Luhn + context keyword scoring
   ▼ deterministic normalizer
Stage 1.5 — Normalizer
   │ 한글 수사 / 역순 / spaced email / DEMOGRAPHIC 패턴을 LLM 없이 탐지
   ▼ 미감지 + 난독화 hint 발견
Stage 2 — Contextual Guard + LLM adjudication
   │ 인코딩/유니코드/자연어 분할/영문·중문 숫자 hardcase 우선 정규화
   │ 남은 애매한 문맥은 LLM adjudication
   ▼ 마스킹된 입력
Dexter Agent
   │
   ▼ 응답
Output Guard         (memory_seed PII 차단)
   │ raw token 대신 salted HMAC fingerprint로 cross-session leak 비교
   │
   ▼ trace
Stage 3 Span Processor (Phoenix 송출 직전 last line of defense)
   │
   ▼
[사용자에게 전달]
```


---

## 측정 결과

### Week 1 — Hallucination A/B 실험 (gpt-4o-mini, 50문항)

| Metric | Baseline | + Anti-Hallucination | Δ |
|---|---|---|---|
| **Trap Refusal Rate** | 60% | **100%** | **+40pp** |
| Factual Accuracy | 0.20 | 0.05 | -15pp |
| Groundedness | 0.47 | 0.04 | -43pp |
| Tool Correctness | 0.90 | 0.93 | +3pp |

→ 환각 방지 프롬프트가 trap을 100% 거절하지만 정상 질문도 거절하는 over-correction trade-off를 정량 발견.

### Week 2 — PII Guard 100건 평가

| Metric | 결과 | 목표 |
|---|---|---|
| **Precision** | **1.000** | ≥ 0.90 ✓ |
| **Recall** | **1.000** | ≥ 0.85 ✓ |
| **F1** | **1.000** | ≥ 0.87 ✓ |
| Obfuscated Recall | **1.000** | ≥ 0.70 ✓ |
| Output Guard cross-session | **15/15 차단** | 100% |
| Stage2-only hardcases | **30/30 차단** | Stage1/1.5 탐지 0건, Stage2 추가 30건 |
| Base eval latency p95 | 1ms | 100건 기준 |
| Stage2 hardcase latency p95 | 1ms | 30건 기준 |

```
Category         n   TP  PART  FN  FP  TN
clean            40   0     0   0   0  40    ← 13개 trap 모두 회피
direct           25  25     0   0   0   0
obfuscated       20  20     0   0   0   0    ← 5패턴 × 4건 모두 catch
cross_session    10   0     0   0   0  10
prompt_injection  5   0     0   0   0   5
```

---

## 사용법

### 인터랙티브 (TUI)
```bash
bun start                              # Dexter 실행 + Phoenix trace 자동 누적
```

### Week 1 — Hallucination 평가
```bash
bun run scripts/run-evals.ts                          # 50문항 전체
bun run scripts/run-evals.ts --limit 5                # 빠른 smoke
bun run scripts/run-evals.ts --level trap             # trap만
DEXTER_PROMPT_VARIANT=improved bun run scripts/run-evals.ts  # A/B
bun run scripts/compare-evals.ts <baseline> <improved>       # 비교 리포트
```

### Week 2 — PII Guard
```bash
# Sanity check
bun run scripts/check-stage1.ts                       # Stage 1 단독 (deterministic)
bun run scripts/check-stage2.ts                       # Stage 1+2 통합
bun run scripts/check-stage2.ts --stage2-hard         # Stage 2-only hardcase 30건
bun test src/observability/guards/piiGuard.test.ts    # Orchestrator deterministic regression
bun run scripts/check-stage2.ts --obf                 # obfuscated 20건만
bun run scripts/check-output-guard.ts                 # Output Guard 7-case

# 전체 평가 (Phoenix trace 생성 포함)
bun run scripts/run-pii-evals.ts                      # 100건 → JSONL + trace
bun run scripts/run-pii-evals.ts --category obfuscated  # 카테고리 부분 평가
bun run scripts/run-pii-evals.ts --stage2-hard        # Stage2 hardcase JSONL + trace
bun run scripts/validate-pii-finance-dataset.ts       # 금융 benchmark 스키마/분포 검증
bun run scripts/run-pii-evals.ts --finance            # 금융 170건 baseline gap 측정
bun run scripts/run-pii-evals.ts --all-pii            # 기존 100 + hardcase 30 + 금융 170 = 300건

# Week 1 평가 시 PII Guard 우회 (12자리 매출 숫자 오탐 방지)
PII_GUARD_DISABLED=1 bun run scripts/run-evals.ts
```

`.dexter/pii-evals/` 산출물은 로컬 검증 artifact로만 취급하며 Git에 커밋하지 않습니다.

금융 benchmark는 현재 Guard 변경을 강제하지 않는 baseline dataset입니다. `CUSTOMER_ID`, `AUTH_SECRET`, `TRANSACTION_REF`, `SECURITIES_ACCOUNT`, `LOAN_ID`, `INSURANCE_POLICY`, `MYDATA_ID`, `BUSINESS_ID`, `FINANCIAL_PROFILE` 같은 세분 타입은 평가 row와 리포트에 먼저 도입되며, 실제 마스킹 runtime 확장은 후속 `enhance/pii-finance-guard` 브랜치에서 처리합니다.

금융 benchmark 작성 원칙:
- 실제 고객 데이터, 내부 운영 로그, 운영 스크린샷은 사용하지 않습니다.
- 공개 금융 서비스 문맥만 참고하고 식별자 값은 모두 합성합니다.
- clean trap은 ISIN, CUSIP, SWIFT, MCC, 상품코드, 시스템 job id처럼 PII와 닮았지만 개인 식별자가 아닌 값으로 구성합니다.
- CI는 `validate-pii-finance-dataset.ts`만 hard gate로 실행합니다. 금융 세분 타입 recall은 아직 baseline gap이므로 CI 실패 조건이 아닙니다.

운영 경계:
- TUI와 WhatsApp Gateway는 Agent 호출 전에 입력을 마스킹합니다.
- Agent 최종 응답과 WhatsApp outbound는 전송 전에 다시 검사합니다.
- in-memory history, persistent memory, scratchpad, large tool-result 파일, Phoenix span attribute는 저장 직전에 동기 redaction을 적용합니다.
- 평가 JSONL은 raw PII 대신 masked input, masked output, redacted detection label, leak fingerprint만 저장합니다.

### 자체 Dashboard (실시간 시각화)

Phoenix UI는 trace viewer 위주라 차트가 부족. 자체 정적 dashboard를 3가지 모드로 제공:

```bash
# Serve (localhost 서버, 평가 진행 중 실시간 확인)
bun run scripts/build-dashboard.ts --serve            # http://localhost:7777
bun run scripts/build-dashboard.ts --serve --port 8080
```

---

## 환경변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PHOENIX_COLLECTOR_ENDPOINT` | `http://localhost:6006/v1/traces` | OTLP HTTP 수신 주소 |
| `PHOENIX_API_KEY` | (없음) | Phoenix Cloud 인증 |
| `PHOENIX_PROJECT_NAME` | `dexter` | Phoenix UI 프로젝트 |
| `PHOENIX_DISABLED` | (꺼짐) | `1`이면 telemetry 차단 |
| `PHOENIX_DEBUG` | (꺼짐) | `1`이면 OTel diag 로그 verbose |
| `DEXTER_PROMPT_VARIANT` | `baseline` | `improved`로 환각 방지 프롬프트 |
| `DEXTER_EVAL_MODEL` | `gpt-4o-mini` | 평가 시 agent 모델 |
| `EVAL_JUDGE_MODEL` | `gpt-4o-mini` | LLM-Judge 모델 |
| `PII_GUARD_DISABLED` | (꺼짐) | `1`이면 Guard redaction 우회. 운영 환경에서는 사용 금지 |
| `PII_GUARD_MODEL` | `gpt-4o-mini` | Stage 2 LLM Guard 모델 |
| `PII_GUARD_STAGE2_TIMEOUT_MS` | `450` | Stage 2 보조 판정 timeout |
| `PII_GUARD_FINGERPRINT_SALT` | `dexter-local-dev-pii-guard-salt` | cross-session leak fingerprint salt. 운영에서는 별도 secret 필수 |

---

## 프로젝트 구조

```
.
├── src/
│   ├── index.tsx                          # entry — telemetry init이 LangChain 임포트보다 먼저
│   ├── agent/
│   │   ├── agent.ts                       # AGENT/CHAIN/LLM span 주입
│   │   ├── tool-executor.ts               # TOOL span 주입
│   │   └── prompts.ts                     # DEXTER_PROMPT_VARIANT 스위치 + 환각방지 프롬프트
│   └── observability/
│       ├── telemetry.ts                   # Phoenix OTLP exporter + PIIRedactingSpanProcessor wrap
│       ├── spanProcessors.ts              # Stage 3 — Proxy 기반 PII redaction
│       ├── evaluators/                    # Week 1 — 5종 Evaluator
│       │   ├── types.ts                   # EvalResult / AgentRunCapture / DatasetRow
│       │   ├── judge.ts                   # LLM-as-Judge 헬퍼 (JSON mode, temp=0)
│       │   ├── hallucination.ts           # Factual Accuracy + Groundedness
│       │   ├── toolCorrectness.ts         # 도구 선택 + ticker 매칭
│       │   ├── refusal.ts                 # 트랩 거절 적절성
│       │   └── planQuality.ts             # reasoning 품질
│       ├── guards/                        # Week 2 — PII 3-Stage Guard
│       │   ├── regexGuard.ts              # Stage 1 — 5종 정규식 + confidence
│       │   ├── llmGuard.ts                # Stage 2 — LLM Guard + escalation gating
│       │   └── outputGuard.ts             # Output Guard — cross-session leak 차단
│       └── datasets/
│           ├── hallucination_50q.json     # Week 1 — 50문항 (Easy/Medium/Hard/Trap)
│           ├── pii_100samples.json        # Week 2 — 100건 (5종 카테고리)
│           ├── pii_stage2_hardcases.json  # Stage 2 — 30건 hardcase red-team set
│           └── pii_finance_170samples.json # Finance — 170건 synthetic benchmark
│
├── scripts/
│   ├── phoenix-smoketest.ts               # Phoenix 연결 검증
│   ├── run-evals.ts                       # Week 1 — 50문항 → 5 evaluator → JSONL
│   ├── compare-evals.ts                   # Week 1 — baseline vs improved A/B
│   ├── check-stage1.ts                    # Week 2 — Stage 1 sanity check
│   ├── check-stage2.ts                    # Week 2 — Stage 1+2 통합 sanity check
│   ├── check-output-guard.ts              # Week 2 — Output Guard 7-case 검증
│   ├── run-pii-evals.ts                   # Week 2 — 100건 → Phoenix trace + JSONL
│   ├── validate-pii-finance-dataset.ts    # Finance — 170건 스키마/분포 검증
│   └── build-dashboard.ts                 # Week 2 — Static / Watch / Serve dashboard 빌더
│
├── env.example                            # PHOENIX_*, DEXTER_*, PII_GUARD_* 템플릿
```

---

## 참고 자료

- [Arize Phoenix Docs](https://arize.com/docs/phoenix)
- [Arize Mask & Redact](https://arize.com/docs/ax/instrument/mask-and-redact-data) — Week 2 기반 패턴
- [OpenInference 시맨틱 컨벤션](https://github.com/Arize-ai/openinference)
- [Dexter 원본 저장소](https://github.com/virattt/dexter)
- [Microsoft Presidio](https://microsoft.github.io/presidio/) — 보너스 NLP-기반 PII 탐지

---

## 라이선스 및 배경

전북대 6-7주차 AI Observability 실습 과제 (2026년 4월) 산출물입니다. 원본 Dexter 라이선스를 따르며, 본 모듈은 `feat/phoenix-observability` 브랜치에 추가 구현되어 있습니다.
