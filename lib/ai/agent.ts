// The orchestration loop: model decides which tool to call, we make the real
// HTTP call to the matching GridForge engine endpoint, validate the result,
// and only then let the model produce explanation text bound to it.
//
// This is the fix for the honesty-kernel violation in the old app/api/chat
// route: that handler called Anthropic directly, with no tools, and returned
// raw prose as if it were an engineering read. Every "directional read" was
// narration. Here, a numeric claim can only reach the reply after a real
// tool_use round trip through callEngineTool (lib/ai/tools.ts) — the engine,
// not the model, is the source of every number.

import Anthropic from "@anthropic-ai/sdk";
import { checkEntitlement, type EntitlementContext } from "./entitlements";
import { isOutOfScope, MAX_TOOL_CALLS_PER_TURN, OUT_OF_SCOPE_REPLY } from "./policy";
import { buildSystemPrompt } from "./prompts/system";
import {
  blockFromRefusal,
  constraintFromQualify,
  engagementOfferBlock,
  evidenceSummary,
  metricsFromEngineResponse,
  missingInputBlock,
} from "./responses";
import {
  agentTurnResultSchema,
  type AgentBlock,
  type AgentTurnResult,
  type ToolCallRecord,
} from "./schemas";
import { anthropicTools, callEngineTool, requiredKeys, TOOLS_BY_NAME } from "./tools";
import type { ChatMessage } from "./context";

const MODEL = "claude-sonnet-4-6";

export interface RunTurnOptions {
  apiKey: string;
  messages: ChatMessage[];
  entitlement?: EntitlementContext;
}

type AnthropicMessage = { role: "user" | "assistant"; content: unknown };

/**
 * Run one chat turn through the tool-calling loop and return a structured
 * result: the prose reply (what app/api/chat/route.ts puts in `reply`, so
 * the widget contract never changes) plus the blocks and tool-call ledger a
 * caller can use to enforce "no number without a tool call this turn".
 */
export async function runTurn(opts: RunTurnOptions): Promise<AgentTurnResult> {
  const { apiKey, messages } = opts;
  const entitlement = opts.entitlement ?? {};

  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (lastUser && isOutOfScope(lastUser.content)) {
    return agentTurnResultSchema.parse({ reply: OUT_OF_SCOPE_REPLY, blocks: [], toolCalls: [] });
  }

  const anthropic = new Anthropic({ apiKey });
  const system = buildSystemPrompt();
  const blocks: AgentBlock[] = [];
  const toolCalls: ToolCallRecord[] = [];

  const convo: AnthropicMessage[] = messages.map((m) => ({ role: m.role, content: m.content }));

  let finalText = "";
  for (let round = 0; round < MAX_TOOL_CALLS_PER_TURN + 1; round++) {
    const resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system,
      tools: anthropicTools(),
      messages: convo as Anthropic.MessageParam[],
    });

    const toolUseBlocks = resp.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (text) finalText = text;

    if (toolUseBlocks.length === 0 || toolCalls.length >= MAX_TOOL_CALLS_PER_TURN) {
      break;
    }

    // Anthropic requires the assistant turn that requested tools to be
    // echoed back before the tool_result turn.
    convo.push({ role: "assistant", content: resp.content });

    const toolResultContent: {
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    }[] = [];

    for (const use of toolUseBlocks) {
      if (toolCalls.length >= MAX_TOOL_CALLS_PER_TURN) break;
      const { record, block, resultText } = await runOneToolCall(use, entitlement);
      toolCalls.push(record);
      if (block) blocks.push(...block);
      toolResultContent.push({
        type: "tool_result",
        tool_use_id: use.id,
        content: resultText,
        is_error: !record.ok,
      });
    }

    convo.push({ role: "user", content: toolResultContent });
  }

  return agentTurnResultSchema.parse({
    reply: finalText || "I need a bit more to go on — what platform, MW and site details can you share?",
    blocks,
    toolCalls,
  });
}

async function runOneToolCall(
  use: Anthropic.ToolUseBlock,
  entitlement: EntitlementContext
): Promise<{ record: ToolCallRecord; block: AgentBlock[] | null; resultText: string }> {
  const tool = TOOLS_BY_NAME[use.name];
  const args = (use.input && typeof use.input === "object" ? use.input : {}) as Record<string, unknown>;

  if (!tool) {
    return {
      record: { tool: use.name, args, ok: false, status: 400 },
      block: null,
      resultText: `Unknown tool "${use.name}".`,
    };
  }

  // Missing required input → a missingInput block, never a guessed value and
  // never a wasted (possibly billable) round trip to the engine.
  const missing = requiredKeys(tool).filter((k) => args[k] === undefined || args[k] === null || args[k] === "");
  if (missing.length > 0) {
    const field = missing[0];
    return {
      record: { tool: tool.name, args, ok: false, status: 422 },
      block: [missingInputBlock(tool.name, field, `Required by ${tool.name}.`)],
      resultText: `Missing required input(s): ${missing.join(", ")}. Ask the user for these rather than assuming a value.`,
    };
  }

  const entitlementResult = await checkEntitlement(tool, entitlement);
  if (!entitlementResult.allowed) {
    return {
      record: { tool: tool.name, args, ok: false, status: entitlementResult.status },
      block: [
        blockFromRefusal(tool.name, {
          ok: false,
          reason: entitlementResult.reason === "quota_exceeded" ? "quota_exceeded" : "rejected",
          status: entitlementResult.status,
          detail: entitlementResult.detail,
        }),
      ],
      resultText: `Refused (${entitlementResult.status}): ${entitlementResult.detail} This is a paid engagement — point the user at /pricing rather than answering the question.`,
    };
  }

  const outcome = await callEngineTool(tool, args);
  if (!outcome.ok) {
    return {
      record: { tool: tool.name, args, ok: false, status: outcome.status },
      block: [blockFromRefusal(tool.name, outcome)],
      resultText: `Engine call failed (${outcome.reason}, ${outcome.status}): ${outcome.detail} Do not invent a result — tell the user the engine could not be reached or the call was refused.`,
    };
  }

  const metricBlocks = metricsFromEngineResponse(tool.name, outcome.body);
  const digestOf = metricBlocks
    .map((b) => (b.type === "metric" ? b.quantity.digest : null))
    .filter((d): d is string => typeof d === "string");

  // The commercial handoff: a successful free qualify that named a binding
  // constraint always gets an offer for the paid next step (Density Screen),
  // never left as an essay with no way to buy. Other tools never generate
  // this block — they either already produced their own paid deliverable
  // (entitlement allowed it) or were refused above.
  const constraintBlocks = tool.name === "gridforge_qualify" ? constraintFromQualify(tool.name, outcome.body) : [];
  const resultBlocks: AgentBlock[] = [...metricBlocks, ...constraintBlocks];
  if (constraintBlocks.length > 0) {
    resultBlocks.push(engagementOfferBlock(tool.name));
  }
  // Standing calibration disclosure: every reply carrying a number must say
  // where it stands on the evidence ladder, and that the ledger is empty.
  resultBlocks.push(...evidenceSummary(tool.name, outcome.body));

  return {
    record: { tool: tool.name, args, ok: true, status: outcome.status, digestOf },
    block: resultBlocks,
    resultText: JSON.stringify(outcome.body),
  };
}
