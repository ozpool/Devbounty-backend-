import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  isAddress,
  getAddress,
  parseEventLogs,
  type Address,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { env } from '../config/env.js';
import { escrowAbi } from './escrowAbi.js';

// Built from CHAIN_ID/RPC rather than a hardcoded chain so the same code runs
// against Arbitrum Sepolia and a local node. The url defaults to the primary
// RPC but can be overridden (the indexer reads from a separate endpoint).
function buildChain(url: string = env.RPC_URL_HTTP) {
  return defineChain({
    id: env.CHAIN_ID,
    name: `chain-${env.CHAIN_ID}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [url] } },
  });
}

let publicClient: PublicClient | undefined;
export function getPublicClient(): PublicClient {
  if (!publicClient) {
    publicClient = createPublicClient({ chain: buildChain(), transport: http(env.RPC_URL_HTTP) });
  }
  return publicClient;
}

// A read-only client for the indexer's historical scans, kept separate from the
// primary client so it can point at an RPC (e.g. Envio HyperRPC) that serves the
// large getLogs ranges free public tiers cap hard — without affecting on-chain
// writes/state reads. Falls back to RPC_URL_HTTP when INDEXER_RPC_URL is unset.
let indexerReadClient: PublicClient | undefined;
export function getIndexerReadClient(): PublicClient {
  if (!indexerReadClient) {
    const url = env.INDEXER_RPC_URL || env.RPC_URL_HTTP;
    indexerReadClient = createPublicClient({ chain: buildChain(url), transport: http(url) });
  }
  return indexerReadClient;
}

/** True when a distinct backfill RPC is set, so the indexer can use it for deep
 * ranges. When false, getIndexerReadClient() is just the primary RPC. */
export function isBackfillRpcConfigured(): boolean {
  return Boolean(env.INDEXER_RPC_URL);
}

/** The deployed escrow address, validated. Throws if unset/malformed. */
export function getEscrowAddress(): Address {
  const raw = env.ESCROW_ADDRESS;
  if (!raw || !isAddress(raw)) {
    throw new Error('ESCROW_ADDRESS is not set to a valid address');
  }
  return getAddress(raw);
}

let walletAccount: PrivateKeyAccount | undefined;
function getWalletAccount(): PrivateKeyAccount {
  if (!walletAccount) {
    const key = env.BACKEND_PRIVATE_KEY;
    if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
      throw new Error('BACKEND_PRIVATE_KEY is not set to a 32-byte hex key');
    }
    walletAccount = privateKeyToAccount(key as `0x${string}`);
  }
  return walletAccount;
}

let walletClient: WalletClient | undefined;
export function getWalletClient(): WalletClient {
  if (!walletClient) {
    walletClient = createWalletClient({
      account: getWalletAccount(),
      chain: buildChain(),
      transport: http(env.RPC_URL_HTTP),
    });
  }
  return walletClient;
}

// Mirror of the contract's Status enum order: None=0, Open=1, Paid=2, Refunded=3.
export const ON_CHAIN_STATUS_NONE = 0;
export const ON_CHAIN_STATUS_PAID = 2;

/**
 * Read a bounty's on-chain escrow status (the `bounties` mapping's `status`
 * field). Returns 0 (None) when the bounty was never funded. Used to verify a
 * bounty really is unfunded before a destructive off-chain action like cancel,
 * since the off-chain record can lag the chain.
 */
export async function getOnChainBountyStatus(bountyId: `0x${string}`): Promise<number> {
  const result = await getPublicClient().readContract({
    address: getEscrowAddress(),
    abi: escrowAbi,
    functionName: 'bounties',
    args: [bountyId],
  });
  // Outputs: [maintainer, amount, createdAt, refundWindow, status]
  return Number((result as readonly unknown[])[4]);
}

/**
 * Confirm a transaction the client claims happened on the escrow really did, for
 * the specific bounty, before we trust it off-chain. The receipt must exist, have
 * succeeded, target the escrow, AND contain the named event (BountyCreated /
 * BountyRefunded) carrying this bounty id. Returns false (never throws) for a
 * missing/failed/unrelated/wrong-bounty tx so the caller can reject a bogus hash.
 * Only meaningful when an escrow is configured; callers gate on isIndexerConfigured().
 */
export async function verifyEscrowEventTx(
  txHash: `0x${string}`,
  eventName: 'BountyCreated' | 'BountyRefunded',
  bountyId: string,
): Promise<boolean> {
  try {
    const receipt = await getPublicClient().getTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success' || !receipt.to) return false;
    if (getAddress(receipt.to) !== getEscrowAddress()) return false;
    const events = parseEventLogs({ abi: escrowAbi, eventName, logs: receipt.logs });
    const target = bountyId.toLowerCase();
    return events.some((e) => {
      const id = (e.args as { id?: string }).id;
      return typeof id === 'string' && id.toLowerCase() === target;
    });
  } catch {
    // Not mined yet, unknown hash, or RPC error — treat as unverifiable.
    return false;
  }
}

/** True when both a signer and an escrow address are configured for releasing. */
export function isPayoutConfigured(): boolean {
  return (
    Boolean(env.BACKEND_PRIVATE_KEY) &&
    Boolean(env.ESCROW_ADDRESS) &&
    isAddress(env.ESCROW_ADDRESS ?? '')
  );
}

/** True when the indexer has an escrow address to watch. */
export function isIndexerConfigured(): boolean {
  return Boolean(env.ESCROW_ADDRESS) && isAddress(env.ESCROW_ADDRESS ?? '');
}
