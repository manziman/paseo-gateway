export function writeSnapshot(root: string, uid: string, bytes: Buffer): Promise<string>;
export function pruneSnapshots(
  root: string,
  uid: string,
  committedFileName?: string,
): Promise<void>;
export function readAgent(
  root: string,
  uid: string,
  agentId: string,
  generation: number,
  fileName: string,
): Promise<unknown>;
