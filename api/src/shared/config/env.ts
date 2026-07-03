// THIS IS THE ONLY FILE ALLOWED TO READ process.env
import { z } from 'zod';

const nodeEnvValues = ['development', 'test', 'production'] as const;

// In test mode many external services aren't available, so we provide safe
// defaults so modules can be imported without a full .env file.
const isTest = process.env['NODE_ENV'] === 'test';

function requiredInProd(fallback: string) {
  return isTest ? z.string().default(fallback) : z.string().min(1);
}

// Secrets must meet a minimum length in production so a weak/placeholder value
// can never ship. In test the fallback is used as-is.
function secretInProd(minLength: number, fallback: string) {
  return isTest ? z.string().default(fallback) : z.string().min(minLength);
}

// The schema is split into per-domain slices so a feature PR only touches its
// own slice (auth, chain, github, ...) instead of editing one monolithic object.
// Add a new domain by defining a slice below and merging it into `schema`.

const runtimeEnv = z.object({
  NODE_ENV: z.enum(nodeEnvValues).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  PORT: z.coerce.number().int().positive().default(4000),
});

const databaseEnv = z.object({
  // Required in production, defaulted in test.
  MONGO_URI: requiredInProd('mongodb://localhost:27017/devbounty_test'),
});

const authEnv = z.object({
  // HS256 signing key — at least 32 chars of entropy in production.
  JWT_SECRET: secretInProd(32, 'test-jwt-secret-not-for-production'),
  JWT_COOKIE_NAME: z.string().default('devbounty_jwt'),
  JWT_TTL: z.string().default('7d'), // session lifetime, e.g. 7d / 12h / 3600
});

