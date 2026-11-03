import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { PauseSchema, PolicySchema } from "./policy.ts";

/** Host-scoped, so every client of this daemon sees one Session Guard policy. */
export const guardPreferences = defineSettings({ id: "session-guard", scope: "host", version: 1, schema: PolicySchema });

/**
 * Who is running Session Guard on this host.
 *
 * - `off`: the feature is disabled here, and this plugin holds no lock.
 * - `active`: this plugin is the host's one governor.
 * - `deferred`: the standalone `paseo-session-guard` plugin is enabled, or another live
 *   process holds the governor lock. Nothing is paused from here until that changes.
 * - `error`: the saved state or the lock could not be read.
 */
export const GovernorSchema = z.enum(["off", "active", "deferred", "error"]);
export type Governor = z.infer<typeof GovernorSchema>;

const ProviderSchema = z.object({ providerId: z.string(), usedPct: z.number().nullable(), resetsAt: z.string().nullable() });

export const statusRpc = defineRpc({
  name: "smart-session.guard.status", input: z.object({}),
  output: z.object({
    governor: GovernorSchema,
    /** Whether the standalone plugin is configured and enabled; null when unknown or not checked. */
    standalone: z.boolean().nullable(),
    checkedAt: z.string().nullable(), error: z.string().nullable(),
    pauses: z.array(PauseSchema), overrides: z.record(z.string(), z.boolean()),
    policy: PolicySchema,
    providers: z.array(ProviderSchema),
  }),
});
/** One agent's view, for the agent itself: its own protection and pauses, nobody else's. */
export const agentStatusRpc = defineRpc({
  name: "smart-session.guard.agent", input: z.object({ agentId: z.string().min(1) }),
  output: z.object({
    governor: GovernorSchema,
    enabled: z.boolean(), protected: z.boolean(), override: z.boolean().nullable(),
    thresholdPct: z.number(), autoResume: z.boolean(),
    pauses: z.array(z.object({ id: z.string(), phase: PauseSchema.shape.phase, provider: z.string(), resetsAt: z.string().nullable() })),
    providers: z.array(ProviderSchema),
    summary: z.array(z.string()),
  }),
});
export const setProtectionRpc = defineRpc({
  name: "smart-session.guard.protection", input: z.object({ agentId: z.string().min(1), enabled: z.boolean().nullable() }),
  output: z.object({ ok: z.boolean() }),
});
export const cancelResumeRpc = defineRpc({
  name: "smart-session.guard.cancel", input: z.object({ agentId: z.string().min(1) }), output: z.object({ ok: z.boolean() }),
});
export const resumeNowRpc = defineRpc({
  name: "smart-session.guard.resume-now", input: z.object({ agentId: z.string().min(1), pauseId: z.string().min(1) }),
  output: z.object({ ok: z.boolean() }),
});
export const dismissPauseRpc = defineRpc({
  name: "smart-session.guard.dismiss-pause", input: z.object({ agentId: z.string().min(1), pauseId: z.string().min(1) }),
  output: z.object({ ok: z.boolean() }),
});
export const demoPauseRpc = defineRpc({
  name: "smart-session.guard.demo-pause", input: z.object({ agentId: z.string().min(1) }), output: z.object({ ok: z.boolean() }),
});
// Obtains the host-owned IPC API; network clients cannot impersonate plugins.
export const runtimeRpc = defineRpc({ name: "smart-session.guard.runtime", input: z.object({}), output: z.object({ ok: z.boolean() }) });
