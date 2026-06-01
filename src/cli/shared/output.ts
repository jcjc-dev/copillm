export function writeCommandOutput(
  opts: { json?: boolean },
  humanLine: string,
  payload: Record<string, unknown>
): void {
  if (opts.json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    return;
  }
  process.stdout.write(`${humanLine}\n`);
}

export function writeHealthOutput(opts: { json?: boolean }, payload: Record<string, unknown>): void {
  if (opts.json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    return;
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}
