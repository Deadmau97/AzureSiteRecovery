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
//   vpnGateway:     Item[],   // VPN Gateway hourly SKUs
//   natGateway:     Item[],   // NAT Gateway hourly + processed data
//   appServicePlan: Item[],   // App Service Plan hourly SKUs
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
      vpnGatewayCount: cache[cur]?.vpnGateway?.length || 0,
      natGatewayCount: cache[cur]?.natGateway?.length || 0,
      appServicePlanCount: cache[cur]?.appServicePlan?.length || 0,
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
      // 10. VPN Gateway — hourly SKUs (Basic, VpnGw1..5, with AZ variants)
      const vpnFilter = `serviceName eq 'VPN Gateway' and ${regionFilter} and priceType eq 'Consumption'`;
      // 11. NAT Gateway — gateway hours + data processed
      const natFilter = `serviceName eq 'NAT Gateway' and ${regionFilter} and priceType eq 'Consumption'`;
      // 12. App Service Plan — Basic/Standard/PremiumV3/Isolated tiers
      const appSvcFilter = `serviceName eq 'Azure App Service' and ${regionFilter} and priceType eq 'Consumption'`;

      const [asr, disks, vms, cacheStore, publicIp, bandwidth, vmReservations, backup, blobStorage, vpnGateway, natGateway, appServicePlan] = await Promise.all([
        fetchAllPages(asrFilter, currency),
        fetchAllPages(diskFilter, currency),
        fetchAllPages(vmFilter, currency, { pageLimit: 200 }),
        fetchAllPages(cacheStoreFilter, currency),
        fetchAllPages(publicIpFilter, currency),
        fetchAllPages(bandwidthFilter, currency, { pageLimit: 20 }),
        fetchAllPages(vmRiFilter, currency, { pageLimit: 200 }),
        fetchAllPages(backupFilter, currency, { pageLimit: 50 }),
        fetchAllPages(blobFilter, currency, { pageLimit: 50 }),
        fetchAllPages(vpnFilter, currency, { pageLimit: 20 }),
        fetchAllPages(natFilter, currency, { pageLimit: 10 }),
        fetchAllPages(appSvcFilter, currency, { pageLimit: 80 }),
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
        vpnGateway,
        natGateway,
        appServicePlan,
        updatedAt: new Date(),
      };

      if (verbose) {
        console.log(
          `[prices] ${currency} warmed in ${Date.now() - t0}ms ` +
            `(asr=${asr.length}, disks=${disks.length}, vms=${vms.length}, vmRI=${vmReservations.length}, ` +
            `cacheStore=${cacheStore.length}, publicIp=${publicIp.length}, bandwidth=${bandwidth.length}, ` +
            `backup=${backup.length}, blob=${blobStorage.length}, vpn=${vpnGateway.length}, ` +
            `nat=${natGateway.length}, appSvc=${appServicePlan.length})`
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
 * Azure VM Backup — Protected Instance (agent) fee.
 *
 * The Azure Retail Prices API publishes a single flat meter named exactly
 * `Azure VM Protected Instance` (skuName='Azure VM', productName='Backup') of
 * ~€8.5/month per protected VM. That is the "agent" fee the user was missing
 * from the estimate. For workloads above 500 GB the same per-instance fee
 * applies to every additional 500-GB tranche (per Microsoft's published
 * pricing schedule, since the size-tiered meter names have been collapsed into
 * the single "Azure VM Protected Instance" meter).
 *
 * Returns { monthly, breakdown[] }.
 */
export function findBackupProtectedInstanceMonthly(currency, armRegionName, sizeGiB) {
  const items = cache[currency]?.backup || [];
  // The Azure VM workload meter (modern, post-2021 schedule).
  const azureVm = items.find(
    (i) =>
      (i.armRegionName === armRegionName || !i.armRegionName) &&
      (i.skuName || '').toLowerCase() === 'azure vm' &&
      /azure\s*vm\s*protected\s*instance/i.test(i.meterName || '')
  );

  if (azureVm) {
    const breakdown = [];
    let monthly = azureVm.retailPrice;
    breakdown.push({
      tier: sizeGiB <= 500 ? `Azure VM Protected Instance (\u2264 500 GiB)` : 'Azure VM Protected Instance (first 500 GiB)',
      amount: azureVm.retailPrice,
      meterName: azureVm.meterName,
    });
    if (sizeGiB > 500) {
      const extra = Math.ceil((sizeGiB - 500) / 500);
      const cost = azureVm.retailPrice * extra;
      monthly += cost;
      breakdown.push({
        tier: `${extra} \u00d7 additional 500 GiB tranche(s)`,
        amount: cost,
        unit: azureVm.retailPrice,
        meterName: azureVm.meterName,
      });
    }
    return { monthly, breakdown, currency };
  }

  // Fallback to the legacy size-tiered MARS / on-prem schedule if Azure VM meter is
  // not published in this region/currency (rare, but keeps older behaviour intact).
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
 *
 * The API meters under serviceName='Backup' for Azure VM workload storage are named
 * literally `Standard LRS Data Stored`, `Standard GRS Data Stored`, `Standard ZRS Data
 * Stored` and `Standard RA-GRS Data Stored` (skuName='Standard'). Earlier we required
 * the literal phrase "backup storage" in the meter name which never matches, so the
 * estimator falsely warned that GRS/ZRS pricing was missing for West Europe / Italy
 * North. We now match by skuName + a strict meterName pattern.
 */
export function findBackupStoragePricePerGiBMonth(currency, armRegionName, redundancy /* 'LRS'|'GRS'|'ZRS' */) {
  const items = cache[currency]?.backup || [];
  const want = (redundancy || 'LRS').toUpperCase();
  // Map "GRS" -> match both GRS and (fallback) RA-GRS if pure GRS is not published.
  const primaryRe = new RegExp(`^Standard\\s+${want}\\s+Data\\s+Stored$`, 'i');
  const fallbackRe = want === 'GRS' ? /^Standard\s+RA-GRS\s+Data\s+Stored$/i : null;

  const regional = items.filter((i) =>
    (i.armRegionName === armRegionName || !i.armRegionName) &&
    (i.skuName || '').toLowerCase() === 'standard'
  );
  let hit = regional.find((i) => primaryRe.test(i.meterName || ''));
  if (!hit && fallbackRe) hit = regional.find((i) => fallbackRe.test(i.meterName || ''));

  if (!hit) {
    // Last-resort generic scan across all Backup items in the region (any sku).
    hit = items.find((i) =>
      (i.armRegionName === armRegionName || !i.armRegionName) &&
      new RegExp(`\\b${want}\\b\\s+Data\\s+Stored$`, 'i').test(i.meterName || '')
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

// ---------- VPN Gateway / NAT Gateway / App Service Plan ----------

/**
 * List the available VPN Gateway SKUs for the region (deduplicated by skuName).
 * Returns [{ skuName, hourly, productName, meterName }, ...] sorted alphabetically.
 */
export function listVpnGatewaySkus(currency, armRegionName) {
  const items = cache[currency]?.vpnGateway || [];
  const byHour = items.filter(
    (i) =>
      i.armRegionName === armRegionName &&
      /(hour|gateway)/i.test(i.unitOfMeasure || '') &&
      !/data\s*transfer|egress|inter/i.test(i.meterName || '')
  );
  const seen = new Map();
  for (const i of byHour) {
    const key = i.skuName || i.meterName;
    if (!key) continue;
    if (!seen.has(key)) {
      seen.set(key, { skuName: key, hourly: i.retailPrice, productName: i.productName, meterName: i.meterName });
    }
  }
  return [...seen.values()].sort((a, b) => a.skuName.localeCompare(b.skuName));
}

export function findVpnGatewayPrice(currency, armRegionName, skuName) {
  const items = cache[currency]?.vpnGateway || [];
  return items.find(
    (i) =>
      i.armRegionName === armRegionName &&
      i.skuName === skuName &&
      /(hour|gateway)/i.test(i.unitOfMeasure || '') &&
      !/data\s*transfer|egress|inter/i.test(i.meterName || '')
  ) || null;
}

/**
 * NAT Gateway hourly + processed-data prices.
 */
export function findNatGatewayPrice(currency, armRegionName) {
  const items = cache[currency]?.natGateway || [];
  const hour = items.find(
    (i) => i.armRegionName === armRegionName && /gateway\s*hour|nat\s*gateway/i.test(i.meterName || '') && /hour/i.test(i.unitOfMeasure || '')
  );
  const data = items.find(
    (i) => i.armRegionName === armRegionName && /data\s*processed/i.test(i.meterName || '')
  );
  return { hour, data };
}

/**
 * List the App Service Plan SKUs for the region.
 * Filters down to per-instance hourly meters (Basic/Standard/PremiumV3/Isolated tiers).
 */
export function listAppServicePlanSkus(currency, armRegionName) {
  const items = cache[currency]?.appServicePlan || [];
  const byHour = items.filter(
    (i) =>
      i.armRegionName === armRegionName &&
      /hour/i.test(i.unitOfMeasure || '') &&
      !/stamp\s*fee|isolated\s*v2\s*stamp/i.test(i.meterName || '')
  );
  const seen = new Map();
  for (const i of byHour) {
    const key = `${i.productName || ''} \u2014 ${i.skuName || ''}`.trim();
    if (!key || key === '\u2014') continue;
    if (!seen.has(key)) {
      seen.set(key, {
        key,
        skuName: i.skuName,
        productName: i.productName,
        hourly: i.retailPrice,
        meterName: i.meterName,
      });
    }
  }
  return [...seen.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export function findAppServicePlanPrice(currency, armRegionName, productName, skuName) {
  const items = cache[currency]?.appServicePlan || [];
  return items.find(
    (i) =>
      i.armRegionName === armRegionName &&
      i.productName === productName &&
      i.skuName === skuName &&
      /hour/i.test(i.unitOfMeasure || '')
  ) || null;
}
