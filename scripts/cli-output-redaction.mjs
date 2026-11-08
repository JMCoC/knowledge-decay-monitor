const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g;
const SUPABASE_KEY_PATTERN = /\bsb_(?:secret|publishable)_[A-Za-z0-9._-]+/g;
const CREDENTIAL_URL_PATTERN = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
const NAMED_SECRET_PATTERN =
  /(\b(?:anon|service[ _-]?role|jwt|secret|api|access|s3)[ _-]*(?:key|secret|token|password)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi;

const REDACTED = "[redacted]";

export function redactCliOutput(text, options = {}) {
  const maxLines = options.maxLines ?? 40;
  const maxChars = options.maxChars ?? 4000;
  if (typeof text !== "string") return "";
  let redacted = text
    .replace(ANSI_PATTERN, "")
    .replace(JWT_PATTERN, REDACTED)
    .replace(SUPABASE_KEY_PATTERN, REDACTED)
    .replace(CREDENTIAL_URL_PATTERN, `$1${REDACTED}@`)
    .replace(NAMED_SECRET_PATTERN, `$1${REDACTED}`);
  const lines = redacted.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (maxLines > 0 && lines.length > maxLines) {
    redacted = lines.slice(-maxLines).join("\n");
  } else {
    redacted = lines.join("\n");
  }
  return maxChars > 0 && redacted.length > maxChars ? redacted.slice(-maxChars) : redacted;
}
