/** Small durable control records. Content is configuration/status, never provider credentials. */
export interface ControlRecord<T = unknown> {
  id: string;
  kind: string;
  version?: string;
  value: T;
}

/** Updates and deletes require the version read by the caller; conflicts are not hidden. */
export interface RecordStore {
  records<T = unknown>(kind: string): Promise<ControlRecord<T>[]>;
  record<T = unknown>(kind: string, id: string): Promise<ControlRecord<T> | undefined>;
  createRecord<T>(record: ControlRecord<T>): Promise<ControlRecord<T>>;
  updateRecord<T>(record: ControlRecord<T>): Promise<ControlRecord<T>>;
  deleteRecord(record: ControlRecord): Promise<void>;
}
