import { createRequire } from "node:module";

export interface PackageInfo {
  name: string;
  version: string;
}

const FALLBACK_PACKAGE_INFO: PackageInfo = {
  name: "copillm",
  version: "0.2.7"
};

export function getPackageInfo(): PackageInfo {
  const envName = cleanPackageValue(process.env.COPILLM_PACKAGE_NAME);
  const envVersion = cleanPackageValue(process.env.COPILLM_PACKAGE_VERSION);
  if (envName && envVersion) {
    return { name: envName, version: envVersion };
  }

  try {
    const pkg = createRequire(import.meta.url)("../../package.json") as {
      name?: unknown;
      version?: unknown;
    };
    if (typeof pkg.name === "string" && pkg.name.length > 0 && typeof pkg.version === "string" && pkg.version.length > 0) {
      return { name: pkg.name, version: pkg.version };
    }
  } catch {
    // Standalone bundles may not have package.json on disk.
  }

  return FALLBACK_PACKAGE_INFO;
}

export function fallbackPackageInfo(): PackageInfo {
  return FALLBACK_PACKAGE_INFO;
}

function cleanPackageValue(value: undefined | string): null | string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}
