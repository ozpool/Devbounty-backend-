/**
 * Pure planner for the indexer's next scan window. It has no I/O so every branch
 * is unit-testable.
 *
 * Two log sources with opposite strengths:
 *  - the primary RPC (an authoritative node) always has the newest logs, but its
 *    free tier caps a getLogs call to a tiny block range;
 *  - the backfill RPC (an index such as Envio HyperRPC) serves huge ranges, but
 *    its index can lag the chain tip, so its newest blocks may be missing logs.
 *
 * The planner keeps the backfill source strictly below a tip-safety margin (where
 * it is settled and complete) and scans the tip itself from the authoritative
 * primary source in small steps. That gives fast catch-up after downtime without
 * ever advancing the checkpoint past an event the source had not indexed yet.
 */

export type ScanSource = 'backfill' | 'tip';

export interface ScanPlanInput {
  /** Chain head from the authoritative primary RPC. */
  head: bigint;
  /** Last fully-processed block (the checkpoint). */
  last: bigint;
  /** Reorg buffer: never scan within this many blocks of head. */
  confirmations: bigint;
  /** Blocks below head reserved for the primary source (the backfill index may lag). */
  tipSafety: bigint;
  /** Backfill (large-range) source per-call block span. */
  maxRange: bigint;
  /** Primary source per-call block span near the tip. */
  tipRange: bigint;
  /** Whether a distinct backfill RPC is configured; if not, everything is 'tip'. */
  backfillConfigured: boolean;
}

export interface ScanPlan {
  from: bigint;
  to: bigint;
  source: ScanSource;
  /** True when more remains after this window, so the caller should poll fast. */
  behind: boolean;
}

function minBig(...xs: bigint[]): bigint {
  return xs.reduce((m, x) => (x < m ? x : m));
}

/**
 * Decide the next window to scan, or null when the checkpoint is already caught
 * up to the confirmed head. Guarantees `from <= to` and that `to` never exceeds
 * the confirmed head, so a returned plan is always safe to scan and checkpoint.
 */
export function planScan(i: ScanPlanInput): ScanPlan | null {
  const confirmed = i.head - i.confirmations;
  if (confirmed <= i.last) return null;

  // Highest block the backfill source is trusted for. Clamped at 0 so a chain
  // whose head is below the safety margin (e.g. a fresh local node) just uses the
  // primary source everywhere.
  const settledTop = i.head > i.tipSafety ? i.head - i.tipSafety : 0n;

  let to: bigint;
  let source: ScanSource;
  if (i.backfillConfigured && i.last < settledTop) {
    // Deep, settled range → backfill source, big chunk. `confirmed` in the min is
    // a defensive guard for the odd case tipSafety < confirmations.
    to = minBig(i.last + i.maxRange, settledTop, confirmed);
    source = 'backfill';
  } else {
    // Tip range (or no backfill source) → authoritative primary source, small step.
    to = minBig(i.last + i.tipRange, confirmed);
    source = 'tip';
  }

  return { from: i.last + 1n, to, source, behind: to < confirmed };
}
