import { createHash } from "node:crypto";

const SECRET_PATTERN =
  /(bearer\s+)[a-z0-9._~+/=-]+|sk-[a-z0-9_-]{12,}|([?&](?:token|key|secret|code)=)[^&\s]+/gi;
const TEXT_KEYS = /^(?:text|assistantText|prompt|goal|delta|transcript|sdp|audio|content|input|summary|question|message|line|latestProgress|detail)$/i;
const SECRET_KEYS = /token|secret|password|cookie|credential|authorization|api[-_]?key/i;

export function textMeta(value: string) {
  return {
    chars: value.length,
    sha256: createHash("sha256").update(value).digest("hex").slice(0, 12),
  };
}

function scrubString(value: string) {
  return value
    .replace(SECRET_PATTERN, (_match, bearerPrefix: string | undefined, queryPrefix: string | undefined) =>
      `${bearerPrefix ?? queryPrefix ?? ""}[REDACTED]`)
    .slice(0, 800);
}

export function sanitizeDiagnostic(
  value: unknown,
  key = "",
  depth = 0,
): unknown {
  if (depth > 5) return "[MAX_DEPTH]";
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (SECRET_KEYS.test(key)) return "[REDACTED]";
    if (TEXT_KEYS.test(key)) return textMeta(value);
    return scrubString(value);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 30).map((item) => sanitizeDiagnostic(item, key, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 60)
        .map(([entryKey, entryValue]) => [
          entryKey,
          SECRET_KEYS.test(entryKey) && typeof entryValue !== "number"
            ? "[REDACTED]"
            : sanitizeDiagnostic(entryValue, entryKey, depth + 1),
        ]),
    );
  }
  return String(value);
}

export function diagnosticLog(
  scope: string,
  event: string,
  details: Record<string, unknown> = {},
) {
  const payload = {
    at: new Date().toISOString(),
    pid: process.pid,
    scope,
    event,
    details: sanitizeDiagnostic(details),
  };
  console.log(`[BMO-DIAG] ${JSON.stringify(payload)}`);
}
