import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { AwsAdapter, MockAwsAdapter, type AwsAdapterInterface } from "./actions.js";
import type { AppDb } from "./db/app-client.js";
import { connectors } from "./db/app-schema.js";
import { eq, and } from "drizzle-orm";

interface CachedCredentials {
  adapter: AwsAdapterInterface;
  expiresAt: number; // epoch ms
}

// In-memory cache of resolved adapters keyed by tenantId.
// Credentials from AssumeRole last up to 1 hour; we evict at 55 minutes to
// guarantee we never hand out near-expiry creds to a long-running action.
const TTL_MS = 55 * 60 * 1000;
const cache = new Map<string, CachedCredentials>();

export function evictTenant(tenantId: string): void {
  cache.delete(tenantId);
}

// Resolve the AWS adapter for a tenant. Priority:
//   1. Cached live credentials (not yet expired)
//   2. Active iam_role connector in appDb → AssumeRole → AwsAdapter
//   3. Env-var-backed AwsAdapter (same path as single-tenant mode)
//   4. MockAwsAdapter (no credentials configured at all)
export async function resolveAdapterForTenant(
  tenantId: string,
  appDb: AppDb | null,
): Promise<AwsAdapterInterface> {
  const cached = cache.get(tenantId);
  if (cached && Date.now() < cached.expiresAt) return cached.adapter;

  if (appDb) {
    const [connector] = await appDb
      .select()
      .from(connectors)
      .where(and(eq(connectors.tenantId, tenantId), eq(connectors.isActive, true)))
      .limit(1);

    if (connector?.type === "iam_role" && connector.roleArn) {
      const sts = new STSClient({ region: connector.region });
      const assumed = await sts.send(
        new AssumeRoleCommand({
          RoleArn: connector.roleArn,
          RoleSessionName: `maximal-${tenantId.slice(0, 8)}`,
          DurationSeconds: 3600,
          ...(connector.externalId ? { ExternalId: connector.externalId } : {}),
        })
      );
      if (assumed.Credentials?.AccessKeyId && assumed.Credentials?.SecretAccessKey) {
        const credentials = {
          accessKeyId: assumed.Credentials.AccessKeyId,
          secretAccessKey: assumed.Credentials.SecretAccessKey,
          ...(assumed.Credentials.SessionToken
            ? { sessionToken: assumed.Credentials.SessionToken }
            : {}),
        };
        const adapter = new AwsAdapter(connector.region, credentials);
        cache.set(tenantId, { adapter, expiresAt: Date.now() + TTL_MS });
        return adapter;
      }
    }
  }

  // Fallback: env-var credentials (standard SDK credential chain)
  const awsConfigured = Boolean(
    process.env.AWS_ACCESS_KEY_ID ||
    process.env.AWS_PROFILE ||
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI,
  );
  const adapter = awsConfigured
    ? new AwsAdapter(process.env.AWS_REGION ?? "us-east-1")
    : new MockAwsAdapter();
  return adapter;
}
