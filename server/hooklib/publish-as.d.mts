export declare const DEADLINE_MS: number;
export declare const HELPER_ENV: string;
export declare const UNREACHABLE: string;
export declare function mayPublish(input: unknown): boolean;
export declare function mayRoute(tool: unknown, input: unknown): boolean;
export declare function recordHook(
  event: unknown,
  context: { env: Record<string, string | undefined>; call: (method: string, input: any) => Promise<any> },
): Promise<null>;
export declare function publishAsHook(
  event: unknown,
  context: {
    env: Record<string, string | undefined>;
    call: (method: string, input: any) => Promise<any>;
    native: boolean;
    deadlineMs?: number;
    now?: () => number;
  },
): Promise<object | null>;
