/**
 * Paseo 0.16 lists one usage card per source: in the composer's context popover, on the
 * Usage screen and on a host's settings page. Smart Session's card covers what Paseo's
 * own Claude card says and adds the forecast and the other ZeroSub accounts, so on web
 * and desktop the built-in card steps aside while ours, for the same login, shows the
 * same numbers beside it. The rule and its invariant are `shared/usage-hide.ts`.
 *
 * The plugin API cannot replace a usage source (a taken source id throws and stops the
 * plugin), so this is a DOM step, kept small and safe:
 *
 * - **No flash, no wait.** One stylesheet holds every built-in card back from its first
 *   frame for at most 1.5 s (a CSS animation). The decision then reads only what is
 *   already here: the hashes of logins seen before, the server's last answer about which
 *   of our cards may stand in (fetched at start and refreshed in the background when the
 *   pointer reaches the meter or the Usage item), and the numbers both cards render. It
 *   runs in the frame our card appears, so the list goes from the context window straight
 *   to our cards.
 * - **Fail safe.** Only `usage-report-claude:*` cards inside the known lists are touched.
 *   If this script stops, the animation ends and the card shows. Different numbers, a
 *   login we don't cover, our card missing or the setting off: the card shows.
 * - **Cheap.** No standing document observer. While the pointer rests on the context
 *   meter or the Usage entry, one finder (ten seconds at most) waits for the list to
 *   mount; the grace animation's own start event covers any other way in. One observer
 *   then watches that list until it unmounts.
 * - **Web only.** Native apps keep both cards: React Native has no DOM to adjust.
 *
 * The server never sends an email: it sends hashes, and the built-in card's footer
 * (Paseo's own text) is hashed here, synchronously, to compare.
 */

import { Platform } from "react-native";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { usageCardsStatus } from "../shared/smart-session";
import {
  BUILTIN_PREFIX,
  DECIDED_ATTR,
  GRACE_ANIMATION,
  OURS_PREFIX,
  PERCENT,
  SCOPES,
  decide,
  hideStylesheet,
  type WindowValues,
} from "../shared/usage-hide";
import { sha256Hex } from "../shared/sha256";
import { loginText } from "../shared/usage-source";
import { subscribeDisplay } from "./display";

// ---------------------------------------------------------------- the DOM (web only)

interface Anim { readonly animationName?: string; readonly playState: string }
interface El {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  closest(selector: string): El | null;
  querySelectorAll(selector: string): ArrayLike<El>;
  readonly isConnected: boolean;
  readonly children: ArrayLike<El>;
  readonly previousElementSibling: El | null;
  readonly textContent: string | null;
  getAnimations?(): Anim[];
}
interface StyleEl { id: string; textContent: string | null; remove(): void }
interface Observer { observe(target: El, options: Record<string, boolean>): void; disconnect(): void }
type Listener = (event: { target: unknown; animationName?: string }) => void;
interface WebGlobals {
  document: {
    head: { appendChild(el: StyleEl): void } | null;
    createElement(tag: "style"): StyleEl;
    body: El | null;
    querySelectorAll(selector: string): ArrayLike<El>;
    addEventListener(type: string, fn: Listener, capture: boolean): void;
    removeEventListener(type: string, fn: Listener, capture: boolean): void;
  };
  MutationObserver: new (callback: () => void) => Observer;
}

const STYLE_ID = "smart-session-usage-hide";
const SCOPE_SELECTOR = SCOPES.map((scope) => `[data-testid="${scope}"]`).join(",");
/** Where the pointer goes before a list of usage cards opens: the context meter and the sidebar's Usage entries. */
const ARMS = '[data-testid="context-window-meter"],[data-testid="sidebar-usage"],[data-testid="sidebar-usage-icon"]';
const CARDS_TTL_MS = 30_000;
/** How long a pointer on the meter keeps the finder looking for the list to open. */
const FIND_MS = 10_000;

/** Every window row's value by its label: a leaf text holding a percentage, after its label. */
export function windowValues(card: El): WindowValues {
  const values = new Map<string, string>();
  for (const el of Array.from(card.querySelectorAll("*"))) {
    if (el.children.length > 0) continue;
    const value = el.textContent ?? "";
    if (!PERCENT.test(value)) continue;
    const label = el.previousElementSibling;
    if (!label || label.children.length > 0) continue;
    const name = (label.textContent ?? "").trim();
    if (name !== "" && !values.has(name)) values.set(name, value.trim());
  }
  return values;
}

