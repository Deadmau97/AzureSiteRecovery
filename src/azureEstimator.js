// Azure Calculator estimator — monthly cost orchestration for the general-purpose
// "Azure Calculator" tool (separate from ASR).
//
// Inputs:
//   {
//     region, currency,
//     vms: [{
//       id, name, vcpu, ramGiB, os, recommendedVm,
//       reservation: 'payg'|'1y'|'3y',
//       hybridBenefit: boolean,
//       disks: [{ family, sizeGiB }],   // includes OS + data disks
//       publicIp: boolean,
//       backup: { enabled, policy, retentionDays, redundancy, dailyChurnPct } | null,
//     }],
//     storageAccounts: [{ id, name, tier, redundancy, capacityGiB }],
//   }
//
// Output (per VM): { lineItems[], monthlyTotal } and a grand total.

import {
  findVmEffectiveHourly,
  findDiskPrice,
  findStandardPublicIpPricePerHour,
  findBackupProtectedInstanceMonthly,
  findBackupStoragePricePerGiBMonth,
  findBlobStoragePricePerGiBMonth,
  HOURS_PER_MONTH,
} from './prices.js';

export function estimateAzure(input) {
  const { region, currency } = input;
  const armRegionName = region;
  const warnings = [];
  const vms = [];

  let grandMonthly = 0;

  for (const vm of input.vms || []) {
    const lineItems = [];
    let vmMonthly = 0;

    // ---- Compute ----
    if (vm.recommendedVm) {
      const os = vm.os === 'windows' ? 'windows' : 'linux';
      const eff = findVmEffectiveHourly(currency, armRegionName, vm.recommendedVm, os, {
        reservation: vm.reservation || 'payg',
        hybridBenefit: !!vm.hybridBenefit,
      });
      if (eff) {
        const monthly = eff.hourly * HOURS_PER_MONTH;
        vmMonthly += monthly;
        lineItems.push({
          category: 'Compute',
          detail: `${vm.recommendedVm} \u2014 ${os} \u2014 ${eff.detail}${vm.hybridBenefit && os === 'windows' ? ' (AHB applied)' : ''}`,
          amount: monthly,
          meta: {
            hourly: eff.hourly,
            reservation: eff.reservation,
            hybridBenefit: eff.hybridBenefit,
            source: eff.source,
          },
        });
      } else {
        warnings.push(`No compute price for ${vm.recommendedVm} (${os}) in ${armRegionName}/${currency}.`);
      }
    }

    // ---- Disks (OS + data) ----
    let totalDiskGiB = 0;
    for (const d of vm.disks || []) {
      if (!d.family || !d.sku) continue;
      totalDiskGiB += d.sizeGiB || 0;
      const dp = findDiskPrice(currency, armRegionName, d.family, d.sku);
      if (dp) {
        vmMonthly += dp.retailPrice;
        lineItems.push({
          category: 'Disk',
          detail: `${d.family} ${d.sku} (${d.sizeGiB} GiB)${d.role ? ` \u2014 ${d.role}` : ''}`,
          amount: dp.retailPrice,
        });
      } else {
        warnings.push(`No price for ${d.family} ${d.sku} in ${armRegionName}.`);
      }
    }

    // ---- Public IP (Standard Static) ----
    if (vm.publicIp) {
      const ip = findStandardPublicIpPricePerHour(currency, armRegionName);
      if (ip) {
        const monthly = ip.retailPrice * HOURS_PER_MONTH;
        vmMonthly += monthly;
        lineItems.push({
          category: 'Public IP',
          detail: `Standard Static IPv4 \u2014 ${ip.meterName}`,
          amount: monthly,
        });
      } else {
        warnings.push(`No Standard Public IP price found for ${armRegionName}/${currency}.`);
      }
    }

    // ---- Backup ----
    if (vm.backup && vm.backup.enabled) {
      const { policy = 'daily', retentionDays = 30, redundancy = 'LRS', dailyChurnPct = 5 } = vm.backup;

      // Protected instance fee — tiered by source size (total disk GiB)
      const pi = findBackupProtectedInstanceMonthly(currency, armRegionName, totalDiskGiB || 1);
      if (pi) {
        vmMonthly += pi.monthly;
        const tiers = pi.breakdown.map((b) => `${b.tier}`).join(' + ');
        lineItems.push({
          category: 'Backup — Protected instance',
          detail: `Source ~${totalDiskGiB.toFixed(0)} GiB \u2014 ${tiers}`,
          amount: pi.monthly,
          meta: { breakdown: pi.breakdown },
        });
      } else {
        warnings.push(`No Backup protected-instance price for ${armRegionName}/${currency}.`);
      }

      // Backup storage — approximation:
      //   first full copy = totalDiskGiB
      //   incremental adds  = totalDiskGiB * (dailyChurnPct/100) per day
      //   over retention period, average size ~ baseline + churn * (retention/2)
      // Plus 30% overhead for metadata + recovery points (industry-rule-of-thumb).
      const ratePeriod = policy === 'weekly' ? Math.max(7, retentionDays) : retentionDays;
      const incremental = totalDiskGiB * (dailyChurnPct / 100) * (ratePeriod / 2);
      const storedGiB = (totalDiskGiB + incremental) * 1.3;
      const bs = findBackupStoragePricePerGiBMonth(currency, armRegionName, redundancy);
      if (bs && storedGiB > 0) {
        const monthly = bs.retailPrice * storedGiB;
        vmMonthly += monthly;
        lineItems.push({
          category: `Backup \u2014 ${redundancy} storage`,
          detail: `~${storedGiB.toFixed(0)} GiB stored (${policy}, ${retentionDays}d retention, ${dailyChurnPct}%/d churn)`,
          amount: monthly,
        });
      } else if (!bs) {
        warnings.push(`No Backup ${redundancy} storage price for ${armRegionName}/${currency}.`);
      }
    }

    grandMonthly += vmMonthly;
    vms.push({
      id: vm.id,
      name: vm.name,
      recommendedVm: vm.recommendedVm,
      os: vm.os,
      reservation: vm.reservation || 'payg',
      hybridBenefit: !!vm.hybridBenefit,
      monthly: vmMonthly,
      lineItems,
    });
  }

  // ---- Storage Accounts (independent of VMs) ----
  const storageAccounts = [];
  for (const sa of input.storageAccounts || []) {
    const lineItems = [];
    let monthly = 0;
    const sp = findBlobStoragePricePerGiBMonth(currency, armRegionName, sa.tier, sa.redundancy);
    if (sp && sa.capacityGiB > 0) {
      monthly = sp.retailPrice * sa.capacityGiB;
      lineItems.push({
        category: `Storage \u2014 ${sa.tier} ${sa.redundancy}`,
        detail: `${sa.capacityGiB} GiB stored \u2014 ${sp.meterName}`,
        amount: monthly,
      });
    } else if (!sp) {
      warnings.push(`No ${sa.tier}/${sa.redundancy} blob storage price for ${armRegionName}/${currency}.`);
    }
    grandMonthly += monthly;
    storageAccounts.push({
      id: sa.id,
      name: sa.name,
      tier: sa.tier,
      redundancy: sa.redundancy,
      capacityGiB: sa.capacityGiB,
      monthly,
      lineItems,
    });
  }

  return {
    region: armRegionName,
    currency,
    grandMonthly,
    vms,
    storageAccounts,
    warnings,
  };
}
