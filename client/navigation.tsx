import type { ComponentType } from "react";
import type { PluginClientContext, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Pressable, Text, View } from "react-native";

export function withNavigation<P extends PluginSurfaceProps>(Component: ComponentType<P>, client: PluginClientContext, home: string, active = "overview") {
  return function PluginView(props: P) {
    return <View style={{ flex: 1, backgroundColor: props.theme.colors.surface0 }}>
      <View accessibilityRole="toolbar" style={{ flexDirection: "row", flexWrap: "wrap", gap: 4, padding: 8, borderBottomWidth: 1, borderColor: props.theme.colors.border }}>
        {[{ id: "overview", title: "Overview", target: home }, { id: "display", title: "Display settings", target: "display-settings" }].map(item => <Pressable key={item.id} accessibilityRole="button" accessibilityState={{ selected: active === item.id }} onPress={() => client.openSurface(item.target)} style={({ pressed }) => ({ minHeight: 44, paddingHorizontal: 12, justifyContent: "center", borderRadius: 6, backgroundColor: pressed || active === item.id ? props.theme.colors.surface2 : "transparent" })}><Text style={{ color: active === item.id ? props.theme.colors.foreground : props.theme.colors.foregroundMuted, fontSize: 13, fontWeight: active === item.id ? "600" : "400" }}>{item.title}</Text></Pressable>)}
      </View>
      <Component {...props} />
    </View>;
  };
}
