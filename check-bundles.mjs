/** Builds both v0.8 runtime entries and executes the client contribution. */
import * as esbuild from "esbuild";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditRuntimeBoundaries, buildOptions, instantiateBundle } from "./check-lib.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));

async function runClientBundle(code) {
  const zod = await import("zod");
  const contracts = {
    defineSettings: (definition) => definition,
    settingsRpc: (id) => ({ read: { name: `settings.${id}.read` } }),
    defineRpc: (definition) => definition,
    defineAttachmentSource: (definition) => definition,
  };
  const stubs = {
    zod,
    react: {},
    "react/jsx-runtime": {},
    "react-native": { Platform: { OS: "web" }, Animated: {}, Easing: {}, AccessibilityInfo: {} },
    "@tanstack/react-query": {},
    "@getpaseo/plugin/client/ui": {
      SettingsAction: () => null, SettingsCard: () => null, SettingsSection: () => null, SettingsSwitch: () => null,
      SettingsInput: () => null, SettingsRow: () => null, SidebarRow: () => null, Icon: () => null, ScrollView: () => null,
      useToast: () => ({ show() {}, error() {} }),
    },
    "@getpaseo/plugin": contracts,
    "@getpaseo/plugin/client": { useRpc: () => async () => ({}), useSettings: () => ({ status: "loading" }) },
    "@getpaseo/plugin/client/react-native": {
      Icon: () => null,
      Modal: () => null,
      useToast: () => ({ show() {}, error() {} }),
    },
  };
  const exported = instantiateBundle(code, (id) => {
    if (!(id in stubs)) throw new Error(`Module "${id}" is not available in plugin client code`);
    return stubs[id];
  });
  if (typeof exported?.default !== "function") {
    throw new Error("index.client.tsx must default-export a function");
  }

  const summary = [];
  const surfaces = new Set();
  const sidebarSurfaces = [];
  const registrations = [];
  let agentListOptions;
  let agentObserver;
  let agentObservationUnsubscribed = false;
  let agentObservationReleaseCount = 0;
  const requireText = (value, what) => {
    if (typeof value !== "string" || value.trim() === "") throw new Error(`Missing ${what}`);
  };
  const requireFunction = (value, what) => {
    if (typeof value !== "function") throw new Error(`${what} is not a function`);
  };
  const removable = () => {
    let removed = false;
    return () => {
      if (!removed) removed = true;
    };
  };
  const client = {
    paseo: {
      agents: {
        subscribe() { return removable(); },
        async list(options) {
          agentListOptions = options;
          return {
            entries: [{ agent: {
              id: "agent-1",
              workspaceId: "workspace-1",
              provider: "claude",
              model: "opus-5.5",
            } }],
            subscription: {
              subscribe(observer) {
                agentObserver = observer;
                return () => {
                  agentObservationUnsubscribed = true;
                };
              },
              async release() {
                agentObservationReleaseCount += 1;
              },
            },
          };
        },
      },
    },
    async rpc(contract) {
      if (contract?.name === "settings.display.read") return { status: "ready", values: { showSidebar: true }, revision: "1" };
      if (contract?.name === "smart-session.guard.status") {
        return {
          governor: "active",
          checkedAt: null,
          error: null,
          pauses: [],
          overrides: {},
          policy: { enabled: true, protectByDefault: true, thresholdPct: 100, autoResume: true, includeNativeSubagents: true },
          providers: [],
        };
      }
      if (contract?.name === "smart-session.enrolment.state") {
        return {
          showPill: true,
          enabled: true,
          agents: [{ agentId: "agent-1", enrolled: true, explicit: true }],
        };
      }
      return {};
    },
    addSettingsScreen(screen) {
      if (typeof screen.Component !== "function") throw new Error("Invalid settings screen");
      summary.push(`addSettingsScreen(${screen.id})`);
      return () => {};
    },
    addSurface(id, Component) {
      requireText(id, "surface id");
      requireFunction(Component, `surface ${id}`);
      surfaces.add(id);
      summary.push(`addSurface(${id})`);
      return removable();
    },
    addScreen(screen) {
      requireText(screen?.id, "screen id");
      if (typeof screen.title !== "function") requireText(screen?.title, `screen ${screen.id} title`);
      requireFunction(screen?.Component, `screen ${screen.id}`);
      surfaces.add(screen.id);
      summary.push(`addScreen(${screen.id})`);
      return removable();
    },
    addSidebarHeaderItem(item) {
      requireText(item?.id, "sidebar id");
      requireText(item?.title, "sidebar title");
      requireFunction(item?.Component, "sidebar component");
      summary.push(`addSidebarHeaderItem(${item.id})`);
      return removable();
    },
    addTimelineTransformer(item) {
      requireText(item?.id, "timeline transformer id");
      requireText(item?.query?.itemType, "timeline transformer item type");
      requireFunction(item?.transform, "timeline transformer");
      summary.push(`addTimelineTransformer(${item.id})`);
      return removable();
    },
    openScreen() {},
    openSettings() {},
    addSidebarItem(item) {
      requireText(item?.id, "sidebar id");
      requireText(item?.title, "sidebar title");
      requireText(item?.icon, "sidebar icon");
      requireText(item?.surface, "sidebar surface");
      sidebarSurfaces.push(item.surface);
      summary.push(`addSidebarItem(${item.id})`);
      return removable();
    },
    addCommandCenterItem(item) {
      requireText(item?.id, "Command Center id");
      requireText(item?.title, "Command Center title");
      requireText(item?.icon, "Command Center icon");
      requireFunction(item?.onSelect, `Command Center ${item.id} callback`);
      summary.push(`addCommandCenterItem(${item.id})`);
      return removable();
    },
    addTimelineRenderer(item) {
      requireText(item?.kind, "timeline renderer kind");
      if (!Number.isInteger(item?.version) || item.version < 1) throw new Error("Invalid timeline renderer version");
      requireFunction(item?.schema?.safeParse, "timeline renderer schema");
      requireFunction(item?.Component, "timeline renderer component");
      summary.push(`addTimelineRenderer(${item.kind})`);
      return removable();
    },
    addComposerPill(item) {
      requireText(item?.id, "composer pill id");
      requireText(item?.workspaceId, "composer pill workspace");
      requireText(item?.agentId, "composer pill agent");
      requireText(item?.button?.title, "composer pill button title");
      requireText(item?.button?.label, "composer pill button label");
      requireFunction(item?.button?.icon, "composer pill button icon");
      // The one Smart Session pill opens a popover: Paseo positions it, and makes it a sheet on phones.
      if (item.id !== "smart-compact") throw new Error(`Smart Session draws one pill, not ${item.id}`);
      if (item?.button?.behavior?.kind !== "popover") throw new Error("The Smart Session pill must use a popover descriptor");
      requireFunction(item.button.behavior.Content, "composer pill popover content");
      summary.push(`addComposerPill(${item.id})`);
      let removed = false;
      const registration = {
        id: item.id,
        agentId: item.agentId,
        removed: false,
        update(patch) {
          if (!removed && patch.title !== undefined) requireText(patch.title, "updated pill title");
        },
        remove() {
          removed = true;
          registration.removed = true;
        },
      };
      registrations.push(registration);
      return registration;
    },
  };

  const cleanup = exported.default(client);
  if (typeof cleanup !== "function") throw new Error("client contribution must return cleanup");
  // Long enough for the pills' first RPCs to resolve, not for their polls to fire.
  await new Promise((resolve) => setImmediate(resolve));
  if (agentListOptions?.subscribe === undefined) {
    throw new Error("composer pills must own an observed agent directory");
  }
  if (!agentListOptions.signal || typeof agentListOptions.signal.aborted !== "boolean") {
    throw new Error("agent observation must share the client contribution lifetime");
  }
  if (!agentObserver) throw new Error("owned agent observation was not consumed");
  agentObserver.update({
    type: "agent_update",
    payload: {
      kind: "upsert",
      agent: {
        id: "agent-opus-5-5",
        workspaceId: "workspace-1",
        provider: "claude",
        model: "opus-5.5",
      },
    },
  });
  if (summary.filter((item) => item === "addComposerPill(smart-compact)").length !== 2) {
    throw new Error("observed agents must receive the pill regardless of model");
  }
  if (summary.some((item) => item.startsWith("addComposerPill(") && item !== "addComposerPill(smart-compact)")) {
    throw new Error("Smart Session draws one composer pill per session");
  }
  const settingsScreens = summary.filter((item) => item.startsWith("addSettingsScreen("));
  if (settingsScreens.join() !== "addSettingsScreen(smart-compact)") {
    throw new Error(`Smart Session has one settings screen, under the id links already use; got ${settingsScreens.join(", ")}`);
  }
  if (!summary.includes("addTimelineRenderer(quota-pause)")) {
    throw new Error("Session Guard's timeline cards must have a renderer");
  }
  for (const id of ["overview", "paused-sessions"]) {
    if (!summary.includes(`addScreen(${id})`)) throw new Error(`the ${id} view must be a titled screen, not a surface`);
  }
  if (summary.some((item) => item.startsWith("addSurface(") || item.startsWith("addSidebarItem("))) {
    throw new Error("deprecated surfaces show their raw id as the header title; register screens instead");
  }
  for (const kind of ["smart-session-tool", "smart-session-prompt"]) {
    if (!summary.includes(`addTimelineRenderer(${kind})`)) throw new Error(`chat rows of kind ${kind} need a renderer`);
  }
  agentObserver.snapshot({
    entries: [{ agent: { id: "agent-opus-5-5", workspaceId: "workspace-1" } }],
  });
  if (!registrations.filter((registration) => registration.agentId === "agent-1").every((registration) => registration.removed)) {
    throw new Error("a restored agent snapshot must remove stale composer pills");
  }
  for (const surface of sidebarSurfaces) {
    if (!surfaces.has(surface)) throw new Error(`Sidebar references missing surface: ${surface}`);
  }
  await cleanup();
  if (!agentListOptions.signal.aborted) throw new Error("cleanup did not abort the observation");
  if (!agentObservationUnsubscribed) throw new Error("cleanup did not detach its observer");
  if (agentObservationReleaseCount !== 1) {
    throw new Error("cleanup did not release the agent observation exactly once");
  }
  await cleanup();
  if (agentObservationReleaseCount !== 1) {
    throw new Error("repeated cleanup released the agent observation twice");
  }
  for (const registration of registrations) {
    registration.remove();
    registration.remove();
  }
  return summary;
}

console.log("Checking Paseo v0.8 runtime entries...");
const boundaryFailures = auditRuntimeBoundaries(DIR);
for (const failure of boundaryFailures) console.error(`  ✗ ${failure}`);

let failed = boundaryFailures.length > 0;
for (const target of ["client", "server"]) {
  const entry = resolve(DIR, `index.${target}.${target === "client" ? "tsx" : "ts"}`);
  try {
    const built = await esbuild.build(buildOptions(entry, DIR, target));
    if (target === "client") {
      const summary = await runClientBundle(built.outputFiles[0].text);
      if (!summary.some((item) => item.startsWith("addComposerPill"))) {
        throw new Error("client entry did not register its composer pill");
      }
      console.log(`  ✓ client: ${summary.join(", ")}`);
    } else {
      console.log("  ✓ server: builds from index.server.ts");
    }
  } catch (error) {
    console.error(`  ✗ ${target}: ${error instanceof Error ? error.message : String(error)}`);
    failed = true;
  }
}

if (failed) {
  console.error("Runtime entry check failed.");
  process.exitCode = 1;
} else {
  console.log("Runtime entries OK.");
}
