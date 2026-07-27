import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeDiagnostic, textMeta } from "../electron/diagnostics";

test("diagnostic metadata identifies text without recording its contents", () => {
  const source = "Hello, this should remain private.";
  const metadata = textMeta(source);

  assert.equal(metadata.chars, source.length);
  assert.match(metadata.sha256, /^[a-f0-9]{12}$/);
  assert.doesNotMatch(JSON.stringify(metadata), /Hello|private/);
});

test("diagnostic sanitizer removes secrets and converts conversational text to metadata", () => {
  const sanitized = sanitizeDiagnostic({
    token: "top-secret-token",
    authorization: "Bearer sk-super-secret-123456789",
    text: "Hello from the user",
    assistantText: "A private answer",
    nested: {
      message: "Assistant response",
      url: "https://example.com/?token=abc123&view=full",
    },
    usage: {
      inputTokens: 1200,
      outputTokens: 300,
      totalTokens: 1500,
    },
  });
  const serialized = JSON.stringify(sanitized);

  assert.doesNotMatch(serialized, /top-secret|super-secret|abc123|Hello from|A private answer|Assistant response/);
  assert.match(serialized, /\[REDACTED\]/);
  assert.match(serialized, /"chars":19/);
  assert.match(serialized, /"totalTokens":1500/);
});
