// Cost estimator. Combines pricing lookups for:
//  - Monthly: ASR per-instance, replica managed disks, cache storage account
//  - 24h Test DR: VM compute (Linux/Windows), snapshot storage for test disks, Standard Public IP
//
// Notes & assumptions:
//  - Replica disks: priced as monthly tier rate (LRS) for the chosen SKU.
//  - Cache storage: assumes daily churn % of total disk capacity stored for ~3 days retention.
//    Defaults: churnPctPerDay = 10, retentionDays = 3 → cacheGiB = totalDiskGiB * 0.10 * 3.
//  - Snapshot storage for test failover: priced as 24h slice of "Standard Page Blob v2" /
//    fallback GPv2 Hot LRS data-stored rate × disk size. We treat 24h = 1/30 of monthly.
//  - Public IP: priced for 24h (24 * hourly rate). Counted once per VM in test failover.

import { pickDiskTier } from './diskTiers.js';
import {
  findAsrPrice,
  findDiskPrice,
  findVmPrice,
  findCacheStoragePricePerGiBMonth,
  findStandardPublicIpPricePerHour,
  findInterRegionEgressPricePerGiB,
  vmHourlyToMonthly,
  HOURS_PER_MONTH,
} from './prices.js';

const TEST_HOURS = 24;
const MONTH_HOURS_FRACTION = TEST_HOURS / HOURS_PER_MONTH; // ~0.0329

