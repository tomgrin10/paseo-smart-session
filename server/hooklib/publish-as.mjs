/**
 * The `PreToolUse` hook on the Artifact tool, as a function: `hooks/publish-as.mjs` wires it to
 * stdin, stdout and the daemon, and the tests call it with the plugin's own handlers.
 *
 * A page published from a session on another Claude account (under ZeroSub) is published as the
 * main account instead, so the person owns it. The decision and the helper run live in the plugin
 * (`server/publish-as.ts`); this only asks. A call it takes over is answered "deny" with the link:
 * the only way a `PreToolUse` hook can stop the original publish and still hand text back. That
 * reason leads with the success, so the model doesn't retry.
 *
 * It never fails the turn: anything unexpected (no daemon, an old plugin, a malformed event) lets
 * the call through as it is, which is what happened before this hook existed.
 */

/** Under the hook's own timeout (180 s in settings.json), with room to answer. */
export const DEADLINE_MS = 160_000;
export const HELPER_ENV = "SMART_SESSION_PUBLISH_HELPER";

export const UNREACHABLE =
  "Smart Session couldn't reach Paseo to check which Claude account this artifact should be published as, so it is published on this session's own account. If that isn't the user's main account, they may not be able to open it: say so when you share the link.";

/** Only a publish can create or change a page; anything else never reaches the daemon. */
export function mayPublish(input) {
  if (input === null || typeof input !== "object") return false;
  const action = typeof input.action === "string" && input.action.trim() !== "" ? input.action.trim() : "publish";
  if (action !== "publish") return false;
  return ["url", "type_url", "file_path"].some((key) => typeof input[key] === "string" && input[key].trim() !== "")
    || (input.files !== undefined && input.files !== null);
}

const output = (fields) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", ...fields } });

/**
 * @param {any} event The hook's stdin, parsed.
 * @param {{ env: Record<string, string | undefined>, call: (method: string, input: unknown) => Promise<any>, native: boolean, deadlineMs?: number, now?: () => number }} context
 * @returns {Promise<object | null>} The hook's stdout, or null to say nothing.
 */
export async function publishAsHook(event, context) {
  if (event?.tool_name !== "Artifact" || !mayPublish(event.tool_input)) return null;
  // A helper is on the main account already; never let it start another helper.
  if (context.env[HELPER_ENV] === "1") return null;
  const agentId = context.env.PASEO_AGENT_ID;
  if (!agentId) return null;
  const now = context.now ?? Date.now;

  let started;
  try {
    started = await context.call("smart-session.publish_as.start", {
      callerAgentId: agentId,
      cwd: typeof event.cwd === "string" && event.cwd !== "" ? event.cwd : process.cwd(),
      input: event.tool_input,
      via: "hook",
    });
  } catch {
    return output({ additionalContext: UNREACHABLE });
  }
  // Out of usage and not allowed to spend Extra usage: nothing was published, and the model is told why.
  if (started?.decision === "refused" && typeof started.note === "string") {
    return output({ permissionDecision: "deny", permissionDecisionReason: started.note });
  }
  if (started?.decision !== "queued") {
    return typeof started?.note === "string" && started.note !== "" ? output({ additionalContext: started.note }) : null;
  }

  const until = now() + (context.deadlineMs ?? DEADLINE_MS);
  while (now() < until) {
    let waited;
    try {
      waited = await context.call("smart-session.publish_as.wait", {
        jobId: started.jobId, waitMs: Math.max(0, Math.min(25_000, until - now())), native: context.native,
      });
    } catch {
      break;
    }
    if (waited?.done) return output({ permissionDecision: "deny", permissionDecisionReason: waited.text });
  }
  return output({
    permissionDecision: "deny",
    permissionDecisionReason: `Not confirmed yet: Smart Session is still publishing this as ${started.owner} and stopped waiting. Don't call Artifact for it again. In a minute, call ${context.native ? "smart_publish_as" : "publish_as"} with the same file_path: it updates that same page and returns its link.`,
  });
}
