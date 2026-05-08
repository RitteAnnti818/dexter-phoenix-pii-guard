import { AIMessage, AIMessageChunk, SystemMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { StructuredToolInterface } from '@langchain/core/tools';
import { context as otelContext, trace, SpanStatusCode, type Span } from '@opentelemetry/api';
import {
  OpenInferenceSpanKind,
  SemanticConventions,
  MimeType,
} from '@arizeai/openinference-semantic-conventions';
import { callLlmWithMessages, streamLlmWithMessages } from '../model/llm.js';
import { getTools, getToolConcurrencyMap } from '../tools/registry.js';
import { buildSystemPrompt, loadSoulDocument, loadRulesDocument } from './prompts.js';
import { extractTextContent, hasToolCalls } from '../utils/ai-message.js';
import { InMemoryChatHistory } from '../utils/in-memory-chat-history.js';
import { estimateTokens, getAutoCompactThreshold, KEEP_TOOL_USES } from '../utils/tokens.js';
import { exceedsSizeCap, persistLargeResult, buildPersistedContent } from '../utils/tool-result-storage.js';
import { enforceResultBudget } from '../utils/tool-result-budget.js';
import { formatUserFacingError, isContextOverflowError } from '../utils/errors.js';
import type { AgentConfig, AgentEvent, CompactionEvent, ContextClearedEvent, MicrocompactEvent, QueueDrainEvent, TokenUsage } from '../agent/types.js';
import type { MessageQueue } from '../utils/message-queue.js';
import { compactContext, MAX_CONSECUTIVE_COMPACTION_FAILURES, MIN_TOOL_RESULTS_FOR_COMPACTION } from './compact.js';
import { microcompactMessages } from './microcompact.js';
import { createRunContext, type RunContext } from './run-context.js';
import { AgentToolExecutor } from './tool-executor.js';
import { MemoryManager } from '../memory/index.js';
import { runMemoryFlush, shouldRunMemoryFlush } from '../memory/flush.js';
import { resolveProvider } from '../providers.js';
import { getTracer } from '../observability/telemetry.js';
import { regexDetect, maskText, dedupeOverlapping } from '../observability/guards/regexGuard.js';
import { llmDetect } from '../observability/guards/llmGuard.js';
import { checkOutput } from '../observability/guards/outputGuard.js';

// Cap span attribute string size — Phoenix UI struggles with multi-MB blobs.
const SPAN_ATTR_MAX_LEN = 4000;
const truncate = (s: string, n = SPAN_ATTR_MAX_LEN) => (s.length > n ? `${s.slice(0, n)}...` : s);

// Run Stage 1 + Stage 2 (with internal gating) and return masked text.
// PII_GUARD_DISABLED=1 bypasses entirely — used by Week 1 evaluation runs
// where 12-digit revenue numbers might trip BANK_ACCT regex.
async function maskUserInput(text: string): Promise<string> {
  if (process.env.PII_GUARD_DISABLED === '1') return text;
  try {
    const stage1 = regexDetect(text);
    const stage2 = await llmDetect(text, { stage1Detections: stage1 });
    const detections = dedupeOverlapping([...stage1, ...stage2]);
    return detections.length > 0 ? maskText(text, detections) : text;
  } catch {
    return text;
  }
}

// Run the Output Guard on the agent's final answer.
// Returns the masked answer (or a refusal placeholder if a cross-session
// memory leak was detected).
async function maskAgentOutput(text: string): Promise<string> {
  if (process.env.PII_GUARD_DISABLED === '1') return text;
  if (!text) return text;
  try {
    const result = await checkOutput(text);
    return result.maskedOutput;
  } catch {
    return text;
  }
}


const DEFAULT_MODEL = 'gpt-5.4';
const DEFAULT_MAX_ITERATIONS = 10;
const MAX_OVERFLOW_RETRIES = 2;
const OVERFLOW_KEEP_ROUNDS = 3;

/**
 * The core agent class that handles the agent loop and tool execution.
 *
 * Architecture:
 * - Growing message array with full reasoning continuity
 * - Concurrent execution for read-only tools
 * - Streaming LLM responses with fallback to blocking
 * - Per-turn microcompact + threshold-based full compaction
 */
export class Agent {
  private readonly model: string;
  private readonly maxIterations: number;
  private readonly tools: StructuredToolInterface[];
  private readonly toolMap: Map<string, StructuredToolInterface>;
  private readonly toolExecutor: AgentToolExecutor;
  private readonly systemPrompt: string;
  private readonly signal?: AbortSignal;
  private readonly memoryEnabled: boolean;
  private readonly messageQueue?: MessageQueue;
  private compactionFailures: number = 0;
  private reflectionUsed: boolean = false;
  private toolReflectionUsed: boolean = false;

  private constructor(
    config: AgentConfig,
    tools: StructuredToolInterface[],
    systemPrompt: string,
    concurrencyMap: Map<string, boolean>,
  ) {
    this.model = config.model ?? DEFAULT_MODEL;
    this.maxIterations = config.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    this.tools = tools;
    this.toolMap = new Map(tools.map(t => [t.name, t]));
    this.toolExecutor = new AgentToolExecutor(
      this.toolMap,
      concurrencyMap,
      config.signal,
      config.requestToolApproval,
      config.sessionApprovedTools,
    );
    this.systemPrompt = systemPrompt;
    this.signal = config.signal;
    this.memoryEnabled = config.memoryEnabled ?? true;
    this.messageQueue = config.messageQueue;
  }

  static async create(config: AgentConfig = {}): Promise<Agent> {
    const model = config.model ?? DEFAULT_MODEL;
    const tools = getTools(model);
    const concurrencyMap = getToolConcurrencyMap(model);
    const soulContent = await loadSoulDocument();
    const rulesContent = await loadRulesDocument();
    let memoryFiles: string[] = [];
    let memoryContext: string | null = null;

    if (config.memoryEnabled !== false) {
      const memoryManager = await MemoryManager.get();
      memoryFiles = await memoryManager.listFiles();
      const session = await memoryManager.loadSessionContext();
      if (session.text.trim()) {
        memoryContext = session.text;
      }
    }

    const systemPrompt = buildSystemPrompt(
      model,
      soulContent,
      config.channel,
      config.groupContext,
      memoryFiles,
      memoryContext,
      rulesContent,
    );
    return new Agent(config, tools, systemPrompt, concurrencyMap);
  }

  /**
   * Run the agent with streaming, concurrent tools, and microcompact.
   */
  async *run(query: string, inMemoryHistory?: InMemoryChatHistory): AsyncGenerator<AgentEvent> {
    const startTime = Date.now();

    if (this.tools.length === 0) {
      yield { type: 'done', answer: 'No tools available. Please check your API key configuration.', toolCalls: [], iterations: 0, totalTime: Date.now() - startTime };
      return;
    }

    const ctx = createRunContext(query);
    const memoryFlushState = { alreadyFlushed: false };

    // Input PII Guard — mask user query before it reaches the LLM.
    // Stage 2 internally skips when neither Stage 1 nor obfuscation hints fire,
    // so clean inputs add ~0ms overhead.
    const maskedQuery = await maskUserInput(query);

    // Build initial message array
    const historyMessages = inMemoryHistory?.getRecentTurnsAsMessages() ?? [];
    let messages: BaseMessage[] = [
      new SystemMessage(this.systemPrompt),
      ...historyMessages,
      new HumanMessage(maskedQuery),
    ];

    // ─── OpenInference: AGENT span wraps the whole run ───────────────────
    const tracer = getTracer();
    const agentSpan = tracer.startSpan('Agent.run', {
      attributes: {
        [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.AGENT,
        [SemanticConventions.AGENT_NAME]: 'dexter',
        [SemanticConventions.LLM_MODEL_NAME]: this.model,
        [SemanticConventions.INPUT_VALUE]: truncate(maskedQuery),
        [SemanticConventions.INPUT_MIME_TYPE]: MimeType.TEXT,
      },
    });
    const agentCtx = trace.setSpan(otelContext.active(), agentSpan);
    this.toolExecutor.setParentContext(agentCtx);

    // Capture root span/trace IDs so evaluator scripts can attach Phoenix
    // annotations to the AGENT span. Returns zero-IDs when telemetry is
    // disabled — consumers must check before posting.
    const sc = agentSpan.spanContext();
    const isValidSpanId = sc.spanId && sc.spanId !== '0'.repeat(16);
    const agentSpanId = isValidSpanId ? sc.spanId : undefined;
    const traceId = isValidSpanId ? sc.traceId : undefined;

    let finalAnswerForSpan = '';
    let agentError: unknown = undefined;

    try {
      // Main agent loop
      let overflowRetries = 0;
      while (ctx.iteration < this.maxIterations) {
        ctx.iteration++;

        // Microcompact: per-turn lightweight trimming before LLM call
        const mcResult = microcompactMessages(messages);
        if (mcResult.trigger) {
          messages = mcResult.messages;
          yield { type: 'microcompact', cleared: mcResult.cleared, tokensSaved: mcResult.estimatedTokensSaved } as MicrocompactEvent;
        }

        // Strip old reasoning from AIMessages (keep last 2 for continuity)
        this.stripOldThinking(messages, 2);

        let response: AIMessage;
        let usage: TokenUsage | undefined;

        // ─── CHAIN span (planning/reflection) + LLM span per iteration ───
        const chainName = ctx.iteration === 1 ? 'planning' : `reflection (iteration ${ctx.iteration})`;
        const chainSpan = tracer.startSpan(
          chainName,
          {
            attributes: {
              [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.CHAIN,
              'iteration.index': ctx.iteration,
            },
          },
          agentCtx,
        );
        const chainCtx = trace.setSpan(agentCtx, chainSpan);

        const llmSpan = tracer.startSpan(
          'llm.chat',
          {
            attributes: {
              [SemanticConventions.OPENINFERENCE_SPAN_KIND]: OpenInferenceSpanKind.LLM,
              [SemanticConventions.LLM_MODEL_NAME]: this.model,
              [SemanticConventions.LLM_PROVIDER]: resolveProvider(this.model).id,
              'llm.input_messages.count': messages.length,
              [SemanticConventions.INPUT_VALUE]: truncate(this.summarizeMessagesForSpan(messages)),
              [SemanticConventions.INPUT_MIME_TYPE]: MimeType.JSON,
            },
          },
          chainCtx,
        );
        const llmCtx = trace.setSpan(chainCtx, llmSpan);

        try {
          // Call LLM with streaming (falls back to blocking on error)
          while (true) {
            try {
              const result = await otelContext.with(llmCtx, () =>
                this.callModelWithStreaming(messages),
              );
              response = result.response;
              usage = result.usage;
              overflowRetries = 0;
              break;
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : String(error);

              if (isContextOverflowError(errorMessage) && overflowRetries < MAX_OVERFLOW_RETRIES) {
                overflowRetries++;
                const removed = this.truncateMessages(messages, OVERFLOW_KEEP_ROUNDS);
                if (removed > 0) {
                  yield { type: 'context_cleared', clearedCount: removed, keptCount: OVERFLOW_KEEP_ROUNDS };
                  continue;
                }
              }

              llmSpan.recordException(error as Error);
              llmSpan.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage });
              chainSpan.setStatus({ code: SpanStatusCode.ERROR });
              agentError = error;

              const totalTime = Date.now() - ctx.startTime;
              const provider = resolveProvider(this.model).displayName;
              yield {
                type: 'done',
                answer: `Error: ${formatUserFacingError(errorMessage, provider)}`,
                toolCalls: ctx.scratchpad.getToolCallRecords(),
                iterations: ctx.iteration,
                totalTime,
                tokenUsage: ctx.tokenCounter.getUsage(),
                tokensPerSecond: ctx.tokenCounter.getTokensPerSecond(totalTime),
                agentSpanId,
                traceId,
              };
              return;
            }
          }
        } finally {
          if (usage) {
            llmSpan.setAttribute(SemanticConventions.LLM_TOKEN_COUNT_PROMPT, usage.inputTokens);
            llmSpan.setAttribute(SemanticConventions.LLM_TOKEN_COUNT_COMPLETION, usage.outputTokens);
            llmSpan.setAttribute(SemanticConventions.LLM_TOKEN_COUNT_TOTAL, usage.totalTokens);
          }
          if (response!) {
            const responseText = extractTextContent(response!) ?? '';
            llmSpan.setAttribute(SemanticConventions.OUTPUT_VALUE, truncate(responseText));
            llmSpan.setAttribute(SemanticConventions.OUTPUT_MIME_TYPE, MimeType.TEXT);
            const toolCallsCount = response!.tool_calls?.length ?? 0;
            llmSpan.setAttribute('llm.tool_calls.count', toolCallsCount);
            chainSpan.setAttribute('chain.tool_calls.count', toolCallsCount);
          }
          llmSpan.end();
          chainSpan.end();
        }

        ctx.tokenCounter.add(usage);
        if (usage?.inputTokens) {
          ctx.lastApiInputTokens = usage.inputTokens;
        }

        const responseText = extractTextContent(response);

        // Emit thinking if there are also tool calls
        if (responseText?.trim() && hasToolCalls(response)) {
          const trimmedText = responseText.trim();
          ctx.scratchpad.addThinking(trimmedText);
          yield { type: 'thinking', message: trimmedText };
        }

        // No tool calls = final answer (reflection check + Output Guard)
        if (!hasToolCalls(response)) {
          const text = responseText ?? '';
          const reflectionNote = this.buildReflectionNote(text, query);
          if (reflectionNote && ctx.iteration < this.maxIterations) {
            // Inject reflection and let the agent revise
            messages.push(response);
            messages.push(new HumanMessage(reflectionNote));
            continue;
          }
          const safeAnswer = await maskAgentOutput(text);
          finalAnswerForSpan = safeAnswer;
          yield* this.handleDirectResponse(safeAnswer, ctx, { agentSpanId, traceId });
          return;
        }

        // Push AIMessage to conversation history
        messages.push(response);

        // Execute tools concurrently where safe, collect ToolMessages by ID
        let { toolMessages, denied } = yield* this.executeToolsAndCollectMessages(response, ctx);

        // Cap large results (persist to disk, inject preview)
        toolMessages = toolMessages.map(tm => {
          const content = typeof tm.content === 'string' ? tm.content : JSON.stringify(tm.content);
          if (exceedsSizeCap(content)) {
            const { preview, filePath } = persistLargeResult(tm.name ?? 'unknown', tm.tool_call_id, content);
            return new ToolMessage({
              content: buildPersistedContent(filePath, preview, content.length),
              tool_call_id: tm.tool_call_id,
              name: tm.name,
            });
          }
          return tm;
        });

        // Enforce per-turn total budget
        toolMessages = enforceResultBudget(toolMessages);

        messages.push(...toolMessages);

        // Post-tool reflection: inject verification hints as system note
        const toolReflection = this.buildToolResultReflection(query, toolMessages);
        if (toolReflection) {
          messages.push(new HumanMessage(toolReflection));
        }

        if (denied) {
          const totalTime = Date.now() - ctx.startTime;
          yield {
            type: 'done',
            answer: '',
            toolCalls: ctx.scratchpad.getToolCallRecords(),
            iterations: ctx.iteration,
            totalTime,
            tokenUsage: ctx.tokenCounter.getUsage(),
            tokensPerSecond: ctx.tokenCounter.getTokensPerSecond(totalTime),
            agentSpanId,
            traceId,
          };
          return;
        }

        // Context threshold management (may compact the message array)
        const messageState = { messages };
        yield* this.manageContextThreshold(ctx, query, memoryFlushState, messageState);
        messages = messageState.messages;

        // Inject tool usage warning if approaching limits
        const toolUsageWarning = ctx.scratchpad.formatToolUsageForPrompt();
        if (toolUsageWarning) {
          messages.push(new HumanMessage(toolUsageWarning));
        }

        // Drain queued messages: user may have sent follow-ups while agent was working
        const drainResult = this.drainQueue();
        if (drainResult) {
          messages.push(new HumanMessage(drainResult.text));
          yield { type: 'queue_drain', messageCount: drainResult.count, mergedText: drainResult.text } as QueueDrainEvent;
        }
      }

      // Max iterations reached
      const totalTime = Date.now() - ctx.startTime;
      yield {
        type: 'done',
        answer: `Reached maximum iterations (${this.maxIterations}). I was unable to complete the research in the allotted steps.`,
        toolCalls: ctx.scratchpad.getToolCallRecords(),
        iterations: ctx.iteration,
        totalTime,
        tokenUsage: ctx.tokenCounter.getUsage(),
        tokensPerSecond: ctx.tokenCounter.getTokensPerSecond(totalTime),
        agentSpanId,
        traceId,
      };
    } catch (err) {
      agentError = err;
      agentSpan.recordException(err as Error);
      agentSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      this.toolExecutor.setParentContext(undefined);
      agentSpan.setAttribute('agent.iterations', ctx.iteration);
      agentSpan.setAttribute('agent.duration_ms', Date.now() - startTime);
      agentSpan.setAttribute(
        'agent.tool_calls.count',
        ctx.scratchpad.getToolCallRecords().length,
      );
      const usageTotals = ctx.tokenCounter.getUsage();
      if (usageTotals) {
        agentSpan.setAttribute(SemanticConventions.LLM_TOKEN_COUNT_PROMPT, usageTotals.inputTokens);
        agentSpan.setAttribute(SemanticConventions.LLM_TOKEN_COUNT_COMPLETION, usageTotals.outputTokens);
        agentSpan.setAttribute(SemanticConventions.LLM_TOKEN_COUNT_TOTAL, usageTotals.totalTokens);
      }
      if (!agentError) {
        agentSpan.setAttribute(SemanticConventions.OUTPUT_VALUE, truncate(finalAnswerForSpan));
        agentSpan.setAttribute(SemanticConventions.OUTPUT_MIME_TYPE, MimeType.TEXT);
      }
      agentSpan.end();
    }
  }

  /**
   * Compact serialization of recent messages for span attributes.
   * Keeps only role + content snippets to avoid blowing past attr size caps.
   */
  private summarizeMessagesForSpan(messages: BaseMessage[]): string {
    const lastN = messages.slice(-5);
    const out = lastN.map((m) => {
      const role = m._getType();
      const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return { role, content: text.slice(0, 500) };
    });
    return JSON.stringify(out);
  }

  // ---------------------------------------------------------------------------
  // Reflection: code-level verification before final answer
  // ---------------------------------------------------------------------------

  /**
   * Check the agent's final answer for common errors that LLMs struggle with:
   * 1. Date comparison: refusing past dates as "future"
   * 2. Refusing with no tool call when a tool should have been tried
   *
   * Returns a correction note to inject, or null if no issues found.
   * Only triggers ONCE per run to avoid infinite loops.
   */
  private buildReflectionNote(answer: string, query: string): string | null {
    if (this.reflectionUsed) return null;

    const issues: string[] = [];
    const currentYear = new Date().getFullYear();

    // 1. Date comparison: detect refusal claiming "future" for a past date
    const refusalPattern = /해당 데이터를 제공할 수 없습니다|미래|future|제공할 수 없/i;
    if (refusalPattern.test(answer)) {
      const yearRegex = /(\d{4})/g;
      const queryYears: number[] = [];
      let ym: RegExpExecArray | null;
      while ((ym = yearRegex.exec(query)) !== null) queryYears.push(parseInt(ym[1]));
      const pastYears = queryYears.filter(y => y >= 2020 && y < currentYear);

      if (pastYears.length > 0) {
        issues.push(
          `[시스템 검증] 질문에 언급된 연도 ${pastYears.join(', ')}은(는) 현재 연도 ${currentYear}보다 이전이므로 과거입니다. ` +
          `"미래"라는 이유로 거절하지 마세요. 도구를 호출하여 데이터를 조회한 후 답변하세요.`
        );
      }
    }

    // 2. FY period mismatch: answer mentions a different FY than the query asked
    const queryFyRegex = /FY(\d{4})|(\d{4})\s*회계연도/g;
    const answerFyRegex = /FY(\d{4})/g;
    const queryFYs: string[] = [];
    const answerFYs: string[] = [];
    let fm: RegExpExecArray | null;
    while ((fm = queryFyRegex.exec(query)) !== null) queryFYs.push(fm[1] || fm[2]);
    while ((fm = answerFyRegex.exec(answer)) !== null) answerFYs.push(fm[1]);

    if (queryFYs.length === 1 && answerFYs.length > 0) {
      const requested = queryFYs[0];
      const wrongFYs = answerFYs.filter(fy => fy !== requested);
      if (wrongFYs.length > 0 && !answerFYs.includes(requested)) {
        issues.push(
          `[시스템 검증] 질문은 FY${requested} 데이터를 요청했지만, 답변은 FY${wrongFYs[0]} 데이터를 사용하고 있습니다. ` +
          `올바른 회계연도의 데이터를 사용하고 있는지 확인하세요.`
        );
      }
    }

    if (issues.length === 0) return null;
    this.reflectionUsed = true;
    return issues.join('\n');
  }

  /**
   * Post-tool reflection: check tool results for period/data consistency.
   * Injects a verification hint ONCE so the agent can self-correct.
   */
  private buildToolResultReflection(query: string, toolMessages: ToolMessage[]): string | null {
    if (this.toolReflectionUsed) return null;

    const issues: string[] = [];
    const currentYear = new Date().getFullYear();
    const allContent = toolMessages.map(tm =>
      typeof tm.content === 'string' ? tm.content : JSON.stringify(tm.content)
    ).join('\n');

    // 1. FY mismatch: query asks FY2024 but tool returned FY2025
    const queryFyRegex = /FY(\d{4})|(\d{4})\s*회계연도/g;
    const queryFYs: string[] = [];
    let fm: RegExpExecArray | null;
    while ((fm = queryFyRegex.exec(query)) !== null) queryFYs.push(fm[1] || fm[2]);

    if (queryFYs.length > 0) {
      const toolFyRegex = /FY(\d{4})/g;
      const toolFYs: string[] = [];
      while ((fm = toolFyRegex.exec(allContent)) !== null) toolFYs.push(fm[1]);
      const requested = queryFYs[0];

      if (toolFYs.length > 0 && !toolFYs.includes(requested)) {
        issues.push(
          `[시스템 검증] 질문은 FY${requested} 데이터를 요청했지만, tool이 반환한 데이터는 FY${toolFYs[0]}입니다. ` +
          `FY${requested} 데이터가 포함되어 있는지 확인하고, 없다면 다른 period의 데이터임을 답변에 명시하세요.`
        );
      }
    }

    // 2. Tool returned error — remind agent to try alternatives
    if (/error|Error|실패|failed/i.test(allContent)) {
      const yearRegex = /(\d{4})/g;
      const qYears: number[] = [];
      let ym2: RegExpExecArray | null;
      while ((ym2 = yearRegex.exec(query)) !== null) qYears.push(parseInt(ym2[1]));
      const pastYears = qYears.filter(y => y >= 2020 && y < currentYear);

      if (pastYears.length > 0) {
        issues.push(
          `[시스템 검증] tool이 에러를 반환했지만, 요청한 날짜(${pastYears.join(', ')})는 과거입니다. ` +
          `"미래"로 판단하지 말고, 가능하면 web_search 등 대안 도구를 시도하세요.`
        );
      }
    }

    // 3. Metric confusion: query asks gross profit but tool shows revenue
    if (/매출총이익|gross profit/i.test(query) && !/gross_profit|cost_of_goods/i.test(allContent)) {
      if (/revenue/i.test(allContent)) {
        issues.push(
          `[시스템 검증] 질문은 매출총이익(gross profit)을 요청했지만, tool 결과에 gross_profit 필드가 보이지 않습니다. ` +
          `revenue(매출)와 혼동하지 마세요. gross_profit = revenue - cost_of_goods_sold.`
        );
      }
    }

    if (issues.length === 0) return null;
    this.toolReflectionUsed = true;
    return `[자동 검증 — 답변 전 확인 사항]\n${issues.join('\n')}`;
  }

  // ---------------------------------------------------------------------------
  // LLM call methods
  // ---------------------------------------------------------------------------

  /**
   * Call LLM with streaming, falling back to blocking invoke on error.
   */
  private async callModelWithStreaming(
    messages: BaseMessage[],
  ): Promise<{ response: AIMessage; usage?: TokenUsage }> {
    try {
      return await this.streamAndAccumulate(messages);
    } catch {
      // Fallback to blocking invoke (handles providers without streaming support)
      return await this.callModelWithMessages(messages);
    }
  }

  /**
   * Stream the LLM response, accumulating chunks into a final AIMessage.
   */
  private async streamAndAccumulate(
    messages: BaseMessage[],
  ): Promise<{ response: AIMessage; usage?: TokenUsage }> {
    let accumulated: AIMessageChunk | null = null;

    for await (const chunk of streamLlmWithMessages(messages, {
      model: this.model,
      tools: this.tools,
      signal: this.signal,
    })) {
      accumulated = accumulated ? accumulated.concat(chunk) : chunk;
    }

    if (!accumulated) {
      throw new Error('Stream produced no chunks');
    }

    const response = new AIMessage({
      content: accumulated.content,
      tool_calls: accumulated.tool_calls,
      invalid_tool_calls: accumulated.invalid_tool_calls,
      usage_metadata: accumulated.usage_metadata,
      response_metadata: accumulated.response_metadata,
    });

    const usage = accumulated.usage_metadata
      ? {
          inputTokens: accumulated.usage_metadata.input_tokens ?? 0,
          outputTokens: accumulated.usage_metadata.output_tokens ?? 0,
          totalTokens: accumulated.usage_metadata.total_tokens ?? 0,
        }
      : undefined;

    return { response, usage };
  }

  /**
   * Blocking LLM call (fallback when streaming fails).
   */
  private async callModelWithMessages(
    messages: BaseMessage[],
  ): Promise<{ response: AIMessage; usage?: TokenUsage }> {
    const result = await callLlmWithMessages(messages, {
      model: this.model,
      tools: this.tools,
      signal: this.signal,
    });
    return { response: result.response as AIMessage, usage: result.usage };
  }

  // ---------------------------------------------------------------------------
  // Tool execution
  // ---------------------------------------------------------------------------

  /**
   * Execute tools and collect ToolMessages mapped by tool_call_id.
   * Supports concurrent execution — events may arrive out of order.
   */
  private async *executeToolsAndCollectMessages(
    response: AIMessage,
    ctx: RunContext,
  ): AsyncGenerator<AgentEvent, { toolMessages: ToolMessage[]; denied: boolean }> {
    const toolMessageMap = new Map<string, ToolMessage>();
    let denied = false;
    const toolCalls = response.tool_calls!;

    for await (const event of this.toolExecutor.executeAll(response, ctx)) {
      yield event;

      if (event.type === 'tool_end' && event.toolCallId) {
        toolMessageMap.set(event.toolCallId, new ToolMessage({
          content: event.result,
          tool_call_id: event.toolCallId,
          name: event.tool,
        }));
      } else if (event.type === 'tool_error' && event.toolCallId) {
        toolMessageMap.set(event.toolCallId, new ToolMessage({
          content: `Error: ${event.error}`,
          tool_call_id: event.toolCallId,
          name: event.tool,
        }));
      } else if (event.type === 'tool_denied' && event.toolCallId) {
        toolMessageMap.set(event.toolCallId, new ToolMessage({
          content: 'Tool execution denied by user.',
          tool_call_id: event.toolCallId,
          name: event.tool,
        }));
        denied = true;
      }
    }

    // Produce ToolMessages in ORIGINAL tool_calls order
    const toolMessages: ToolMessage[] = toolCalls.map(tc =>
      toolMessageMap.get(tc.id!) ?? new ToolMessage({
        content: 'Skipped (already executed).',
        tool_call_id: tc.id!,
        name: tc.name,
      }),
    );

    return { toolMessages, denied };
  }

  // ---------------------------------------------------------------------------
  // Message queue
  // ---------------------------------------------------------------------------

  /**
   * Drain all queued messages, merge into a single text block.
   * Returns null if the queue is empty or not configured.
   */
  private drainQueue(): { text: string; count: number } | null {
    if (!this.messageQueue || this.messageQueue.isEmpty()) {
      return null;
    }
    const messages = this.messageQueue.dequeueAll();
    if (messages.length === 0) return null;
    return {
      text: messages.map(m => m.text).join('\n\n'),
      count: messages.length,
    };
  }

  // ---------------------------------------------------------------------------
  // Response handling
  // ---------------------------------------------------------------------------

  // Caller must pass already-PII-masked text (see Output Guard call site
  // in run() where !hasToolCalls(response) branch invokes maskAgentOutput).
  private async *handleDirectResponse(
    responseText: string,
    ctx: RunContext,
    spanIds?: { agentSpanId?: string; traceId?: string },
  ): AsyncGenerator<AgentEvent, void> {
    const totalTime = Date.now() - ctx.startTime;
    yield {
      type: 'done',
      answer: responseText,
      toolCalls: ctx.scratchpad.getToolCallRecords(),
      iterations: ctx.iteration,
      totalTime,
      tokenUsage: ctx.tokenCounter.getUsage(),
      tokensPerSecond: ctx.tokenCounter.getTokensPerSecond(totalTime),
      agentSpanId: spanIds?.agentSpanId,
      traceId: spanIds?.traceId,
    };
  }

  // ---------------------------------------------------------------------------
  // Message array management
  // ---------------------------------------------------------------------------

  /**
   * Remove oldest AI+Tool message rounds, keeping SystemMessage, history,
   * HumanMessage, and the most recent N rounds.
   */
  /**
   * Strip text content from old AIMessages, keeping only the most recent N.
   * Preserves tool_calls structure (required for ToolMessage pairing).
   */
  private stripOldThinking(messages: BaseMessage[], keepLast: number): void {
    // Collect indices of AIMessages with text content
    const aiIndices: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i] instanceof AIMessage) {
        aiIndices.push(i);
      }
    }

    // Only strip if we have more than keepLast AIMessages
    const toStrip = aiIndices.slice(0, -keepLast);
    for (const idx of toStrip) {
      const msg = messages[idx] as AIMessage;
      // Only strip if it has tool_calls (reasoning before tools — safe to clear)
      if (msg.tool_calls && msg.tool_calls.length > 0 && msg.content) {
        messages[idx] = new AIMessage({
          content: '',
          tool_calls: msg.tool_calls,
          invalid_tool_calls: msg.invalid_tool_calls,
          usage_metadata: msg.usage_metadata,
          response_metadata: msg.response_metadata,
        });
      }
    }
  }

  private truncateMessages(messages: BaseMessage[], keepRounds: number): number {
    let roundStartIndex = 0;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i] instanceof AIMessage) {
        roundStartIndex = i;
        break;
      }
    }
    if (roundStartIndex === 0) return 0;

    const rounds: { start: number; end: number }[] = [];
    let i = roundStartIndex;
    while (i < messages.length) {
      if (messages[i] instanceof AIMessage) {
        const start = i;
        i++;
        while (i < messages.length && (messages[i] instanceof ToolMessage || messages[i] instanceof HumanMessage)) {
          i++;
        }
        rounds.push({ start, end: i });
      } else {
        i++;
      }
    }

    const roundsToRemove = Math.max(0, rounds.length - keepRounds);
    if (roundsToRemove === 0) return 0;

    const removeEnd = rounds[roundsToRemove - 1].end;
    const removed = removeEnd - roundStartIndex;
    messages.splice(roundStartIndex, removed);
    return removed;
  }

  /**
   * Replace message array with compacted version after LLM summarization.
   */
  private compactMessages(messages: BaseMessage[], summary: string, query: string): BaseMessage[] {
    return [
      messages[0], // SystemMessage
      new HumanMessage(`${query}\n\n${summary}`),
    ];
  }

  // ---------------------------------------------------------------------------
  // Context threshold management
  // ---------------------------------------------------------------------------

  private async *manageContextThreshold(
    ctx: RunContext,
    query: string,
    memoryFlushState: { alreadyFlushed: boolean },
    messageState: { messages: BaseMessage[] },
  ): AsyncGenerator<ContextClearedEvent | CompactionEvent | AgentEvent, void> {
    const estimatedContextTokens = ctx.lastApiInputTokens > 0
      ? ctx.lastApiInputTokens
      : estimateTokens(messageState.messages.map(m =>
          typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        ).join('\n'));
    const threshold = getAutoCompactThreshold(this.model);

    if (estimatedContextTokens <= threshold) {
      return;
    }

    // Step 1: Memory flush
    const fullToolResults = ctx.scratchpad.getToolResults();
    if (
      this.memoryEnabled &&
      shouldRunMemoryFlush({
        estimatedContextTokens,
        threshold,
        alreadyFlushed: memoryFlushState.alreadyFlushed,
      })
    ) {
      yield { type: 'memory_flush', phase: 'start' };
      const flushResult = await runMemoryFlush({
        model: this.model,
        systemPrompt: this.systemPrompt,
        query,
        toolResults: fullToolResults,
        signal: this.signal,
      }).catch(() => ({ flushed: false, written: false as const }));
      memoryFlushState.alreadyFlushed = flushResult.flushed;
      yield {
        type: 'memory_flush',
        phase: 'end',
        filesWritten: flushResult.written ? [`${new Date().toISOString().slice(0, 10)}.md`] : [],
      };
    }

    // Step 2: Compaction
    if (
      this.compactionFailures < MAX_CONSECUTIVE_COMPACTION_FAILURES &&
      ctx.scratchpad.getActiveToolResultCount() >= MIN_TOOL_RESULTS_FOR_COMPACTION
    ) {
      yield { type: 'compaction', phase: 'start', preCompactTokens: estimatedContextTokens };

      try {
        const result = await compactContext({
          model: this.model,
          systemPrompt: this.systemPrompt,
          query,
          toolResults: fullToolResults,
          signal: this.signal,
        });

        messageState.messages = this.compactMessages(messageState.messages, result.summary, query);
        ctx.scratchpad.setCompactionSummary(result.summary);

        if (result.usage) {
          ctx.tokenCounter.add(result.usage);
        }

        this.compactionFailures = 0;
        memoryFlushState.alreadyFlushed = false;

        const postCompactTokens = estimateTokens(
          messageState.messages.map(m =>
            typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          ).join('\n'),
        );

        yield {
          type: 'compaction',
          phase: 'end',
          success: true,
          preCompactTokens: estimatedContextTokens,
          postCompactTokens,
          compactionModel: resolveProvider(this.model).fastModel ?? this.model,
        };

        return;
      } catch {
        this.compactionFailures++;
        yield {
          type: 'compaction',
          phase: 'end',
          success: false,
          preCompactTokens: estimatedContextTokens,
        };
      }
    }

    // Step 3: Fallback — truncate oldest rounds
    const removed = this.truncateMessages(messageState.messages, KEEP_TOOL_USES);
    if (removed > 0) {
      memoryFlushState.alreadyFlushed = false;
      yield { type: 'context_cleared', clearedCount: removed, keptCount: KEEP_TOOL_USES };
    }
  }
}
