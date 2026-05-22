// Azure Calculator estimator — row-based cost orchestration matching the official
// Azure Pricing Calculator UX: every item the user adds (VM, disk, IP, backup, storage
// account) is its own configurable row, priced independently and returned as a separate
// line so the UI can render and remove them individually.

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
  const { region: armRegionName, currency } = input;
  const warnings = [];
  const items = [];
  let grandMonthly = 0;

  // Build a name index for backup rows so we can reference the parent VM by id even
  // after the user renames the VM.
  const vmById = new Map();
  for (const row of input.rows || []) {
    if (row.type === 'vm') vmById.set(row.id, row);
  }

  for (const row of input.rows || []) {
    let monthly = 0;
    const lineItems = [];

    switch (row.type) {
      case 'vm': {
        if (row.recommendedVm) {
          const os = row.os === 'windows' ? 'windows' : 'linux';
          const eff = findVmEffectiveHourly(currency, armRegionName, row.recommendedVm, os, {
            reservation: row.reservation || 'payg',
            hybridBenefit: !!row.hybridBenefit,
          });
          if (eff) {
            const m = eff.hourly * HOURS_PER_MONTH;
            monthly += m;
            lineItems.push({
              category: 'Compute',
              detail: `${row.recommendedVm} \u2014 ${os} \u2014 ${eff.detail}${eff.hybridBenefit && os === 'windows' ? ' (AHB applied)' : ''}`,
              amount: m,
            });
          } else {
            warnings.push(`No compute price for ${row.recommendedVm} (${os}) in ${armRegionName}/${currency}.`);
          }
        }
        // Inline OS disk (every VM has exactly one)
        if (row.osDisk && row.osDisk.sku) {
          const dp = findDiskPrice(currency, armRegionName, row.osDisk.family, row.osDisk.sku);
          if (dp) {
            monthly += dp.retailPrice;
            lineItems.push({
              category: 'OS disk',
              detail: `${row.osDisk.family} ${row.osDisk.sku} (${row.osDisk.sizeGiB} GiB)`,
              amount: dp.retailPrice,
            });
          } else {
            warnings.push(`No OS-disk price for ${row.osDisk.family} ${row.osDisk.sku} in ${armRegionName}.`);
          }
        }
        break;
      }

      case 'disk': {
        if (row.sku) {
          const dp = findDiskPrice(currency, armRegionName, row.family, row.sku);
          if (dp) {
            monthly += dp.retailPrice;
            const attachedName = row.attachedToVmId ? vmById.get(row.attachedToVmId)?.name : null;
            lineItems.push({
              category: 'Managed disk',
              detail: `${row.family} ${row.sku} (${row.sizeGiB} GiB)${attachedName ? ` \u2014 attached to ${attachedName}` : ''}`,
              amount: dp.retailPrice,
            });
          } else {
            warnings.push(`No price for ${row.family} ${row.sku} in ${armRegionName}.`);
          }
        }
        break;
      }

      case 'ip': {
        const ip = findStandardPublicIpPricePerHour(currency, armRegionName);
        const count = Math.max(1, Number(row.count) || 1);
        if (ip) {
          const m = ip.retailPrice * HOURS_PER_MONTH * count;
          monthly += m;
          lineItems.push({
            category: 'Public IP',
            detail: `${count} \u00d7 Standard Static IPv4`,
            amount: m,
          });
        } else {
          warnings.push(`No Standard Public IP price for ${armRegionName}/${currency}.`);
        }
        break;
      }

      case 'backup': {
        const sourceGiB = Math.max(1, Number(row.sourceSizeGiB) || 1);
        const policy = row.policy || 'daily';
        const retentionDays = Number(row.retentionDays) || 30;
        const redundancy = row.redundancy || 'LRS';
        const dailyChurnPct = Number(row.dailyChurnPct) || 5;

        const pi = findBackupProtectedInstanceMonthly(currency, armRegionName, sourceGiB);
        if (pi) {
          monthly += pi.monthly;
          const tiers = pi.breakdown.map((b) => b.tier).join(' + ');
          lineItems.push({
            category: 'Protected instance',
            detail: `Source ~${sourceGiB.toFixed(0)} GiB \u2014 ${tiers}`,
            amount: pi.monthly,
          });
        } else {
          warnings.push(`No Backup protected-instance price for ${armRegionName}/${currency}.`);
        }

        const ratePeriod = policy === 'weekly' ? Math.max(7, retentionDays) : retentionDays;
        const incremental = sourceGiB * (dailyChurnPct / 100) * (ratePeriod / 2);
        const storedGiB = (sourceGiB + incremental) * 1.3;
        const bs = findBackupStoragePricePerGiBMonth(currency, armRegionName, redundancy);
        if (bs && storedGiB > 0) {
          const m = bs.retailPrice * storedGiB;
          monthly += m;
          lineItems.push({
            category: `${redundancy} backup storage`,
            detail: `~${storedGiB.toFixed(0)} GiB stored (${policy}, ${retentionDays}d retention, ${dailyChurnPct}%/d churn)`,
            amount: m,
          });
        } else if (!bs) {
          warnings.push(`No Backup ${redundancy} storage price for ${armRegionName}/${currency}.`);
        }
        break;
      }

      case 'storage': {
        const cap = Math.max(0, Number(row.capacityGiB) || 0);
        const sp = findBlobStoragePricePerGiBMonth(currency, armRegionName, row.tier, row.redundancy);
        if (sp && cap > 0) {
          const m = sp.retailPrice * cap;
          monthly += m;
          lineItems.push({
            category: `${row.tier} ${row.redundancy} blob`,
            detail: `${cap} GiB stored`,
            amount: m,
          });
        } else if (!sp) {
          warnings.push(`No ${row.tier}/${row.redundancy} blob storage price for ${armRegionName}/${currency}.`);
        }
        break;
      }

      default:
        warnings.push(`Unknown row type: ${row.type}`);
    }

    grandMonthly += monthly;
    items.push({
      id: row.id,
      type: row.type,
      name: row.name,
      parentVmId: row.parentVmId || null,
      monthly,
      lineItems,
    });
  }

  return { region: armRegionName, currency, grandMonthly, items, warnings };
}
