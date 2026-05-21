// Azure Calculator frontend.
// Vanilla ES modules.

const SERVICES = [
  {
    id: 'vm',
    title: 'Virtual Machines',
    sub: 'Compute, OS disk, reservations, AHB',
    icon: '/icons/compute/10021-icon-service-Virtual-Machine.svg',
    defaultOn: true,
    required: true,
  },
  {
    id: 'disks',
    title: 'Managed Disks',
    sub: 'Standard / Premium SSD',
    icon: '/icons/compute/10032-icon-service-Disks.svg',
    defaultOn: true,
  },
  {
    id: 'backup',
    title: 'Azure Backup',
    sub: 'Per-VM Backup add-on',
    icon: '/icons/storage/00017-icon-service-Recovery-Services-Vaults.svg',
    defaultOn: true,
  },
  {
    id: 'storage',
    title: 'Storage Accounts',
    sub: 'Blob (Hot/Cool/Archive)',
    icon: '/icons/storage/10086-icon-service-Storage-Accounts.svg',
    defaultOn: true,
  },
  {
    id: 'pip',
    title: 'Public IP',
    sub: 'Standard Static IPv4',
    icon: '/icons/networking/10069-icon-service-Public-IP-Addresses.svg',
    defaultOn: false,
  },
];

const state = {
  region: null,
  currency: 'EUR',
  servicesEnabled: new Set(SERVICES.filter((s) => s.defaultOn).map((s) => s.id)),
  vms: [],
  storageAccounts: [],
  diskTiers: { 'Standard SSD': [], 'Premium SSD': [] },
  lastEstimate: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const uid = () => Math.random().toString(36).slice(2, 10);
const fmt = (n) => {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: state.currency }).format(n);
  } catch {
    return `${(n || 0).toFixed(2)} ${state.currency}`;
  }
};

init();

async function init() {
  await Promise.all([loadRegions(), loadCurrencies(), loadDiskTiers()]);
  renderServices();
  wireToolbar();
  wireBackupModal();
  pollStatus();
  addBlankVm();
  applyServiceVisibility();
}

// ---------- Bootstrap data ----------
async function loadRegions() {
  const r = await fetch('/api/regions').then((x) => x.json());
  const sel = $('#regionSelect');
  sel.innerHTML = '';
  for (const region of r) {
    const opt = document.createElement('option');
    opt.value = region.armRegionName;
    opt.textContent = region.displayName;
    sel.appendChild(opt);
  }
  state.region = r[0].armRegionName;
  sel.value = state.region;
  sel.addEventListener('change', () => (state.region = sel.value));
}

async function loadCurrencies() {
  const c = await fetch('/api/currencies').then((x) => x.json());
  const sel = $('#currencySelect');
  sel.innerHTML = '';
  for (const cur of c) {
    const opt = document.createElement('option');
    opt.value = cur;
    opt.textContent = cur;
    sel.appendChild(opt);
  }
  state.currency = c[0];
  sel.value = state.currency;
  sel.addEventListener('change', () => (state.currency = sel.value));
}

async function loadDiskTiers() {
  const [std, prem] = await Promise.all([
    fetch('/api/disk-tiers?family=Standard%20SSD').then((x) => x.json()),
    fetch('/api/disk-tiers?family=Premium%20SSD').then((x) => x.json()),
  ]);
  state.diskTiers['Standard SSD'] = std;
  state.diskTiers['Premium SSD'] = prem;
}

function pickDiskTier(family, sizeGiB) {
  const tiers = state.diskTiers[family] || [];
  return tiers.find((t) => t.sizeGiB >= sizeGiB) || tiers[tiers.length - 1] || null;
}

async function pollStatus(force = false) {
  const pill = $('#statusPill');
  try {
    const s = await fetch('/api/status').then((x) => x.json());
    if (s.warming) {
      pill.textContent = 'Warming prices…';
      pill.className = 'status-pill warming';
      setTimeout(() => pollStatus(), 1500);
    } else if (s.lastError) {
      pill.textContent = 'Price cache error';
      pill.className = 'status-pill error';
    } else {
      const cur = s.currencies.find((c) => c.currency === state.currency);
      const counts = cur ? `VMs ${cur.vmCount} · Disks ${cur.diskCount} · Backup ${cur.backupCount} · Blob ${cur.blobStorageCount}` : 'Ready';
      pill.textContent = counts;
      pill.className = 'status-pill ready';
    }
  } catch {
    pill.textContent = 'Status check failed';
    pill.className = 'status-pill error';
  }
}

