/**
 * Paseo 0.16's context window details list one usage card per source. Smart Session's
 * card covers what Paseo's own Claude card says and adds the forecast and the other
 * ZeroSub accounts, so on web and desktop the built-in card steps aside while ours
 * stands beside it for the same login with a fresh reading.
 *
 * The plugin API has no way to replace a usage source (a taken source id throws and
 * stops the plugin), so this is a DOM step, kept as small and as safe as it can be:
 *
 * - **Fail safe.** It hides only `usage-report-claude:*` cards, and only while a
 *   `usage-report-smart-session:*` card is rendered in the same list, its key is one
 *   the server calls fresh (`smart-session.usage-cards`), and the built-in card's
 *   footer login hashes to the same SHA-256 the server holds for ours. Change any of
 *   those test ids in a future Paseo, or let our reading go stale, and nothing is
 *   hidden. Hidden cards come back the moment a condition stops holding.
 * - **Cheap.** Nothing observes the document. Pointing at, focusing or pressing the
 *   context meter arms one short-lived finder (at most ten seconds) that waits for
 *   our card to render, then one observer on that card's list until it unmounts.
 * - **Web only.** Native apps keep both cards: React Native has no DOM to adjust.
 *
 * The email never reaches this file in clear from the server: it sends hashes, and the
 * built-in card's footer (Paseo's own text) is hashed here to compare.
 */

import { Platform } from "react-native";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { usageCardsStatus } from "../shared/smart-session";
import { BUILTIN_PREFIX, OURS_PREFIX, cardsToHide, loginText, type RenderedCard } from "../shared/usage-source";
import { subscribeDisplay } from "./display";

// ---------------------------------------------------------------- the DOM (web only)

interface El {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  hasAttribute(name: string): boolean;
  closest(selector: string): El | null;
  querySelectorAll(selector: string): ArrayLike<El>;
  querySelector(selector: string): El | null;
  readonly parentElement: El | null;
  readonly isConnected: boolean;
  readonly children: ArrayLike<El>;
  readonly textContent: string | null;
  readonly style: { display: string };
}
interface Observer { observe(target: El, options: Record<string, boolean>): void; disconnect(): void }
interface WebGlobals {
  document: { body: El | null; addEventListener(type: string, fn: (event: { target: unknown }) => void, capture: boolean): void; removeEventListener(type: string, fn: (event: { target: unknown }) => void, capture: boolean): void };
  MutationObserver: new (callback: () => void) => Observer;
  crypto: { subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> } };
  TextEncoder: new () => { encode(text: string): Uint8Array };
  requestAnimationFrame(fn: () => void): number;
}

const HIDDEN_ATTR = "data-smart-session-replaced";
const METER = '[data-testid="context-window-meter"]';
const FIND_MS = 10_000;
const CARDS_TTL_MS = 10_000;

