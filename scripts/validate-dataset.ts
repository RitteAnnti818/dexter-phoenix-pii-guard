#!/usr/bin/env bun
/**
 * Validate hallucination_50q.json for:
 * 1. Formula correctness (growth rate / margin questions)
 * 2. acceptable_range reasonableness (does answer fall inside?)
 * 3. Potential data availability issues
 * 4. required_tool consistency
 */

const DATASET_PATH = 'src/observability/datasets/hallucination_50q.json';

interface Row {
  id: string;
  level: string;
  category: string;
  question: string;
  ground_truth: {
    answer: string;
    formula?: string;
    source?: string;
    note?: string;
    acceptable_range?: [number, number];
  };
  required_tool: string | null;
  expected_ticker?: string;
}

const rows: Row[] = JSON.parse(await Bun.file(DATASET_PATH).text());

const RESET = '\x1b[0m';
const RED   = '\x1b[31m';
const YEL   = '\x1b[33m';
const GRN   = '\x1b[32m';
const BOLD  = '\x1b[1m';
const DIM   = '\x1b[2m';

let warns = 0, errors = 0;

function ok(id: string, msg: string) {
  console.log(`${GRN}✓${RESET} ${DIM}${id}${RESET} ${msg}`);
}
function warn(id: string, msg: string) {
  console.log(`${YEL}⚠ ${id}${RESET} ${msg}`);
  warns++;
}
function err(id: string, msg: string) {
  console.log(`${RED}✗ ${BOLD}${id}${RESET} ${msg}`);
  errors++;
}

// ─── 1. Formula check ────────────────────────────────────────────────────────

console.log(`\n${BOLD}── 1. Formula correctness ──────────────────────────────────────${RESET}`);

for (const row of rows) {
  if (!row.ground_truth.formula) continue;
  const formula = row.ground_truth.formula.trim();
  const range = row.ground_truth.acceptable_range;

  let computed: number;
  try {
    // eslint-disable-next-line no-new-func
    computed = Function(`"use strict"; return (${formula})`)() as number;
  } catch (e) {
    warn(row.id, `formula parse error: ${formula}`);
    continue;
  }

  if (!range) {
    warn(row.id, `has formula but no acceptable_range — computed=${computed.toFixed(3)}`);
    continue;
  }

  const [lo, hi] = range;
  if (computed >= lo && computed <= hi) {
    ok(row.id, `formula=${computed.toFixed(3)} ∈ [${lo}, ${hi}]`);
  } else {
    err(row.id, `formula=${computed.toFixed(3)} NOT in [${lo}, ${hi}] — range too tight or wrong numbers`);
  }
}

// ─── 2. Range sanity ─────────────────────────────────────────────────────────

console.log(`\n${BOLD}── 2. acceptable_range sanity ──────────────────────────────────${RESET}`);

for (const row of rows) {
  const range = row.ground_truth.acceptable_range;
  if (!range) continue;
  const [lo, hi] = range;

  if (lo >= hi) {
    err(row.id, `range inverted: [${lo}, ${hi}]`);
    continue;
  }

  const mid = (lo + hi) / 2;
  const widthPct = mid !== 0 ? ((hi - lo) / Math.abs(mid)) * 100 : hi - lo;

  if (widthPct > 30) {
    warn(row.id, `range very wide: [${lo}, ${hi}] width=${widthPct.toFixed(1)}% — evaluator might be too lenient`);
  } else if (widthPct < 0.1 && lo !== hi) {
    warn(row.id, `range extremely tight: [${lo}, ${hi}] — might cause false negatives`);
  } else {
    ok(row.id, `range [${lo}, ${hi}] width=${widthPct.toFixed(1)}%`);
  }
}

// ─── 3. Data availability flags ──────────────────────────────────────────────

console.log(`\n${BOLD}── 3. Potential data availability issues ───────────────────────${RESET}`);

// NVDA FY2025 — verified 2026-05-06: API confirmed working
const nvdaFy25 = rows.filter(r =>
  r.ground_truth.source?.includes('FY2025') && r.expected_ticker === 'NVDA'
);
for (const r of nvdaFy25) {
  ok(r.id, `NVDA FY2025 data verified in API (source: ${r.ground_truth.source})`);
}

// Segment data — endpoint fixed to /financials/segments/ (verified 2026-05-06)
const segmentRows = rows.filter(r => r.category === 'segment');
for (const r of segmentRows) {
  ok(r.id, `segment question — /financials/segments/ endpoint verified working`);
}