// ---------- Services strip ----------
function renderServices() {
  const grid = $('#servicesGrid');
  grid.innerHTML = '';
  for (const svc of SERVICES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'service-tile';
    btn.setAttribute('aria-pressed', state.servicesEnabled.has(svc.id));
    btn.dataset.serviceId = svc.id;
    btn.innerHTML = `
      <img src="${svc.icon}" alt="" />
      <span class="st-body">
        <span class="st-title">${svc.title}</span>
        <span class="st-sub">${svc.sub}</span>
      </span>
      <span class="st-check">✓</span>
    `;
    btn.addEventListener('click', () => {
      if (svc.required) return;
      if (state.servicesEnabled.has(svc.id)) state.servicesEnabled.delete(svc.id);
      else state.servicesEnabled.add(svc.id);
      btn.setAttribute('aria-pressed', state.servicesEnabled.has(svc.id));
      applyServiceVisibility();
    });
    grid.appendChild(btn);
  }
}

function applyServiceVisibility() {
  $('#vmSectionWrapper').hidden = !state.servicesEnabled.has('vm');
  $('#storageSectionWrapper').hidden = !state.servicesEnabled.has('storage');

  // Show/hide per-VM controls
  const showDisks = state.servicesEnabled.has('disks');
  const showBackup = state.servicesEnabled.has('backup');
  const showPip = state.servicesEnabled.has('pip');
  $$('#vmList .vm-card').forEach((card) => {
    card.querySelector('.vm-disks').hidden = !showDisks;
    card.querySelector('.backup-btn').hidden = !showBackup;
    card.querySelector('.vm-backup-summary').hidden = !showBackup;
    const pip = card.querySelector('.vm-pip').closest('label');
    pip.hidden = !showPip;
  });
}

// ---------- Toolbar ----------
function wireToolbar() {
  $('#refreshPricesBtn').addEventListener('click', async () => {
    await fetch('/api/refresh-prices', { method: 'POST' });
    pollStatus(true);
  });
  $('#addVmBtn').addEventListener('click', () => addBlankVm());
  $('#rvtoolsFile').addEventListener('change', onUploadRvtools);
  $('#addStorageBtn').addEventListener('click', () => addStorageAccount());
  $('#estimateBtn').addEventListener('click', runEstimate);
  $('#currencySelect').addEventListener('change', () => pollStatus(true));
}

// ---------- VM cards ----------
function addBlankVm() {
  const vm = {
    id: uid(),
    name: `VM-${state.vms.length + 1}`,
    vcpu: 2,
    ramGiB: 8,
    os: 'linux',
    recommendedVm: null,
    reservation: 'payg',
    hybridBenefit: false,
    publicIp: false,
    disks: [{ id: uid(), family: 'Standard SSD', sizeGiB: 128, role: 'OS' }],
    backup: null,
  };
  state.vms.push(vm);
  renderVmCard(vm);
  applyServiceVisibility();
}

