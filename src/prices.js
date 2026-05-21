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
//   asr:            Item[],
//   disks:          Item[],
//   vms:            Item[],   // PAYG (Consumption)
//   vmReservations: Item[],   // 1Y/3Y reserved instances
//   cacheStore:     Item[],
//   publicIp:       Item[],
//   bandwidth:      Item[],   // inter-region egress
//   backup:         Item[],   // Azure Backup
//   blobStorage:    Item[],   // Hot/Cool/Archive blob tiers
//   updatedAt:      Date,
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
      vmReservationCount: cache[cur]?.vmReservations?.length || 0,
      cacheStoreCount: cache[cur]?.cacheStore?.length || 0,
      publicIpCount: cache[cur]?.publicIp?.length || 0,
      bandwidthCount: cache[cur]?.bandwidth?.length || 0,
      backupCount: cache[cur]?.backup?.length || 0,
      blobStorageCount: cache[cur]?.blobStorage?.length || 0,
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
      // 6. Bandwidth — inter-region egress. No regionFilter because some bandwidth meters
      // are sold as global SKUs (Zone 1/2/3) without an armRegionName.
      const bandwidthFilter = `serviceName eq 'Bandwidth' and priceType eq 'Consumption'`;
      // 7. VM Reservations — 1Y/3Y reserved instance prices for the same VMs
      const vmRiFilter = `serviceName eq 'Virtual Machines' and priceType eq 'Reservation' and ${regionFilter}`;
      // 8. Azure Backup — protected instance fees + backup storage redundancies
      const backupFilter = `serviceName eq 'Backup' and ${regionFilter} and priceType eq 'Consumption'`;
      // 9. Blob Storage — Hot/Cool/Archive tiers + LRS/GRS/ZRS redundancies (data stored)
      const blobFilter = `serviceName eq 'Storage' and (productName eq 'General Block Blob v2' or productName eq 'Blob Storage' or productName eq 'Archive Blob Storage') and ${regionFilter} and priceType eq 'Consumption'`;

      const [asr, disks, vms, cacheStore, publicIp, bandwidth, vmReservations, backup, blobStorage] = await Promise.all([
        fetchAllPages(asrFilter, currency),
        fetchAllPages(diskFilter, currency),
        fetchAllPages(vmFilter, currency, { pageLimit: 200 }),
        fetchAllPages(cacheStoreFilter, currency),
        fetchAllPages(publicIpFilter, currency),
        fetchAllPages(bandwidthFilter, currency, { pageLimit: 20 }),
        fetchAllPages(vmRiFilter, currency, { pageLimit: 200 }),
        fetchAllPages(backupFilter, currency, { pageLimit: 50 }),
        fetchAllPages(blobFilter, currency, { pageLimit: 50 }),
      ]);

      cache[currency] = {
        asr,
        disks,
        vms,
        vmReservations,
        cacheStore,
        publicIp,
        bandwidth,
        backup,
        blobStorage,
        updatedAt: new Date(),
      };

      if (verbose) {
        console.log(
          `[prices] ${currency} warmed in ${Date.now() - t0}ms ` +
            `(asr=${asr.length}, disks=${disks.length}, vms=${vms.length}, vmRI=${vmReservations.length}, ` +
            `cacheStore=${cacheStore.length}, publicIp=${publicIp.length}, bandwidth=${bandwidth.length}, ` +
            `backup=${backup.length}, blob=${blobStorage.length})`
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
  // Per Microsoft: "Azure Site Recovery between Azure regions is charged at the same rate
  // as Azure Site Recovery to Azure." So we always look up the "to Azure" meter, even for
  // the A2A scenario. The literal "Azure to Azure" meter in the API is a BYOL/customer-
  // owned rate that we intentionally exclude.
  const regional = getRegional(items, armRegionName).filter(
    (i) =>
      !/bandwidth|data transfer|transfer out|egress|ingress|operations|storage/i.test(
        i.meterName || ''
      ) &&
      !/azure to azure/i.test(i.meterName || '')
  );
  if (regional.length === 0) return null;

  const lower = (s) => (s || '').toLowerCase();
  const candidate =
    regional.find((i) => lower(i.meterName).includes('to azure')) ||
    regional.find((i) => lower(i.meterName).includes('disaster recovery')) ||
    regional.find((i) => lower(i.meterName).includes('protected instance')) ||
    regional[0];

  return candidate
    ? {
        retailPrice: candidate.retailPrice,
        unitOfMeasure: candidate.unitOfMeasure, // typically "1 Hour"
        meterName: candidate.meterName,
        productName: candidate.productName,
        skuName: candidate.skuName,
        scenarioApplied: scenario,
        currency,
      }
    : null;
}

export function findDiskPrice(currency, armRegionName, family, skuName) {
  // family: 'Premium SSD' | 'Standard SSD'
  // skuName: 'P10', 'E20', etc.
  //
  // The Retail Prices API returns SEVERAL line items per disk SKU that share the same
  // skuName ("E1 LRS"). For example: monthly tier fee, disk operations (per 10k), disk
  // mounts, bursting, etc. We must pin the lookup to the monthly tier fee, otherwise we
  // pick up a per-transaction price that has no relation to the tier ladder
  // (e.g. E1 LRS Disk Operations can be > E10 LRS Disk per-month).
  const items = cache[currency]?.disks || [];
  const productName = family === 'Premium SSD' ? 'Premium SSD Managed Disks' : 'Standard SSD Managed Disks';
  const target = `${skuName} LRS`;

  const monthly = items.filter(
    (i) =>
      i.armRegionName === armRegionName &&
      i.productName === productName &&
      i.skuName === target &&
      /month/i.test(i.unitOfMeasure || '') &&
      !/operations|mounts|bursting|provisioned|iops|throughput|snapshot/i.test(i.meterName || '')
  );

  // Among remaining monthly meters, prefer the one whose meterName ends with " Disk"
  // (the per-disk tier fee), then any remaining.
  const hit =
    monthly.find((i) => /\bdisk(s)?$/i.test(i.meterName || '')) ||
    monthly.find((i) => / disk(s)? /i.test(i.meterName || '')) ||
    monthly[0];

  return hit
    ? {
        retailPrice: hit.retailPrice,
        unitOfMeasure: hit.unitOfMeasure, // "1/Month"
        skuName: hit.skuName,
        meterName: hit.meterName,
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

// Inter-region bandwidth (Zone 1 by default — covers our curated EU regions).
// Used to estimate Azure-to-Azure replication egress.
export function findInterRegionEgressPricePerGiB(currency, armRegionName) {
  const items = cache[currency]?.bandwidth || [];
  const isEU = /europe|france|italy|sweden|germany|switzerland|spain|poland|norway|uk/i.test(
    armRegionName || ''
  );
  const preferredZone = isEU ? 'zone 1' : null;

  const lower = (s) => (s || '').toLowerCase();
  const matchesInterRegion = (i) =>
    /inter[- ]?region/i.test(i.meterName || '') ||
    /inter[- ]?region/i.test(i.productName || '') ||
    /inter[- ]?region/i.test(i.skuName || '');

  const isPerGb = (i) => /gb/i.test(i.unitOfMeasure || '');

  let pool = items.filter((i) => matchesInterRegion(i) && isPerGb(i));
  if (pool.length === 0) {
    // Fallback: any "transfer out" bandwidth meter priced per GB.
    pool = items.filter(
      (i) =>
        /transfer out|outbound data transfer/i.test(i.meterName || '') && isPerGb(i)
    );
  }
  if (pool.length === 0) return null;

  const hit =
    (preferredZone &&
      pool.find(
        (i) =>
          lower(i.skuName).includes(preferredZone) ||
          lower(i.meterName).includes(preferredZone) ||
          lower(i.productName).includes(preferredZone)
      )) ||
    pool.find((i) => lower(i.skuName).includes('zone 1')) ||
    pool[0];

  return hit
    ? {
        retailPrice: hit.retailPrice,
        unitOfMeasure: hit.unitOfMeasure, // "1 GB"
        meterName: hit.meterName,
        skuName: hit.skuName,
        productName: hit.productName,
        currency,
      }
    : null;
}

export function vmHourlyToMonthly(hourly) {
  return hourly * HOURS_PER_MONTH;
}

// ---------- Azure Calculator helpers (compute reservations, backup, blob storage) ----------

const HOURS_PER_YEAR = 8760;

/**
 * Find the effective hourly price for a VM given a reservation term.
 * The Retail Prices API returns Reservation items for each (sku, term). The "retailPrice"
 * is the FULL TERM total (e.g. ~$1100 for a 1Y D2s v3). To compare with PAYG we divide
 * by the number of hours in the term.
 *
 * @param term '1 Year' | '3 Years'
 */
export function findVmReservationPrice(currency, armRegionName, armSkuName, os, term) {
  const items = cache[currency]?.vmReservations || [];
  const wantWindows = os === 'windows';
  const pool = items.filter(
    (i) =>
      i.armRegionName === armRegionName &&
      i.armSkuName === armSkuName &&
      i.reservationTerm === term &&
      /windows/i.test(i.productName || '') === wantWindows
  );
  if (pool.length === 0) return null;
  const hit = pool[0];
  // Some entries use unitOfMeasure "1 Hour" with retailPrice already hourly; others use
  // the term total. Heuristic: if unit contains "Hour" and price is small, treat as hourly;
  // otherwise divide by term hours.
  const termHours = term === '3 Years' ? HOURS_PER_YEAR * 3 : HOURS_PER_YEAR;
  let effectiveHourly;
  if (/hour/i.test(hit.unitOfMeasure || '') && hit.retailPrice < 5) {
    effectiveHourly = hit.retailPrice;
  } else {
    effectiveHourly = hit.retailPrice / termHours;
  }
  return {
    retailPrice: hit.retailPrice,
    effectiveHourly,
    unitOfMeasure: hit.unitOfMeasure,
    reservationTerm: hit.reservationTerm,
    productName: hit.productName,
    skuName: hit.skuName,
    os: wantWindows ? 'windows' : 'linux',
    currency,
  };
}

/**
 * Effective hourly price for a VM combining OS, reservation and Hybrid Benefit.
 * Hybrid Benefit (AHB) on Windows lets you "bring your own" Windows license, so the
 * effective compute price collapses to the Linux PAYG/RI price for the same SKU.
 *
 * @param opts.reservation 'payg' | '1y' | '3y'
 * @param opts.hybridBenefit boolean
 */
export function findVmEffectiveHourly(currency, armRegionName, armSkuName, os, opts = {}) {
  const reservation = opts.reservation || 'payg';
  const hybridBenefit = !!opts.hybridBenefit;

  // AHB collapses Windows compute to the Linux rate for the same SKU.
  const effectiveOs = hybridBenefit && os === 'windows' ? 'linux' : os;

  if (reservation === '1y' || reservation === '3y') {
    const term = reservation === '3y' ? '3 Years' : '1 Year';
    const ri = findVmReservationPrice(currency, armRegionName, armSkuName, effectiveOs, term);
    if (ri) {
      return {
        hourly: ri.effectiveHourly,
        source: 'reservation',
        reservation,
        hybridBenefit,
        os,
        effectiveOs,
        detail: `${term} RI \u2013 ${ri.skuName}`,
        productName: ri.productName,
        currency,
      };
    }
    // Fall back to PAYG if RI not found.
  }

  const payg = findVmPrice(currency, armRegionName, armSkuName, effectiveOs);
  if (!payg) return null;
  return {
    hourly: payg.retailPrice,
    source: 'payg',
    reservation: 'payg',
    hybridBenefit,
    os,
    effectiveOs,
    detail: hybridBenefit && os === 'windows' ? 'PAYG (Linux rate, Windows AHB)' : 'PAYG',
    productName: payg.productName,
    currency,
  };
}

/**
 * Azure Backup protected instance fee for a given source size.
 * Microsoft's published schedule (per instance / month):
 *   - <= 50 GB:        one fee
 *   - > 50 GB, <= 500: a higher fee
 *   - every additional 500 GB tranche: same as the 500-GB fee added again
 *
 * The API meters are named "Azure VM Backup Protected Instances Size <= 50 GB",
 * "Azure VM Backup Protected Instances Size > 50 GB to 500 GB", and
 * "Azure VM Backup Protected Instances Size > 500 GB Multiples" (or similar).
 *
 * Returns { monthly, breakdown[] }.
 */
export function findBackupProtectedInstanceMonthly(currency, armRegionName, sizeGiB) {
  const items = cache[currency]?.backup || [];
  const regional = items.filter(
    (i) =>
      (i.armRegionName === armRegionName || !i.armRegionName) &&
      /protected instance/i.test(i.meterName || '')
  );
  if (regional.length === 0) return null;

  const findMeter = (re) => regional.find((i) => re.test(i.meterName || ''));
  const small = findMeter(/50\s*gb\s*or\s*less|<=?\s*50\s*gb|size\s*0\s*to\s*50/i);
  const mid = findMeter(/50\s*gb\s*to\s*500\s*gb|>\s*50\s*gb.*500/i);
  const tranche = findMeter(/500\s*gb\s*multiples|>\s*500\s*gb/i);

  const breakdown = [];
  let monthly = 0;
  if (sizeGiB <= 50 && small) {
    monthly += small.retailPrice;
    breakdown.push({ tier: '\u2264 50 GiB', amount: small.retailPrice, meterName: small.meterName });
  } else if (sizeGiB <= 500 && mid) {
    monthly += mid.retailPrice;
    breakdown.push({ tier: '> 50 GiB to 500 GiB', amount: mid.retailPrice, meterName: mid.meterName });
  } else if (sizeGiB > 500) {
    // Mid bracket counts once for the first 500 GB, then a 500-GB tranche for every additional
    // 500 GB or part thereof.
    if (mid) {
      monthly += mid.retailPrice;
      breakdown.push({ tier: 'First 500 GiB', amount: mid.retailPrice, meterName: mid.meterName });
    }
    if (tranche) {
      const extra = Math.ceil((sizeGiB - 500) / 500);
      const cost = tranche.retailPrice * extra;
      monthly += cost;
      breakdown.push({
        tier: `${extra} \u00d7 500 GiB tranches`,
        amount: cost,
        unit: tranche.retailPrice,
        meterName: tranche.meterName,
      });
    }
  } else if (mid) {
    monthly += mid.retailPrice;
    breakdown.push({ tier: 'Default', amount: mid.retailPrice, meterName: mid.meterName });
  }

  return { monthly, breakdown, currency };
}

/**
 * Backup Storage per GiB/Month for a given redundancy (LRS|GRS|ZRS).
 */
export function findBackupStoragePricePerGiBMonth(currency, armRegionName, redundancy /* 'LRS'|'GRS'|'ZRS' */) {
  const items = cache[currency]?.backup || [];
  const want = (redundancy || 'LRS').toLowerCase();
  const regional = items.filter(
    (i) =>
      (i.armRegionName === armRegionName || !i.armRegionName) &&
      /backup storage/i.test(i.meterName || '') &&
      /data stored/i.test(i.meterName || '') &&
      new RegExp(`\\b${want}\\b`, 'i').test(i.meterName + ' ' + (i.skuName || ''))
  );
  let hit = regional[0];
  if (!hit) {
    // Looser: any backup data-stored meter
    hit = items.find(
      (i) =>
        (i.armRegionName === armRegionName || !i.armRegionName) &&
        /backup/i.test(i.meterName || '') &&
        /data stored/i.test(i.meterName || '') &&
        new RegExp(want, 'i').test(i.meterName + ' ' + (i.skuName || ''))
    );
  }
  return hit
    ? {
        retailPrice: hit.retailPrice,
        unitOfMeasure: hit.unitOfMeasure,
        meterName: hit.meterName,
        skuName: hit.skuName,
        redundancy,
        currency,
      }
    : null;
}

/**
 * Blob storage per GiB/Month for a given tier (Hot|Cool|Archive) + redundancy.
 * Uses the first pricing tranche (\u2264 50 TB / "data stored").
 */
export function findBlobStoragePricePerGiBMonth(currency, armRegionName, tier /* 'Hot'|'Cool'|'Archive' */, redundancy /* 'LRS'|'GRS'|'ZRS' */) {
  const items = cache[currency]?.blobStorage || [];
  const wantTier = (tier || 'Hot').toLowerCase();
  const wantRed = (redundancy || 'LRS').toLowerCase();
  const regional = items.filter(
    (i) =>
      i.armRegionName === armRegionName &&
      /data stored/i.test(i.meterName || '') &&
      new RegExp(wantTier, 'i').test(i.meterName + ' ' + (i.skuName || '') + ' ' + (i.productName || '')) &&
      new RegExp(`\\b${wantRed}\\b`, 'i').test(i.meterName + ' ' + (i.skuName || ''))
  );
  // Prefer the lowest tranche (smallest "tierMinimumUnits") if present
  regional.sort((a, b) => (a.tierMinimumUnits || 0) - (b.tierMinimumUnits || 0));
  const hit = regional[0];
  return hit
    ? {
        retailPrice: hit.retailPrice,
        unitOfMeasure: hit.unitOfMeasure,
        meterName: hit.meterName,
        skuName: hit.skuName,
        productName: hit.productName,
        tier,
        redundancy,
        currency,
      }
    : null;
}

export { HOURS_PER_MONTH };
