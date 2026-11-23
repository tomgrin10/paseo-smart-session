export type ClaimBy = "governor" | "prompt" | "stale";
export function claimContinuation(requestId: string, by: ClaimBy, now?: number): boolean;
export function readClaim(requestId: string): { by: string; at: string | null } | null;
export function releaseClaim(requestId: string): void;
