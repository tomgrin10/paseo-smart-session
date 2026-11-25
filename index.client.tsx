import { withButtonVisibility } from "./client/button-visibility";
import { contributeDisplay } from "./client/display";
import type { PluginClientContext, PluginScreenProps, PluginSurfaceProps } from "@getpaseo/plugin/client";

import { observeAgents } from "./client/agents";
import { contributeChat } from "./client/chat";
import { commandItems } from "./client/commands";
import { contributeGuardTimeline } from "./client/guard/index";
import { watchGuard } from "./client/guard/status";
import { createLive } from "./client/live";
import { OVERVIEW_SCREEN, PAUSED_SCREEN, SMART_COMPACT_SETTINGS, makeOverview } from "./client/overview";
import { contributeClient } from "./client/pill";
import { contributeRowBadges } from "./client/row-badges";
import { makeSettings } from "./client/settings";
import { ReportSheetHost, openReportSheet, setReportFallback } from "./client/report-issue";
import { reportSendRpc } from "./shared/report-issue";
import { watchSubscriptions } from "./client/subscriptions";
import { watchUsageCards } from "./client/usage-hide";
import { budgetStatus } from "./shared/smart-session";

export default function contribute(host: PluginClientContext) {
  const visibility = withButtonVisibility(host);
  const client = visibility.client;
  const live = createLive();
  const BareOverview = makeOverview(client, live);
  const BareSettings = makeSettings(client);
  // Report a bug (docs/report-issue.md): the sheet lives on the overview and in Settings; with neither on screen, the
  // overview opens and its host shows the request already waiting.
  setReportFallback(() => client.openScreen({ screenId: OVERVIEW_SCREEN }));
  const Overview = (props: PluginScreenProps) => <><BareOverview {...props} /><ReportSheetHost theme={props.theme} layout={props.layout} openAgent={props.navigation ? (agentId) => props.navigation!.openAgent({ agentId }) : undefined} /></>;
  const Settings = (props: PluginSurfaceProps) => <><BareSettings {...props} /><ReportSheetHost theme={props.theme} layout={props.layout} openAgent={props.navigation ? (agentId) => props.navigation!.openAgent({ agentId }) : undefined} /></>;
  const removers = [
    client.addScreen({ id: OVERVIEW_SCREEN, title: "Smart Session", Component: Overview }),
    // The old Paused sessions screen: links to it from older chats and clients land on the list.
    client.addScreen({ id: PAUSED_SCREEN, title: "Smart Session", Component: (props) => <Overview {...props} params={{ ...props.params, focus: "paused" }} /> }),
    client.addSettingsScreen({ id: SMART_COMPACT_SETTINGS, title: "Settings", icon: "Gauge", Component: Settings }),
    // /report-smart-session: words go straight to this agent; with none, the sheet opens with this agent picked.
    client.addSlashCommand({ name: "report-smart-session", description: "Report a Smart Session bug, idea or feedback; this agent files it on GitHub after you OK it", argumentHint: "what happened", context: "agent", async onSubmit({ args, agent, workspace, rpc }) {
      if (args.trim()) await rpc(reportSendRpc, { kind: "bug", text: args.trim(), agentId: agent.id }).catch(() => openReportSheet({ agentId: agent.id, workspaceId: workspace.id }));
      else openReportSheet({ agentId: agent.id, workspaceId: workspace.id });
    } }),
    contributeDisplay(client, live),
    ...commandItems().map((item) => client.addCommandCenterItem(item)),
    contributeChat(client),
    contributeGuardTimeline(client),
  ];

  // The sidebar row shows the session window between overview visits.
  const readBudget = () => client.rpc(budgetStatus, {}).then((budget) => live.setBudget(budget)).catch(() => undefined);
  void readBudget();
  const budgetTimer = setInterval(() => void readBudget(), 2 * 60_000);

  // One agent observation and one protection poll for the one pill.
  const agents = observeAgents(client);
  const stopGuard = watchGuard(client, live);
  // ZeroSub's subscriptions, for the overview, the sidebar row and the popover; rare without ZeroSub.
  const stopSubscriptions = watchSubscriptions(client, (next) => live.setSubscriptions(next));
  // The pill registers on the host's own client: a paused session keeps it even when pills are hidden.
  const removeClient = contributeClient(host, agents);
  // Paseo 0.17.1+: the held badge (and, with ZeroSub, the account) on each sidebar workspace row; nothing on older hosts.
  removers.push(...contributeRowBadges(host, agents));
  // Paseo 0.16, web and desktop: Paseo's own Claude usage card steps aside for ours.
  const stopUsageCards = watchUsageCards(client);
  return () => {
    clearInterval(budgetTimer);
    stopGuard();
    stopSubscriptions();
    stopUsageCards();
    removeClient();
    for (const remove of removers.splice(0)) void remove();
    visibility.dispose();
    return agents.dispose();
  };
}
