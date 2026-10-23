import type { PluginClientContext, PluginButtonRegistration } from "@getpaseo/plugin/client";
import { subscribeDisplay } from "./display";

export function withButtonVisibility(client: PluginClientContext) {
  const entries = new Set<{ reconcile(): void; remove(): void }>();
  let enableHeader = true;
  let enableComposer = true;
  function gated<K extends "addHeaderButton" | "addComposerPill">(method: K, input: Parameters<PluginClientContext[K]>[0]): PluginButtonRegistration {
    let descriptor = input.button;
    let registration: PluginButtonRegistration | undefined;
    const entry = {
      reconcile() {
        const enabled = method === "addHeaderButton" ? enableHeader : enableComposer;
        if (enabled && !registration) registration = (client[method] as (value: typeof input) => PluginButtonRegistration)({ ...input, button: descriptor });
        if (!enabled && registration) { registration.remove(); registration = undefined; }
      },
      remove() { registration?.remove(); registration = undefined; entries.delete(entry); },
    };
    entries.add(entry);
    entry.reconcile();
    return { remove: entry.remove, update(patch) { descriptor = { ...descriptor, ...patch }; registration?.update(patch); } };
  }
  const buttons = Object.create(client) as PluginClientContext;
  buttons.addHeaderButton = input => gated("addHeaderButton", input);
  buttons.addComposerPill = input => gated("addComposerPill", input);
  const unsubscribe = subscribeDisplay(values => {
    
    enableComposer = values.enable_composer_button;
    for (const entry of entries) entry.reconcile();
  });
  return { client: buttons, dispose() { unsubscribe(); for (const entry of [...entries]) entry.remove(); } };
}
