import type { PluginButtonIcon, PluginButtonIconProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";

// Like Smart Compact, keep the host's pill chrome and color the icon slot.
function GuardOnIcon({ theme, size }: PluginButtonIconProps) {
  return <Icon name="ShieldCheck" size={size} color={theme.colors.statusSuccess} />;
}

function GuardOffIcon({ theme, size }: PluginButtonIconProps) {
  return <Icon name="ShieldOff" size={size} color={theme.colors.foregroundMuted} />;
}

function GuardPausedIcon({ theme, size }: PluginButtonIconProps) {
  return <Icon name="Pause" size={size} color={theme.colors.statusWarning} />;
}

function GuardAttentionIcon({ theme, size }: PluginButtonIconProps) {
  return <Icon name="TriangleAlert" size={size} color={theme.colors.statusDanger} />;
}

export const guardPillIcons: Readonly<Record<string, PluginButtonIcon>> = {
  ShieldCheck: GuardOnIcon,
  ShieldOff: GuardOffIcon,
  Pause: GuardPausedIcon,
  TriangleAlert: GuardAttentionIcon,
};