function renderVmCard(vm) {
  const tpl = $('#vmCardTpl').content.cloneNode(true);
  const card = tpl.querySelector('.vm-card');
  card.dataset.vmId = vm.id;

  const nameInput = card.querySelector('.vm-name');
  const vcpuInput = card.querySelector('.vm-vcpu');
  const ramInput = card.querySelector('.vm-ram');
  const skuSelect = card.querySelector('.vm-sku');
  const reservationSel = card.querySelector('.vm-reservation');
  const ahbInput = card.querySelector('.vm-ahb');
  const ahbLabel = card.querySelector('.ahb-label');
  const pipInput = card.querySelector('.vm-pip');
  const osButtons = $$('.os-btn', card);
  const disksWrap = card.querySelector('.disk-rows');
  const backupBtn = card.querySelector('.backup-btn');
  const backupLabel = card.querySelector('.backup-label');
  const backupSummary = card.querySelector('.vm-backup-summary');

  nameInput.value = vm.name;
  vcpuInput.value = vm.vcpu;
  ramInput.value = vm.ramGiB;
  reservationSel.value = vm.reservation;
  ahbInput.checked = vm.hybridBenefit;
  pipInput.checked = vm.publicIp;
  osButtons.forEach((b) => b.setAttribute('aria-pressed', b.dataset.os === vm.os));
  updateAhbLabel();

  nameInput.addEventListener('input', () => (vm.name = nameInput.value));
  vcpuInput.addEventListener('change', () => {
    vm.vcpu = Number(vcpuInput.value) || 0;
    refreshRecommendations();
  });
  ramInput.addEventListener('change', () => {
    vm.ramGiB = Number(ramInput.value) || 0;
    refreshRecommendations();
  });
  reservationSel.addEventListener('change', () => (vm.reservation = reservationSel.value));
  ahbInput.addEventListener('change', () => (vm.hybridBenefit = ahbInput.checked));
  pipInput.addEventListener('change', () => (vm.publicIp = pipInput.checked));
  osButtons.forEach((b) =>
    b.addEventListener('click', () => {
      vm.os = b.dataset.os;
      osButtons.forEach((other) => other.setAttribute('aria-pressed', other === b));
      updateAhbLabel();
    })
  );
  skuSelect.addEventListener('change', () => (vm.recommendedVm = skuSelect.value || null));

  function updateAhbLabel() {
    // AHB only meaningful for Windows
    ahbLabel.classList.toggle('disabled', vm.os !== 'windows');
  }

  card.querySelector('.vm-remove').addEventListener('click', () => {
    state.vms = state.vms.filter((v) => v.id !== vm.id);
    card.remove();
  });

  card.querySelector('.add-disk').addEventListener('click', () => {
    const d = { id: uid(), family: 'Standard SSD', sizeGiB: 128, role: '' };
    vm.disks.push(d);
    renderDiskRow(vm, d, disksWrap);
  });

  for (const d of vm.disks) renderDiskRow(vm, d, disksWrap);

  backupBtn.addEventListener('click', () => openBackupModal(vm));
  function refreshBackupUi() {
    if (vm.backup && vm.backup.enabled) {
      backupBtn.classList.add('active');
      backupLabel.textContent = 'Backup configured';
      backupSummary.textContent = `${vm.backup.policy} · ${vm.backup.retentionDays}d · ${vm.backup.redundancy}`;
    } else {
      backupBtn.classList.remove('active');
      backupLabel.textContent = 'Add Backup';
      backupSummary.textContent = '';
    }
  }
  vm._refreshBackupUi = refreshBackupUi;
  refreshBackupUi();

  // Initial recommendation fetch
  refreshRecommendationsForVm(vm, skuSelect);

  $('#vmList').appendChild(card);
}

async function refreshRecommendationsForVm(vm, skuSelect) {
  try {
    const r = await fetch('/api/recommend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vcpu: vm.vcpu, ramGiB: vm.ramGiB }),
    }).then((x) => x.json());
    skuSelect.innerHTML = '';
    if (!Array.isArray(r) || r.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No match';
      skuSelect.appendChild(opt);
      vm.recommendedVm = null;
      return;
    }
    for (const rec of r) {
      const opt = document.createElement('option');
      opt.value = rec.armSkuName;
      opt.textContent = `${rec.armSkuName} — ${rec.vcpu}v / ${rec.ramGiB}GiB`;
      skuSelect.appendChild(opt);
    }
    skuSelect.value = r[0].armSkuName;
    vm.recommendedVm = r[0].armSkuName;
  } catch (e) {
    console.error('recommend error', e);
  }
}

function refreshRecommendations() {
  for (const vm of state.vms) {
    const card = $(`.vm-card[data-vm-id="${vm.id}"]`);
    if (!card) continue;
    const sel = card.querySelector('.vm-sku');
    refreshRecommendationsForVm(vm, sel);
  }
}

function renderDiskRow(vm, d, container) {
  const tpl = $('#diskRowTpl').content.cloneNode(true);
  const row = tpl.querySelector('.disk-row');
  row.dataset.diskId = d.id;
  const familySel = row.querySelector('.disk-family');
  const sizeInput = row.querySelector('.disk-size');
  const skuLabel = row.querySelector('.disk-sku');
  const roleInput = row.querySelector('.disk-role');

  familySel.value = d.family;
  sizeInput.value = d.sizeGiB;
  roleInput.value = d.role || '';

  function recomputeSku() {
    const tier = pickDiskTier(d.family, d.sizeGiB);
    d.sku = tier ? tier.sku : null;
    skuLabel.textContent = tier ? tier.sku : '—';
  }
  recomputeSku();

  familySel.addEventListener('change', () => {
    d.family = familySel.value;
    recomputeSku();
  });
  sizeInput.addEventListener('change', () => {
    d.sizeGiB = Number(sizeInput.value) || 0;
    recomputeSku();
  });
  roleInput.addEventListener('input', () => (d.role = roleInput.value));
  row.querySelector('.disk-remove').addEventListener('click', () => {
    vm.disks = vm.disks.filter((x) => x.id !== d.id);
    row.remove();
  });

  container.appendChild(row);
}

