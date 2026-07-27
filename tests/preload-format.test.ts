import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("the sandboxed preload uses Electron-loadable CommonJS", async () => {
  const source = await readFile(
    fileURLToPath(new URL("../electron/preload.cjs", import.meta.url)),
    "utf8",
  );

  assert.match(source, /require\(["']electron["']\)/);
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.match(source, /contextBridge\.exposeInMainWorld\(["']companion["']/);
  assert.match(source, /sendConversation:\s*\(text\)/);
  assert.match(source, /startRealtimeVoice:\s*\(offerSdp\)/);
  assert.match(source, /stopRealtimeVoice:\s*\(\)/);
  assert.match(source, /onConversationUpdate:\s*\(listener\)/);
  assert.match(source, /onRealtimeVoiceUpdate:\s*\(listener\)/);
  assert.match(source, /logDiagnostic:\s*\(event\)/);
});