export function estimateProject({
  currency = 'EUR',
  armRegionName,
  scenario = 'onprem', // 'onprem' | 'a2a'
  vms = [],
  options = {},
}) {
  const {
    churnPctPerDay = 10,
    cacheRetentionDays = 3,
    includeTestPublicIp = true,
  } = options;

  const perVm = [];
  let totalMonthly = 0;
  let totalTest = 0;
  const warnings = [];

  for (const vm of vms) {
    const lineItems = { monthly: [], test: [] };
    let vmMonthly = 0;
    let vmTest = 0;

    // ---- ASR per-instance protection ----
    const asr = findAsrPrice(currency, armRegionName, scenario === 'a2a' ? 'a2a' : 'onprem');
    if (asr) {
      // ASR is normally priced per hour per protected instance — convert to monthly.
      const isHourly = /hour/i.test(asr.unitOfMeasure || '');
      const monthly = isHourly ? asr.retailPrice * HOURS_PER_MONTH : asr.retailPrice;
      vmMonthly += monthly;
      lineItems.monthly.push({
        category: 'ASR Protected Instance',
        detail: `${asr.meterName} (${asr.unitOfMeasure}${isHourly ? ` × ${HOURS_PER_MONTH}h` : ''})`,
        amount: monthly,
      });
    } else {
      warnings.push(`No ASR price found for ${armRegionName}/${currency}.`);
    }

    // ---- Replica managed disks (monthly tier rate) ----
    let totalDiskGiB = 0;
    for (const disk of vm.disks || []) {
      const tier = pickDiskTier(Number(disk.sizeGiB) || 0, disk.family || 'Premium SSD');
      totalDiskGiB += tier.sizeGiB;
      const dp = findDiskPrice(currency, armRegionName, tier.family, tier.sku);
      if (dp) {
        vmMonthly += dp.retailPrice;
        lineItems.monthly.push({
          category: 'Replica Disk',
          detail: `${tier.family} ${tier.sku} (${tier.sizeGiB} GiB) LRS — ${disk.label || ''}`,
          amount: dp.retailPrice,
        });
        // Test failover snapshot slice (24h)
        const snapshot24h = dp.retailPrice * MONTH_HOURS_FRACTION;
        vmTest += snapshot24h;
        lineItems.test.push({
          category: 'Test failover disk snapshot (24h)',
          detail: `${tier.family} ${tier.sku} (${tier.sizeGiB} GiB)`,
          amount: snapshot24h,
        });
      } else {
        warnings.push(`No price for ${tier.family} ${tier.sku} in ${armRegionName}.`);
      }
    }

    // ---- Cache storage account (per VM share) ----
    const cacheGiB = totalDiskGiB * (churnPctPerDay / 100) * cacheRetentionDays;
    if (cacheGiB > 0) {
      const cs = findCacheStoragePricePerGiBMonth(currency, armRegionName);
      if (cs) {
        const monthly = cs.retailPrice * cacheGiB;
        vmMonthly += monthly;
        lineItems.monthly.push({
          category: 'Cache storage (GPv2 LRS Hot)',
          detail: `~${cacheGiB.toFixed(1)} GiB (churn ${churnPctPerDay}%/day × ${cacheRetentionDays}d)`,
          amount: monthly,
        });
      } else {
        warnings.push(`No cache-storage price found for ${armRegionName}/${currency}.`);
      }
    }

    // ---- Inter-region replication egress (Azure-to-Azure only) ----
    // ASR continuously replicates the disk delta from the source region to the DR region.
    // We approximate the monthly outbound traffic as totalDiskGiB × churn%/day × 30 days.
    if (scenario === 'a2a' && totalDiskGiB > 0) {
      const monthlyEgressGiB = totalDiskGiB * (churnPctPerDay / 100) * 30;
      const bw = findInterRegionEgressPricePerGiB(currency, armRegionName);
      if (bw) {
        const monthly = bw.retailPrice * monthlyEgressGiB;
        vmMonthly += monthly;
        lineItems.monthly.push({
          category: 'Inter-region replication egress',
          detail: `~${monthlyEgressGiB.toFixed(1)} GiB/mo (churn ${churnPctPerDay}%/day × 30d) · ${bw.skuName || bw.meterName}`,
          amount: monthly,
        });
      } else {
        warnings.push(`No inter-region egress price found for ${armRegionName}/${currency}.`);
      }
    }

    // ---- Test failover VM compute (24h PAYG, OS-aware) ----
    if (vm.recommendedVm) {
      const os = (vm.os === 'windows' ? 'windows' : 'linux');
      const vmPrice = findVmPrice(currency, armRegionName, vm.recommendedVm, os);
      if (vmPrice) {
        const compute24h = vmPrice.retailPrice * TEST_HOURS;
        vmTest += compute24h;
        lineItems.test.push({
          category: 'Test failover VM compute (24h)',
          detail: `${vm.recommendedVm} — ${os} — ${vmPrice.productName}`,
          amount: compute24h,
        });
        // Informational only: equivalent monthly compute if VM ran continuously (not added)
        lineItems.test.push({
          category: 'Informational: equivalent monthly compute',
          detail: `${vm.recommendedVm} × ${HOURS_PER_MONTH}h`,
          amount: 0,
          info: vmHourlyToMonthly(vmPrice.retailPrice),
        });
      } else {
        warnings.push(`No VM price for ${vm.recommendedVm} (${vm.os}) in ${armRegionName}.`);
      }
    } else {
      warnings.push(`VM "${vm.name}" has no DR target selected — compute not estimated.`);
    }

    // ---- Standard Public IP (24h) ----
    if (includeTestPublicIp) {
      const pip = findStandardPublicIpPricePerHour(currency, armRegionName);
      if (pip) {
        const cost = pip.retailPrice * TEST_HOURS;
        vmTest += cost;
        lineItems.test.push({
          category: 'Standard Public IP (24h)',
          detail: pip.meterName,
          amount: cost,
        });
      }
    }

    totalMonthly += vmMonthly;
    totalTest += vmTest;
    perVm.push({
      vmId: vm.id,
      name: vm.name,
      monthlyTotal: round(vmMonthly),
      testTotal: round(vmTest),
      lineItems,
    });
  }

  return {
    currency,
    armRegionName,
    scenario,
    totals: {
      monthly: round(totalMonthly),
      testFailover24h: round(totalTest),
    },
    perVm,
    warnings: dedupe(warnings),
  };
}

function round(n) {
  return Math.round(n * 100) / 100;
}

function dedupe(arr) {
  return Array.from(new Set(arr));
}
