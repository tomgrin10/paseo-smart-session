import { useEffect, useState, type ReactNode } from "react";
import { Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { Icon } from "@getpaseo/plugin/client/ui";
import { PressScale, Spinner } from "./motion";
import { raised, tabular, tint, withAlpha, type Colors, type Theme } from "./theme";

export type { Theme } from "./theme";

/**
 * The plugin family's kit (Follow-up and Defer use the same pieces): one button
 * vocabulary, raised cards, tinted chips, an accessible switch and the type scale.
 */

/** Re-render on an interval so relative times keep moving between polls. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The family type scale: tabular numerals wherever a time or count can appear. */
export const text = (colors: Colors) => ({
  title: { color: colors.foreground, fontSize: 15, lineHeight: 21, fontWeight: "600" as const },
  body: { color: colors.foreground, fontSize: 13, lineHeight: 19 },
  meta: { color: colors.foregroundMuted, fontSize: 12, lineHeight: 17, ...tabular },
  small: { color: colors.foregroundMuted, fontSize: 11, lineHeight: 15, ...tabular },
  label: { color: colors.foreground, fontSize: 13, lineHeight: 18, fontWeight: "600" as const },
  group: { color: colors.foregroundMuted, fontSize: 12, lineHeight: 16, fontWeight: "600" as const, ...tabular },
});

type ButtonKind = "primary" | "secondary" | "ghost" | "danger";
/** 28–32px with a hit slop on desktop, 44px on touch layouts. */
export function Button({ title, onPress, theme, kind = "secondary", disabled = false, loading = false, icon, iconColor, compact = false, small = false, accessibilityLabel, accessibilityHint }: {
  title: string; onPress: () => void; theme: Theme; kind?: ButtonKind; disabled?: boolean; loading?: boolean; icon?: string; iconColor?: string; compact?: boolean; small?: boolean; accessibilityLabel?: string; accessibilityHint?: string;
}) {
  const c = theme.colors;
  const fg = kind === "primary" ? c.accentForeground : kind === "danger" ? c.statusDanger : c.foreground;
  const inactive = disabled || loading;
  const height = compact ? 44 : small ? 28 : 32;
  return <PressScale accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? title} accessibilityHint={accessibilityHint} accessibilityState={{ disabled: inactive, busy: loading }}
    disabled={inactive} onPress={onPress} hitSlop={compact ? 0 : 4} outerStyle={{ alignSelf: "flex-start" }}
    style={({ pressed, hovered }) => ({
      minHeight: height, paddingHorizontal: compact ? 14 : small ? 9 : 11, borderRadius: compact ? 8 : 6, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
      opacity: disabled ? 0.45 : 1,
      ...(kind === "primary" ? { backgroundColor: pressed ? withAlpha(c.accent, 0.85) : hovered ? withAlpha(c.accent, 0.92) : c.accent }
        : kind === "ghost" || kind === "danger" ? { backgroundColor: pressed ? c.surface2 : hovered ? c.surface1 : "transparent" }
        : { ...raised(c), backgroundColor: pressed ? c.surface2 : hovered ? c.surface2 : c.surface1 }),
    })}>
    {loading ? <Spinner color={fg} size={12} /> : icon ? <Icon name={icon} size={compact ? 16 : 14} color={iconColor ?? fg} /> : null}
    <Text numberOfLines={1} style={{ color: fg, fontSize: compact ? 14 : small ? 12 : 13, lineHeight: compact ? 19 : 16, fontWeight: kind === "primary" ? "600" : "500", ...tabular }}>{title}</Text>
  </PressScale>;
}

/** A square icon-only control with an accessible name. */
export function IconButton({ icon, label, onPress, theme, compact = false, disabled = false, color }: { icon: string; label: string; onPress: () => void; theme: Theme; compact?: boolean; disabled?: boolean; color?: string }) {
  const c = theme.colors;
  const size = compact ? 44 : 28;
  return <PressScale accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} hitSlop={compact ? 0 : 6}
    style={({ pressed, hovered }) => ({ width: size, height: size, borderRadius: 6, alignItems: "center", justifyContent: "center", backgroundColor: pressed ? c.surface2 : hovered ? c.surface1 : "transparent", opacity: disabled ? 0.45 : 1 })}>
    <Icon name={icon} size={compact ? 18 : 15} color={color ?? c.foregroundMuted} />
  </PressScale>;
}

/** A raised container. Groups of rows sit inside one; rows divide with hairlines. */
export function Card({ theme, children, style }: { theme: Theme; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const c = theme.colors;
  return <View style={[{ borderRadius: 10, overflow: "hidden", backgroundColor: c.surface0 }, raised(c), style]}>{children}</View>;
}

/** A row inside a card: hairline on top, hover tint when pressable. */
export function CardRow({ theme, onPress, accessibilityLabel, children, style, first = false }: { theme: Theme; onPress?: () => void; accessibilityLabel?: string; children: ReactNode; style?: StyleProp<ViewStyle>; first?: boolean }) {
  const c = theme.colors;
  const base: ViewStyle = { paddingHorizontal: 14, paddingVertical: 12, borderTopWidth: first ? 0 : 1, borderTopColor: c.border };
  if (!onPress) return <View style={[base, style]}>{children}</View>;
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} onPress={onPress}
    style={(state) => [base, { backgroundColor: state.pressed ? c.surface2 : (state as { hovered?: boolean }).hovered ? c.surface1 : "transparent" }, style]}>{children}</Pressable>;
}

