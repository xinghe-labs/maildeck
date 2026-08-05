import { describe, expect, it } from "vitest";
import { CredentialGenerations } from "../electron/main/credential-generations.js";

describe("CredentialGenerations", () => {
  it("invalidates only the accounts whose credentials changed", () => {
    const generations = new CredentialGenerations();
    const first = generations.capture("account-1");
    const second = generations.capture("account-2");

    generations.invalidateAccounts(["account-1", "account-1"]);

    expect(generations.isCurrent(first)).toBe(false);
    expect(generations.isCurrent(second)).toBe(true);
    expect(() => generations.assertCurrent(first)).toThrow("凭据或代理已更新");
  });

  it("invalidates every account snapshot when the proxy changes", () => {
    const generations = new CredentialGenerations();
    const first = generations.capture("account-1");
    const second = generations.capture("account-2");

    generations.invalidateProxy();

    expect(generations.isCurrent(first)).toBe(false);
    expect(generations.isCurrent(second)).toBe(false);
    expect(generations.isCurrent(generations.capture("account-1"))).toBe(true);
  });
});
