/**
 * Publishing an artifact as another Claude account: the decisions, kept free of I/O.
 *
 * An artifact belongs to the account of the session that publishes it. Under ZeroSub an agent may
 * run on a seat account, and then the person can't open, share or edit what it publishes. So a
 * publish from a session on a non-main account is handed to a short-lived helper agent pinned to
 * the main account (`server/publish-as.ts`), and the `PreToolUse` hook on the Artifact tool
 * (`hooks/publish-as.mjs`) does that by default. This module decides when, for whom, and what the
 * model is told.
 *
 * Only actions that create or change a page this feature owns are taken over. Anything else passes
 * through untouched, and so does a publish to a url we didn't make: an older page owned by the seat
 * can only be updated from the seat, and breaking its link is worse than a wrong owner.
 */
import { accountOf, type ZeroSubAccount, type ZeroSubSnapshot } from "./guard/zerosub.ts";

/** The environment variable every helper runs with, so the hook never takes over its own helper. */
export const HELPER_ENV = "SMART_SESSION_PUBLISH_HELPER";
/** The label every helper agent carries; also what a cleanup of ZeroSub's bindings can look for. */
export const HELPER_LABEL = { key: "smart-session.helper", value: "publish-as" } as const;

/** The Artifact tool's input, as far as this module reads it. Everything else is passed on verbatim. */
export type ArtifactInput = Record<string, unknown>;

/** A page this feature published, so a later update of it is routed to the account that owns it. */
export interface OwnedPage {
  readonly url: string;
  readonly callerAgentId: string;
  /** The caller's own path to the page file, absolute; null for a page made from a type. */
  readonly filePath: string | null;
  readonly accountId: string;
  readonly at: string;
}

export type ArtifactAction =
  | { kind: "other" }
  /** A new page (or a republish of a path this caller published through us before). */
  | { kind: "create"; filePath: string | null }
  /** A publish, or an asset upload, to an existing url. */
  | { kind: "update"; url: string };

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);

