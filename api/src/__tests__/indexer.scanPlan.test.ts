/**
 * Exhaustive tests for the pure scan planner. They pin the source choice and
 * window bounds across the tricky cases: deep backfill, the tip zone, the
 * boundary between them, no backfill source, tiny chains, and odd configs — the
 * exact logic that, when wrong, silently skips a freshly-mined event.
 */
import { describe, it, expect } from 'vitest';
import { planScan, type ScanPlanInput } from '../indexer/scanPlan.js';

// Sensible defaults; each test overrides what it exercises.
const base: ScanPlanInput = {
  head: 1_000_000n,
  last: 0n,
  confirmations: 5n,
  tipSafety: 300n,
  maxRange: 1000n,
  tipRange: 10n,
  backfillConfigured: true,
};
const plan = (o: Partial<ScanPlanInput>) => planScan({ ...base, ...o });

describe('planScan — nothing to do', () => {
  it('returns null when the checkpoint is at the confirmed head', () => {
    expect(plan({ head: 1000n, confirmations: 5n, last: 995n })).toBeNull();
  });
  it('returns null when the checkpoint is beyond the confirmed head', () => {
    expect(plan({ head: 1000n, confirmations: 5n, last: 999n })).toBeNull();
  });
  it('returns null when only unconfirmed blocks exist above the checkpoint', () => {
    // head-confirmations == last exactly.
    expect(plan({ head: 100n, confirmations: 5n, last: 95n })).toBeNull();
  });
});

describe('planScan — deep backfill', () => {
  it('uses the backfill source in maxRange chunks when far behind', () => {
    const p = plan({ last: 0n, maxRange: 1000n })!;
    expect(p.source).toBe('backfill');
    expect(p.from).toBe(1n);
    expect(p.to).toBe(1000n); // last + maxRange
    expect(p.behind).toBe(true);
  });
  it('stops the backfill window at the tip-safety ceiling', () => {
    // settledTop = head - tipSafety = 999_700; a huge maxRange must not cross it.
    const p = plan({ last: 999_000n, maxRange: 1_000_000n })!;
    expect(p.source).toBe('backfill');
    expect(p.to).toBe(999_700n);
    expect(p.behind).toBe(true); // still below confirmed (999_995)
  });
});

describe('planScan — tip zone (authoritative source)', () => {
  it('switches to the tip source once the checkpoint reaches settledTop', () => {
    // last == settledTop → not "< settledTop" → tip.
    const p = plan({ last: 999_700n, tipRange: 10n })!;
    expect(p.source).toBe('tip');
    expect(p.from).toBe(999_701n);
    expect(p.to).toBe(999_710n); // last + tipRange
    expect(p.behind).toBe(true);
  });
  it('scans up to confirmed and reports caught-up when within one tip step', () => {
    const p = plan({ last: 999_990n, tipRange: 10n })!;
    expect(p.source).toBe('tip');
    expect(p.to).toBe(999_995n); // confirmed = head - confirmations
    expect(p.behind).toBe(false);
  });
});

describe('planScan — no backfill source configured', () => {
  it('always uses the tip source, even with a huge gap', () => {
    const p = plan({ last: 0n, backfillConfigured: false })!;
    expect(p.source).toBe('tip');
    expect(p.to).toBe(10n); // capped by tipRange, not maxRange
    expect(p.behind).toBe(true);
  });
});

describe('planScan — small / edge chains', () => {
  it('uses the tip source when head is below the safety margin', () => {
    // settledTop clamps to 0, so last(0) is never < settledTop.
    const p = plan({ head: 100n, last: 0n, confirmations: 5n, tipSafety: 300n })!;
    expect(p.source).toBe('tip');
    expect(p.to).toBe(10n);
  });
  it('handles zero confirmations', () => {
    const p = plan({
      head: 1000n,
      confirmations: 0n,
      last: 500n,
      tipSafety: 300n,
      maxRange: 1000n,
    })!;
    expect(p.source).toBe('backfill');
    expect(p.to).toBe(700n); // settledTop = 1000 - 300
  });
  it('never scans unconfirmed blocks even when tipSafety < confirmations', () => {
    // confirmed = 500; settledTop = 700 > confirmed. `to` must clamp to confirmed.
    const p = plan({
      head: 1000n,
      confirmations: 500n,
      tipSafety: 300n,
      last: 0n,
      maxRange: 1000n,
    })!;
    expect(p.to).toBe(500n);
    expect(p.behind).toBe(false);
  });
});

describe('planScan — invariants across a wide sweep', () => {
  it('always yields from <= to, to <= confirmed, and from = last + 1', () => {
    const heads = [0n, 50n, 300n, 1000n, 1_000_000n];
    const lasts = [0n, 5n, 299n, 300n, 700n, 999_000n, 999_700n, 999_994n];
    const confs = [0n, 5n, 500n];
    const safeties = [0n, 5n, 300n];
    for (const head of heads)
      for (const last of lasts)
        for (const confirmations of confs)
          for (const tipSafety of safeties)
            for (const backfillConfigured of [true, false]) {
              const p = planScan({
                head,
                last,
                confirmations,
                tipSafety,
                maxRange: 1000n,
                tipRange: 10n,
                backfillConfigured,
              });
              if (p === null) continue;
              const confirmed = head - confirmations;
              expect(p.from).toBe(last + 1n);
              expect(p.to).toBeGreaterThanOrEqual(p.from);
              expect(p.to).toBeLessThanOrEqual(confirmed);
              expect(p.behind).toBe(p.to < confirmed);
              if (p.source === 'tip') expect(p.to).toBeLessThanOrEqual(last + 10n);
            }
  });
});
