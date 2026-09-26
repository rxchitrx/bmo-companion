import { readFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import {
  AppServerConnection,
  COMPANION_CODEX_STARTUP_FLAGS,
  createCompanionConversationThreadParams,
  createCompanionTurnText,
} from "../electron/conversation-client.js";
import { normalizeTaskTokenUsage } from "../electron/codex-adapter.js";
import { tokenUsageDelta } from "../electron/context-telemetry.js";
import type { TokenUsage } from "../electron/task-runtime.js";

const cwd = process.cwd();
const configPath = resolve(process.env.CODEX_HOME ?? resolve(homedir(), ".codex"), "config.toml");
const configText = await readFile(configPath, "utf8").catch(() => "");
const model = process.env.BMO_EVAL_MODEL ?? configText.match(/^model\s*=\s*"([^"]+)"/m)?.[1];
const effort = process.env.BMO_EVAL_EFFORT ?? configText.match(/^model_reasoning_effort\s*=\s*"([^"]+)"/m)?.[1];
if (!model || !effort) throw new Error("Configure Codex model and effort or set BMO_EVAL_MODEL and BMO_EVAL_EFFORT.");

const taskState = "[AUTHORITATIVE TASK STATE]\nNo Task exists.";
const prompts = [
  "For this short experiment, remember that my code word is amber. Acknowledge in one short sentence.",
  "Give me a one-sentence encouragement for starting a small task.",
  "What was my code word? Answer with only the word.",
  "Suggest one simple way to take a short break. One sentence.",
  "For this experiment, remember that my lucky number is 17. Acknowledge in one short sentence.",
  "Give me one short sentence to help me focus.",
  "What was my code word? Answer with only the word.",
  "What was my lucky number? Answer with only the number.",
  "Suggest one way to organize a small to-do list. One sentence.",
  "What were my code word and lucky number? Answer briefly.",
] as const;
const expected = new Map<number, string[]>([
  [3, ["amber"]],
  [7, ["amber"]],
  [8, ["17"]],
  [10, ["amber", "17"]],
]);

interface TurnResult {
  turn: number;
  inputTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  elapsedMs: number;
  answer: string;
  memoryCheck: "pass" | "fail" | "not-applicable";
  toolRequests: number;
}

async function runArm(id: string, flags: readonly string[]): Promise<TurnResult[]> {
  let toolRequests = 0;
  const connection = new AppServerConnection(
    `conversation.growth.${id}`,
    () => {
      toolRequests++;
      return { error: { code: -32601, message: "The conversation growth lab has no external tools." } };
    },
    flags,
  );
  const results: TurnResult[] = [];
  let cumulativeUsage: TokenUsage | undefined;
  try {
    await connection.start();
    const thread = await connection.request("thread/start", createCompanionConversationThreadParams(cwd));
    const threadId = thread?.thread?.id;
    if (typeof threadId !== "string") throw new Error("Codex did not return a thread ID.");
    for (let index = 0; index < prompts.length; index++) {
      let answer = "";
      let latestUsage: TokenUsage | undefined;
      const toolCountBefore = toolRequests;
      const remove = connection.onNotification((message) => {
        if (message.method === "thread/tokenUsage/updated") {
          latestUsage = normalizeTaskTokenUsage(message.params?.tokenUsage);
        } else if (message.method === "item/agentMessage/delta") {
          answer += String(message.params?.delta ?? "");
        } else if (message.method === "item/completed" && message.params?.item?.type === "agentMessage") {
          answer = String(message.params.item.text ?? answer);
        }
      });
      const started = Date.now();
      try {
        await connection.request("turn/start", {
          threadId,
          model,
          effort,
          input: [{ type: "text", text: createCompanionTurnText(taskState, prompts[index]!) }],
        }, 120_000);
        const completion = await connection.waitFor(
          (message) => message.method === "turn/completed" && message.params?.threadId === threadId,
          `conversation growth turn ${index + 1}`,
          120_000,
        );
        if (completion.params?.turn?.status !== "completed") throw new Error(`Turn ${index + 1} did not complete.`);
      } finally {
        remove();
      }
      if (!latestUsage) throw new Error(`Turn ${index + 1} provided no token usage.`);
      const delta = tokenUsageDelta(latestUsage, cumulativeUsage);
      cumulativeUsage = latestUsage;
      const required = expected.get(index + 1);
      const memoryCheck = required
        ? required.every((part) => answer.toLowerCase().includes(part)) ? "pass" : "fail"
        : "not-applicable";
      const result: TurnResult = {
        turn: index + 1,
        inputTokens: delta.inputTokens,
        cachedInputTokens: delta.cachedInputTokens,
        uncachedInputTokens: delta.inputTokens - delta.cachedInputTokens,
        outputTokens: delta.outputTokens,
        elapsedMs: Date.now() - started,
        answer: answer.trim(),
        memoryCheck,
        toolRequests: toolRequests - toolCountBefore,
      };
      results.push(result);
      process.stderr.write(`${id} turn ${result.turn}/10: ${result.inputTokens} input tokens, memory ${memoryCheck}.\n`);
      if (!answer.trim() || memoryCheck === "fail" || result.toolRequests > 0 || delta.inputTokens <= 0) {
        throw new Error(`${id} turn ${index + 1} violated the conversation lab contract.`);
      }
    }
    return results;
  } finally {
    connection.stop("conversation growth lab finished");
  }
}

const arms = [
  { id: "baseline", flags: [] },
  { id: "lean", flags: COMPANION_CODEX_STARTUP_FLAGS },
] as const;
const observations: Record<string, TurnResult[]> = {};
const outputPath = resolve(process.env.BMO_EVAL_OUTPUT_PATH ?? "outputs/evaluation/conversation-growth-2026-09-24.json");
for (const arm of arms) {
  try {
    observations[arm.id] = await runArm(arm.id, arm.flags);
  } finally {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, JSON.stringify({
      generatedAt: new Date().toISOString(),
      model,
      effort,
      taskState,
      prompts,
      arms: arms.map(({ id, flags }) => ({ id, flags })),
      observations,
    }, null, 2) + "\n");
  }
}
process.stdout.write(`${outputPath}\n`);