/** Same page, however the url was written: no trailing slash, no query or fragment. */
export function normalizeUrl(url: string): string {
  return url.trim().replace(/[?#].*$/, "").replace(/\/+$/, "");
}

/** What an Artifact call does. Only `publish` (the default action) can create or change a page. */
export function classify(input: ArtifactInput): ArtifactAction {
  const action = text(input.action) ?? "publish";
  if (action !== "publish") return { kind: "other" };
  const url = text(input.url);
  if (url) return { kind: "update", url: normalizeUrl(url) };
  // An asset upload or copy always names the artifact it goes to; without one there's nothing to do.
  if (input.asset === true) return { kind: "other" };
  if (text(input.type_url)) return { kind: "create", filePath: null };
  if (text(input.file_path) || (input.files !== undefined && input.files !== null)) {
    return { kind: "create", filePath: text(input.file_path) };
  }
  return { kind: "other" };
}

export interface PublishAsSettings {
  /** "Publish artifacts as the main account". */
  readonly enabled: boolean;
  /** The account to publish as; null is the main Claude account (the CLI's own login). */
  readonly accountId: string | null;
}

/**
 * The account a publish goes to: the one asked for (an id, a name, or "main"), else the setting's,
 * else the CLI's own Claude login. Null when there is no such usable Claude account.
 */
export function targetAccount(snapshot: ZeroSubSnapshot, wanted: string | null): ZeroSubAccount | null {
  const claude = snapshot.accounts.filter((account) => account.family === "claude");
  const asked = wanted?.trim().toLowerCase() ?? "";
  const account = asked === "" || asked === "main"
    ? claude.find((candidate) => candidate.kind === "main")
    : claude.find((candidate) => candidate.id.toLowerCase() === asked
      || candidate.label?.toLowerCase() === asked);
  return account ?? null;
}

/** Why a usable target account can't take a publish, or null when it can. */
export function unusable(account: ZeroSubAccount): string | null {
  if (!account.signedIn) return "it is signed out in ZeroSub";
  if (account.disabled) return "it is set aside in ZeroSub";
  return null;
}

export interface HookInput {
  readonly callerAgentId: string | null;
  readonly provider: string;
  readonly input: ArtifactInput;
  readonly settings: PublishAsSettings;
  /** `absent`: ZeroSub isn't enabled here. `unreadable`: it is, but its registry couldn't be read. */
  readonly zerosub: ZeroSubSnapshot | "absent" | "unreadable";
  readonly pages: readonly OwnedPage[];
  /** The caller is itself a helper (by its environment or label). */
  readonly isHelper: boolean;
}

export type HookDecision =
  | { decision: "pass"; why: PassReason; note: string | null }
  | {
      decision: "redirect";
      target: ZeroSubAccount;
      /** The Artifact input to hand the helper: the caller's, with a known page's url filled in. */
      input: ArtifactInput;
      /** The caller's own file, for the record of which page it made. */
      filePath: string | null;
    };

export type PassReason =
  | "helper" | "not-a-publish" | "setting-off" | "no-agent" | "not-claude" | "no-zerosub" | "zerosub-unreadable"
  | "no-target" | "target-unusable" | "on-target" | "unknown-url";

const pass = (why: PassReason, note: string | null = null): HookDecision => ({ decision: "pass", why, note });

/**
 * The hook's decision table: whether this Artifact call is taken over and published as the target
 * account, or passes through untouched. The order matters: cheap and certain reasons first.
 */
export function decide(hook: HookInput): HookDecision {
  if (hook.isHelper) return pass("helper");
  const action = classify(hook.input);
  if (action.kind === "other") return pass("not-a-publish");
  if (!hook.settings.enabled) return pass("setting-off");
  if (!hook.callerAgentId) return pass("no-agent");
  if (hook.provider !== "claude") return pass("not-claude");
  if (hook.zerosub === "absent") return pass("no-zerosub");
  if (hook.zerosub === "unreadable") return pass("zerosub-unreadable", UNREADABLE_NOTE);
  const snapshot = hook.zerosub;
  const target = targetAccount(snapshot, hook.settings.accountId);
  if (!target) return pass("no-target");
  const caller = accountOf(snapshot, hook.callerAgentId, "claude");
  if (!caller || caller.id === target.id) return pass("on-target");
  const problem = unusable(target);
  if (problem) return pass("target-unusable", `Smart Session didn't publish this as ${ownerName(target)} because ${problem}, so it goes out on this session's own account. The user may not be able to open it.`);

  if (action.kind === "update") {
    const page = hook.pages.find((candidate) => normalizeUrl(candidate.url) === action.url);
    // A page we didn't make belongs to whoever did; only that account can update it.
    if (!page) return pass("unknown-url");
    return { decision: "redirect", target, input: hook.input, filePath: page.filePath };
  }
  // Republishing a file this caller published through us before updates that page, as it would have
  // in the caller's own session.
  const previous = action.filePath === null ? undefined : [...hook.pages].reverse()
    .find((page) => page.callerAgentId === hook.callerAgentId && page.filePath === action.filePath);
  return {
    decision: "redirect",
    target,
    input: previous ? { ...hook.input, url: previous.url } : hook.input,
    filePath: action.filePath,
  };
}

/**
 * A readable name for an account: the name the person gave it, else a neutral one. Never an email
 * or ZeroSub's generated label, which is made from the email.
 */
export function ownerName(account: ZeroSubAccount): string {
  if (account.label) return account.kind === "main" ? `${account.label} (the main Claude account)` : account.label;
  return account.kind === "main" ? "the main Claude account (CLI login)" : `the Claude account ${account.id}`;
}

export const UNREADABLE_NOTE =
  "Smart Session couldn't read ZeroSub's account registry, so this artifact is published on this session's own account. If that isn't the user's main account, they may not be able to open it: say so when you share the link.";

/** The tool's name as this session sees it: `smart_publish_as` natively, `publish_as` over stdio. */
export const toolName = (native: boolean) => (native ? "smart_publish_as" : "publish_as");

/**
 * What the model reads after the hook published for it. It arrives as a "denied" tool call, so it
 * leads with the success and says plainly not to retry; the pinned wording is tested.
 */
export function successReason(result: { url: string; owner: string; resultText?: string | null }): string {
  const lines = [
    `Published as ${result.owner}: ${result.url}. This is the finished publish, not an error; do not retry or republish.`,
    `Owner: ${result.owner} (via helper). This session runs on another Claude account, so Smart Session published the page on ${result.owner} for you; share this url.`,
    `To update this page later, call Artifact again with url ${result.url}; Smart Session routes that to ${result.owner} too.`,
  ];
  if (result.resultText) lines.push(`The publish result, as the helper received it:\n${result.resultText}`);
  return lines.join("\n");
}

/** What the model reads when the helper could not publish. Nothing was published by this call. */
export function failureReason(error: string, owner: string, native: boolean): string {
  return [
    `Not published: Smart Session tried to publish this as ${owner} through a helper and it failed (${error}).`,
    `Nothing was published. To try again, call ${toolName(native)} with the same file_path. If the user is fine with the page living on this session's own account, ask them to turn off "Publish artifacts as the main account" in Smart Session's settings first.`,
  ].join("\n");
}

/** The first claude.ai artifact link in a helper's reply. */
export function extractUrl(reply: string | null | undefined): string | null {
  const match = reply?.match(/https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+/);
  return match ? match[0] : null;
}

/** The helper's one-line JSON reply, read defensively: any url in it counts, and an error is kept. */
export function parseHelperReply(reply: string | null | undefined): { url: string | null; error: string | null; resultText: string | null } {
  let parsed: Record<string, unknown> | null = null;
  const line = reply?.trim().split("\n").reverse().find((candidate) => candidate.trim().startsWith("{"));
  try { parsed = line ? (JSON.parse(line) as Record<string, unknown>) : null; } catch { parsed = null; }
  const url = text(parsed?.url) ?? extractUrl(reply);
  return {
    url: url ? extractUrl(url) : null,
    error: text(parsed?.error),
    resultText: text(parsed?.result)?.slice(0, 6000) ?? null,
  };
}

/** The helper's whole task. It publishes the given input once, as given, and reports back. */
export function helperPrompt(input: ArtifactInput): string {
  const url = text(input.url);
  const typed = text(input.type_url) !== null;
  return [
    "You are a publishing helper. Do exactly this and nothing else.",
    url
      ? `1. Call the Artifact tool with action "read" and url ${url} (it must be read before it can be republished).\n2. Call the Artifact tool once with exactly these parameters:`
      : "1. Call the Artifact tool once with exactly these parameters:",
    "```json",
    JSON.stringify(input, null, 2),
    "```",
    "Relative paths are relative to your working directory. You may read the files before publishing, but never change a file or a parameter, never publish anything else, and never retry a refused publish.",
    `Then reply with only one line of JSON: {"url": "<the artifact url>", "error": null${typed ? ', "result": "<the publish result text, verbatim>"' : ""}}. If the publish failed, put the reason in "error" and the url as null.`,
  ].join("\n");
}
