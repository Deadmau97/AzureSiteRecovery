// Azure Calculator estimator — row-based cost orchestration matching the official
// Azure Pricing Calculator UX: every item the user adds (VM, disk, IP, backup, storage
// account) is its own configurable row, priced independently and returned as a separate
// line so the UI can render and remove them individually.

import {
  findVmEffectiveHourly,
  findDiskPrice,
  findFlexDiskPrice,
  findStandardPublicIpPricePerHour,
  findPublicIpPriceBySku,
  findBackupProtectedInstanceMonthly,
  findBackupStoragePricePerGiBMonth,
  findBlobStoragePricePerGiBMonth,
  findBlobOperationsPricePer10K,
  findAzureFilesPricePerGiBMonth,
  findVpnGatewayPrice,
  findNatGatewayPrice,
  findAppServicePlanPrice,
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
            // Reservations are billed for the full month; PAYG honours the user-defined
            // uptime so part-time machines are priced realistically.
            const isPayg = (row.reservation || 'payg') === 'payg';
            const hours = isPayg
              ? Math.min(HOURS_PER_MONTH, Math.max(0, Number(row.hoursPerMonth) || HOURS_PER_MONTH))
              : HOURS_PER_MONTH;
            const m = eff.hourly * hours;
            monthly += m;
            const uptimeDetail = isPayg && hours < HOURS_PER_MONTH ? ` @ ${hours}h/mo` : '';
            lineItems.push({
              category: 'Compute',
              detail: `${row.recommendedVm} \u2014 ${os} \u2014 ${eff.detail}${eff.hybridBenefit && os === 'windows' ? ' (AHB applied)' : ''}${uptimeDetail}`,
              amount: m,
            });
          } else {
            warnings.push(`No compute price for ${row.recommendedVm} (${os}) in ${armRegionName}/${currency}.`);
          }
        }
        // Inline disks (index 0 is the OS disk, the rest are data disks added by the user)
        const disks = Array.isArray(row.disks) ? row.disks : [];
        disks.forEach((disk, idx) => {
          if (!disk) return;
          const label = idx === 0 ? 'OS disk' : `Data disk: ${disk.label || `Disk ${idx}`}`;

          // Premium SSD v2 / Ultra Disk — priced per provisioned GiB + IOPS + MB/s.
          if (disk.family === 'Premium SSD v2' || disk.family === 'Ultra Disk') {
            const fp = findFlexDiskPrice(
              currency, armRegionName, disk.family,
              disk.sizeGiB, disk.iops, disk.throughputMBps
            );
            if (fp) {
              monthly += fp.total;
              const parts = fp.lines.map((l) => `${l.part}: ${l.detail}`).join(' · ');
              lineItems.push({
                category: label,
                detail: `${disk.family} — ${disk.sizeGiB} GiB / ${disk.iops || 0} IOPS / ${disk.throughputMBps || 0} MB/s — ${parts}`,
                amount: fp.total,
              });
            } else {
              warnings.push(`No price for ${disk.family} in ${armRegionName}.`);
            }
            return;
          }

          // Standard SSD / Premium SSD — tier-ladder priced.
          if (!disk.sku) return;
          const dp = findDiskPrice(currency, armRegionName, disk.family, disk.sku);
          if (dp) {
            monthly += dp.retailPrice;
            lineItems.push({
              category: label,
              detail: `${disk.family} ${disk.sku} (${disk.sizeGiB} GiB)`,
              amount: dp.retailPrice,
            });
          } else {
            warnings.push(`No disk price for ${disk.family} ${disk.sku} in ${armRegionName}.`);
          }
        });
        break;
      }

      case 'disk': {
        // Standalone disk rows are no longer added via the UI but the estimator still
        // honours them for backward compatibility (e.g. older payloads).
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
        const skuName = row.skuName || 'Standard';
        const ip = findPublicIpPriceBySku(currency, armRegionName, skuName)
          || findStandardPublicIpPricePerHour(currency, armRegionName);
        const count = Math.max(1, Number(row.count) || 1);
        if (ip) {
          const m = ip.retailPrice * HOURS_PER_MONTH * count;
          monthly += m;
          lineItems.push({
            category: 'Public IP',
            detail: `${count} \u00d7 ${skuName} Static IPv4`,
            amount: m,
          });
        } else {
          warnings.push(`No ${skuName} Public IP price for ${armRegionName}/${currency}.`);
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
        const writeOps10K = Math.max(0, Number(row.writeOps10K) || 0);
        const readOps10K = Math.max(0, Number(row.readOps10K) || 0);
        if (writeOps10K > 0) {
          const op = findBlobOperationsPricePer10K(currency, armRegionName, row.tier, row.redundancy, 'write');
          if (op) {
            const m = op.retailPrice * writeOps10K;
            monthly += m;
            lineItems.push({ category: 'Write operations', detail: `${writeOps10K} \u00d7 10K`, amount: m });
          }
        }
        if (readOps10K > 0) {
          const op = findBlobOperationsPricePer10K(currency, armRegionName, row.tier, row.redundancy, 'read');
          if (op) {
            const m = op.retailPrice * readOps10K;
            monthly += m;
            lineItems.push({ category: 'Read operations', detail: `${readOps10K} \u00d7 10K`, amount: m });
          }
        }
        break;
      }

      case 'files': {
        const cap = Math.max(0, Number(row.capacityGiB) || 0);
        const fp = findAzureFilesPricePerGiBMonth(currency, armRegionName, row.tier, row.redundancy);
        if (fp && cap > 0) {
          const m = fp.retailPrice * cap;
          monthly += m;
          lineItems.push({
            category: `${row.tier} ${row.redundancy} file share`,
            detail: `${cap} GiB ${row.tier === 'Premium' ? 'provisioned' : 'stored'}`,
            amount: m,
          });
        } else if (!fp) {
          warnings.push(`No ${row.tier}/${row.redundancy} Azure Files price for ${armRegionName}/${currency}.`);
        }
        break;
      }

      case 'vpn': {
        if (row.skuName) {
          const p = findVpnGatewayPrice(currency, armRegionName, row.skuName);
          if (p) {
            const m = p.retailPrice * HOURS_PER_MONTH;
            monthly += m;
            lineItems.push({
              category: 'VPN Gateway',
              detail: `${row.skuName} \u2014 ${HOURS_PER_MONTH}h/mo`,
              amount: m,
            });
          } else {
            warnings.push(`No VPN Gateway price for ${row.skuName} in ${armRegionName}/${currency}.`);
          }
        }
        if (row.publicIp) {
          const sku = row.publicIpSku || 'Standard';
          const ip = findPublicIpPriceBySku(currency, armRegionName, sku);
          if (ip) {
            const m = ip.retailPrice * HOURS_PER_MONTH;
            monthly += m;
            lineItems.push({ category: 'Public IP (VPN)', detail: `${sku} Static IPv4`, amount: m });
          }
        }
        break;
      }

      case 'nat': {
        const sku = row.skuName || 'Standard';
        const { hour, data } = findNatGatewayPrice(currency, sku);
        if (hour) {
          const m = hour.retailPrice * HOURS_PER_MONTH;
          monthly += m;
          lineItems.push({
            category: 'NAT Gateway',
            detail: `${sku} hourly fee \u00d7 ${HOURS_PER_MONTH}h`,
            amount: m,
          });
        } else {
          warnings.push(`No NAT Gateway hourly price (${sku}) for ${currency}.`);
        }
        const dataGiB = Math.max(0, Number(row.dataProcessedGiB) || 0);
        if (data && dataGiB > 0) {
          const m = data.retailPrice * dataGiB;
          monthly += m;
          lineItems.push({
            category: 'NAT data processed',
            detail: `${dataGiB} GiB`,
            amount: m,
          });
        }
        if (row.publicIp) {
          const ipSku = row.publicIpSku || 'Standard';
          const ip = findPublicIpPriceBySku(currency, armRegionName, ipSku);
          if (ip) {
            const m = ip.retailPrice * HOURS_PER_MONTH;
            monthly += m;
            lineItems.push({ category: 'Public IP (NAT)', detail: `${ipSku} Static IPv4`, amount: m });
          }
        }
        break;
      }

      case 'appservice': {
        if (row.productName && row.skuName) {
          const p = findAppServicePlanPrice(currency, armRegionName, row.productName, row.skuName);
          if (p) {
            const instances = Math.max(1, Number(row.instances) || 1);
            const m = p.retailPrice * HOURS_PER_MONTH * instances;
            monthly += m;
            lineItems.push({
              category: 'App Service Plan',
              detail: `${row.productName} \u2014 ${row.skuName} \u00d7 ${instances}`,
              amount: m,
            });
          } else {
            warnings.push(`No App Service Plan price for ${row.productName}/${row.skuName} in ${armRegionName}/${currency}.`);
          }
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
