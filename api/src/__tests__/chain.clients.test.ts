/**
 * The indexer reads historical logs through a client separate from the primary
 * one, so it can point at an RPC that serves large getLogs ranges (e.g. Envio
 * HyperRPC) without touching the on-chain write/state path. These tests pin that
 * selection: the indexer client honours INDEXER_RPC_URL and falls back to
 * RPC_URL_HTTP, while the primary client always stays on RPC_URL_HTTP.
 */
import { describe, it, expect, vi } from 'vitest';

const PRIMARY = 'https://primary.example/rpc';
const INDEXER = 'https://arbitrum-sepolia.rpc.hypersync.xyz/test-token';

// Re-import clients.js with a fresh env each time so INDEXER_RPC_URL changes take
// effect (env is read and frozen at module load; the client is a cached singleton).
async function loadClients(indexerRpc?: string) {
  vi.resetModules();
  process.env['NODE_ENV'] = 'test';
  process.env['LOG_LEVEL'] = 'fatal';
  process.env['CORS_ORIGIN'] = 'http://localhost:3000';
  process.env['API_PUBLIC_BASE_URL'] = 'http://localhost:4000';
  process.env['INTERNAL_HEALTH_TOKEN'] = 'test-internal-token';
  process.env['RPC_URL_HTTP'] = PRIMARY;
  if (indexerRpc === undefined) delete process.env['INDEXER_RPC_URL'];
  else process.env['INDEXER_RPC_URL'] = indexerRpc;
  return import('../shared/chain/clients.js');
}

// The url passed to buildChain() surfaces as the chain's default http RPC, and is
// the same url handed to the http() transport — so asserting it proves routing.
function rpcOf(client: { chain?: { rpcUrls: { default: { http: readonly string[] } } } }) {
  return client.chain?.rpcUrls.default.http[0];
}

describe('getIndexerReadClient', () => {
  it('uses INDEXER_RPC_URL when set', async () => {
    const { getIndexerReadClient } = await loadClients(INDEXER);
    expect(rpcOf(getIndexerReadClient())).toBe(INDEXER);
  });

  it('falls back to RPC_URL_HTTP when INDEXER_RPC_URL is unset', async () => {
    const { getIndexerReadClient } = await loadClients(undefined);
    expect(rpcOf(getIndexerReadClient())).toBe(PRIMARY);
  });

  it('keeps the primary client (writes/state) on RPC_URL_HTTP even when the indexer RPC differs', async () => {
    const { getPublicClient, getIndexerReadClient } = await loadClients(INDEXER);
    expect(rpcOf(getPublicClient())).toBe(PRIMARY);
    expect(rpcOf(getIndexerReadClient())).toBe(INDEXER);
  });
});