const chainEnv = z.object({
  // No hardcoded addresses here; they come from env.
  CHAIN_ID: z.coerce.number().int().positive().default(421614),
  RPC_URL_HTTP: requiredInProd('http://localhost:8545'),
  RPC_URL_HTTP_FALLBACK: z.string().optional(),
  // Dedicated RPC for the indexer's historical log reads (e.g. Envio HyperRPC,
  // which serves large getLogs ranges that free public tiers cap hard). Only the
  // indexer's head-block and getContractEvents calls use it; all on-chain writes
  // and state reads stay on RPC_URL_HTTP. Unset → the indexer reuses RPC_URL_HTTP.
  INDEXER_RPC_URL: z.string().optional(),
  // The deployed BountyEscrow address. Optional until a deploy exists; payout
  // and the indexer are inert without it.
  ESCROW_ADDRESS: z.string().optional(),
  // Backend hot-wallet key that signs release() txs (testnet custody is an env
  // key; production moves to a KMS/HSM). Optional: absent disables on-chain payout.
  BACKEND_PRIVATE_KEY: z.string().optional(),
  // Reorg buffer: the indexer only processes events this many blocks behind head.
  INDEXER_CONFIRMATIONS: z.coerce.number().int().nonnegative().default(5),
  // Max blocks per getLogs call on the backfill source (INDEXER_RPC_URL). This
  // is the large-range path used for deep catch-up; the primary RPC uses
  // INDEXER_TIP_RANGE near the tip instead.
  INDEXER_MAX_RANGE: z.coerce.number().int().positive().default(2000),
  // Blocks below head reserved for the authoritative primary RPC. The backfill
  // index can lag the chain tip, so it is only used at or below head - this,
  // where its data is settled. Should be >= INDEXER_CONFIRMATIONS.
  INDEXER_TIP_SAFETY: z.coerce.number().int().nonnegative().default(300),
  // Per-call getLogs range for tip scans on the primary RPC, whose free tier
  // caps it hard (Arbitrum Sepolia + Alchemy free = 10 blocks).
  INDEXER_TIP_RANGE: z.coerce.number().int().positive().default(10),
  // First block to scan on a cold start (the escrow's deploy block).
  INDEXER_START_BLOCK: z.coerce.number().int().nonnegative().default(0),
  // Health marks the indexer stale once its checkpoint heartbeat is older than
  // this. The indexer is a separate singleton process, so this is reported by the
  // API's health endpoint but never gates the API's own readiness.
  INDEXER_STALE_AFTER_MS: z.coerce.number().int().positive().default(60_000),
  // Run the indexer loop inside the API process instead of as its own service.
  // Lets a single-instance free-tier deploy index without a paid worker. A DB
  // lease still guarantees only one loop scans, so this is safe to leave on as
  // long as the API runs a single instance; turn OFF before scaling horizontally.
  RUN_INDEXER_IN_PROCESS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

const servicesEnv = z.object({
  // Bearer token for /health/internal — at least 16 chars in production.
  INTERNAL_HEALTH_TOKEN: secretInProd(16, 'test-internal-token'),
  // Public base URL of THIS backend (used to build webhook + OAuth callback URLs).
  API_PUBLIC_BASE_URL: requiredInProd('http://localhost:4000'),
  // Strict CORS origin — the web frontend origin. Also the SIWE domain. This is a
  // security allowlist value; do not reuse it as a redirect target.
  CORS_ORIGIN: requiredInProd('http://localhost:3000'),
  // Frontend app base URL — where the browser is sent back after a flow completes
  // (e.g. the post-OAuth landing). Kept separate from CORS_ORIGIN so the landing
  // target can differ from the CORS allowlist without coupling the two.
  APP_BASE_URL: requiredInProd('http://localhost:3000'),
});

const monitoringEnv = z.object({
  // Optional; Sentry is a no-op when absent.
  SENTRY_DSN: z.string().optional(),
});

const rateLimitEnv = z.object({
  // Auth endpoints are the cheapest to abuse (nonce/verify spam, credential
  // probing), so they get the tighter cap, keyed by client IP.
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_AUTH_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  // State-changing routes are capped per authenticated wallet (falling back to
  // IP when unauthenticated) so one signed-in user cannot flood writes.
  RATE_LIMIT_MUTATION_MAX: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_MUTATION_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
});

const encryptionEnv = z.object({
  // Encryption at rest for tokens/secrets (AES-256-GCM). Keys are 32-byte values
  // in hex. Versioning enables rotation: new writes use the active version; old
  // blobs decrypt by the version stored alongside them.
  ENC_ACTIVE_KEY_VERSION: z.string().default('v1'),
  ENC_KEY_V1: requiredInProd('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'),
  ENC_KEY_V2: z.string().optional(),
});

const githubEnv = z.object({
  // GitHub OAuth app credentials for account linking.
  GITHUB_OAUTH_CLIENT_ID: requiredInProd('test-github-client-id'),
  GITHUB_OAUTH_CLIENT_SECRET: requiredInProd('test-github-client-secret'),
  GITHUB_OAUTH_SCOPES: z.string().default('read:user repo'),
  // Explicit OAuth callback URL. Must match the OAuth app's registered callback
  // EXACTLY (GitHub rejects any mismatch). Optional: when absent it falls back to
  // <API_PUBLIC_BASE_URL>/auth/github/callback.
  GITHUB_OAUTH_CALLBACK_URL: z.string().optional(),
});

const schema = runtimeEnv
  .merge(databaseEnv)
  .merge(authEnv)
  .merge(chainEnv)
  .merge(servicesEnv)
  .merge(monitoringEnv)
  .merge(encryptionEnv)
  .merge(githubEnv)
  .merge(rateLimitEnv);

export type Env = z.infer<typeof schema>;

/**
 * Parse a raw env object. Exported for unit testing with fake inputs.
 * Throws ZodError on invalid input — callers decide how to handle.
 */
export function parseEnv(raw: Record<string, string | undefined>): Env {
  return schema.parse(raw);
}

function loadEnv(): Readonly<Env> {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    // Use process.stderr directly — logger depends on env, can't use it here
    process.stderr.write(`[env] Invalid environment configuration:\n${result.error.toString()}\n`);
    process.exit(1);
  }
  return Object.freeze(result.data);
}

export const env: Readonly<Env> = loadEnv();
