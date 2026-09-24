import { describe, expect, it } from "vitest";
import { DirectoryPages } from "../src/gateway/catalog.js";

describe("aggregate directory pagination", () => {
  it("retains one immutable listing across page requests, with no 200-row truncation for legacy CLI", () => {
    const pages = new DirectoryPages();
    const rows = Array.from({ length: 450 }, (_, id) => ({ id }));
    expect(pages.read("agents", undefined, rows).entries).toHaveLength(450);
    const first = pages.read("agents", { limit: 200 }, rows);
    const second = pages.read("agents", { limit: 200, cursor: first.pageInfo.nextCursor ?? "" });
    const third = pages.read("agents", { limit: 200, cursor: second.pageInfo.nextCursor ?? "" });
    expect([...first.entries, ...second.entries, ...third.entries]).toEqual(rows);
    expect(third.pageInfo.hasMore).toBe(false);
    expect(
      pages.read("agents", { limit: 200, cursor: third.pageInfo.prevCursor ?? "" }).entries,
    ).toEqual(second.entries);
  });

  it("rejects a cursor reused with another filter, expired cursor, or invalid offset", () => {
    let now = 0;
    const pages = new DirectoryPages(() => now);
    const first = pages.read("project-one", { limit: 1 }, [1, 2]);
    const cursor = first.pageInfo.nextCursor ?? "";
    expect(() => pages.read("project-two", { limit: 1, cursor })).toThrow("cursor");
    expect(() =>
      pages.read("project-one", { limit: 1, cursor: cursor.replace(":1", ":NaN") }),
    ).toThrow("cursor");
    now = 300001;
    expect(() => pages.read("project-one", { limit: 1, cursor })).toThrow("cursor");
  });

  it("bounds memory instead of returning a silently incomplete unpaged CLI listing", () => {
    expect(() =>
      new DirectoryPages().read(
        "agents",
        undefined,
        Array.from({ length: 10001 }, (_, id) => id),
      ),
    ).toThrow("capacity");
  });
});
