import { readFile, readdir } from "node:fs/promises";
import type { Agent, Pause } from "../../shared/guard/policy.ts";

export type Suspension = NonNullable<Pause["suspension"]>;
type Identity = Suspension["processes"][number];
type Snapshot = Identity & { ppid: number; state: string };
export interface ProcessControl {
  discover(agent: Agent, daemonPid: number): Promise<Suspension | null>;
  freeze(suspension: Suspension, journal: () => Promise<void>): Promise<void>;
  resume(suspension: Suspension): Promise<void>;
  stopped(suspension: Suspension): Promise<boolean>;
  alive?(suspension: Suspension): Promise<boolean>;
  owned?(suspension: Suspension): Promise<boolean>;
  daemonIdentity?(): Promise<string>;
}

/** Linux process suspension keeps native workers and their in-memory turns intact.
 * Roots must be direct children of this daemon with its exact injected agent ID.
 * No process-name scans, credentials, transcripts, or provider sessions are used.
 */
export class LinuxProcessControl implements ProcessControl {
  private readonly daemonPid: number;
  constructor(daemonPid: number = process.ppid) { this.daemonPid = daemonPid; }
  private async inspect(pid: number): Promise<Snapshot | null> {
    try {
      const raw = await readFile(`/proc/${pid}/stat`, "utf8");
      const fields = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/);
      if (!fields[19] || !Number.isInteger(Number(fields[1]))) return null;
      return { pid, state: fields[0], ppid: Number(fields[1]), startTime: fields[19] };
    } catch (error) {
      if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
      throw new Error("Provider process could not be inspected.");
    }
  }
  private async table(): Promise<Snapshot[]> {
    const entries = await readdir("/proc");
    const result: Snapshot[] = [];
    // Bounded batches avoid opening one descriptor per host process at once.
    const pids = entries.filter(name => /^\d+$/.test(name)).map(Number);
    for (let i = 0; i < pids.length; i += 64) {
      const batch = await Promise.all(pids.slice(i, i + 64).map(pid => this.inspect(pid)));
      result.push(...batch.filter((item): item is Snapshot => item !== null));
    }
    return result;
  }
  async discover(agent: Agent, daemonPid: number): Promise<Suspension | null> {
    if (process.platform !== "linux" || !["claude", "codex"].includes(agent.provider)) return null;
    if (!Number.isInteger(daemonPid) || daemonPid <= 1 || daemonPid !== this.daemonPid || daemonPid === process.pid) return null;
    const candidates: Snapshot[] = [];
    for (const child of (await this.table()).filter(p => p.ppid === daemonPid)) {
      if (child.pid === process.pid || ["T", "t", "Z", "X"].includes(child.state)) continue;
      try {
        const environment = await readFile(`/proc/${child.pid}/environ`);
        const owner = environment.toString().split("\0").find(field => field.startsWith("PASEO_AGENT_ID="));
        if (owner === `PASEO_AGENT_ID=${agent.id}`) candidates.push(child);
      } catch (error) {
        if (!["ENOENT", "ESRCH", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
    }
    // Ambiguous ownership must never freeze a shared process or another session.
    if (candidates.length !== 1) return null;
    const root = candidates[0];
    return { rootPid: root.pid, processes: [{ pid: root.pid, startTime: root.startTime }] };
  }
  private async signal(identity: Identity, signal: "SIGSTOP" | "SIGCONT"): Promise<boolean> {
    if (identity.pid <= 1 || identity.pid === process.pid || identity.pid === process.ppid) throw new Error("Unsafe provider process identity.");
    const snapshot = await this.inspect(identity.pid);
    if (!snapshot || snapshot.startTime !== identity.startTime || ["Z", "X"].includes(snapshot.state)) return false;
    try { process.kill(identity.pid, signal); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw new Error("Provider process signal failed.");
    }
  }
  private async resourceHolder(pid: number): Promise<boolean> {
    try {
      // Inspect only the opt-in marker; never decode or log the environment.
      const environment = await readFile(`/proc/${pid}/environ`);
      const key = Buffer.from("HARNESS_SLOT_HELD=");
      for (let start = 0; start < environment.length;) {
        const end = environment.indexOf(0, start);
        const stop = end < 0 ? environment.length : end;
        if (stop > start + key.length && environment.subarray(start, start + key.length).equals(key)) return true;
        start = stop + 1;
      }
      // The shell wrapper owns the flock before its command inherits the marker.
      // Match an executable or interpreter's script, never an arbitrary argument.
      const argv = (await readFile(`/proc/${pid}/cmdline`)).toString().split("\0");
      const basename = (value: string) => value.slice(value.lastIndexOf("/") + 1);
      return basename(argv[0] ?? "") === "harness-slot" ||
        (["bash", "sh", "dash"].includes(basename(argv[0] ?? "")) && basename(argv[1] ?? "") === "harness-slot");
    } catch (error) {
      if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
      // If we cannot rule out a shared-resource holder, leave it running.
      return true;
    }
  }
  private async protectedTree(table: Snapshot[]): Promise<Set<number>> {
    const protectedPids = new Set<number>();
    for (const p of table) if (await this.resourceHolder(p.pid)) protectedPids.add(p.pid);
    let grew = true;
    while (grew) {
      grew = false;
      for (const p of table) if (protectedPids.has(p.ppid) && !protectedPids.has(p.pid)) {
        protectedPids.add(p.pid); grew = true;
      }
    }
    return protectedPids;
  }
  async freeze(suspension: Suspension, journal: () => Promise<void>): Promise<void> {
    const root = suspension.processes.find(p => p.pid === suspension.rootPid);
    if (root && await this.resourceHolder(root.pid)) throw new Error("Provider holds a shared resource and cannot be suspended.");
    if (!root || !await this.signal(root, "SIGSTOP")) throw new Error("Provider process exited before suspension.");
    // Stop the root before traversing. Descendants are then stopped as discovered;
    // repeat to catch a tool worker that forked during the previous scan.
    const seen = new Set(suspension.processes.map(p => `${p.pid}:${p.startTime}`));
    for (let pass = 0; pass < 8; pass++) {
      const table = await this.table();
      const owned = new Set<number>();
      for (const p of suspension.processes) {
        if (table.some(s => s.pid === p.pid && s.startTime === p.startTime)) owned.add(p.pid);
      }
      let grew = true;
      while (grew) {
        grew = false;
        for (const p of table) if (owned.has(p.ppid) && !owned.has(p.pid)) { owned.add(p.pid); grew = true; }
      }
      const protectedPids = await this.protectedTree(table.filter(p => owned.has(p.pid)));
      const additions = table.filter(p => owned.has(p.pid) && !protectedPids.has(p.pid) && !seen.has(`${p.pid}:${p.startTime}`) && !["Z", "X"].includes(p.state));
      if (!additions.length) {
        if (!await this.stopped(suspension)) throw new Error("Provider suspension was externally changed.");
        return;
      }
      for (const p of additions) {
        seen.add(`${p.pid}:${p.startTime}`);
        // A worker already stopped by a person/debugger is never ours to resume.
        if (["T", "t"].includes(p.state)) continue;
        suspension.processes.push({ pid: p.pid, startTime: p.startTime });
        await journal(); // Durable identity before each signal, including crash windows.
        await this.signal(p, "SIGSTOP");
      }
    }
    throw new Error("Provider process tree did not settle.");
  }
  async resume(suspension: Suspension): Promise<void> {
    let failed = false;
    // Tools first, then root, so the provider can consume their pending responses.
    for (const p of [...suspension.processes].reverse()) {
      try { await this.signal(p, "SIGCONT"); } catch { failed = true; }
    }
    if (failed) throw new Error("Some suspended provider processes could not be released.");
  }
  async stopped(suspension: Suspension): Promise<boolean> {
    const root = suspension.processes.find(p => p.pid === suspension.rootPid);
    if (!root) return false;
    const snapshot = await this.inspect(root.pid);
    if (!snapshot || snapshot.startTime !== root.startTime || !["T", "t"].includes(snapshot.state)) return false;
    for (const p of suspension.processes) {
      if (p.pid === root.pid) continue;
      const child = await this.inspect(p.pid);
      if (child && child.startTime === p.startTime && !["T", "t", "Z", "X"].includes(child.state)) return false;
    }
    return true;
  }
  async daemonIdentity(): Promise<string> {
    if (process.platform !== "linux") return `portable:${this.daemonPid}`;
    const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
    const daemon = await this.inspect(this.daemonPid);
    if (!daemon) throw new Error("Daemon identity is unavailable.");
    return `${boot}:${daemon.pid}:${daemon.startTime}`;
  }
  async owned(suspension: Suspension): Promise<boolean> {
    const root = suspension.processes.find(p => p.pid === suspension.rootPid);
    if (!root) return false;
    const snapshot = await this.inspect(root.pid);
    return !!snapshot && snapshot.startTime === root.startTime && snapshot.ppid === this.daemonPid;
  }
  async alive(suspension: Suspension): Promise<boolean> {
    const root = suspension.processes.find(p => p.pid === suspension.rootPid);
    if (!root) return false;
    const snapshot = await this.inspect(root.pid);
    return !!snapshot && snapshot.startTime === root.startTime && !["Z", "X"].includes(snapshot.state);
  }
}
