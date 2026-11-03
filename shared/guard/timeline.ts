import { z } from "zod";

export const TimelineDataSchema = z.object({
  pauseId: z.string(), event: z.enum(["paused", "resumed", "released", "attention", "recovery"]),
  at: z.string(), provider: z.string(), native: z.boolean(), autoResume: z.boolean(),
  resetAt: z.string().nullable(), usedPct: z.number().nullable(), note: z.string().nullable(),
  manualResume: z.boolean().optional(), demo: z.boolean().optional(), dismissed: z.boolean().optional(),
});
export type TimelineData = z.infer<typeof TimelineDataSchema>;
export const NotificationSchema = z.object({
  id: z.string(), data: TimelineDataSchema, delivery: z.enum(["pending", "sending", "sent"]),
});
export type Notification = z.infer<typeof NotificationSchema>;

export function timelinePresentation(data: TimelineData) {
  const provider = data.provider === "claude" ? "Claude" : data.provider === "codex" ? "Codex" : data.provider;
  if (data.event === "released" && data.dismissed) return { title: "Pause dismissed", icon: "ShieldOff", tone: "muted" as const,
    detail: "No message was sent. Protection is off for this session." + (data.native ? " Existing workers were released; their current work may continue." : "") };
  if (data.event === "resumed") return { title: "Session resumed", icon: "Play", tone: "success" as const,
    detail: data.manualResume ? "Resumed by you. Protection is off for this session; restore it from the composer pill when ready."
      : data.native ? "Session and native subagents resumed after the quota reset." : "A continuation was sent after the quota reset." };
  if (data.event === "released") return { title: data.native ? "Session released" : "Automatic resume cancelled", icon: "ShieldOff", tone: "muted" as const,
    detail: data.note ?? (data.native ? "Suspended workers were released." : "Continue this session manually when ready.") };
  if (data.event === "attention") return { title: "Pause needs attention", icon: "TriangleAlert", tone: "danger" as const,
    detail: data.note ?? "Check this session before continuing manually." };
  if (data.event === "recovery") return { title: "Waiting after Paseo restart", icon: "Pause", tone: "warning" as const,
    detail: `The original workers ended, but this pause is saved. ${data.autoResume ? "Session Guard will continue this conversation after the quota resets." : "Automatic resume is off; continue manually when ready."} Your workspace and conversation remain in place.` };
  if (data.demo) return { title: "Session Guard demo paused", icon: "Pause", tone: "warning" as const,
    detail: "This empty test session is suspended so you can try Resume now. No provider quota was changed, and no task was sent. It will wait for you to resume it." };
  const reset = data.resetAt ? Date.parse(data.resetAt) : NaN;
  const resetLabel = Number.isFinite(reset) ? `Expected reset ${new Date(reset).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}.` : "The provider has not reported a reset time yet.";
  return { title: "Paused for session limit", icon: "Pause", tone: "warning" as const,
    detail: `${provider}${data.usedPct === null ? "" : ` · ${data.usedPct}% used`}. ${data.native ? "This session and its native subagents are paused." : "The active turn was interrupted."} ${resetLabel} ${data.autoResume ? "Automatic resume was scheduled after reset confirmation." : "Automatic resume was off; continue manually when ready."}` };
}
