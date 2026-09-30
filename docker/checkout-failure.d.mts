export interface GitResult {
  status: number | null;
  stderr?: string | Buffer;
  error?: { code?: string };
}

export class CheckoutFailure extends Error {
  stage: string;
  code: string;
  attempts: number;
  constructor(stage: string, code: string, attempts?: number);
}

export const FETCH_DEADLINE_MS: number;
export const MAX_FETCH_ATTEMPTS: number;
export function classifyGitFailure(
  result: GitResult,
  stage: string,
  attempts?: number,
): CheckoutFailure;
export function terminationMessage(error: unknown): string;
export function runFetchCommand(
  args: string[],
  cwd: string,
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): Promise<GitResult>;
export function fetchWithRetry(
  run: (remainingMs: number) => GitResult | Promise<GitResult>,
  options?: {
    now?: () => number;
    wait?: (milliseconds: number) => Promise<unknown>;
    deadline?: number;
    attemptOffset?: number;
  },
): Promise<number>;
