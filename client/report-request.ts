/**
 * The Report a bug sheet's open request (client/report-issue.tsx), without JSX so ⌘K items, Settings and tests can
 * open it. One request at a time; the first mounted host (the overview or Settings) shows it.
 */
export type ReportKind = "bug" | "feature" | "feedback";
export type ReportRequest = { kind?: ReportKind; error?: string | null; at?: number; agentId?: string; workspaceId?: string };

let current: (ReportRequest & { token: number }) | null = null;
let token = 0;
const listeners = new Set<() => void>();
let version = 0;
const emit = () => { version++; for (const l of listeners) l(); };
const hosts: number[] = [];
let hostIds = 0;
let fallback: ((r: ReportRequest) => void) | null = null;

/** Opens the sheet wherever a host is mounted; otherwise asks the plugin to open a screen that has one (the overview). */
export function openReportSheet(request: ReportRequest = {}): void {
  current = { ...request, token: ++token };
  if (hosts.length) emit(); else fallback?.(request);
}
/** index.client.tsx: how to reach a host when none is mounted (open the overview, which mounts one and reads the request). */
export function setReportFallback(open: ((r: ReportRequest) => void) | null) { fallback = open; }
/** Test seam. */
export const reportRequestNow = () => current;
export const closeReport = () => { current = null; emit(); };

export const nextHostId = () => ++hostIds;
/** A host mounts: returns its unmount. */
export function hostsReport(id: number): () => void {
  hosts.push(id); emit();
  return () => { hosts.splice(hosts.indexOf(id), 1); emit(); };
}
export function subscribeReport(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export const reportVersion = () => version;
/** The open request, for the host that owns the sheet (the first mounted); null for the others. */
export const currentReport = (id: number) => (current && hosts[0] === id ? current : null);
