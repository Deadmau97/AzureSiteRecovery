// Azure managed disk tier tables.
// Tiers are billed at a flat monthly rate per SKU regardless of actual usage <= tier ceiling.
// Reference: https://learn.microsoft.com/azure/virtual-machines/disks-types

// [skuName, sizeGiB]
const PREMIUM_SSD = [
  ['P1', 4],
  ['P2', 8],
  ['P3', 16],
  ['P4', 32],
  ['P6', 64],
  ['P10', 128],
  ['P15', 256],
  ['P20', 512],
  ['P30', 1024],
  ['P40', 2048],
  ['P50', 4096],
  ['P60', 8192],
  ['P70', 16384],
  ['P80', 32767],
];

const STANDARD_SSD = [
  ['E1', 4],
  ['E2', 8],
  ['E3', 16],
  ['E4', 32],
  ['E6', 64],
  ['E10', 128],
  ['E15', 256],
  ['E20', 512],
  ['E30', 1024],
  ['E40', 2048],
  ['E50', 4096],
  ['E60', 8192],
  ['E70', 16384],
  ['E80', 32767],
];

export function pickDiskTier(sizeGiB, family /* 'Premium SSD' | 'Standard SSD' */) {
  const table = family === 'Premium SSD' ? PREMIUM_SSD : STANDARD_SSD;
  for (const [sku, ceiling] of table) {
    if (sizeGiB <= ceiling) return { sku, sizeGiB: ceiling, family };
  }
  const [sku, ceiling] = table[table.length - 1];
  return { sku, sizeGiB: ceiling, family };
}

export function listTiers(family) {
  const table = family === 'Premium SSD' ? PREMIUM_SSD : STANDARD_SSD;
  return table.map(([sku, sizeGiB]) => ({ sku, sizeGiB, family }));
}

export const DISK_FAMILIES = ['Standard SSD', 'Premium SSD'];