// ---------- RVTools import ----------
async function onUploadRvtools(e) {
  const file = e.target.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  const r = await fetch('/api/upload', { method: 'POST', body: fd }).then((x) => x.json());
  if (r.error) {
    alert('Upload failed: ' + r.error);
    return;
  }

  // Clear existing VMs and rebuild
  state.vms = [];
  $('#vmList').innerHTML = '';

  for (const v of r.vms || []) {
    const vm = {
      id: uid(),
      name: v.name,
      vcpu: v.vcpu || 2,
      ramGiB: v.ramGiB || 4,
      os: v.os === 'windows' ? 'windows' : 'linux',
      recommendedVm: null,
      reservation: 'payg',
      hybridBenefit: false,
      publicIp: false,
      disks: (v.disks && v.disks.length
        ? v.disks
        : [{ id: uid(), family: 'Standard SSD', sizeGiB: 128, role: 'OS' }]
      ).map((d) => ({ id: uid(), family: d.family || 'Standard SSD', sizeGiB: d.sizeGiB || 128, role: d.label || '' })),
      backup: null,
    };
    state.vms.push(vm);
    renderVmCard(vm);
  }
  applyServiceVisibility();
  e.target.value = '';
}

// ---------- Storage accounts ----------
function addStorageAccount() {
  const sa = {
    id: uid(),
    name: `storage-${state.storageAccounts.length + 1}`,
    tier: 'Hot',
    redundancy: 'LRS',
    capacityGiB: 100,
  };
  state.storageAccounts.push(sa);
  renderStorageCard(sa);
}

function renderStorageCard(sa) {
  const tpl = $('#storageCardTpl').content.cloneNode(true);
  const card = tpl.querySelector('.vm-card');
  card.dataset.saId = sa.id;
  const nameInput = card.querySelector('.sa-name');
  const tierSel = card.querySelector('.sa-tier');
  const redSel = card.querySelector('.sa-redundancy');
  const capInput = card.querySelector('.sa-capacity');

  nameInput.value = sa.name;
  tierSel.value = sa.tier;
  redSel.value = sa.redundancy;
  capInput.value = sa.capacityGiB;

  nameInput.addEventListener('input', () => (sa.name = nameInput.value));
  tierSel.addEventListener('change', () => (sa.tier = tierSel.value));
  redSel.addEventListener('change', () => (sa.redundancy = redSel.value));
  capInput.addEventListener('change', () => (sa.capacityGiB = Number(capInput.value) || 0));
  card.querySelector('.sa-remove').addEventListener('click', () => {
    state.storageAccounts = state.storageAccounts.filter((x) => x.id !== sa.id);
    card.remove();
  });
  $('#storageList').appendChild(card);
}

// ---------- Backup modal ----------
let backupTargetVm = null;

function wireBackupModal() {
  $('#backupModalClose').addEventListener('click', closeBackupModal);
  $('#backupModal').addEventListener('click', (e) => {
    if (e.target.id === 'backupModal') closeBackupModal();
  });
  $('#backupSaveBtn').addEventListener('click', () => {
    if (!backupTargetVm) return;
    backupTargetVm.backup = {
      enabled: true,
      policy: $('#backupPolicy').value,
      retentionDays: Number($('#backupRetention').value) || 30,
      redundancy: $('#backupRedundancy').value,
      dailyChurnPct: Number($('#backupChurn').value) || 5,
    };
    backupTargetVm._refreshBackupUi?.();
    closeBackupModal();
  });
  $('#backupRemoveBtn').addEventListener('click', () => {
    if (!backupTargetVm) return;
    backupTargetVm.backup = null;
    backupTargetVm._refreshBackupUi?.();
    closeBackupModal();
  });
}

