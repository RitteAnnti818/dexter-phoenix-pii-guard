// Evaluator #3 — Tool Call Correctness (deterministic).
//
// For factual rows: the required_tool must have been invoked, and if an
// expected_ticker is set the call args must mention that ticker.
//
// For trap rows: the agent should ideally not call any data-fetching tool
// at all (no AAPL/NVDA/MSFT data exists for those queries). Calling tools
// is allowed if the agent then refuses based on empty/error results, but
// confidently returning a number from a tool call would be a worse failure
// — that gets caught by Factual Accuracy + Refusal evaluators instead.

import type { AgentRunCapture, DatasetRow, EvalResult, ToolCallCapture } from './types.js';

const FINANCE_TOOLS = new Set([
  'get_financials',
  'get_market_data',
  'read_filings',
  'stock_screener',
]);

// Map free-form company mentions to tickers so a call args of
// `{query: "Apple revenue"}` still credits expected_ticker=AAPL.
const COMPANY_ALIASES: Record<string, string[]> = {
  AAPL: ['apple'],
  NVDA: ['nvidia'],
  MSFT: ['microsoft'],
};

function callMentionsTicker(call: ToolCallCapture, ticker: string): boolean {
  const upper = ticker.toUpperCase();
  const argsBlob = JSON.stringify(call.args);
  const haystack = `${argsBlob}\n${call.result}`.toLowerCase();
  if (haystack.includes(upper.toLowerCase())) return true;
  for (const alias of COMPANY_ALIASES[upper] ?? []) {
    if (haystack.includes(alias)) return true;
  }
  return false;
}

export function evaluateToolCorrectness(
  row: DatasetRow,
  run: AgentRunCapture,
): EvalResult {
  // ── Trap rows ────────────────────────────────────────────────────────
  if (row.level === 'trap') {
    const usedFinanceTool = run.toolCalls.some((t) => FINANCE_TOOLS.has(t.name));
    if (!usedFinanceTool) {
      return {
        score: 1,
        label: 'correct',
        explanation: 'trap question — agent correctly avoided fetching data',
      };
    }
    // Tool was called. That's only OK if it surfaced no data and the agent
    // ended up refusing. We treat this as "partial" — Factual Accuracy and
    // Refusal evaluators are responsible for the final verdict.
    const calls = run.toolCalls.map((t) => t.name).join(', ');
    return {
      score: 0.5,
      label: 'partial',
      explanation: `trap question — agent invoked finance tool(s): ${calls}. Acceptable only if results were empty and answer refused.`,
    };
  }

  // ── Factual rows ─────────────────────────────────────────────────────
  if (!row.required_tool) {
    return {
      score: 1,
      label: 'correct',
      explanation: 'no required_tool specified — skipping check',
    };
  }
  const matchingCalls: ToolCallCapture[] = run.toolCalls.filter(
    (t) => t.name === row.required_tool,
  );
  if (matchingCalls.length === 0) {
    return {
      score: 0,
      label: 'incorrect',
      explanation: `expected ${row.required_tool}, but agent called: ${
        run.toolCalls.map((t) => t.name).join(', ') || '(none)'
      }`,
    };
  }
  if (row.expected_ticker) {
    const tickerHit = matchingCalls.some((t) =>
      callMentionsTicker(t, row.expected_ticker!),
    );
    if (!tickerHit) {
      return {
        score: 0.5,
        label: 'partial',
        explanation: `${row.required_tool} was called but neither args nor result mentioned ${row.expected_ticker}`,
      };
    }
  }
  return {
    score: 1,
    label: 'correct',
    explanation: `${row.required_tool} called${
      row.expected_ticker ? ` with ${row.expected_ticker}` : ''
    }`,
  };
}
