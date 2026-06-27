import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./app-schema.js";

export type AppDb = ReturnType<typeof drizzle<typeof schema>>;

function createAppDb(databaseUrl: string): AppDb {
  const isLocal =
    databaseUrl.includes("localhost") ||
    databaseUrl.includes("127.0.0.1") ||
    databaseUrl.includes("host.docker.internal");

  const sql = postgres(databaseUrl, {
    ssl: isLocal ? false : { rejectUnauthorized: true },
    max: 5,
    idle_timeout: 30,
    connect_timeout: 10,
    onnotice: () => {},
  });

  return drizzle(sql, { schema });
}

function resolveAppUrl(): string | null {
  if (process.env.APP_DATABASE_URL) return process.env.APP_DATABASE_URL;
  const host = process.env.DB_APP_HOST;
  const port = process.env.DB_APP_PORT ?? "5432";
  const user = process.env.DB_APP_USER;
  const pass = process.env.DB_APP_PASSWORD;
  const db   = process.env.DB_APP_DB ?? "maximal_app";
  if (host && user && pass) {
    return `postgres://${user}:${encodeURIComponent(pass)}@${host}:${port}/${db}`;
  }
  return null;
}

let _appDb: AppDb | null = null;

export function getAppDb(): AppDb | null {
  if (_appDb) return _appDb;
  const url = resolveAppUrl();
  if (!url) return null;
  _appDb = createAppDb(url);
  return _appDb;
}
