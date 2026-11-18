/** Ordered exclusions and transient classes, shared by event and pre-send checks. */
export const TRANSIENT_PATTERNS: readonly { kind: TransientClass | null; pattern: RegExp }[] = [
  { kind: null, pattern: /\b401\b|\b(?:login|session|token|credentials?)\b.{0,24}\bexpired\b|\bexpired\b.{0,24}\b(?:login|session|token|credentials?)\b/i },
  { kind: null, pattern: /\b429\b|usage limit|rate.?limit|hit your limit|quota|limit reached|exceeded.*limit|limit.*exceeded|too many requests/i },
  // Some CLIs prefix an edge block with "Failed to authenticate". The page wins
  // over that generic prefix; an actual 401 or expired credential above never does.
  { kind: "cloudflare", pattern: /attention required|\bcf-ray\b/i },
  { kind: null, pattern: /\b403\b|unauthenticated|unauthorized|forbidden|failed to authenticate|invalid (?:api[ -]?key|token|credentials?)|(?:login|authentication) required|authentication failed|not logged in/i },
  { kind: "overloaded", pattern: /\boverloaded\b|(?:^|\b(?:HTTP(?:\/[\d.]+)?|API(?:\s+Error)?|status(?:\s*code)?)[\s:=()-]*)529\b/i },
  { kind: "server", pattern: /(?:^|\b(?:HTTP(?:\/[\d.]+)?|API(?:\s+Error)?|status(?:\s*code)?)[\s:=()-]*)5\d\d\b/i },
  { kind: "connection", pattern: /\bECONNRESET\b|\bconnection (?:was )?reset\b|\bsocket hang up\b/i },
  { kind: "timeout", pattern: /\b(?:ETIMEDOUT|ESOCKETTIMEDOUT|TimeoutError|UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT|timeout)\b|\btimed?\s*out\b/i },
];
export type TransientClass = "cloudflare" | "overloaded" | "server" | "connection" | "timeout";
export function classifyTransient(message: string): TransientClass | null {
  return TRANSIENT_PATTERNS.find(rule => rule.pattern.test(message))?.kind ?? null;
}
export const TRANSIENT_BACKOFF_MS = [60_000, 180_000, 600_000] as const;
export const TRANSIENT_SPACING_MS = 5_000;
export const TRANSIENT_CONTINUATION = "Your last turn hit a transient API error. Continue the unfinished task in this conversation from where you left off. Check interrupted operations before retrying them. If the task is already complete, do not repeat it.";
