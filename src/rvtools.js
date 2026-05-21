// RVTools parser. Autodetects XLSX (multi-sheet) vs CSV (vInfo.csv + vDisk.csv).
// We focus on these columns:
//   vInfo:  VM, CPUs, Memory (MiB), Powerstate, OS according to the configuration file
//   vDisk:  VM, Capacity MiB (or "Capacity MB"/"Capacity GB"), Disk
//
// Column names in RVTools have evolved across versions; we use a tolerant matcher.

import XLSX from 'xlsx';

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function pickColumn(row, candidates) {
  const keys = Object.keys(row);
  for (const cand of candidates) {
    const target = norm(cand);
    const k = keys.find((kk) => norm(kk) === target);
    if (k != null) return k;
  }
  // fuzzy contains
  for (const cand of candidates) {
    const target = norm(cand);
    const k = keys.find((kk) => norm(kk).includes(target));
    if (k != null) return k;
  }
  return null;
}

function parseSheetVInfo(rows) {
  if (!rows.length) return [];
  const vmCol = pickColumn(rows[0], ['VM']);
  const cpuCol = pickColumn(rows[0], ['CPUs', 'CPU']);
  const memCol = pickColumn(rows[0], ['Memory', 'Memory MiB', 'Memory MB']);
  const osCol = pickColumn(rows[0], [
    'OS according to the configuration file',
    'OS',
    'Guest OS',
  ]);
  const powerCol = pickColumn(rows[0], ['Powerstate', 'Power State']);

  return rows
    .map((r) => {
      const name = vmCol ? String(r[vmCol] || '').trim() : '';
      if (!name) return null;
      const vcpu = Number(r[cpuCol]) || 0;
      const memMiB = Number(r[memCol]) || 0;
      const os = osCol ? String(r[osCol] || '').toLowerCase() : '';
      const power = powerCol ? String(r[powerCol] || '').toLowerCase() : '';
      return {
        name,
        vcpu,
        ramGiB: memMiB > 0 ? +(memMiB / 1024).toFixed(2) : 0,
        os: /windows/.test(os) ? 'windows' : 'linux',
        powered: power ? /on/.test(power) : true,
      };
    })
    .filter(Boolean);
}

function parseSheetVDisk(rows) {
  if (!rows.length) return new Map();
  const vmCol = pickColumn(rows[0], ['VM']);
  // capacity in vDisk can be 'Capacity MiB', 'Capacity MB', 'Capacity', 'Capacity (MB)'
  const capCol = pickColumn(rows[0], [
    'Capacity MiB',
    'Capacity MB',
    'Capacity',
    'Capacity (MiB)',
    'Capacity (MB)',
    'Size MiB',
  ]);
  const diskCol = pickColumn(rows[0], ['Disk', 'Disk Key', 'Hard Disk']);

  const byVm = new Map();
  for (const r of rows) {
    const name = vmCol ? String(r[vmCol] || '').trim() : '';
    if (!name) continue;
    const capMiB = Number(r[capCol]) || 0;
    if (capMiB <= 0) continue;
    const sizeGiB = +(capMiB / 1024).toFixed(2);
    const label = diskCol ? String(r[diskCol] || '').trim() : '';
    if (!byVm.has(name)) byVm.set(name, []);
    byVm.get(name).push({ label: label || `Disk ${byVm.get(name).length + 1}`, sizeGiB });
  }
  return byVm;
}

export function parseRvtoolsBuffer(buffer, originalName = '') {
  const lower = originalName.toLowerCase();
  if (lower.endsWith('.csv')) {
    // Single CSV — assume vInfo
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const sheetName = wb.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '' });
    return { vms: parseSheetVInfo(rows), disksByVm: new Map(), warnings: ['CSV with no vDisk sheet — disks must be entered manually.'] };
  }

  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheetNames = wb.SheetNames;
  const find = (needle) => sheetNames.find((n) => norm(n) === norm(needle));

  const infoSheet = find('vInfo') || find('tabvInfo') || sheetNames.find((n) => /info/i.test(n));
  const diskSheet = find('vDisk') || find('tabvDisk') || sheetNames.find((n) => /disk/i.test(n));

  const warnings = [];
  let vms = [];
  let disksByVm = new Map();

  if (infoSheet) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[infoSheet], { defval: '' });
    vms = parseSheetVInfo(rows);
  } else {
    warnings.push('No vInfo sheet found.');
  }

  if (diskSheet) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[diskSheet], { defval: '' });
    disksByVm = parseSheetVDisk(rows);
  } else {
    warnings.push('No vDisk sheet found — disks must be entered manually.');
  }

  // Merge disks into vms
  const merged = vms.map((v) => ({
    ...v,
    id: cryptoRandomId(),
    disks: (disksByVm.get(v.name) || []).map((d, i) => ({
      id: cryptoRandomId(),
      label: d.label || `Disk ${i + 1}`,
      sizeGiB: d.sizeGiB,
      family: 'Standard SSD',
    })),
  }));

  return { vms: merged, warnings };
}

function cryptoRandomId() {
  return Math.random().toString(36).slice(2, 10);
}
