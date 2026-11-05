import { PolicySchema, type Policy } from "./policy.ts";

/** The limit-timing fields, as typed. Nothing is saved until every one parses. */
export type Timing = { thresholdPct: string; pollSeconds: string; resetGraceSeconds: string; resumeSpacingSeconds: string; continuation: string; providerIds: string; windowIds: string };
const NUMERIC = ["thresholdPct", "pollSeconds", "resetGraceSeconds", "resumeSpacingSeconds"] as const;
const LISTS = ["providerIds", "windowIds"] as const;

export function timingOf(policy: Policy): Timing {
  return {
    thresholdPct: String(policy.thresholdPct), pollSeconds: String(policy.pollSeconds), resetGraceSeconds: String(policy.resetGraceSeconds),
    resumeSpacingSeconds: String(policy.resumeSpacingSeconds), continuation: policy.continuation, providerIds: policy.providerIds.join(", "), windowIds: policy.windowIds.join(", "),
  };
}
const list = (value: string) => [...new Set(value.split(",").map((s) => s.trim()).filter(Boolean))];

/** Each field checked on its own, so the message sits under the field it is about. */
export function checkTiming(draft: Timing): { values: Partial<Policy>; errors: Partial<Record<keyof Timing, string>> } {
  const values: Record<string, unknown> = {};
  const errors: Partial<Record<keyof Timing, string>> = {};
  const range: Record<(typeof NUMERIC)[number], string> = {
    thresholdPct: "Enter a number from 1 to 100.", pollSeconds: "Enter whole seconds from 5 to 300.",
    resetGraceSeconds: "Enter whole seconds from 0 to 600.", resumeSpacingSeconds: "Enter whole seconds from 0 to 300.",
  };
  for (const key of NUMERIC) {
    const raw = draft[key].trim();
    const parsed = PolicySchema.shape[key].safeParse(raw === "" ? NaN : Number(raw));
    if (parsed.success) values[key] = parsed.data; else errors[key] = range[key];
  }
  const continuation = PolicySchema.shape.continuation.safeParse(draft.continuation);
  if (continuation.success) values.continuation = continuation.data; else errors.continuation = "Write a message of 1 to 8,000 characters.";
  for (const key of LISTS) {
    const parsed = PolicySchema.shape[key].safeParse(list(draft[key]));
    if (parsed.success) values[key] = parsed.data; else errors[key] = "Name at least one window, e.g. five_hour.";
  }
  return { values: values as Partial<Policy>, errors };
}

