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

import { lifecycle } from "../shared/lifecycle.ts";
import { install, refreshPointer, resolvePluginDir } from "./install.ts";
import { removeGlobalRegistrations } from "./mcp-registrations.ts";

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

// Older versions registered the agent tools globally; they are attached per launch now. Only an
// install Paseo actually loads from this PASEO_HOME does this, so a check that loads the bundle
// against a sandbox (check-teardown.mjs) never reaches the machine's real Claude and Codex homes.
void resolvePluginDir()
  .then((directory) => (directory === null ? [] : removeGlobalRegistrations()))
  .then((results) => {
    for (const result of results) {
      if (result.status === "removed") console.log(`[smart-session] removed the global MCP registration from ${result.path} (backup beside it)`);
      if (result.status === "error" || result.status === "unavailable") console.error(`[smart-session] could not remove the global MCP registration from ${result.path}: ${result.error ?? "no claude CLI on PATH"}`);
    }
  })
  .catch(() => undefined);

// Self-heal. The hooks run through shims whose pointer names an install directory, and
// Paseo deletes an install directory on update. install() above already points the shims
// at the running version; this repairs the pointer if its target disappears later. A
// healthy pointer costs a few stat calls and writes nothing, hence ten minutes.
const HEAL_MS = 10 * 60_000;
const heal = setInterval(() => {
  void refreshPointer()
    .then((moved) => {
      if (moved) console.log("[smart-session] re-pointed the hook shims at the running install");
    })
    .catch(() => undefined);
}, HEAL_MS);
heal.unref?.();
lifecycle.teardowns.push(() => clearInterval(heal));
