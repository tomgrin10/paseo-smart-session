/**
 * Which of Paseo's listed Claude reports is the CLI login's (`usage-account-identity`).
 * ZeroSub knows the main Claude account's email hash; the recorder and Session Guard both
 * pick that login's report by it. No side effects: the guard imports it without the recorder.
 */

import { createHash } from "node:crypto";

import { readZeroSub } from "./guard/zerosub.ts";
import { sourceState } from "./usage-source.ts";

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** The CLI login's email hash; `accountId` is ZeroSub's main Claude account when the caller knows it. */
export async function cliLoginHash(accountId: string | null = null): Promise<string | null> {
  const id = accountId ?? (await readZeroSub().catch(() => null))?.accounts.find((a) => a.family === "claude" && a.kind === "main")?.id ?? null;
  if (id === null) return null;
  const state = await sourceState().catch(() => null);
  return state?.zerosub?.extras[id]?.emailHash ?? null;
}
