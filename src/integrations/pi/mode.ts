const FALSE_VALUES = new Set(["", "0", "false", "no", "off"]);

/** Native Copilot is the default; explicit false-like values retain proxy mode. */
export function isPiNativeCopilotEnabled(value = process.env.COPILLM_PI_NATIVE_COPILOT): boolean {
  return value === undefined || !FALSE_VALUES.has(value.trim().toLowerCase());
}
