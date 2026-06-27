import type { Config } from "drizzle-kit";

export default {
  schema: "./src/db/app-schema.ts",
  out: "./drizzle/app-migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.APP_DATABASE_URL!,
  },
} satisfies Config;
