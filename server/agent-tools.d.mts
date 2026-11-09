export type AgentToolsContext = {
  agentId: string | null;
  call: (method: string, input: unknown) => Promise<any>;
  home?: string;
  stateFile?: string;
};
export type AgentTool = {
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<string>;
};
export declare const AGENT_SCOPED: Set<string>;
export declare function agentTools(context: AgentToolsContext): Record<"context_status" | "budget_status" | "checkpoint" | "request_compaction" | "defer_compaction", AgentTool>;
export declare const TOOL_SHAPES: { name: string; description: string; inputSchema: Record<string, unknown> }[];
export declare function named(text: string, native?: boolean): string;
