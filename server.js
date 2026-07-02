// Express server for the ASR estimator.
// Routes:
//   GET  /api/status                 — price cache state
//   GET  /api/regions                — region list
//   GET  /api/currencies             — supported currencies
//   GET  /api/disk-tiers?family=...  — disk tier table
//   POST /api/upload (multipart)     — RVTools upload → parsed VMs
//   GET  /api/vm-search?q=...        — VM catalog search
//   POST /api/recommend              — { vcpu, ramGiB } → top recommendations
//   POST /api/estimate               — full project → cost breakdown
//   POST /api/refresh-prices         — force re-warm

import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { REGIONS, CURRENCIES, warmCache, getStatus, hydrateCacheFromDb } from './src/prices.js';
import { listTiers, DISK_FAMILIES } from './src/diskTiers.js';
import { parseRvtoolsBuffer } from './src/rvtools.js';
import { recommendVms, searchVms } from './src/recommender.js';
import { estimateProject } from './src/estimator.js';
import { estimateAzure } from './src/azureEstimator.js';
import {
  dbEnabled,
  saveEstimateConfig,
  getEstimateConfig,
  searchEstimateConfigs,
} from './src/db.js';
import {
  findDiskPrice,
  findAsrPrice,
  listVpnGatewaySkus,
  listAppServicePlanSkus,
  listNatGatewaySkus,
  listPublicIpSkus,
} from './src/prices.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ limits: { fileSize: 50 * 1024 * 1024 } });

app.use(express.json({ limit: '5mb' }));

// Explicit routes for the landing page and the ASR app, then static middleware for
// every shared asset (styles.css, app.js, etc.).
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});
app.get(['/asr', '/asr/'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get(['/azure', '/azure/'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'azure.html'));
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));
// Serve the SVG icon library at /icons/<category>/<file>.svg so the frontend can
// reference official Azure service icons directly.
app.use('/icons', express.static(path.join(__dirname, 'Icons'), { maxAge: '7d' }));

app.get('/api/status', (req, res) => {
  res.json(getStatus());
});

app.get('/api/regions', (req, res) => {
  res.json(REGIONS);
});

app.get('/api/currencies', (req, res) => {
  res.json(CURRENCIES);
});

app.get('/api/disk-tiers', (req, res) => {
  const family = req.query.family || 'Premium SSD';
  if (!DISK_FAMILIES.includes(family)) return res.status(400).json({ error: 'Unknown family' });
  res.json(listTiers(family));
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file' });
    const result = parseRvtoolsBuffer(req.file.buffer, req.file.originalname);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/vm-search', (req, res) => {
  const q = req.query.q || '';
  const includeSpecialty = req.query.includeSpecialty !== 'false';
  res.json(searchVms(q, { includeSpecialty }));
});

app.post('/api/recommend', (req, res) => {
  const { vcpu, ramGiB } = req.body || {};
  if (vcpu == null || ramGiB == null) return res.status(400).json({ error: 'vcpu and ramGiB required' });
  res.json(recommendVms({ vcpu: Number(vcpu), ramGiB: Number(ramGiB) }));
});

