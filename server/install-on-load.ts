/**
 * Reconciling Claude Code's configuration, once, when the plugin loads.
 *
 * A separate module from `install.server.ts` for two reasons, and both of them
 * matter more than the four lines saved by merging them.
 *
 * Paseo compiles the server entry independently, so the load-time side effect
 * belongs here and is imported only by `index.server.ts`. `check-bundles.mjs`
 * guards that runtime boundary.
 *
 * And it keeps `install.server.ts` free of side effects, so a test can import the
 * reconciler without a module-level call racing it — or worse, writing to the
 * machine's real Claude Code settings just because something imported a function.
 */

import { install } from "./install.ts";

void install()
  .then((report) => {
    if (report.error !== null) {
      console.error(`[smart-session] ${report.error}`);
      return;
    }
    if (report.changed) {
      console.log(`[smart-session] registered ${report.hooks.join(", ")} in ${report.settingsPath}`);
    }
    if (report.mcp === "added") console.log("[smart-session] registered the agent-facing MCP server");
    if (report.mcp === "updated") console.log("[smart-session] updated the agent-facing MCP server path");
    if (report.mcp === "unavailable") {
      console.error(
        "[smart-session] could not reach the `claude` CLI to register the MCP server; run `claude mcp add-json --scope user smart-session` by hand if the agent tools are missing",
      );
    }
  })
  .catch((error: unknown) => console.error("[smart-session] hook install failed", String(error)));
