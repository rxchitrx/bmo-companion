import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { authorizePiToolCall, scopedCodePath } from "./pi-tool-scope.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };
type ToolDefinition = {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (_id: unknown, params: Record<string, string>) => Promise<ToolResult>;
};
type PiExtensionApi = {
  on: (name: string, handler: (event: { toolName: string; input: Record<string, unknown> }) => Promise<{ block: true; reason: string } | undefined>) => void;
  registerTool: (definition: ToolDefinition) => void;
};
const result = (text: string): ToolResult => ({ content: [{ type: "text", text }], details: {} });
const schema = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object", properties, required, additionalProperties: false,
});
const pathParameter = { type: "string", description: "Path relative to the isolated code workspace" };

/** Custom tools only. Pi starts with --no-builtin-tools, so a failed extension
 * load grants zero filesystem operations to the model. */
export default function (pi: PiExtensionApi) {
  const root = process.cwd();
  pi.on("tool_call", async (event) => {
    try {
      await authorizePiToolCall(root, event.toolName, event.input);
      return undefined;
    } catch (error) {
      return { block: true, reason: error instanceof Error ? error.message : "Tool denied by BMO." };
    }
  });
  pi.registerTool({
    name: "bmo_ls", label: "List workspace", description: "List one directory inside the isolated code workspace.",
    parameters: schema({ path: { type: "string", description: "Directory path, defaults to current workspace" } }, []),
    async execute(_id, params) {
      const path = await scopedCodePath(root, params.path ?? ".");
      const names = (await readdir(path, { withFileTypes: true }))
        .filter((entry) => !entry.name.startsWith(".") || [".gitignore", ".editorconfig"].includes(entry.name))
        .slice(0, 200).map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`);
      return result(names.join("\n") || "(empty)");
    },
  });
  pi.registerTool({
    name: "bmo_read", label: "Read workspace file", description: "Read a text file inside the isolated code workspace (up to 64 KB).",
    parameters: schema({ path: pathParameter }, ["path"]),
    async execute(_id, params) {
      const path = await scopedCodePath(root, params.path);
      if ((await stat(path)).size > 1_000_000) throw new Error("File is too large for this coding tool.");
      const content = await readFile(path, "utf8");
      if (content.includes("\0")) throw new Error("Binary files are outside this tool's scope.");
      return result(content.length > 64_000 ? `${content.slice(0, 64_000)}\n[truncated]` : content);
    },
  });
  pi.registerTool({
    name: "bmo_edit", label: "Edit workspace file", description: "Replace one exact unique text span in a workspace file.",
    parameters: schema({ path: pathParameter, oldText: { type: "string" }, newText: { type: "string" } }, ["path", "oldText", "newText"]),
    async execute(_id, params) {
      const path = await scopedCodePath(root, params.path);
      if (!params.oldText || params.newText.length > 128_000) throw new Error("Invalid edit size.");
      if ((await stat(path)).size > 1_000_000) throw new Error("File is too large for this coding tool.");
      const content = await readFile(path, "utf8");
      const first = content.indexOf(params.oldText);
      if (first < 0 || content.indexOf(params.oldText, first + params.oldText.length) >= 0) throw new Error("Edit target must occur exactly once.");
      await writeFile(path, content.slice(0, first) + params.newText + content.slice(first + params.oldText.length), "utf8");
      return result("Updated the scoped file.");
    },
  });
  pi.registerTool({
    name: "bmo_write", label: "Write workspace file", description: "Create or replace one text file inside the isolated code workspace.",
    parameters: schema({ path: pathParameter, content: { type: "string" } }, ["path", "content"]),
    async execute(_id, params) {
      const path = await scopedCodePath(root, params.path);
      if (params.content.length > 256_000) throw new Error("File content is too large.");
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, params.content, "utf8");
      return result("Wrote the scoped file.");
    },
  });
}
