import {
  acquireBossAccountLock,
  withBossAccountLock,
  type BossAccountLock,
  type BossAccountLockOptions
} from "@boss-forge/boss-cli-adapter";

export async function acquireAccountLock(
  accountId: string,
  options: AccountLockOptions = {}
): Promise<AccountLock> {
  return acquireBossAccountLock(accountId, options);
}

export async function withAccountLock<T>(
  accountId: string,
  callback: () => Promise<T>,
  options: AccountLockOptions = {}
): Promise<T> {
  return withBossAccountLock(accountId, callback, options);
}

export type AccountLock = BossAccountLock;
export type AccountLockOptions = BossAccountLockOptions;
