// Return a copy of a tools array with a prompt-cache breakpoint on the LAST
// tool, so the (large, per-turn-stable) tool schemas are cached alongside the
// system prompt instead of being re-tokenized on every tool-loop iteration.
// With ~88 tools cycled up to 5x per turn, this is the single biggest per-turn
// cost/latency win in the loop. Returns the input unchanged when empty and
// never mutates the shared tools array.
export function withToolsCacheControl<T extends object>(tools: T[]): T[] {
  if (tools.length === 0) return tools;
  const last = tools[tools.length - 1];
  return [...tools.slice(0, -1), { ...last, cache_control: { type: "ephemeral" } }];
}
