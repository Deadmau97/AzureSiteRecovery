// Curated catalog of common Azure VM sizes for the best-fit recommender.
// Each entry: { armSkuName, family, generation, vcpu, ramGiB, premiumIo, specialty }
// Specialty SKUs (GPU/HPC/M-series) are flagged so they can be excluded from auto-suggest
// but remain searchable.

const D_SIZES = [
  ['2', 2, 8],
  ['4', 4, 16],
  ['8', 8, 32],
  ['16', 16, 64],
  ['32', 32, 128],
  ['48', 48, 192],
  ['64', 64, 256],
  ['96', 96, 384],
];

const E_SIZES = [
  ['2', 2, 16],
  ['4', 4, 32],
  ['8', 8, 64],
  ['16', 16, 128],
  ['20', 20, 160],
  ['32', 32, 256],
  ['48', 48, 384],
  ['64', 64, 512],
  ['96', 96, 672],
  ['104', 104, 672],
];

const F_SIZES = [
  ['2', 2, 4],
  ['4', 4, 8],
  ['8', 8, 16],
  ['16', 16, 32],
  ['32', 32, 64],
  ['48', 48, 96],
  ['64', 64, 128],
  ['72', 72, 144],
];

const B_SIZES = [
  ['B1s', 'B1s', 1, 1],
  ['B1ms', 'B1ms', 1, 2],
  ['B2s', 'B2s', 2, 4],
  ['B2ms', 'B2ms', 2, 8],
  ['B4ms', 'B4ms', 4, 16],
  ['B8ms', 'B8ms', 8, 32],
  ['B12ms', 'B12ms', 12, 48],
  ['B16ms', 'B16ms', 16, 64],
  ['B20ms', 'B20ms', 20, 80],
];

const M_SIZES = [
  ['M8ms', 8, 218.75],
  ['M16ms', 16, 437.5],
  ['M32ts', 32, 192],
  ['M32ls', 32, 256],
  ['M32ms', 32, 875],
  ['M64s', 64, 1024],
  ['M64ms', 64, 1792],
  ['M128s', 128, 2048],
  ['M128ms', 128, 3892],
];

const catalog = [];

function add(entry) {
  catalog.push(entry);
}

// D-series general purpose (Intel + AMD), v3..v5
for (const gen of [3, 4, 5]) {
  for (const [suffix, vcpu, ram] of D_SIZES) {
    // Intel Ds_v
    add({ armSkuName: `Standard_D${suffix}s_v${gen}`, family: 'Dsv', generation: gen, vcpu, ramGiB: ram, premiumIo: true, specialty: false, arch: 'x64', vendor: 'Intel' });
    if (gen >= 4) {
      // AMD Das_v / Dads_v
      add({ armSkuName: `Standard_D${suffix}as_v${gen}`, family: 'Dasv', generation: gen, vcpu, ramGiB: ram, premiumIo: true, specialty: false, arch: 'x64', vendor: 'AMD' });
    }
    if (gen >= 5) {
      add({ armSkuName: `Standard_D${suffix}ads_v${gen}`, family: 'Dadsv', generation: gen, vcpu, ramGiB: ram, premiumIo: true, specialty: false, arch: 'x64', vendor: 'AMD' });
      add({ armSkuName: `Standard_D${suffix}ds_v${gen}`, family: 'Ddsv', generation: gen, vcpu, ramGiB: ram, premiumIo: true, specialty: false, arch: 'x64', vendor: 'Intel' });
    }
  }
}

// E-series memory optimized
for (const gen of [3, 4, 5]) {
  for (const [suffix, vcpu, ram] of E_SIZES) {
    add({ armSkuName: `Standard_E${suffix}s_v${gen}`, family: 'Esv', generation: gen, vcpu, ramGiB: ram, premiumIo: true, specialty: false, arch: 'x64', vendor: 'Intel' });
    if (gen >= 4) {
      add({ armSkuName: `Standard_E${suffix}as_v${gen}`, family: 'Easv', generation: gen, vcpu, ramGiB: ram, premiumIo: true, specialty: false, arch: 'x64', vendor: 'AMD' });
    }
    if (gen >= 5) {
      add({ armSkuName: `Standard_E${suffix}ads_v${gen}`, family: 'Eadsv', generation: gen, vcpu, ramGiB: ram, premiumIo: true, specialty: false, arch: 'x64', vendor: 'AMD' });
      add({ armSkuName: `Standard_E${suffix}ds_v${gen}`, family: 'Edsv', generation: gen, vcpu, ramGiB: ram, premiumIo: true, specialty: false, arch: 'x64', vendor: 'Intel' });
    }
  }
}

// F-series compute optimized (v2 only widely available)
for (const [suffix, vcpu, ram] of F_SIZES) {
  add({ armSkuName: `Standard_F${suffix}s_v2`, family: 'Fsv', generation: 2, vcpu, ramGiB: ram, premiumIo: true, specialty: false, arch: 'x64', vendor: 'Intel' });
}

// B-series burstable
for (const [_, name, vcpu, ram] of B_SIZES) {
  add({ armSkuName: `Standard_${name}`, family: 'B', generation: 1, vcpu, ramGiB: ram, premiumIo: true, specialty: false, arch: 'x64', vendor: 'Intel' });
}

// M-series (specialty: huge memory)
for (const [name, vcpu, ram] of M_SIZES) {
  add({ armSkuName: `Standard_${name}`, family: 'M', generation: 1, vcpu, ramGiB: ram, premiumIo: true, specialty: true, arch: 'x64', vendor: 'Intel' });
}

// GPU (specialty: searchable only)
const NC_SIZES = [
  ['NC4as_T4_v3', 4, 28],
  ['NC8as_T4_v3', 8, 56],
  ['NC16as_T4_v3', 16, 110],
  ['NC64as_T4_v3', 64, 440],
];
for (const [name, vcpu, ram] of NC_SIZES) {
  add({ armSkuName: `Standard_${name}`, family: 'NC', generation: 3, vcpu, ramGiB: ram, premiumIo: true, specialty: true, arch: 'x64', vendor: 'AMD' });
}

// HC / HB HPC (specialty)
add({ armSkuName: 'Standard_HB120rs_v3', family: 'HB', generation: 3, vcpu: 120, ramGiB: 448, premiumIo: true, specialty: true, arch: 'x64', vendor: 'AMD' });
add({ armSkuName: 'Standard_HC44rs', family: 'HC', generation: 1, vcpu: 44, ramGiB: 352, premiumIo: true, specialty: true, arch: 'x64', vendor: 'Intel' });

export const VM_CATALOG = catalog;

const byName = new Map(catalog.map((v) => [v.armSkuName.toLowerCase(), v]));
export function getVmSpec(armSkuName) {
  return byName.get((armSkuName || '').toLowerCase()) || null;
}