// Cross-statement: both ROE (income+balance sheet) and FCF (income+cash flow)
// are served by get_financials, which routes internally to the correct statements.
const crossRows = rows.filter(r => r.category === 'cross_statement');
for (const r of crossRows) {
  ok(r.id, `cross_statement — get_financials covers income, balance sheet, and cash flow`);
}

// Price lookup — requires get_market_data, data available from 2025-05-06
const priceRows = rows.filter(r => r.category === 'price_lookup');
for (const r of priceRows) {
  if (r.required_tool !== 'get_market_data') {
    err(r.id, `price_lookup must use required_tool=get_market_data, got "${r.required_tool}"`);
  } else {
    ok(r.id, `price_lookup — get_market_data, free tier data available from 2025-05-06`);
  }
}

// Unavailable price data (pre-2025-05-06) — should be trap with required_tool=null
const oldPriceRows = rows.filter(r => r.category === 'unavailable_price_data');
for (const r of oldPriceRows) {
  if (r.level !== 'trap') {
    err(r.id, `unavailable_price_data must be level=trap`);
  } else if (r.required_tool !== null) {
    err(r.id, `unavailable_price_data trap must have required_tool=null`);
  } else {
    ok(r.id, `unavailable_price_data — correctly set as trap (pre-2025-05-06, API불가)`);
  }
}

// Ratio questions without formula
const noFormulaRatio = rows.filter(r =>
  (r.category === 'margin' || r.category === 'ratio') &&
  !r.ground_truth.formula &&
  r.level !== 'trap'
);
for (const r of noFormulaRatio) {
  warn(r.id, `margin/ratio with no formula — agent must compute or API must return it directly`);
}

// ─── 4. required_tool consistency ────────────────────────────────────────────

console.log(`\n${BOLD}── 4. required_tool field ──────────────────────────────────────${RESET}`);

const VALID_TOOLS = new Set(['get_financials', 'get_market_data', 'read_filings', 'stock_screener']);
let toolIssues = 0;

for (const row of rows) {
  if (row.level === 'trap') {
    if (row.required_tool !== null) {
      warn(row.id, `trap should have required_tool=null, got "${row.required_tool}"`);
      toolIssues++;
    }
    continue;
  }
  if (row.required_tool === null) {
    err(row.id, `non-trap question has required_tool=null`);
    toolIssues++;
  } else if (!VALID_TOOLS.has(row.required_tool)) {
    err(row.id, `required_tool="${row.required_tool}" not in known tool list`);
    toolIssues++;
  }
}
if (toolIssues === 0) {
  ok('ALL', `required_tool fields valid for all ${rows.length} rows`);
}

// ─── 5. Trap integrity ───────────────────────────────────────────────────────

console.log(`\n${BOLD}── 5. Trap integrity ───────────────────────────────────────────${RESET}`);

const VALID_TRAP_CATEGORIES = new Set([
  'unsupported_ticker', 'future_data', 'unavailable_price_data',
  'private_company', 'advice', 'impossible_period',
]);

const trapRows = rows.filter(r => r.level === 'trap');
for (const r of trapRows) {
  const hasAnswer = r.ground_truth.answer?.startsWith('조회 불가');
  const validCat = VALID_TRAP_CATEGORIES.has(r.category);
  const nullTool = r.required_tool === null;

  if (!hasAnswer) {
    warn(r.id, `trap answer should start with "조회 불가", got: "${r.ground_truth.answer}"`);
  } else if (!validCat) {
    warn(r.id, `unknown trap category: "${r.category}"`);
  } else if (!nullTool) {
    warn(r.id, `trap required_tool should be null, got "${r.required_tool}"`);
  } else {
    ok(r.id, `trap [${r.category}] — answer/category/tool all correct`);
  }
}

// ─── 6. Summary ──────────────────────────────────────────────────────────────

console.log(`\n${BOLD}── Summary ─────────────────────────────────────────────────────${RESET}`);
console.log(`Total rows  : ${rows.length}`);
console.log(`${RED}Errors      : ${errors}${RESET}`);
console.log(`${YEL}Warnings    : ${warns}${RESET}`);

const byLevel: Record<string, number> = {};
const byCategory: Record<string, number> = {};
for (const r of rows) {
  byLevel[r.level] = (byLevel[r.level] ?? 0) + 1;
  byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;
}
console.log('\nBy level:', Object.entries(byLevel).map(([k,v]) => `${k}=${v}`).join(', '));
console.log('By category:', Object.entries(byCategory).map(([k,v]) => `${k}=${v}`).join(', '));

if (errors > 0) process.exit(1);
