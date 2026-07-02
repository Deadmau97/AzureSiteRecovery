// Azure SQL Database integration.
//
// Configuration (environment variables — set them in App Service / container):
//   AZURE_SQL_CONNECTION_STRING  — full ADO/ODBC-style connection string, e.g.
//     "Server=tcp:myserver.database.windows.net,1433;Database=azurecalc;User Id=app;Password=...;Encrypt=true"
//   — OR discrete variables —
//   AZURE_SQL_SERVER    (myserver.database.windows.net)
//   AZURE_SQL_DATABASE  (azurecalc)
//   AZURE_SQL_USER
//   AZURE_SQL_PASSWORD
//
// When no configuration is present every helper is a no-op / returns null so the
// app still runs fully in-memory (useful for local development).
//
// Tables (created automatically on first connection):
//   dbo.EstimateConfigs — saved calculator configurations, addressable by a
//                         short share code (https://myfqdn.com/<code>).
//   dbo.PriceCache      — snapshot of the Retail Prices cache per currency so
//                         restarts don't have to re-crawl the API and other
//                         services can consume the same price data.

import sql from 'mssql';
import crypto from 'node:crypto';

let pool = null;
let poolPromise = null;
let schemaReady = false;

export function dbEnabled() {
  return Boolean(
    process.env.AZURE_SQL_CONNECTION_STRING ||
    (process.env.AZURE_SQL_SERVER && process.env.AZURE_SQL_DATABASE &&
     process.env.AZURE_SQL_USER && process.env.AZURE_SQL_PASSWORD)
  );
}

function buildConfig() {
  if (process.env.AZURE_SQL_CONNECTION_STRING) {
    return process.env.AZURE_SQL_CONNECTION_STRING;
  }
  return {
    server: process.env.AZURE_SQL_SERVER,
    database: process.env.AZURE_SQL_DATABASE,
    user: process.env.AZURE_SQL_USER,
    password: process.env.AZURE_SQL_PASSWORD,
    options: {
      encrypt: true,            // required for Azure SQL
      trustServerCertificate: false,
    },
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
    requestTimeout: 60000,
  };
}

export async function getPool() {
  if (!dbEnabled()) return null;
  if (pool) return pool;
  if (!poolPromise) {
    const cfg = buildConfig();
    poolPromise = (typeof cfg === 'string' ? sql.connect(cfg) : new sql.ConnectionPool(cfg).connect())
      .then(async (p) => {
        pool = p;
        pool.on('error', (err) => {
          console.error('[db] pool error:', err.message);
          pool = null;
          poolPromise = null;
        });
        await ensureSchema(pool);
        return pool;
      })
      .catch((err) => {
        poolPromise = null;
        throw err;
      });
  }
  return poolPromise;
}

async function ensureSchema(p) {
  if (schemaReady) return;
  await p.request().batch(`
IF OBJECT_ID('dbo.EstimateConfigs', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.EstimateConfigs (
    Id         INT IDENTITY(1,1) PRIMARY KEY,
    ShortCode  NVARCHAR(16)  NOT NULL,
    Fqdn       NVARCHAR(256) NOT NULL,
    Payload    NVARCHAR(MAX) NOT NULL,
    CreatedAt  DATETIME2     NOT NULL CONSTRAINT DF_EstimateConfigs_CreatedAt DEFAULT SYSUTCDATETIME(),
    UpdatedAt  DATETIME2     NOT NULL CONSTRAINT DF_EstimateConfigs_UpdatedAt DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_EstimateConfigs_ShortCode UNIQUE (ShortCode)
  );
  CREATE INDEX IX_EstimateConfigs_Fqdn ON dbo.EstimateConfigs (Fqdn);
END;

IF OBJECT_ID('dbo.PriceCache', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.PriceCache (
    CacheKey  NVARCHAR(64)  NOT NULL PRIMARY KEY,
    Payload   NVARCHAR(MAX) NOT NULL,
    FetchedAt DATETIME2     NOT NULL CONSTRAINT DF_PriceCache_FetchedAt DEFAULT SYSUTCDATETIME()
  );
END;
`);
  schemaReady = true;
  console.log('[db] schema verified (EstimateConfigs, PriceCache)');
}

