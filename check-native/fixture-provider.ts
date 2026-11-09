// A provider that runs no model: it records each launch config (so the check can see which MCP servers and
// tools an agent was given) and answers the session protocol just enough for agents to open, idle and close.
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export default function contribute(server: PluginServerContext) {
  server.registerProvider({
    id: "smart-session-fixture", label: "Smart Session test agent",
    async status() { return { available: true }; },
    async connect() {
      const listeners = new Set<(event: ProviderEvent) => void>();
      const emit = (e: ProviderEvent) => listeners.forEach((listener) => listener(e));
      const capabilities = ["prompt.message", "session.persistence", "session.list", "session.archive", "permission.tool_policy"];
      return {
        version: 1, capabilities,
        onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        async close() { listeners.clear(); },
        async send(input) {
          if (input.type === "catalog") emit({ type: "catalog", requestId: input.requestId, catalog: { models: [{ id: "fixture", label: "Fixture", isDefault: true }], modes: [{ id: "default", label: "Default" }] } });
          else if (input.type === "sessions") emit({ type: "sessions", requestId: input.requestId, sessions: [] });
          else if (input.type === "session.open") {
            await writeFile(join(process.env.PASEO_HOME!, `fixture-agent-config-${input.config.env.PASEO_AGENT_ID}.json`), JSON.stringify(input.config));
            emit({ type: "session.opened", requestId: input.requestId, sessionId: input.sessionId, capabilities, restoration: "core", cwd: input.config.cwd, persistence: { version: 1, data: { sessionId: input.sessionId } } });
            emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
          } else if (input.type === "session.prompt") {
            const turnId = randomUUID();
            emit({ type: "session.prompt_result", sessionId: input.sessionId, clientMessageId: input.prompt.clientMessageId, result: { type: "turn", turnId } });
            setTimeout(() => {
              emit({ type: "session.turn", sessionId: input.sessionId, turnId, state: "started" });
              emit({ type: "session.turn", sessionId: input.sessionId, turnId, state: "completed" });
            }, 50);
          } else if (input.type === "session.close") {
            emit({ type: "session.closed", sessionId: input.sessionId }); emit({ type: "request.completed", requestId: input.requestId });
          } else if ("requestId" in input) emit({ type: "request.completed", requestId: input.requestId });
        },
      };
    },
  });
  return () => {};
}