/** Starts the hide on web; a no-op anywhere else. Returns its teardown. */
export function watchUsageCards(client: PluginClientContext): () => void {
  const web = globalThis as unknown as Partial<WebGlobals>;
  if (Platform.OS !== "web" || !web.document?.head || !web.MutationObserver) return () => {};
  const g = web as WebGlobals;

  let enabled = true;
  let hideable: Map<string, string> | null = null;
  let supersedes = new Map<string, readonly number[]>();
  let fetchedAt = 0;
  let fetching = false;
  const hashes = new Map<string, string>();
  const lists = new Map<El, Observer>();
  let finder: { observer: Observer; timer: ReturnType<typeof setTimeout> } | null = null;
  let style: StyleEl | null = null;

  const leaves = (el: El) => Array.from(el.querySelectorAll("*")).filter((child) => child.children.length === 0).map((child) => child.textContent ?? "");
  const graceRunning = (el: El) => (el.getAnimations?.() ?? []).some((a) => a.animationName === GRACE_ANIMATION && a.playState === "running");

  /** The stylesheet, kept in step with the setting and with whether anything may be hidden. */
  const syncStyle = () => {
    const text = enabled ? hideStylesheet(hideable !== null && hideable.size > 0) : "";
    if (text === "") {
      style?.remove();
      style = null;
      return;
    }
    if (style === null) {
      style = g.document.createElement("style");
      style.id = STYLE_ID;
      g.document.head!.appendChild(style);
    }
    if (style.textContent !== text) style.textContent = text;
  };

  /** The server's answer, refreshed in the background; decisions never wait for it. */
  const refresh = (force = false) => {
    if (fetching || (!force && Date.now() - fetchedAt < CARDS_TTL_MS)) return;
    fetching = true;
    void client.rpc(usageCardsStatus, {}).then(
      (result) => result.cards,
      () => [], // An unreachable server hides nothing.
    ).then((cards) => {
      fetching = false;
      fetchedAt = Date.now();
      hideable = new Map(cards.map((card) => [card.emailHash, card.key]));
      supersedes = new Map(cards.flatMap((card) => (card.supersedes ? [[card.emailHash, card.supersedes] as const] : [])));
      syncStyle();
      for (const list of lists.keys()) decideList(list);
    });
  };

  // Synchronous, so a card is decided in the frame it appears. Never evicted: a person has a handful of logins.
  const hashLogin = (login: string) => {
    let hash = hashes.get(login);
    if (hash === undefined) {
      hash = sha256Hex(login);
      hashes.set(login, hash);
    }
    return hash;
  };

  /** Decides every built-in card in one list from what is on screen now. Synchronous. */
  const decideList = (list: El) => {
    if (!list.isConnected) return forget(list);
    const cards = Array.from(list.querySelectorAll('[data-testid^="usage-report-"]'));
    const ours = new Map<string, WindowValues>();
    for (const card of cards) {
      const id = card.getAttribute("data-testid") ?? "";
      if (id.startsWith(OURS_PREFIX)) ours.set(id.slice(OURS_PREFIX.length), windowValues(card));
    }
    for (const card of cards) {
      if (!(card.getAttribute("data-testid") ?? "").startsWith(BUILTIN_PREFIX)) continue;
      const decided = card.getAttribute(DECIDED_ATTR);
      const login = loginText(leaves(card));
      const loginHash = login === null ? null : hashLogin(login);
      const verdict = decide({
        enabled,
        hideable,
        loginHash,
        theirs: windowValues(card),
        ours,
        graceOver: decided !== null || !graceRunning(card),
        shown: decided === "show",
        supersedes: loginHash === null ? null : (supersedes.get(loginHash) ?? null),
      });
      if (verdict === "wait") continue;
      if (decided !== verdict) card.setAttribute(DECIDED_ATTR, verdict);
    }
  };

  const watch = (list: El) => {
    if (lists.has(list)) return decideList(list);
    const observer = new g.MutationObserver(() => decideList(list));
    observer.observe(list, { childList: true, subtree: true, characterData: true });
    lists.set(list, observer);
    decideList(list);
  };
  const forget = (list: El) => {
    lists.get(list)?.disconnect();
    lists.delete(list);
  };
  const sweep = () => {
    for (const list of [...lists.keys()]) if (!list.isConnected) forget(list);
  };
  const stopFinder = () => {
    if (!finder) return;
    finder.observer.disconnect();
    clearTimeout(finder.timer);
    finder = null;
  };
  /**
   * While the pointer is on its way, a short-lived look for the list to mount. A mutation
   * observer runs before the frame is painted, so the list's first frame is already decided
   * (the animation's start event comes a frame later). Ten seconds at most, one at a time.
   */
  const find = () => {
    if (finder || !g.document.body) return;
    const observer = new g.MutationObserver(() => {
      const found = Array.from(g.document.querySelectorAll(SCOPE_SELECTOR));
      if (found.length === 0) return;
      for (const list of found) watch(list);
      stopFinder();
    });
    observer.observe(g.document.body, { childList: true, subtree: true });
    finder = { observer, timer: setTimeout(stopFinder, FIND_MS) };
  };

  // A built-in card starting its grace is a list mounting: watch it. Its grace ending decides it.
  const onAnimation: Listener = (event) => {
    if (event.animationName !== GRACE_ANIMATION) return;
    const card = event.target as Partial<El> | null;
    const list = typeof card?.closest === "function" ? card.closest(SCOPE_SELECTOR) : null;
    if (list) watch(list);
    refresh();
  };
  // The pointer on its way to a list: refresh the server's answer before the list opens.
  const onArm: Listener = (event) => {
    const target = event.target as Partial<El> | null;
    if (typeof target?.closest !== "function" || !target.closest(ARMS)) return;
    sweep();
    refresh();
    const open = Array.from(g.document.querySelectorAll(SCOPE_SELECTOR));
    for (const list of open) watch(list);
    if (open.length === 0 && enabled) find();
  };
  const animationEvents = ["animationstart", "animationend", "animationcancel"] as const;
  const armEvents = ["pointerover", "focusin", "click"] as const;
  for (const type of animationEvents) g.document.addEventListener(type, onAnimation, true);
  for (const type of armEvents) g.document.addEventListener(type, onArm, true);

  const unsubscribe = subscribeDisplay((values) => {
    if (values.replaceUsageCard === enabled) return;
    enabled = values.replaceUsageCard;
    syncStyle();
    for (const list of lists.keys()) decideList(list);
  });

  syncStyle();
  refresh(true);

  return () => {
    for (const type of animationEvents) g.document.removeEventListener(type, onAnimation, true);
    for (const type of armEvents) g.document.removeEventListener(type, onArm, true);
    unsubscribe();
    stopFinder();
    for (const list of [...lists.keys()]) forget(list);
    style?.remove();
    style = null;
    for (const card of Array.from(g.document.querySelectorAll(`[${DECIDED_ATTR}]`))) card.removeAttribute(DECIDED_ATTR);
  };
}
