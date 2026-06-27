import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";

export type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

function createDb(databaseUrl: string): DrizzleDb {
  // Disable SSL for local connections; enforce it for everything else
  // (RDS, ElephantSQL, Supabase, etc. all require SSL in prod)
  const isLocal =
    databaseUrl.includes("localhost") ||
    databaseUrl.includes("127.0.0.1") ||
    databaseUrl.includes("host.docker.internal");

  const sql = postgres(databaseUrl, {
    ssl: isLocal ? false : { rejectUnauthorized: true },
    max: 10,               // connection pool ceiling
    idle_timeout: 30,      // release idle connections after 30s
    connect_timeout: 10,   // fail fast if DB unreachable
    onnotice: () => {},    // suppress NOTICE messages in logs
  });

  return drizzle(sql, { schema });
}

// Build a postgres:// URL from individual ECS-injected env vars (ECS secret
// injection pulls individual JSON fields from the RDS-generated secret).
// Falls back to DATABASE_URL for local dev.
function resolveOpsUrl(): string | null {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const host = process.env.DB_OPS_HOST;
  const port = process.env.DB_OPS_PORT ?? "5432";
  const user = process.env.DB_OPS_USER;
  const pass = process.env.DB_OPS_PASSWORD;
  const db   = process.env.DB_OPS_DB ?? "maximal_ops";
  if (host && user && pass) {
    return `postgres://${user}:${encodeURIComponent(pass)}@${host}:${port}/${db}`;
  }
  return null;
}

let _db: DrizzleDb | null = null;

export function getDb(): DrizzleDb | null {
  if (_db) return _db;
  const url = resolveOpsUrl();
  if (!url) return null;
  _db = createDb(url);
  return _db;
}

// Used in tests or when you need a fresh connection to a specific DB
export function createTestDb(databaseUrl: string): DrizzleDb {
  return createDb(databaseUrl);
}
