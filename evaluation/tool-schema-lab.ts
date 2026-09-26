import { createCompanionConversationThreadParams } from "../electron/conversation-client.js";
import { createRealtimeConversationThreadParams } from "../electron/realtime-voice-client.js";
import { MODEL_VISIBLE_CAPABILITY_ALLOWLIST } from "../electron/capability-selection.js";
import { TOOL_RISK_REGISTRY } from "../electron/tool-policy.js";

const missing = [...MODEL_VISIBLE_CAPABILITY_ALLOWLIST].filter((id) => !TOOL_RISK_REGISTRY[id]);
if (missing.length) throw new Error(`Unmapped connector actions: ${missing.join(", ")}`);

const measure = (surface: string, tools: readonly unknown[]) => ({
  surface,
  visibleTools: tools.length,
  schemaUtf8Bytes: Buffer.byteLength(JSON.stringify(tools)),
});

const typed = createCompanionConversationThreadParams(process.cwd()).dynamicTools;
const voice = createRealtimeConversationThreadParams(process.cwd()).dynamicTools;
const hypotheticalCodeRunner = [{
  type: "function", name: "run_tool_code",
  description: "Hypothetical programmatic tool call. Disabled by BMO's final safety guard.",
  inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false },
}];

process.stdout.write(`${JSON.stringify({
  schemaVersion: "bmo-tool-schema-lab/1",
  modelUsageMeasured: false,
  programmaticToolCallsEnabled: false,
  current: [measure("typed-conversation", typed), measure("realtime-voice", voice)],
  hypothetical: measure("programmatic-single-tool", hypotheticalCodeRunner),
  mappedConnectorActions: MODEL_VISIBLE_CAPABILITY_ALLOWLIST.size,
}, null, 2)}\n`);
