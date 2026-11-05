import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AccessibilityInfo, ActivityIndicator, Animated, Easing, Platform, Pressable, View, type PressableProps, type StyleProp, type ViewStyle } from "react-native";

// The native driver is unavailable on web, where react-native-web animates in JS.
const native = () => Platform.OS !== "web";
// Built on first use, so importing this module needs nothing from react-native.
const out = () => Easing.bezier(0.16, 1, 0.3, 1);

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled().then(value => { if (live) setReduced(value); }).catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    return () => { live = false; subscription.remove(); };
  }, []);
  return reduced;
}

type PressState = { pressed: boolean; hovered: boolean };
/** A pressable that eases to 97% while held. Hover and press tint come from the caller's style function. */
export function PressScale({ style, outerStyle, children, ...props }: Omit<PressableProps, "style" | "children"> & {
  style?: StyleProp<ViewStyle> | ((state: PressState) => StyleProp<ViewStyle>);
  outerStyle?: StyleProp<ViewStyle>;
  children: ReactNode | ((state: PressState) => ReactNode);
}) {
  const reduced = useReducedMotion();
  const scale = useRef(new Animated.Value(1)).current;
  const [pressed, setPressed] = useState(false);
  const [hovered, setHovered] = useState(false);
  const to = (value: number) => { if (!reduced) Animated.timing(scale, { toValue: value, duration: 140, easing: out(), useNativeDriver: native() }).start(); };
  const state = { pressed, hovered };
  return <Pressable {...props} style={outerStyle}
    onHoverIn={event => { setHovered(true); props.onHoverIn?.(event); }}
    onHoverOut={event => { setHovered(false); props.onHoverOut?.(event); }}
    onPressIn={event => { setPressed(true); to(0.97); props.onPressIn?.(event); }}
    onPressOut={event => { setPressed(false); to(1); props.onPressOut?.(event); }}>
    <Animated.View style={[typeof style === "function" ? style(state) : style, { transform: [{ scale }] }]}>
      {typeof children === "function" ? children(state) : children}
    </Animated.View>
  </Pressable>;
}

/** Cross-fades an icon when its key changes: the new one grows in from 40%. Nothing moves on first render. */
export function IconSwap({ swapKey, size, children }: { swapKey: string; size: number; children: ReactNode }) {
  const reduced = useReducedMotion();
  const enter = useRef(new Animated.Value(1)).current;
  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) { first.current = false; return; }
    if (reduced) return;
    enter.setValue(0);
    const animation = Animated.timing(enter, { toValue: 1, duration: 260, easing: out(), useNativeDriver: native() });
    animation.start();
    return () => animation.stop();
  }, [swapKey]);
  return <Animated.View style={{ width: size, height: size, alignItems: "center", justifyContent: "center", opacity: enter, transform: [{ scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }) }] }}>{children}</Animated.View>;
}

/** Content that arrives after load rises 6px into place. Reduced motion shows it at once. */
export function Reveal({ children, delay = 0 }: { children: ReactNode; delay?: number }) {
  const reduced = useReducedMotion();
  const value = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  useEffect(() => {
    if (reduced) { value.setValue(1); return; }
    const animation = Animated.timing(value, { toValue: 1, duration: 280, delay, easing: out(), useNativeDriver: native() });
    animation.start();
    return () => animation.stop();
  }, [reduced]);
  return <Animated.View style={{ opacity: value, transform: [{ translateY: value.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }) }] }}>{children}</Animated.View>;
}

/** The system spinner, sized to sit beside a line of text. */
export function Spinner({ color, size = 12, label = "Working" }: { color: string; size?: number; label?: string }) {
  return <View accessibilityLabel={label} style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
    {Platform.OS === "ios" ? <ActivityIndicator size="small" color={color} style={{ transform: [{ scale: size / 20 }] }} /> : <ActivityIndicator size={size} color={color} />}
  </View>;
}

/** A soft breathing placeholder bar for loading states. Static under reduced motion. */
export function Skeleton({ width, height = 10, color, radius = 4 }: { width: number | `${number}%`; height?: number; color: string; radius?: number }) {
  const reduced = useReducedMotion();
  const value = useRef(new Animated.Value(0.55)).current;
  useEffect(() => {
    if (reduced) return;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(value, { toValue: 1, duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: native() }),
      Animated.timing(value, { toValue: 0.55, duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: native() }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [reduced]);
  return <Animated.View style={{ width, height, borderRadius: radius, backgroundColor: color, opacity: value }} />;
}
