import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { type Address } from 'viem';
import { env } from '../shared/config/env.js';
import { connectDb, registerShutdownHandlers } from '../shared/config/db.js';
import { logger } from '../shared/utils/logger.js';
import { initSentry } from '../shared/utils/sentry.js';
import {
  getIndexerReadClient,
  getEscrowAddress,
  isIndexerConfigured,
} from '../shared/chain/clients.js';
import { escrowAbi } from '../shared/chain/escrowAbi.js';
import { reconcileFailedReleases } from '../shared/bounty/settleMerge.js';
import { IndexerStateModel } from '../shared/models/index.js';
import { handleBountyCreated, handleBountyReleased, handleBountyRefunded } from './handlers.js';

const STATE_ID = 'singleton';
const POLL_INTERVAL_MS = 5_000;
// This process's identity for the scan lease, and how long a lease holds before
// it must be renewed (a crashed instance's lease lapses, letting another take over).
const INSTANCE_ID = randomBytes(8).toString('hex');
const LEASE_TTL_MS = 30_000;
const LEASE_RETRY_MS = 10_000;
// Retry stuck releases roughly once a minute, not every poll.
const RECONCILE_EVERY_TICKS = 12;
// When still behind head (the per-call range cap was hit), poll again quickly so
// a small range cap can still keep pace with a fast chain instead of falling
// permanently behind.
const CATCHUP_INTERVAL_MS = 500;
const MAX_RANGE = BigInt(env.INDEXER_MAX_RANGE); // blocks per getLogs call (RPC-tier limited)
const BACKOFF_CAP_MS = 30_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 11000
  );
}

// Acquire or renew the single-scanner lease. Returns true only if THIS instance
// holds it. The conditional upsert matches when the lease is ours, expired, or
// absent; if another live instance holds it the filter misses and the upsert hits
// the unique _id, which we read as "not ours". This enforces the architecture's
// "exactly one indexer" rule in code, not just by operator discipline.
async function holdLease(): Promise<boolean> {
  const now = Date.now();
  try {
    const res = await IndexerStateModel.updateOne(
      {
        _id: STATE_ID,
        $or: [
          { leaseOwner: INSTANCE_ID },
          { leaseExpiresAt: { $lt: new Date(now) } },
          { leaseExpiresAt: { $exists: false } },
        ],
      },
      {
        $set: { leaseOwner: INSTANCE_ID, leaseExpiresAt: new Date(now + LEASE_TTL_MS) },
        $setOnInsert: { lastBlock: env.INDEXER_START_BLOCK },
      },
      { upsert: true },
    );
    return res.matchedCount > 0 || res.upsertedCount > 0;
  } catch (err: unknown) {
    if (isDuplicateKeyError(err)) return false; // another live instance owns the lease
    throw err;
  }
}

async function loadLastBlock(): Promise<bigint> {
  const state = await IndexerStateModel.findById(STATE_ID).lean();
  return BigInt(state?.lastBlock ?? env.INDEXER_START_BLOCK);
}

async function saveLastBlock(block: bigint): Promise<void> {
  // $max, not $set: the checkpoint may only ever move forward. A restarted or
  // (mis)configured second instance writing a lower block can't rewind the
  // cursor and force already-processed ranges to be replayed.
  // NOTE: a single-instance lease is still required before scaling the indexer
  // (the architecture mandates exactly one). Handlers are idempotent today
  // (ReputationEvent insert is unique on txHash, all writes are id-scoped), so a
  // brief overlap is harmless, but two long-running indexers remain unsupported.
  await IndexerStateModel.updateOne(
    { _id: STATE_ID },
    { $max: { lastBlock: Number(block) }, $set: { lastEventAt: new Date() } },
    { upsert: true },
  );
}

