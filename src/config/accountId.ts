/**
 * Account-id validation, shared by the `auth` layer (which writes the accounts
 * index) and the `models` layer (which embeds the id in a per-account model
 * cache filename). Lives in `config` so both layers can import it without
 * crossing a forbidden import boundary.
 *
 * An account id is embedded in filenames (`credentials.<id>.json`,
 * `models.cache.<id>.json`) and in a keychain account string, so it must be a
 * safe single path segment. GitHub logins are `[A-Za-z0-9-]`; copillm also
 * permits `.` and `_` for synthetic ids.
 */
export const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const MAX_ACCOUNT_ID_LENGTH = 64;

export class InvalidAccountIdError extends Error {
  public constructor(public readonly accountId: string, reason: string) {
    super(`Invalid account id "${accountId}": ${reason}`);
    this.name = "InvalidAccountIdError";
  }
}

/**
 * Validate an account id before it is used in a filename or keychain key.
 * Throws `InvalidAccountIdError` on anything that isn't a safe path segment.
 */
export function assertValidAccountId(accountId: string): void {
  if (accountId.length === 0) {
    throw new InvalidAccountIdError(accountId, "id must not be empty.");
  }
  if (accountId.length > MAX_ACCOUNT_ID_LENGTH) {
    throw new InvalidAccountIdError(accountId, `id must be at most ${MAX_ACCOUNT_ID_LENGTH} characters.`);
  }
  if (!ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new InvalidAccountIdError(
      accountId,
      "id may only contain letters, digits, '.', '_' and '-', and must start with a letter or digit."
    );
  }
}

/**
 * Non-throwing variant for hot paths (e.g. parsing an optional account prefix
 * out of a request URL) where an invalid id should just mean "not an account
 * prefix" rather than an error.
 */
export function isValidAccountId(accountId: string): boolean {
  return accountId.length > 0 && accountId.length <= MAX_ACCOUNT_ID_LENGTH && ACCOUNT_ID_PATTERN.test(accountId);
}