// ---------- Saved configurations (share links) ----------

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'; // no 0/O/1/l/I
function generateShortCode(len = 10) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

/**
 * Persist a calculator configuration. Every save creates a new immutable
 * snapshot with its own share code (like the official Azure Pricing Calculator).
 * @returns {Promise<{code: string}>}
 */
export async function saveEstimateConfig(fqdn, payload) {
  const p = await getPool();
  if (!p) throw new Error('Database not configured');
  const json = JSON.stringify(payload);
  // Retry a few times in the (astronomically unlikely) event of a code collision.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateShortCode();
    try {
      await p.request()
        .input('code', sql.NVarChar(16), code)
        .input('fqdn', sql.NVarChar(256), String(fqdn).slice(0, 256))
        .input('payload', sql.NVarChar(sql.MAX), json)
        .query(`INSERT INTO dbo.EstimateConfigs (ShortCode, Fqdn, Payload) VALUES (@code, @fqdn, @payload)`);
      return { code };
    } catch (err) {
      if (err.number === 2627 || err.number === 2601) continue; // unique violation → retry
      throw err;
    }
  }
  throw new Error('Could not generate a unique share code');
}

/** Load a configuration by its share code. Returns null when not found. */
export async function getEstimateConfig(code) {
  const p = await getPool();
  if (!p) throw new Error('Database not configured');
  const r = await p.request()
    .input('code', sql.NVarChar(16), String(code))
    .query(`SELECT TOP 1 ShortCode, Fqdn, Payload, CreatedAt FROM dbo.EstimateConfigs WHERE ShortCode = @code`);
  const row = r.recordset[0];
  if (!row) return null;
  return {
    code: row.ShortCode,
    fqdn: row.Fqdn,
    createdAt: row.CreatedAt,
    config: JSON.parse(row.Payload),
  };
}

/** Search saved configurations by (partial) FQDN, newest first. */
export async function searchEstimateConfigs(fqdn, limit = 25) {
  const p = await getPool();
  if (!p) throw new Error('Database not configured');
  const r = await p.request()
    .input('fqdn', sql.NVarChar(256), `%${String(fqdn).slice(0, 250)}%`)
    .input('limit', sql.Int, Math.min(100, Math.max(1, limit)))
    .query(`
      SELECT TOP (@limit) ShortCode, Fqdn, CreatedAt
      FROM dbo.EstimateConfigs
      WHERE Fqdn LIKE @fqdn
      ORDER BY CreatedAt DESC`);
  return r.recordset.map((row) => ({
    code: row.ShortCode,
    fqdn: row.Fqdn,
    createdAt: row.CreatedAt,
  }));
}

// ---------- Price cache persistence ----------

/** Upsert one price-cache snapshot (key = currency, payload = full cache slot). */
export async function savePriceSnapshot(cacheKey, payload) {
  const p = await getPool();
  if (!p) return false;
  const json = JSON.stringify(payload);
  await p.request()
    .input('key', sql.NVarChar(64), cacheKey)
    .input('payload', sql.NVarChar(sql.MAX), json)
    .query(`
MERGE dbo.PriceCache AS t
USING (SELECT @key AS CacheKey) AS s ON t.CacheKey = s.CacheKey
WHEN MATCHED THEN UPDATE SET Payload = @payload, FetchedAt = SYSUTCDATETIME()
WHEN NOT MATCHED THEN INSERT (CacheKey, Payload, FetchedAt) VALUES (@key, @payload, SYSUTCDATETIME());`);
  return true;
}

/** Load one snapshot. Returns { payload, fetchedAt } or null. */
export async function loadPriceSnapshot(cacheKey) {
  const p = await getPool();
  if (!p) return null;
  const r = await p.request()
    .input('key', sql.NVarChar(64), cacheKey)
    .query(`SELECT Payload, FetchedAt FROM dbo.PriceCache WHERE CacheKey = @key`);
  const row = r.recordset[0];
  if (!row) return null;
  return { payload: JSON.parse(row.Payload), fetchedAt: row.FetchedAt };
}
