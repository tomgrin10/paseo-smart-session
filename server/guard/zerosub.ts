/**
 * Finding and reading ZeroSub (`@kapybara/zerosub`) on this host, read-only.
 *
 * What the readings mean, and why the guard wants them, is in
 * `shared/guard/zerosub.ts`. This file only answers "is ZeroSub enabled here" from
 * Paseo's `config.json`, and reads its registry, usage readings and preferences. It
 * never writes anything of ZeroSub's and never opens an account home, where the
 * credentials are.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { budgetAccount, parseZeroSub, type ZeroSubSnapshot } from "../../shared/guard/zerosub.ts";

export const ZEROSUB_ID = "zerosub";
export const ZEROSUB_PACKAGE = "@kapybara/zerosub";

type ReadText = (path: string) => Promise<string>;
const readText: ReadText = (path) => readFile(path, "utf8");

const paseoHome = () => process.env.PASEO_HOME ?? join(homedir(), ".paseo");

async function readJson(read: ReadText, path: string): Promise<unknown> {
  try {
    return JSON.parse(await read(path)) as unknown;
  } catch {
    return undefined;
  }
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/**
 * The install id ZeroSub is enabled under, or null. The id can be anything
 * (`--id`), so the manifest and package name in its directory are checked too.
 */
export async function zerosubInstallId(home = paseoHome(), read: ReadText = readText): Promise<string | null> {
  const plugins = record(record(await readJson(read, join(home, "config.json")))?.plugins);
  for (const [id, value] of Object.entries(plugins ?? {})) {
    const entry = record(value);
    if (entry?.enabled !== true) continue;
    if (id === ZEROSUB_ID) return id;
    const path = typeof entry.path === "string" ? entry.path : null;
    if (!path) continue;
    if (record(await readJson(read, join(path, "paseo-plugin.json")))?.id === ZEROSUB_ID) return id;
    if (record(await readJson(read, join(path, "package.json")))?.name === ZEROSUB_PACKAGE) return id;
  }
  return null;
}

/** ZeroSub's view of accounts, or null when it is not enabled or its registry is unusable. */
export async function readZeroSub(home = paseoHome(), read: ReadText = readText): Promise<ZeroSubSnapshot | null> {
  const id = await zerosubInstallId(home, read);
  if (id === null) return null;
  const dir = join(home, "zerosub");
  const [state, usage, preferences] = await Promise.all([
    readJson(read, join(dir, "state.json")),
    readJson(read, join(dir, "usage.json")),
    readJson(read, join(home, "plugin-settings", id, "preferences.json")),
  ]);
  return parseZeroSub(state, usage, preferences);
}

/**
 * What `budget_status` should report for an agent under ZeroSub: which account, and,
 * for an account ZeroSub added, that account's own windows in place of the recorder's
 * (which measure the CLI login). Null without ZeroSub.
 */
export async function zerosubBudgetAccount(agentId: string, home = paseoHome(), read: ReadText = readText, now = Date.now()) {
  const snapshot = await readZeroSub(home, read);
  const account = snapshot ? budgetAccount(snapshot, agentId, now) : null;
  if (!account) return null;
  const windows = account.reading?.windows.map((window) => ({ ...window, burnPctPerHour: null, projectedFullAt: null })) ?? null;
  return {
    account: { kind: account.kind, label: account.label, otherAccountsWithRoom: account.otherAccountsWithRoom, autoSwitch: account.autoSwitch, readAt: account.reading?.fetchedAt ?? null },
    // A managed account without a reading yet: say so with no windows rather than show the CLI login's.
    windows: account.kind === "managed" ? (windows ?? []) : null,
  };
}
