import type { ControlRecord, RecordStore } from "../src/kubernetes/records.js";

/** In-memory API fake retains optimistic version conflicts, including concurrent create. */
export class MemoryRecordStore implements RecordStore {
  private rows = new Map<string, ControlRecord>();
  private revision = 0;
  async records<T>(kind: string): Promise<ControlRecord<T>[]> {
    return structuredClone(
      [...this.rows.values()].filter((r) => r.kind === kind),
    ) as ControlRecord<T>[];
  }
  async record<T>(kind: string, id: string): Promise<ControlRecord<T> | undefined> {
    return structuredClone(this.rows.get(`${kind}/${id}`)) as ControlRecord<T> | undefined;
  }
  async createRecord<T>(row: ControlRecord<T>): Promise<ControlRecord<T>> {
    const key = `${row.kind}/${row.id}`;
    if (this.rows.has(key)) throw { code: 409 };
    const result = { ...structuredClone(row), version: String(++this.revision) };
    this.rows.set(key, result);
    return structuredClone(result);
  }
  async updateRecord<T>(row: ControlRecord<T>): Promise<ControlRecord<T>> {
    const key = `${row.kind}/${row.id}`;
    if (!row.version || this.rows.get(key)?.version !== row.version) throw { code: 409 };
    const result = { ...structuredClone(row), version: String(++this.revision) };
    this.rows.set(key, result);
    return structuredClone(result);
  }
  async deleteRecord(row: ControlRecord) {
    const key = `${row.kind}/${row.id}`;
    if (!row.version || this.rows.get(key)?.version !== row.version) throw { code: 409 };
    this.rows.delete(key);
  }
}
