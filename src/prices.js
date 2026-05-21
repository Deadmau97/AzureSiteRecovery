// Azure Retail Prices API client + in-memory cache.
// Docs: https://learn.microsoft.com/rest/api/cost-management/retail-prices/azure-retail-prices

const BASE = 'https://prices.azure.com/api/retail/prices';
const API_VERSION = '2023-01-01-preview';

export const REGIONS = [
  { armRegionName: 'westeurope', displayName: 'West Europe' },
  { armRegionName: 'northeurope', displayName: 'North Europe' },
  { armRegionName: 'italynorth', displayName: 'Italy North' },
  { armRegionName: 'francecentral', displayName: 'France Central' },
  { armRegionName: 'swedencentral', displayName: 'Sweden Central' },
  { armRegionName: 'germanywestcentral', displayName: 'Germany West Central' },
];

export const CURRENCIES = ['EUR', 'USD'];

const HOURS_PER_MONTH = 730;

async function fetchAllPages(filter, currencyCode, { pageLimit = 50 } = {}) {
  const items = [];
  let url = `${BASE}?api-version=${API_VERSION}&currencyCode=${currencyCode}&$filter=${encodeURIComponent(filter)}`;
  let pages = 0;
  while (url && pages < pageLimit) {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Retail Prices API ${res.status} ${res.statusText} for filter: ${filter}`);
    }
    const data = await res.json();
    if (Array.isArray(data.Items)) items.push(...data.Items);
    url = data.NextPageLink || null;
    pages += 1;
  }
  return items;
}

function regionOr(regions) {
  return regions.map((r) => `armRegionName eq '${r.armRegionName}'`).join(' or ');
}

// ---------- Cache shape ----------
// cache[currency] = {
//   asr:        Item[],
//   disks:      Item[],
//   vms:        Item[],
//   cacheStore: Item[],
//   publicIp:   Item[],
//   updatedAt:  Date,
// }

const cache = {};
let lastError = null;
let warming = false;

export function getStatus() {
  return {
    warming,
    lastError: lastError ? String(lastError) : null,
    currencies: Object.keys(cache).map((cur) => ({
      currency: cur,
      updatedAt: cache[cur]?.updatedAt || null,
      asrCount: cache[cur]?.asr?.length || 0,
      diskCount: cache[cur]?.disks?.length || 0,
      vmCount: cache[cur]?.vms?.length || 0,
      cacheStoreCount: cache[cur]?.cacheStore?.length || 0,
      publicIpCount: cache[cur]?.publicIp?.length || 0,
    })),
  };
}

export async function warmCache({ verbose = true } = {}) {
  warming = true;
  lastError = null;
  try {
    const regionFilter = `(${regionOr(REGIONS)})`;
    for (const currency of CURRENCIES) {
      const t0 = Date.now();

      // 1. ASR — Azure Site Recovery service, all SKUs in selected regions
      const asrFilter = `serviceName eq 'Azure Site Recovery' and ${regionFilter}`;
      // 2. Managed Disks — Premium SSD + Standard SSD
      const diskFilter = `serviceName eq 'Storage' and (productName eq 'Premium SSD Managed Disks' or productName eq 'Standard SSD Managed Disks') and ${regionFilter} and priceType eq 'Consumption'`;
      // 3. VMs — Virtual Machines, consumption tier (skip Spot/Low Priority)
      const vmFilter = `serviceName eq 'Virtual Machines' and priceType eq 'Consumption' and ${regionFilter}`;
      // 4. Cache storage — GPv2 LRS Hot data stored
      const cacheStoreFilter = `serviceName eq 'Storage' and (productName eq 'General Block Blob v2 Hierarchical Namespace' or productName eq 'Standard Page Blob v2' or productName eq 'General Block Blob v2') and ${regionFilter} and priceType eq 'Consumption'`;
      // 5. Public IP — Standard Static IPv4
      const publicIpFilter = `serviceName eq 'Virtual Network' and productName eq 'IP Addresses' and ${regionFilter} and priceType eq 'Consumption'`;

      const [asr, disks, vms, cacheStore, publicIp] = await Promise.all([
        fetchAllPages(asrFilter, currency),
        fetchAllPages(diskFilter, currency),
        fetchAllPages(vmFilter, currency, { pageLimit: 200 }),
        fetchAllPages(cacheStoreFilter, currency),
        fetchAllPages(publicIpFilter, currency),
      ]);

      cache[currency] = {
        asr,
        disks,
        vms,
        cacheStore,
        publicIp,
        updatedAt: new Date(),
      };

      if (verbose) {
        console.log(
          `[prices] ${currency} warmed in ${Date.now() - t0}ms ` +
            `(asr=${asr.length}, disks=${disks.length}, vms=${vms.length}, ` +
            `cacheStore=${cacheStore.length}, publicIp=${publicIp.length})`
        );
      }
    }
  } catch (err) {
    lastError = err;
    if (verbose) console.error('[prices] warm error:', err.message);
  } finally {
    warming = false;
  }
}

function getRegional(items, armRegionName) {
  return items.filter((i) => i.armRegionName === armRegionName);
}

// ---------- Public lookup helpers ----------

export function findAsrPrice(currency, armRegionName, scenario) {
  const items = cache[currency]?.asr || [];
  // Scenarios map to meterName / skuName patterns. Documented ASR meter is "Protected Instance".
  // For most current scenarios the meter is generic; pricing is the same per protected instance.
  const regional = getRegional(items, armRegionName);
  if (regional.length === 0) return null;

  const lower = (s) => (s || '').toLowerCase();
  let candidate = null;

  if (scenario === 'a2a') {
    candidate =
      regional.find((i) => lower(i.meterName).includes('azure to azure')) ||
      regional.find((i) => lower(i.skuName).includes('a2a'));
  } else {
    // VMware/Hyper-V on-prem to Azure
    candidate =
      regional.find((i) => lower(i.meterName).includes('to azure') && !lower(i.meterName).includes('azure to azure')) ||
      regional.find((i) => lower(i.meterName).includes('protected instance'));
  }
  if (!candidate) candidate = regional[0];
  return candidate
    ? {
        retailPrice: candidate.retailPrice,
        unitOfMeasure: candidate.unitOfMeasure,
        meterName: candidate.meterName,
        productName: candidate.productName,
        currency,
      }
    : null;
}

export function findDiskPrice(currency, armRegionName, family, skuName) {
  // family: 'Premium SSD' | 'Standard SSD'
  // skuName: 'P10', 'E20', etc.
  const items = cache[currency]?.disks || [];
  const productName = family === 'Premium SSD' ? 'Premium SSD Managed Disks' : 'Standard SSD Managed Disks';
  const regional = items.filter(
    (i) => i.armRegionName === armRegionName && i.productName === productName
  );
  // skuName in API is like 'P10 LRS', 'E20 LRS' (also ZRS variants). Pick LRS by default.
  const hit =
    regional.find((i) => i.skuName === `${skuName} LRS`) ||
    regional.find((i) => i.skuName.startsWith(`${skuName} `) && !i.skuName.includes('ZRS')) ||
    regional.find((i) => i.skuName.startsWith(`${skuName}`));
  return hit
    ? {
        retailPrice: hit.retailPrice,
        unitOfMeasure: hit.unitOfMeasure, // typically "1/Month"
        skuName: hit.skuName,
        currency,
      }
    : null;
}

export function findVmPrice(currency, armRegionName, armSkuName, os /* 'linux' | 'windows' */) {
  const items = cache[currency]?.vms || [];
  const regional = items.filter(
    (i) =>
      i.armRegionName === armRegionName &&
      i.armSkuName === armSkuName &&
      i.type === 'Consumption' &&
      !/spot|low priority/i.test(i.skuName || '') &&
      !/spot|low priority/i.test(i.meterName || '')
  );
  if (regional.length === 0) return null;
  // Windows entries contain "Windows" in productName; Linux entries do not.
  const wantWindows = os === 'windows';
  const filtered = regional.filter((i) => /windows/i.test(i.productName) === wantWindows);
  const pool = filtered.length ? filtered : regional;
  const hit = pool[0];
  // unitOfMeasure typically "1 Hour"
  return hit
    ? {
        retailPrice: hit.retailPrice,
        unitOfMeasure: hit.unitOfMeasure,
        productName: hit.productName,
        skuName: hit.skuName,
        os: wantWindows ? 'windows' : 'linux',
        currency,
      }
    : null;
}

export function findCacheStoragePricePerGiBMonth(currency, armRegionName) {
  const items = cache[currency]?.cacheStore || [];
  const regional = items.filter((i) => i.armRegionName === armRegionName);
  // Look for Hot LRS data stored
  const hit =
    regional.find(
      (i) =>
        /hot/i.test(i.meterName) &&
        /lrs/i.test(i.skuName || i.meterName) &&
        /data stored/i.test(i.meterName)
    ) ||
    regional.find((i) => /hot/i.test(i.meterName) && /lrs/i.test(i.skuName || i.meterName)) ||
    regional.find((i) => /lrs/i.test(i.skuName || '') && /data stored/i.test(i.meterName));
  return hit
    ? {
        retailPrice: hit.retailPrice,
        unitOfMeasure: hit.unitOfMeasure, // "1 GB/Month" usually
        meterName: hit.meterName,
        skuName: hit.skuName,
        currency,
      }
    : null;
}

export function findStandardPublicIpPricePerHour(currency, armRegionName) {
  const items = cache[currency]?.publicIp || [];
  const regional = items.filter((i) => i.armRegionName === armRegionName);
  const hit =
    regional.find((i) => /standard static/i.test(i.meterName) && !/global/i.test(i.meterName)) ||
    regional.find((i) => /standard/i.test(i.skuName || '') && /static/i.test(i.skuName || '')) ||
    regional.find((i) => /standard.*ipv4/i.test(i.meterName));
  return hit
    ? {
        retailPrice: hit.retailPrice,
        unitOfMeasure: hit.unitOfMeasure, // "1 Hour"
        meterName: hit.meterName,
        skuName: hit.skuName,
        currency,
      }
    : null;
}

export function vmHourlyToMonthly(hourly) {
  return hourly * HOURS_PER_MONTH;
}

export { HOURS_PER_MONTH };
