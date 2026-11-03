import { mkdir, readFile, rename, open, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { StateSchema, type State } from "../../shared/guard/policy.ts";

/**
 * Where Session Guard keeps its pauses, session overrides and governor lock.
 *
 * Deliberately the standalone `paseo-session-guard` plugin's directory, not
 * `plugin-data/smart-session/`. Both plugins may be installed on one host while people
 * move over, and both would otherwise pause the same agent. Sharing this directory
 * means they share `governor.lock`, so exactly one of them governs; and when the
 * standalone plugin is removed, its per-session choices and confirmed waits are picked
 * up here instead of being lost. The state shape is therefore frozen: the standalone
 * plugin reads and rewrites the same file, and its schema would strip anything new.
 */
export function guardDataDir(): string {
  return join(process.env.PASEO_HOME ?? join(homedir(), ".paseo"), "plugin-data", "session-guard");
}

/** A live process already governs this host. Not a failure: the caller defers to it. */
export class LockHeldError extends Error {}

export class Store {
  readonly directory: string;
  constructor(directory: string) { this.directory = directory; }
  async read(): Promise<State> {
    try {
      return StateSchema.parse(JSON.parse(await readFile(join(this.directory, "state.json"), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, overrides: {}, pauses: [] };
      throw new Error("Session Guard state could not be read. Restore state.json before continuing.");
    }
  }
  async write(state: State): Promise<void> {
    const parsed = StateSchema.parse(state);
    // Keep pending work and a bounded history; never write transcripts or prompts.
    const pending = parsed.pauses.filter(p => p.settledAt === null);
    const history = parsed.pauses.filter(p => p.settledAt !== null).slice(-200);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `state-${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify({ ...parsed, pauses: [...history, ...pending] }, null, 2));
        await file.sync(); // Confirmed schedules must reach disk before signals.
      } finally { await file.close(); }
      await rename(temporary, join(this.directory, "state.json"));
      if (process.platform === "linux") {
        const directory = await open(this.directory, "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } finally { await unlink(temporary).catch(() => undefined); }
  }
  /** One governor per host, including installs under a second plugin ID. */
  async lock(): Promise<() => Promise<void>> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, "governor.lock");
    const identity = async (pid: number) => {
      if (process.platform !== "linux") return null;
      const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
      const raw = await readFile(`/proc/${pid}/stat`, "utf8");
      const birth = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/)[19];
      return `${boot}:${birth}`;
    };
    const token = `${process.pid}:${randomUUID()}:${await identity(process.pid) ?? "portable"}`;
    const alive = async (value: string) => {
      const [pidText, , ...saved] = value.split(":"); const pid = Number(pidText);
      if (!Number.isInteger(pid) || pid <= 0) throw new Error("Governor lock has an invalid owner.");
      try {
        process.kill(pid, 0);
        return saved.length < 2 || process.platform !== "linux" || await identity(pid) === saved.join(":");
      } catch (error) {
        if (["ESRCH", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
        throw error;
      }
    };
    const claim = async () => {
      const handle = await open(path, "wx", 0o600);
      try { await handle.writeFile(token); } finally { await handle.close(); }
    };
    try { await claim(); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const previous = await readFile(path, "utf8");
      if (await alive(previous)) throw new LockHeldError("Another Session Guard instance is already running.");
      // Stale-lock recovery must itself be exclusive across simultaneous loads.
      const recoveryPath = `${path}.recovery`;
      const abandoned = await readFile(recoveryPath, "utf8").catch(error => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (abandoned !== null) {
        // Older releases left an empty recovery file. Allow its writer time to
        // finish; a nonempty owner is checked by boot and process birth identity.
        const expired = abandoned === "" ? Date.now() - (await stat(recoveryPath)).mtimeMs > 30_000 : !await alive(abandoned);
        if (!expired) throw new LockHeldError("Governor recovery is already running.");
        if (await readFile(recoveryPath, "utf8") !== abandoned) throw new Error("Governor recovery changed.");
        await unlink(recoveryPath);
      }
      const recovery = await open(recoveryPath, "wx", 0o600);
      await recovery.writeFile(token);
      try {
        if (await readFile(path, "utf8") !== previous) throw new Error("Governor lock changed; reload Session Guard.");
        await unlink(path);
        await claim();
      } finally { await recovery.close(); await unlink(`${path}.recovery`).catch(() => undefined); }
    }
    return async () => {
      if (await readFile(path, "utf8").catch(() => null) === token) await unlink(path);
    };
  }
}
