import { describe, expect, it } from "vitest";
import { mergeTestedAccounts } from "../src/account-result-merge";
import type { AccountView, TestManyResult } from "../src/types";

function account(id: string, status: AccountView["status"] = "untested"): AccountView {
  const timestamp = "2026-08-15T00:00:00.000Z";
  return {
    id,
    email: `${id}@example.com`,
    clientId: `client-${id}`,
    remark: "",
    group: "",
    status,
    lastCheckedAt: null,
    lastError: null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function success(next: AccountView): TestManyResult {
  return { accountId: next.id, account: next, ok: true, message: "ok" };
}

describe("mergeTestedAccounts", () => {
  it("merges a large batch in account order while preserving untouched identities", () => {
    const current = Array.from({ length: 5_000 }, (_, index) => account(`account-${index}`));
    const updatedEvenAccounts = current
      .filter((_, index) => index % 2 === 0)
      .map((item) => success({ ...item, status: "valid" }));

    const merged = mergeTestedAccounts(current, updatedEvenAccounts);

    expect(merged).toHaveLength(current.length);
    expect(merged[0].status).toBe("valid");
    expect(merged[1]).toBe(current[1]);
    expect(merged[4_998].status).toBe("valid");
    expect(merged[4_999]).toBe(current[4_999]);
  });

  it("ignores failed results and applies the last successful update for a duplicate id", () => {
    const original = account("account-1");
    const valid = { ...original, status: "valid" as const };
    const invalid = { ...original, status: "invalid" as const };
    const failed: TestManyResult = {
      accountId: original.id,
      account: null,
      ok: false,
      error: { code: "UNKNOWN", message: "failed", retryable: false }
    };

    expect(mergeTestedAccounts([original], [success(valid), failed, success(invalid)])).toEqual([invalid]);

    const unchanged = [original];
    expect(mergeTestedAccounts(unchanged, [failed])).toBe(unchanged);
    expect(mergeTestedAccounts(unchanged, [failed])[0]).toBe(original);
  });
});
