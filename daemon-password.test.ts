import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { resolveDaemonPassword } from "./server/daemon-password.mjs";

async function fallbackFile(home: string, value: string): Promise<string> {
  const path = join(home, "paseo-hub", "secrets", "daemon-password");
  await mkdir(join(home, "paseo-hub", "secrets"), { recursive: true });
  await writeFile(path, value, { encoding: "utf8", mode: 0o600 });
  return path;
}

test("daemon password prefers PASEO_PASSWORD without touching configured files", async () => {
  const home = await mkdtemp(join(tmpdir(), "smart-session-password-"));
  await fallbackFile(home, "fallback-secret\n");
  assert.equal(
    await resolveDaemonPassword({
      home,
      env: { PASEO_PASSWORD: "  env-secret  ", PASEO_PASSWORD_FILE: join(home, "missing") },
    }),
    "env-secret",
  );
});

test("daemon password reads and trims an explicit password file before the fallback", async () => {
  const home = await mkdtemp(join(tmpdir(), "smart-session-password-"));
  await fallbackFile(home, "fallback-secret\n");
  const explicit = join(home, "explicit-password");
  await writeFile(explicit, "  file-secret\n", { encoding: "utf8", mode: 0o600 });
  assert.equal(
    await resolveDaemonPassword({ home, env: { PASEO_PASSWORD_FILE: explicit } }),
    "file-secret",
  );
});

test("daemon password falls back to the paseo-hub VM secret", async () => {
  const home = await mkdtemp(join(tmpdir(), "smart-session-password-"));
  await fallbackFile(home, "vm-secret\n");
  assert.equal(await resolveDaemonPassword({ home, env: {} }), "vm-secret");
});

test("an absent optional fallback leaves password authentication disabled", async () => {
  const home = await mkdtemp(join(tmpdir(), "smart-session-password-"));
  assert.equal(await resolveDaemonPassword({ home, env: {} }), undefined);
});

test("an unreadable or empty PASEO_PASSWORD_FILE fails without exposing its path", async () => {
  const home = await mkdtemp(join(tmpdir(), "smart-session-password-"));
  const missing = join(home, "secret-name-that-must-not-leak");
  await assert.rejects(
    resolveDaemonPassword({ home, env: { PASEO_PASSWORD_FILE: missing } }),
    (error: unknown) => {
      assert.equal(error instanceof Error && error.message, "PASEO_PASSWORD_FILE could not be read.");
      assert.doesNotMatch(String(error), /secret-name-that-must-not-leak/);
      return true;
    },
  );

  const empty = join(home, "empty");
  await writeFile(empty, " \n", { encoding: "utf8", mode: 0o600 });
  await assert.rejects(
    resolveDaemonPassword({ home, env: { PASEO_PASSWORD_FILE: empty } }),
    /PASEO_PASSWORD_FILE is empty\./,
  );
});

test("every direct daemon client forwards the resolved password and never logs it", async () => {
  for (const file of ["server/daemon.ts", "server/hooklib/daemon.mjs", "probe.mjs"]) {
    const source = await readFile(file, "utf8");
    assert.match(source, /resolveDaemonPassword\(\)/, `${file} must resolve daemon authentication`);
    assert.match(
      source,
      /password === undefined \? \{\} : \{ password \}/,
      `${file} must pass the resolved password to DaemonClient`,
    );
    assert.doesNotMatch(
      source,
      /console\.(?:log|error|warn)\([^\n]*password/i,
      `${file} must not log the daemon password`,
    );
  }
  // The scripts Claude Code runs reach the daemon only through the shared client above.
  for (const file of ["mcp.mjs", "hooks/publish-as.mjs"]) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /new DaemonClient\(/, `${file} must not open its own daemon client`);
    assert.match(source, /from "\.\.?\/server\/hooklib\/daemon\.mjs"/, `${file} must use server/hooklib/daemon.mjs`);
  }
});
