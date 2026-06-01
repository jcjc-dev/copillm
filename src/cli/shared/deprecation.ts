export function emitDeprecation(_opts: { json?: boolean }, oldCmd: string, newCmd: string): void {
  // JSON consumers still get the deprecation on stderr so stdout stays pure;
  // human consumers also get it on stderr. The branches are intentionally
  // identical (preserving the original code shape) so future divergence is
  // explicit.
  process.stderr.write(`note: \`copillm ${oldCmd}\` is deprecated; use \`copillm ${newCmd}\`\n`);
}
