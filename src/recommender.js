// Best-fit Azure VM recommender for DR.
// Rules (from project requirements):
//  - vCPU >= source vCPU (prefer exact)
//  - RAM  >= source RAM
//  - Prefer newest generation (v5 > v4 > v3)
//  - Exclude specialty (GPU/HPC/M) from auto-suggest but keep them searchable
//  - Default preference: D-series general purpose; jump to E-series when RAM/vCPU ratio > 4

import { VM_CATALOG } from './vmCatalog.js';

function ramRatio(specOrSource) {
  return specOrSource.ramGiB / Math.max(1, specOrSource.vcpu);
}

export function recommendVms(source, { limit = 5 } = {}) {
  const sourceVcpu = Number(source.vcpu) || 1;
  const sourceRam = Number(source.ramGiB) || 1;
  const sourceRatio = sourceRam / sourceVcpu;
  const prefersMemory = sourceRatio > 4; // E-series territory

  const candidates = VM_CATALOG.filter(
    (vm) => !vm.specialty && vm.vcpu >= sourceVcpu && vm.ramGiB >= sourceRam
  );

  const scored = candidates.map((vm) => {
    const vcpuOverhead = vm.vcpu - sourceVcpu;
    const ramOverhead = vm.ramGiB - sourceRam;

    // Lower score = better fit. Weights tuned so vCPU match dominates.
    let score = vcpuOverhead * 10 + ramOverhead * 0.5;

    // Strong reward for newest generation
    score -= vm.generation * 5;

    // Prefer matching workload class
    if (prefersMemory) {
      if (/^E/.test(vm.family)) score -= 8;
    } else {
      if (/^D/.test(vm.family)) score -= 6;
      if (/^F/.test(vm.family) && vcpuOverhead === 0) score -= 2;
    }

    // Slight nudge toward Intel-default unless source is clearly AMD-friendly (we don't know,
    // so just keep parity)
    return { vm, score, vcpuOverhead, ramOverhead };
  });

  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, limit).map((s) => ({
    armSkuName: s.vm.armSkuName,
    family: s.vm.family,
    generation: s.vm.generation,
    vcpu: s.vm.vcpu,
    ramGiB: s.vm.ramGiB,
    vendor: s.vm.vendor,
    vcpuOverhead: s.vcpuOverhead,
    ramOverhead: s.vcpuOverhead === 0 ? s.ramOverhead : s.ramOverhead,
    score: Number(s.score.toFixed(2)),
  }));
}

export function searchVms(query, { limit = 25, includeSpecialty = true } = {}) {
  const q = (query || '').trim().toLowerCase();
  let pool = VM_CATALOG;
  if (!includeSpecialty) pool = pool.filter((v) => !v.specialty);
  if (!q) {
    return pool.slice(0, limit).map(plain);
  }
  const hits = pool.filter(
    (v) =>
      v.armSkuName.toLowerCase().includes(q) ||
      v.family.toLowerCase().includes(q) ||
      (q.match(/^\d+$/) && v.vcpu === Number(q))
  );
  return hits.slice(0, limit).map(plain);
}

function plain(v) {
  return {
    armSkuName: v.armSkuName,
    family: v.family,
    generation: v.generation,
    vcpu: v.vcpu,
    ramGiB: v.ramGiB,
    vendor: v.vendor,
    specialty: v.specialty,
  };
}