async function scanRange(escrow: Address, fromBlock: bigint, toBlock: bigint): Promise<void> {
  const logs = await getIndexerReadClient().getContractEvents({
    address: escrow,
    abi: escrowAbi,
    fromBlock,
    toBlock,
    strict: true, // only fully-decoded logs; gives non-optional, typed args
  });
  for (const log of logs) {
    if (log.blockNumber === null || log.transactionHash === null) continue; // skip pending
    const base = { txHash: log.transactionHash, blockNumber: log.blockNumber };
    if (log.eventName === 'BountyCreated') {
      await handleBountyCreated({ ...log.args, ...base });
    } else if (log.eventName === 'BountyReleased') {
      await handleBountyReleased({ ...log.args, ...base });
    } else if (log.eventName === 'BountyRefunded') {
      await handleBountyRefunded({ ...log.args, ...base });
    }
  }
}

// Advance once: scan the next confirmed, range-capped window and checkpoint it.
// Returns true while still behind the confirmed head (range cap was hit), so the
// caller can poll again immediately instead of waiting a full interval.
async function tick(escrow: Address): Promise<boolean> {
  const head = await getIndexerReadClient().getBlockNumber();
  const confirmed = head - BigInt(env.INDEXER_CONFIRMATIONS);
  const last = await loadLastBlock();
  if (confirmed <= last) return false;
  const capped = last + MAX_RANGE < confirmed;
  const to = capped ? last + MAX_RANGE : confirmed;
  await scanRange(escrow, last + 1n, to);
  await saveLastBlock(to);
  return capped;
}

// The poll loop, shared by the standalone process and the in-process co-host.
// Each iteration takes the lease (yielding to whoever already holds it), advances
// one scan window, and periodically retries stuck releases.
async function runLoop(escrow: Address): Promise<void> {
  let backoff = POLL_INTERVAL_MS;
  let ticks = 0;
  for (;;) {
    try {
      if (!(await holdLease())) {
        // Another instance is the active scanner; wait and try to take over later.
        await sleep(LEASE_RETRY_MS);
        continue;
      }
      const behind = await tick(escrow);
      if (ticks++ % RECONCILE_EVERY_TICKS === 0) await reconcileFailedReleases();
      backoff = POLL_INTERVAL_MS; // healthy poll resets the backoff
      await sleep(behind ? CATCHUP_INTERVAL_MS : POLL_INTERVAL_MS);
    } catch (err: unknown) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'indexer poll failed',
      );
      await sleep(backoff);
      backoff = Math.min(backoff * 2, BACKOFF_CAP_MS);
    }
  }
}

// Standalone entrypoint: owns DB connection + shutdown handlers + Sentry.
export async function startIndexer(): Promise<void> {
  if (!isIndexerConfigured()) {
    logger.warn('Indexer has no ESCROW_ADDRESS configured — nothing to watch, exiting');
    return;
  }
  initSentry(env.SENTRY_DSN);
  await connectDb();
  registerShutdownHandlers();
  const escrow = getEscrowAddress();
  logger.info(
    { escrow, confirmations: env.INDEXER_CONFIRMATIONS, instance: INSTANCE_ID },
    'indexer started',
  );
  await runLoop(escrow);
}

// In-process co-host: runs alongside the API, which already owns the DB
// connection and shutdown handlers. Detached, never awaited by the API. The lease
// still guarantees a single active scanner, so this is safe with one API instance.
export function startIndexerInProcess(): void {
  if (!isIndexerConfigured()) {
    logger.warn('RUN_INDEXER_IN_PROCESS set but no ESCROW_ADDRESS — indexer not started');
    return;
  }
  const escrow = getEscrowAddress();
  logger.info({ escrow, instance: INSTANCE_ID }, 'indexer started in-process');
  void runLoop(escrow).catch((err: unknown) => {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'in-process indexer crashed',
    );
  });
}

// Only run when invoked directly (the entrypoint), not when imported by a test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startIndexer().catch((err: unknown) => {
    logger.error({ err }, 'fatal indexer error');
    process.exit(1);
  });
}
