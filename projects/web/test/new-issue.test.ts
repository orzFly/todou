import type { Status } from "@todou/shared";
import { describe, expect, it } from "vitest";
import { pickDefaultStatus } from "../src/pages/new-issue.tsx";

const status = (id: number, name: string, is_default = false): Status => ({
  id,
  name,
  category: "open",
  color: "#6b7280",
  position: id,
  is_default,
});

describe("pickDefaultStatus (mirrors the server's choice)", () => {
  it("prefers the project default over position order", () => {
    const list = [status(1, "Inbox"), status(2, "Todo", true)];
    expect(pickDefaultStatus(list)?.name).toBe("Todo");
  });

  it("falls back to the first status when none is default", () => {
    const list = [status(1, "Inbox"), status(2, "Todo")];
    expect(pickDefaultStatus(list)?.name).toBe("Inbox");
  });

  it("returns undefined for an empty status set", () => {
    expect(pickDefaultStatus([])).toBeUndefined();
  });
});
