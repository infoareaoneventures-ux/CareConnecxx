import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('childcare App Check policy audit', () => {
  it('keeps server policy, exports, client policy, and call sites aligned', () => {
    const output = execFileSync(
      process.execPath,
      [path.resolve('scripts/audit-childcare-app-check.mjs')],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    expect(output).toContain('Childcare App Check audit passed');
    // Timeout: this spawns a child node process that scans the whole tree. It
    // passes in seconds standalone but took 109s under full-shard CPU contention,
    // blowing the previous 90s budget — a false failure that reads exactly like a
    // real policy misalignment. Same class as the pricingLiterals / outboundSeam /
    // firestoreFieldOverrides scan guards.
  }, 300_000);
});
