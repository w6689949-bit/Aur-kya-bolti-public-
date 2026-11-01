import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as schema from "./schema";

const { Pool } = pg;

// Prefer the external Aiven database, while retaining compatibility
// with deployments that still use DATABASE_URL.
const rawDatabaseUrl =
  process.env.EXTERNAL_DATABASE_URL ?? process.env.DATABASE_URL;

if (!rawDatabaseUrl) {
  throw new Error(
    "EXTERNAL_DATABASE_URL or DATABASE_URL must be set.",
  );
}

// Use the Aiven CA certificate bundled at lib/db/ca.pem.
// Keep certificate verification enabled.
const aivenCa = readFileSync(resolve(process.cwd(), "lib/db/ca.pem"), "utf8");

// Explicit SSL settings are supplied here, so remove URL SSL parameters
// that could override the CA-based configuration.
const databaseUrl = new URL(rawDatabaseUrl);
databaseUrl.searchParams.delete("sslmode");
databaseUrl.searchParams.delete("sslrootcert");

export const pool = new Pool({
  connectionString: databaseUrl.toString(),
  ssl: {
    ca: aivenCa,
    rejectUnauthorized: true,
  },
});

export const db = drizzle(pool, { schema });

export * from "./schema";