/** Starts the hide on web; a no-op anywhere else. Returns its teardown. */
export function watchUsageCards(client: PluginClientContext): () => void {
  const web = globalThis as unknown as Partial<WebGlobals>;
  if (Platform.OS !== "web" || !web.document || !web.MutationObserver || !web.crypto?.subtle || !web.TextEncoder) return () => {};
  const g = web as WebGlobals;

  let enabled = true;
  let fresh: { at: number; cards: { key: string; emailHash: string }[] } | null = null;
  let finder: { observer: Observer; timer: ReturnType<typeof setTimeout> } | null = null;
  let scoped: { list: El; observer: Observer } | null = null;
  let scheduled = false;
  const hashes = new Map<string, Promise<string>>();

  const hash = (text: string) => {
    let pending = hashes.get(text);
    if (!pending) {
      pending = g.crypto.subtle.digest("SHA-256", new g.TextEncoder().encode(text)).then((buffer) =>
        [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join(""));
      if (hashes.size > 32) hashes.clear();
      hashes.set(text, pending);
    }
    return pending;
  };

  const readFresh = async () => {
    if (fresh && Date.now() - fresh.at < CARDS_TTL_MS) return fresh.cards;
    try {
      const result = await client.rpc(usageCardsStatus, {});
      fresh = { at: Date.now(), cards: result.cards };
    } catch {
      fresh = { at: Date.now(), cards: [] }; // An unreachable server hides nothing.
    }
    return fresh.cards;
  };

  const cardsIn = (list: El) => [...Array.from(list.children)].filter((el) => (el.getAttribute("data-testid") ?? "").startsWith("usage-report-"));
  const texts = (el: El) => [...Array.from(el.querySelectorAll("*"))].filter((child) => child.children.length === 0).map((child) => child.textContent ?? "");

  const restore = (list: El | null) => {
    for (const el of Array.from((list ?? g.document.body)?.querySelectorAll(`[${HIDDEN_ATTR}]`) ?? [])) {
      el.style.display = "";
      el.removeAttribute(HIDDEN_ATTR);
    }
  };

  const apply = async () => {
    scheduled = false;
    const list = scoped?.list;
    if (!list) return;
    if (!list.isConnected) return stopScoped();
    if (!enabled) return restore(list);
    const cards = cardsIn(list);
    const rendered: RenderedCard[] = await Promise.all(cards.map(async (el) => {
      const testId = el.getAttribute("data-testid") ?? "";
      const login = testId.startsWith(BUILTIN_PREFIX) ? loginText(texts(el)) : null;
      return { testId, loginHash: login === null ? null : await hash(login) };
    }));
    const hide = cardsToHide(rendered, await readFresh());
    for (const el of cards) {
      const id = el.getAttribute("data-testid") ?? "";
      if (hide.has(id) && !el.hasAttribute(HIDDEN_ATTR)) {
        el.style.display = "none";
        el.setAttribute(HIDDEN_ATTR, "");
      } else if (!hide.has(id) && el.hasAttribute(HIDDEN_ATTR)) {
        el.style.display = "";
        el.removeAttribute(HIDDEN_ATTR);
      }
    }
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    g.requestAnimationFrame(() => void apply());
  };

  const stopScoped = () => {
    scoped?.observer.disconnect();
    scoped = null;
  };
  const stopFinder = () => {
    if (!finder) return;
    finder.observer.disconnect();
    clearTimeout(finder.timer);
    finder = null;
  };

  /** Our card's list, once it is on screen. */
  const findList = (): El | null => {
    const body = g.document.body;
    const ours = body?.querySelector(`[data-testid="context-window-details"] [data-testid^="${OURS_PREFIX}"]`) ?? body?.querySelector(`[data-testid^="${OURS_PREFIX}"]`);
    return ours?.parentElement ?? null;
  };
  const attach = (list: El) => {
    stopFinder();
    if (scoped?.list === list) return schedule();
    stopScoped();
    const observer = new g.MutationObserver(schedule);
    observer.observe(list, { childList: true, subtree: true, characterData: true });
    scoped = { list, observer };
    fresh = null; // A new look at the card reads freshness again.
    schedule();
  };

  const arm = () => {
    if (scoped && !scoped.list.isConnected) stopScoped();
    if (!enabled) return;
    const list = findList();
    if (list) return attach(list);
    if (finder || !g.document.body) return;
    const observer = new g.MutationObserver(() => {
      const found = findList();
      if (found) attach(found);
    });
    observer.observe(g.document.body, { childList: true, subtree: true });
    finder = { observer, timer: setTimeout(stopFinder, FIND_MS) };
  };

  const onEvent = (event: { target: unknown }) => {
    const target = event.target as Partial<El> | null;
    if (typeof target?.closest !== "function") return;
    if (target.closest(METER)) arm();
    else if (scoped && !scoped.list.isConnected) stopScoped();
  };
  const events = ["pointerover", "focusin", "click"] as const;
  for (const type of events) g.document.addEventListener(type, onEvent, true);

  const unsubscribe = subscribeDisplay((values) => {
    if (values.replaceUsageCard === enabled) return;
    enabled = values.replaceUsageCard;
    if (!enabled) { restore(scoped?.list ?? null); stopFinder(); }
    else schedule();
  });

  return () => {
    for (const type of events) g.document.removeEventListener(type, onEvent, true);
    unsubscribe();
    stopFinder();
    restore(scoped?.list ?? null);
    stopScoped();
  };
}