/** A count or status tag in its own hue at 12–16%. */
export function Chip({ theme, label, color, icon }: { theme: Theme; label: string; color?: string; icon?: string }) {
  const c = theme.colors;
  const hue = color ?? c.foregroundMuted;
  return <View style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 7, paddingVertical: 1, borderRadius: 999, backgroundColor: tint(hue, c), alignSelf: "center" }}>
    {icon ? <Icon name={icon} size={11} color={hue} /> : null}
    <Text numberOfLines={1} style={{ color: hue, fontSize: 11, lineHeight: 16, fontWeight: "600", ...tabular }}>{label}</Text>
  </View>;
}

/** A section heading with an optional count and a right-hand slot. */
export function SectionHead({ theme, title, count, trailing }: { theme: Theme; title: string; count?: number; trailing?: ReactNode }) {
  const c = theme.colors;
  return <View style={{ flexDirection: "row", alignItems: "center", gap: 7, minHeight: 28 }}>
    <Text accessibilityRole="header" style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16, fontWeight: "600" }}>{title}</Text>
    {count === undefined ? null : <Chip theme={theme} label={String(count)} />}
    <View style={{ flex: 1 }} />
    {trailing}
  </View>;
}

/** A quiet text link with a trailing arrow, for places a view points to rather than controls. */
export function TextLink({ theme, label, onPress, icon = "ArrowUpRight", compact = false }: { theme: Theme; label: string; onPress: () => void; icon?: string; compact?: boolean }) {
  const c = theme.colors;
  return <Pressable accessibilityRole="link" accessibilityLabel={label} onPress={onPress} hitSlop={compact ? 0 : 6}
    style={(state) => ({ minHeight: compact ? 44 : 24, flexDirection: "row", alignItems: "center", gap: 3, opacity: state.pressed ? 0.6 : 1 })}>
    {(state) => <>
      <Text style={{ color: (state as { hovered?: boolean }).hovered ? c.foreground : c.foregroundMuted, fontSize: 12, lineHeight: 17, textDecorationLine: (state as { hovered?: boolean }).hovered ? "underline" : "none" }}>{label}</Text>
      <Icon name={icon} size={12} color={c.foregroundMuted} />
    </>}
  </Pressable>;
}

/** An accessible switch: accent only for "on", the one place this plugin uses it besides primary buttons. */
export function Switch({ theme, label, value, onChange, disabled = false, hideLabel = false, compact = false }: { theme: Theme; label: string; value: boolean | null; onChange: (next: boolean) => void; disabled?: boolean; hideLabel?: boolean; compact?: boolean }) {
  const c = theme.colors;
  const on = value === true;
  const inactive = disabled || value === null;
  return <Pressable accessibilityRole="switch" aria-checked={value === null ? "mixed" : on} accessibilityLabel={label}
    accessibilityState={{ checked: value === null ? "mixed" : on, disabled: inactive }} accessibilityValue={{ text: value === null ? "Unknown" : on ? "On" : "Off" }}
    disabled={inactive} onPress={() => onChange(!on)} hitSlop={compact ? 0 : 6}
    style={({ pressed }) => ({ minHeight: compact ? 44 : 28, flexDirection: "row", alignItems: "center", gap: 8, opacity: inactive ? 0.5 : pressed ? 0.8 : 1 })}>
    {hideLabel ? null : <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 16 }}>{label}</Text>}
    <View style={{ width: 34, height: 20, borderRadius: 10, backgroundColor: on ? c.accent : c.surface2, borderWidth: 1, borderColor: on ? c.accent : c.border, justifyContent: "center" }}>
      <View style={{ width: 14, height: 14, borderRadius: 7, marginLeft: value === null ? 9 : on ? 16 : 2, backgroundColor: on ? c.accentForeground : value === null ? c.border : c.foregroundMuted }} />
    </View>
  </Pressable>;
}

/** A small status dot, or a spinner while the agent works. */
export function StatusGlyph({ theme, status }: { theme: Theme; status: string }) {
  const c = theme.colors;
  if (status === "running" || status === "initializing") return <Spinner color={c.foregroundMuted} size={11} label="Working" />;
  const color = status === "error" ? c.statusDanger : status === "idle" ? c.foregroundMuted : c.border;
  return <View accessibilityLabel={status} style={{ width: 11, height: 11, alignItems: "center", justifyContent: "center" }}>
    <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: color }} />
  </View>;
}
