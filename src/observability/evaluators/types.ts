// Shared types for the 5 Phoenix evaluators (Task 1-3).
// All evaluators return the same shape so a runner can post them
// uniformly to Phoenix as annotations.

export type EvalLabel = 'correct' | 'incorrect' | 'partial';

export interface EvalResult {
  /** 0.0 — 1.0. Use 0/1 for binary evaluators, fractional for graded ones. */
  score: number;
  label: EvalLabel;
  /** Human-readable rationale. Shown in Phoenix annotation panel. */
  explanation: string;
  /** Phoenix span ID this evaluation should attach to. */
  span_id?: string;
}

/** A single tool invocation captured from the agent run. */
export interface ToolCallCapture {
  name: string;
  args: Record<string, unknown>;
  result: string;
  durationMs: number;
}

/** Everything an evaluator may need from one agent run. */
export interface AgentRunCapture {
  question: string;
  /** Final natural-language answer the agent emitted. */
  finalAnswer: string;
  /** All "thinking" chunks (text emitted before tool calls). Acts as the "plan". */
  thinking: string[];
  toolCalls: ToolCallCapture[];
  iterations: number;
  /** OpenInference IDs (from manual spans) — optional, set when available. */
  traceId?: string;
  agentSpanId?: string;
}

/** Ground-truth row from hallucination_50q.json. */
export interface DatasetRow {
  id: string;
  level: 'easy' | 'medium' | 'hard' | 'trap';
  category: string;
  question: string;
  ground_truth: {
    answer: string;
    source?: string;
    note?: string;
    formula?: string;
    acceptable_range?: [number, number];
  };
  required_tool: string | null;
  expected_ticker?: string;
}
