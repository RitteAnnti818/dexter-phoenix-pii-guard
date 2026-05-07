#!/usr/bin/env bun
/**
 * One-time setup: insert hallucination_50q dataset + 5 eval prompts + agent config
 * into IQHub's SQLite database.
 *
 * Usage:
 *   bun run scripts/setup-iqhub.ts            # insert (skip if exists)
 *   bun run scripts/setup-iqhub.ts --force     # drop & recreate
 */
import { Database } from 'bun:sqlite';

// ── Config ───────────────────────────────────────────────────────────────────
const IQHUB_DB = process.env.IQHUB_DB
  ?? require('path').resolve(process.cwd(), '../my-own-phoenix/prisma/dev.db');
const DATASET_PATH = 'src/observability/datasets/hallucination_50q.json';
const DATASET_NAME = 'hallucination-50q';
const DATASET_ID = 'ds_hallucination_50q';
const AGENT_PROJECT = 'dexter';

const force = process.argv.includes('--force');

// ── Helpers ──────────────────────────────────────────────────────────────────
function uid(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

const RESET = '\x1b[0m';
const GRN = '\x1b[32m';
const YEL = '\x1b[33m';
const BOLD = '\x1b[1m';

function ok(msg: string) { console.log(`${GRN}✓${RESET} ${msg}`); }
function skip(msg: string) { console.log(`${YEL}→${RESET} ${msg} (already exists, use --force to recreate)`); }

// ── Eval Definitions (API type — calls serve-agent.ts /evaluate) ──────────────
const EVAL_ENDPOINT = 'http://localhost:2024/evaluate';

const EVAL_PROMPTS = [
  { name: 'factual_accuracy', badgeLabel: 'FA', outputMode: 'score',
    description: 'Regex 숫자 추출 + acceptable_range 범위 체크 (deterministic)' },
  { name: 'groundedness', badgeLabel: 'GND', outputMode: 'score',
    description: 'Tool output 기반 LLM-as-Judge — 답변이 도구 결과에 근거하는지' },
  { name: 'tool_correctness', badgeLabel: 'TOOL', outputMode: 'score',
    description: 'required_tool과 실제 호출 도구 일치 여부 (deterministic)' },
  { name: 'refusal', badgeLabel: 'REF', outputMode: 'score',
    description: 'Trap 질문 거절 적절성 — LLM-as-Judge (trap만 평가)' },
  { name: 'plan_quality', badgeLabel: 'PLAN', outputMode: 'score',
    description: 'Planning + Tool 선택 품질 — LLM-as-Judge' },
];

// ── Main ─────────────────────────────────────────────────────────────────────
const db = new Database(IQHUB_DB);
db.exec('PRAGMA journal_mode=WAL');

const now = new Date().toISOString();
const evalNames = EVAL_PROMPTS.map(e => e.name);

// ── 1. Dataset + Rows ────────────────────────────────────────────────────────
console.log(`\n${BOLD}── Dataset ──────────────────────────────────────────${RESET}`);

const existing = db.query('SELECT id FROM Dataset WHERE id = ?').get(DATASET_ID) as any;

if (existing && !force) {
  skip(`Dataset "${DATASET_NAME}"`);
} else {
  if (existing) {
    db.exec(`DELETE FROM DatasetRow WHERE datasetId = '${DATASET_ID}'`);
    db.exec(`DELETE FROM DatasetRun WHERE datasetId = '${DATASET_ID}'`);
    db.exec(`DELETE FROM Dataset WHERE id = '${DATASET_ID}'`);
    ok('Removed existing dataset (--force)');
  }

  const rows: any[] = JSON.parse(await Bun.file(DATASET_PATH).text());

  // Flatten each row: ground_truth becomes a JSON string so IQHub can use it as {context}
  const headers = ['id', 'level', 'category', 'question', 'ground_truth', 'required_tool', 'expected_ticker'];

  db.exec(`
    INSERT INTO Dataset (id, name, fileName, headers, queryCol, contextCol, evalNames, evalOverrides, rowCount, rows, createdAt, updatedAt)
    VALUES ('${DATASET_ID}', '${DATASET_NAME}', 'hallucination_50q.json',
            '${JSON.stringify(headers)}', 'question', 'ground_truth',
            '${JSON.stringify(evalNames)}', '{}',
            ${rows.length}, '[]', '${now}', '${now}')
  `);

  const insertRow = db.prepare(
    'INSERT INTO DatasetRow (id, datasetId, rowIndex, data) VALUES (?, ?, ?, ?)'
  );

  const insertMany = db.transaction((items: any[]) => {
    for (let i = 0; i < items.length; i++) {
      const r = items[i];
      const flat: Record<string, string> = {
        id: r.id,
        level: r.level,
        category: r.category,
        question: r.question,
        ground_truth: JSON.stringify(r.ground_truth),
        required_tool: r.required_tool ?? 'null',
        expected_ticker: r.expected_ticker ?? '',
      };
      insertRow.run(uid('dr'), DATASET_ID, i, JSON.stringify(flat));
    }
  });

  insertMany(rows);
  ok(`Dataset "${DATASET_NAME}" — ${rows.length} rows inserted`);
}

// ── 2. Eval Prompts ──────────────────────────────────────────────────────────
console.log(`\n${BOLD}── Eval Prompts ─────────────────────────────────────${RESET}`);

for (const ep of EVAL_PROMPTS) {
  const existingEval = db.query(
    'SELECT id FROM EvalPrompt WHERE name = ? AND (projectId IS NULL OR projectId = "")'
  ).get(ep.name) as any;

  if (existingEval && !force) {
    skip(`EvalPrompt "${ep.name}"`);
    continue;
  }

  if (existingEval) {
    db.exec(`DELETE FROM EvalPrompt WHERE id = '${existingEval.id}'`);
  }

  db.prepare(`
    INSERT INTO EvalPrompt (id, name, projectId, evalType, outputMode, template, ruleConfig, badgeLabel, description, isCustom, model, updatedAt)
    VALUES (?, ?, NULL, 'api', ?, '', ?, ?, ?, 1, 'gpt-4o-mini', ?)
  `).run(
    uid('ep'), ep.name,
    ep.outputMode, JSON.stringify({ endpoint: EVAL_ENDPOINT }),
    ep.badgeLabel, ep.description, now
  );

  ok(`EvalPrompt "${ep.name}" [${ep.badgeLabel}]`);
}

// ── 3. Agent Template ────────────────────────────────────────────────────────
console.log(`\n${BOLD}── Agent Template ───────────────────────────────────${RESET}`);

const TEMPLATE_NAME = 'Dexter Financial Agent';
const TEMPLATE_ID = 'tpl_dexter';

const existingTpl = db.query('SELECT id FROM AgentTemplate WHERE id = ?').get(TEMPLATE_ID) as any;

if (existingTpl && !force) {
  skip(`AgentTemplate "${TEMPLATE_NAME}"`);
} else {
  if (existingTpl) {
    db.exec(`DELETE FROM AgentTemplate WHERE id = '${TEMPLATE_ID}'`);
  }

  db.prepare(`
    INSERT INTO AgentTemplate (id, name, description, agentType, endpoint, assistantId, evalPrompts, createdAt, updatedAt)
    VALUES (?, ?, ?, 'rest', 'http://localhost:2024', 'agent', '{}', ?, ?)
  `).run(TEMPLATE_ID, TEMPLATE_NAME, 'Dexter 금융 리서치 에이전트 (AAPL/NVDA/MSFT)', now, now);

  ok(`AgentTemplate "${TEMPLATE_NAME}"`);
}

// ── 4. Agent Config ──────────────────────────────────────────────────────────
console.log(`\n${BOLD}── Agent Config ─────────────────────────────────────${RESET}`);

const existingAgent = db.query('SELECT id FROM AgentConfig WHERE project = ?').get(AGENT_PROJECT) as any;

if (existingAgent && !force) {
  skip(`AgentConfig "${AGENT_PROJECT}"`);
} else {
  if (existingAgent) {
    db.exec(`DELETE FROM AgentConfig WHERE project = '${AGENT_PROJECT}'`);
  }

  db.prepare(`
    INSERT INTO AgentConfig (id, project, alias, templateId, agentType, endpoint, assistantId, updatedAt)
    VALUES (?, ?, ?, ?, 'rest', 'http://localhost:2024', 'agent', ?)
  `).run(uid('ac'), AGENT_PROJECT, 'Dexter Agent', TEMPLATE_ID, now);

  ok(`AgentConfig "${AGENT_PROJECT}" → http://localhost:2024`);
}

db.close();

console.log(`\n${BOLD}── Done ─────────────────────────────────────────────${RESET}`);
console.log(`IQHub DB: ${IQHUB_DB}`);
console.log(`Dataset:  ${DATASET_NAME} (${DATASET_ID})`);
console.log(`Evals:    ${evalNames.join(', ')}`);
console.log(`Agent:    ${AGENT_PROJECT} → http://localhost:2024\n`);