function openBackupModal(vm) {
  backupTargetVm = vm;
  const cfg = vm.backup || { policy: 'daily', retentionDays: 30, redundancy: 'GRS', dailyChurnPct: 5 };
  $('#backupModalVmName').textContent = vm.name;
  $('#backupPolicy').value = cfg.policy;
  $('#backupRetention').value = cfg.retentionDays;
  $('#backupRedundancy').value = cfg.redundancy;
  $('#backupChurn').value = cfg.dailyChurnPct;
  $('#backupModal').hidden = false;
}

function closeBackupModal() {
  $('#backupModal').hidden = true;
  backupTargetVm = null;
}

// ---------- Estimate ----------
async function runEstimate() {
  const payload = {
    region: state.region,
    currency: state.currency,
    vms: state.servicesEnabled.has('vm')
      ? state.vms.map((vm) => ({
          id: vm.id,
          name: vm.name,
          vcpu: vm.vcpu,
          ramGiB: vm.ramGiB,
          os: vm.os,
          recommendedVm: vm.recommendedVm,
          reservation: vm.reservation,
          hybridBenefit: vm.hybridBenefit,
          publicIp: state.servicesEnabled.has('pip') && vm.publicIp,
          disks: state.servicesEnabled.has('disks')
            ? vm.disks.map((d) => ({ family: d.family, sizeGiB: d.sizeGiB, sku: d.sku, role: d.role }))
            : [],
          backup: state.servicesEnabled.has('backup') ? vm.backup : null,
        }))
      : [],
    storageAccounts: state.servicesEnabled.has('storage') ? state.storageAccounts : [],
  };

  const meta = $('#estimateMeta');
  meta.textContent = 'Computing…';
  try {
    const r = await fetch('/api/azure/estimate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then((x) => x.json());
    if (r.error) throw new Error(r.error);
    state.lastEstimate = r;
    renderResults(r);
    meta.textContent = `Computed at ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    meta.textContent = '';
    alert('Estimate failed: ' + e.message);
  }
}

function renderResults(r) {
  const card = $('#resultsCard');
  card.hidden = false;
  $('#grandTotal').textContent = fmt(r.grandMonthly);
  $('#resultsMeta').textContent = `${r.region} · ${r.currency} · ${r.vms.length} VM(s)${r.storageAccounts.length ? ` · ${r.storageAccounts.length} storage account(s)` : ''}`;

  const body = $('#resultsBody');
  body.innerHTML = '';

  for (const vm of r.vms) {
    const block = document.createElement('div');
    block.className = 'result-vm';
    const ahbTxt = vm.hybridBenefit ? ' · AHB' : '';
    const resTxt = vm.reservation && vm.reservation !== 'payg' ? ` · ${vm.reservation.toUpperCase()} RI` : '';
    block.innerHTML = `
      <div class="result-vm-head">
        <span class="name">${escapeHtml(vm.name)} <span class="muted">— ${vm.recommendedVm || 'no SKU'} · ${vm.os}${resTxt}${ahbTxt}</span></span>
        <span class="total">${fmt(vm.monthly)}</span>
      </div>
      ${vm.lineItems
        .map(
          (li) => `
            <div class="result-vm-line">
              <strong>${escapeHtml(li.category)}</strong>
              <span class="desc">${escapeHtml(li.detail || '')}</span>
              <span class="amount">${fmt(li.amount)}</span>
            </div>`
        )
        .join('')}
    `;
    body.appendChild(block);
  }

  for (const sa of r.storageAccounts) {
    const block = document.createElement('div');
    block.className = 'result-vm';
    block.innerHTML = `
      <div class="result-vm-head">
        <span class="name">${escapeHtml(sa.name)} <span class="muted">— ${sa.tier} ${sa.redundancy} · ${sa.capacityGiB} GiB</span></span>
        <span class="total">${fmt(sa.monthly)}</span>
      </div>
      ${sa.lineItems
        .map(
          (li) => `
            <div class="result-vm-line">
              <strong>${escapeHtml(li.category)}</strong>
              <span class="desc">${escapeHtml(li.detail || '')}</span>
              <span class="amount">${fmt(li.amount)}</span>
            </div>`
        )
        .join('')}
    `;
    body.appendChild(block);
  }

  const warns = $('#warningsBox');
  if (r.warnings && r.warnings.length) {
    warns.hidden = false;
    warns.innerHTML = `<strong>Warnings:</strong><ul>${r.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`;
  } else {
    warns.hidden = true;
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