app.post('/api/estimate', (req, res) => {
  try {
    const result = estimateProject(req.body || {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/azure/estimate', (req, res) => {
  try {
    const result = estimateAzure(req.body || {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/refresh-prices', async (req, res) => {
  // Fire-and-forget; client polls /api/status
  warmCache().catch((e) => console.error('refresh error', e));
  res.json({ started: true });
});

// SKU listers for the Azure Calculator's service catalog. The frontend uses these
// to populate dropdowns for VPN Gateway and App Service Plan when the user adds
// the corresponding row.
app.get('/api/azure/vpn-skus', (req, res) => {
  const { region, currency } = req.query;
  if (!region) return res.status(400).json({ error: 'region is required' });
  res.json(listVpnGatewaySkus(currency || 'EUR', region));
});

app.get('/api/azure/appservice-skus', (req, res) => {
  const { region, currency } = req.query;
  if (!region) return res.status(400).json({ error: 'region is required' });
  res.json(listAppServicePlanSkus(currency || 'EUR', region));
});

app.get('/api/azure/nat-skus', (req, res) => {
  const { currency } = req.query;
  // NAT Gateway prices are not regional; they are published as armRegionName='Global'.
  res.json(listNatGatewaySkus(currency || 'EUR'));
});

app.get('/api/azure/publicip-skus', (req, res) => {
  const { region, currency } = req.query;
  if (!region) return res.status(400).json({ error: 'region is required' });
  res.json(listPublicIpSkus(currency || 'EUR', region));
});

// Debug: resolved monthly price for every disk tier in a region.
// Use it to sanity-check that prices increase with size (E1 < E2 < E3 < ...).
app.get('/api/disk-prices', (req, res) => {
  const { region, family, currency } = req.query;
  const cur = currency || 'EUR';
  const fam = family || 'Standard SSD';
  const reg = region;
  if (!reg) return res.status(400).json({ error: 'region query parameter is required' });
  if (!DISK_FAMILIES.includes(fam)) return res.status(400).json({ error: 'Unknown family' });
  const tiers = listTiers(fam);
  const rows = tiers.map((t) => {
    const p = findDiskPrice(cur, reg, fam, t.sku);
    return {
      sku: t.sku,
      sizeGiB: t.sizeGiB,
      family: fam,
      retailPrice: p?.retailPrice ?? null,
      unitOfMeasure: p?.unitOfMeasure ?? null,
      meterName: p?.meterName ?? null,
      currency: cur,
    };
  });
  res.json({ region: reg, family: fam, currency: cur, rows });
});

// Debug: resolved ASR price (and the raw matching meter) for a region/scenario/currency.
app.get('/api/asr-price', (req, res) => {
  const region = req.query.region;
  const scenario = req.query.scenario || 'onprem';
  const currency = req.query.currency || 'EUR';
  if (!region) return res.status(400).json({ error: 'region query parameter is required' });
  const hit = findAsrPrice(currency, region, scenario);
  res.json({ region, scenario, currency, hit });
});

// ---------- Saved configurations (Azure SQL) ----------
// Mimics the official Azure Pricing Calculator share flow: saving returns a
// short code; https://<host>/<code> reopens the exact configuration.

function requireDb(res) {
  if (!dbEnabled()) {
    res.status(503).json({ error: 'Azure SQL Database is not configured. Set AZURE_SQL_CONNECTION_STRING (or AZURE_SQL_SERVER/DATABASE/USER/PASSWORD).' });
    return false;
  }
  return true;
}

app.post('/api/configs', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const { fqdn, config } = req.body || {};
    if (!fqdn || typeof fqdn !== 'string' || !fqdn.trim()) {
      return res.status(400).json({ error: 'fqdn (project name) is required' });
    }
    if (!config || !Array.isArray(config.rows)) {
      return res.status(400).json({ error: 'config with a rows array is required' });
    }
    const { code } = await saveEstimateConfig(fqdn.trim().toLowerCase(), config);
    res.json({ code, path: `/${code}` });
  } catch (err) {
    console.error('[configs] save error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/configs/search', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const fqdn = String(req.query.fqdn || '').trim();
    if (!fqdn) return res.status(400).json({ error: 'fqdn query parameter is required' });
    res.json(await searchEstimateConfigs(fqdn));
  } catch (err) {
    console.error('[configs] search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/configs/:code', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const hit = await getEstimateConfig(req.params.code);
    if (!hit) return res.status(404).json({ error: 'Configuration not found' });
    res.json(hit);
  } catch (err) {
    console.error('[configs] load error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Share-link entry point: /<code> (10 base-62 chars) serves the calculator,
// which reads the code from location.pathname and loads the saved config.
app.get('/:code([A-HJ-NP-Za-km-z2-9]{10})', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'azure.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`[asr-estimator] listening on http://localhost:${PORT}`);
  // Prefer hydrating the price cache from Azure SQL — a fresh snapshot means we
  // can skip the multi-minute Retail Prices crawl entirely. Fall back to the
  // API when the DB is absent, empty, or stale.
  try {
    const fresh = await hydrateCacheFromDb();
    if (fresh) {
      console.log('[asr-estimator] price cache hydrated from Azure SQL — skipping API crawl');
      return;
    }
  } catch (e) {
    console.error('[asr-estimator] hydrate error:', e.message);
  }
  console.log('[asr-estimator] warming Azure Retail Prices cache...');
  warmCache().catch((e) => console.error('warm error', e));
});
