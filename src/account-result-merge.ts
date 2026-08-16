import type { AccountView, TestManyResult } from "./types";

export function mergeTestedAccounts(accounts: AccountView[], results: readonly TestManyResult[]) {
  const updates = new Map<string, AccountView>();
  for (const result of results) {
    if (result.account) {
      updates.set(result.account.id, result.account);
    }
  }

  if (updates.size === 0) {
    return accounts;
  }

  return accounts.map((account) => updates.get(account.id) || account);
}
