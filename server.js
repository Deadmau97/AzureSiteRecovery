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

import { REGIONS, CURRENCIES, warmCache, getStatus } from './src/prices.js';
import { listTiers, DISK_FAMILIES } from './src/diskTiers.js';
import { parseRvtoolsBuffer } from './src/rvtools.js';
import { recommendVms, searchVms } from './src/recommender.js';
import { estimateProject } from './src/estimator.js';
import { findDiskPrice, findAsrPrice } from './src/prices.js';

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

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

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

app.post('/api/refresh-prices', async (req, res) => {
  // Fire-and-forget; client polls /api/status
  warmCache().catch((e) => console.error('refresh error', e));
  res.json({ started: true });
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[asr-estimator] listening on http://localhost:${PORT}`);
  console.log('[asr-estimator] warming Azure Retail Prices cache...');
  warmCache().catch((e) => console.error('warm error', e));
});
