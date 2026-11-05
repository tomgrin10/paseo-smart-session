import type { PluginClientContext } from "@getpaseo/plugin/client";

type CommandItem = Parameters<PluginClientContext["addCommandCenterItem"]>[0];

import { displayPreferences, displayRpc } from "../shared/display.ts";
import { enrolmentState } from "../shared/governor.ts";
import { getSettings, setSettings } from "../shared/smart-session.ts";
import { refreshPills } from "./pill-store.ts";
import { OVERVIEW_SCREEN, SETTINGS_SCREEN } from "./screens.ts";

/**
 * Smart Session in the Command Center: one name, four places. The old Session Guard
 * and display items folded in here; their keywords stay so muscle memory still finds them.
 */
export function commandItems(): CommandItem[] {
  return [
    {
      id: "smart-session-open",
      title: "Smart Session",
      icon: "Gauge",
      keywords: ["usage", "budget", "limit", "forecast", "context", "tokens", "compact", "smart session", "overview", "plan"],
      context: "global",
      onSelect({ openScreen }) { openScreen({ screenId: OVERVIEW_SCREEN }); },
    },
    {
      id: "smart-session-settings",
      title: "Smart Session: settings",
      icon: "Settings",
      keywords: ["settings", "smart compact", "threshold", "hooks", "pause at the limit", "protection", "quota", "limit", "guard", "session guard", "display", "sidebar", "pill"],
      context: "global",
      onSelect({ openSettings }) { openSettings(SETTINGS_SCREEN); },
    },
    {
      id: "smart-session-paused",
      title: "Smart Session: paused sessions",
      icon: "Pause",
      keywords: ["paused", "pause", "resume", "waiting", "reset", "quota", "limit", "subagents", "guard", "session guard"],
      context: "global",
      onSelect({ openScreen }) { openScreen({ screenId: OVERVIEW_SCREEN, params: { focus: "paused" } }); },
    },
    {
      id: "smart-session-pill",
      title: "Smart Session: show or hide the pill",
      icon: "ToggleLeft",
      keywords: ["pill", "compact", "smart", "context", "ring", "enrol", "composer", "display", "show", "hide"],
      context: "global",
      async onSelect({ rpc }) {
        // The same one switch as settings: the pill flag, plus the display gate when showing.
        const { settings } = await rpc(getSettings, {});
        const display = await rpc(displayRpc.read, {}).catch(() => null);
        const gate = display?.status === "ready" ? displayPreferences.schema.safeParse(display.values) : null;
        const gateOn = gate?.success ? gate.data.enable_composer_button : true;
        const next = !(settings.showPill && gateOn);
        if (next && gate?.success && !gateOn && display?.status === "ready") {
          await rpc(displayRpc.write, { values: { ...gate.data, enable_composer_button: true }, revision: display.revision });
        }
        await rpc(setSettings, { showPill: next });
        await refreshPills(() => rpc(enrolmentState, {}));
      },
    },
  ];
}
