# Dexter × Phoenix — AI Observability + PII Guard

> 오픈소스 금융 리서치 에이전트 [Dexter](https://github.com/virattt/dexter)에 **엔터프라이즈급 AI Observability**와 **한국어 PII 3-Stage Guard**를 붙인 모듈입니다.

[![Stack](https://img.shields.io/badge/stack-TypeScript%20%2B%20Bun-blue)]()
[![Phoenix](https://img.shields.io/badge/Phoenix-trace%20%26%20eval-purple)]()
[![Status](https://img.shields.io/badge/Week_1-Hallucination_55%2F55-green)]()
[![Status](https://img.shields.io/badge/Week_2-PII_Guard_P%2FR%2FF1=1.000-green)]()

---

## TL;DR

| Week | 목표 | 결과 |
|------|------|------|
| **Week 1** | LLM agent의 환각률을 정량 측정 | 50문항 평가 + 5종 Evaluator + A/B 실험 → trade-off 정량 발견 |
| **Week 2** | 한국어 PII 자동 탐지·마스킹 | 100건 데이터셋 P/R/F1 = **1.000** + Output Guard 15/15 차단 |

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
   ▼ 미감지 + 난독화 hint 발견
Stage 2 — LLM Guard  (gpt-4o-mini, ~2s, 17% 입력만 도달)
   │ 한글 수사 / 역순 / 맥락 추론 (DEMOGRAPHIC)
   ▼ 마스킹된 입력
Dexter Agent
   │
   ▼ 응답
Output Guard         (memory_seed PII 차단)
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
| Latency mean | 477ms | (LLM-bound) |
| Latency p50 | 0ms | (83% 입력 즉시 처리) |

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
bun run scripts/check-stage2.ts --obf                 # obfuscated 20건만
bun run scripts/check-output-guard.ts                 # Output Guard 7-case

# 전체 평가 (Phoenix trace 생성 포함)
bun run scripts/run-pii-evals.ts                      # 100건 → JSONL + trace
bun run scripts/run-pii-evals.ts --category obfuscated  # 카테고리 부분 평가

# Week 1 평가 시 PII Guard 우회 (12자리 매출 숫자 오탐 방지)
PII_GUARD_DISABLED=1 bun run scripts/run-evals.ts
```

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
| `PII_GUARD_DISABLED` | (꺼짐) | `1`이면 Span Processor redaction 우회 |
| `PII_GUARD_MODEL` | `gpt-4o-mini` | Stage 2 LLM Guard 모델 |

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
│           └── pii_100samples.json        # Week 2 — 100건 (5종 카테고리)
│
├── scripts/
│   ├── phoenix-smoketest.ts               # Phoenix 연결 검증
│   ├── run-evals.ts                       # Week 1 — 50문항 → 5 evaluator → JSONL
│   ├── compare-evals.ts                   # Week 1 — baseline vs improved A/B
│   ├── check-stage1.ts                    # Week 2 — Stage 1 sanity check
│   ├── check-stage2.ts                    # Week 2 — Stage 1+2 통합 sanity check
│   ├── check-output-guard.ts              # Week 2 — Output Guard 7-case 검증
│   ├── run-pii-evals.ts                   # Week 2 — 100건 → Phoenix trace + JSONL
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
