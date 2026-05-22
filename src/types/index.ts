export type AccountType = "individual" | "business" | "enterprise";

export interface AppConfig {
  preferredPort: number;
  requireCallerSecret: boolean;
  selectedModels: string[];
  accountType: AccountType;
}

export interface StoredCredentialFile {
  version: 1;
  github_token: string;
  account_type: AccountType;
  saved_at: string;
}

export interface LockFileData {
  pid: number;
  port: number;
  started_at_iso: string;
}

export interface TokenState {
  token: string;
  expiresAtUnix: number;
}

