const SECRET_PATTERN =
  /(bearer\s+)[a-z0-9._~+/=-]+|sk-[a-z0-9_-]{12,}|([?&](?:token|key|secret|code)=)[^&\s]+/gi;
const TEXT_KEYS = /^(?:text|assistantText|prompt|goal|delta|transcript|sdp|audio|content|input|summary|question|message|line|latestProgress|detail)$/i;
const SECRET_KEYS = /token|secret|password|cookie|credential|authorization|api[-_]?key/i;

function textMeta(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return { chars: value.length, fingerprint: (hash >>> 0).toString(16).padStart(8, "0") };
}

function sanitize(value: unknown, key = "", depth = 0): unknown {
  if (depth > 5) return "[MAX_DEPTH]";
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (SECRET_KEYS.test(key)) return "[REDACTED]";
    if (TEXT_KEYS.test(key)) return textMeta(value);
    return value
      .replace(SECRET_PATTERN, (_match, bearerPrefix: string | undefined, queryPrefix: string | undefined) =>
        `${bearerPrefix ?? queryPrefix ?? ""}[REDACTED]`)
      .slice(0, 800);
  }
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => sanitize(item, key, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 60)
        .map(([entryKey, entryValue]) => [
          entryKey,
          SECRET_KEYS.test(entryKey) && typeof entryValue !== "number"
            ? "[REDACTED]"
            : sanitize(entryValue, entryKey, depth + 1),
        ]),
    );
  }
  return String(value);
}

export function clientDiagnostic(
  scope: string,
  event: string,
  details: Record<string, unknown> = {},
) {
  const payload = {
    at: new Date().toISOString(),
    scope,
    event,
    details: sanitize(details),
  };
  console.debug("[BMO-DIAG]", payload);
  if (typeof window !== "undefined" && window.companion?.logDiagnostic) {
    window.companion?.logDiagnostic(payload);
  }
}
