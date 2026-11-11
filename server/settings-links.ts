/**
 * Whether every ZeroSub Claude account home still shares the main Claude Code settings.
 *
 * ZeroSub links each managed home's `settings.json` to the main one, so hooks installed there (this
 * plugin's, Paseo's, everyone's) reach sessions on every account. Anything that rewrites the file
 * atomically through the link replaces it with a copy, and from then on those sessions miss every
 * hook added later. On 2026-11-10 a test run did exactly that to a seat home. This module only
 * looks: it reads ZeroSub's registry for the homes and `lstat`s one file in each. It writes
 * nothing and opens no credential file, and the fix it names is for the person to apply.
 */
import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface HomeLink {
  /** ZeroSub's account id (never an email). */
  readonly accountId: string;
  readonly home: string;
  /** `copy`: its own file. `elsewhere`: a link to another file. `missing`: no settings.json at all. */
  readonly problem: "copy" | "elsewhere" | "missing";
}

/** The ZeroSub Claude account homes whose settings.json isn't a link to `mainSettings`. */
export async function brokenHomeLinks(mainSettings: string, paseoHome = process.env.PASEO_HOME ?? join(homedir(), ".paseo")): Promise<HomeLink[]> {
  let accounts: unknown;
  try {
    accounts = (JSON.parse(await readFile(join(paseoHome, "zerosub", "state.json"), "utf8")) as { accounts?: unknown }).accounts;
  } catch {
    return []; // No ZeroSub, or nothing readable: nothing to say.
  }
  if (!Array.isArray(accounts)) return [];
  const main = await realpath(mainSettings).catch(() => mainSettings);
  const found: HomeLink[] = [];
  for (const account of accounts as { id?: unknown; family?: unknown; home?: unknown }[]) {
    if (account?.family !== "claude" || typeof account.id !== "string" || typeof account.home !== "string" || account.home === "") continue;
    const path = join(account.home, "settings.json");
    const info = await lstat(path).catch(() => null);
    if (info === null) {
      // A home that doesn't exist yet (signed out, never opened) has nothing to share.
      if ((await lstat(account.home).catch(() => null))?.isDirectory()) found.push({ accountId: account.id, home: account.home, problem: "missing" });
      continue;
    }
    if (!info.isSymbolicLink()) found.push({ accountId: account.id, home: account.home, problem: "copy" });
    else if ((await realpath(path).catch(() => null)) !== main) found.push({ accountId: account.id, home: account.home, problem: "elsewhere" });
  }
  return found;
}

/** One line per home, naming the fix. For the settings page and the agent tools alike. */
export function describeHomeLinks(links: readonly HomeLink[], mainSettings: string): string[] {
  return links.map((link) => {
    const what = link.problem === "copy" ? "is its own copy" : link.problem === "elsewhere" ? "links to another file" : "is missing";
    return `ZeroSub account ${link.accountId}: ${join(link.home, "settings.json")} ${what}, not a link to ${mainSettings}, so hooks installed there don't reach that account's sessions. Fix: merge anything it has that the main file lacks, then \`ln -sf ${mainSettings} ${join(link.home, "settings.json")}\`.`;
  });
}
