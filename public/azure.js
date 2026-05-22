// Azure Calculator frontend — row-based model inspired by the official Azure Pricing
// Calculator. Each user-added service is a row. Virtual machines additionally manage
// their own OS + data disks inline (mirroring the ASR side of this app), and a per-VM
// "Add Backup" button spawns a linked backup row right under the VM.

const SERVICES = [
  {
    type: 'vm',
    title: 'Virtual Machine',
    sub: 'Compute + OS / data disks',
    icon: '/icons/compute/10021-icon-service-Virtual-Machine.svg',
  },
  {
    type: 'storage',
    title: 'Storage Account',
    sub: 'Blob (Hot/Cool/Archive)',
    icon: '/icons/storage/10086-icon-service-Storage-Accounts.svg',
  },
  {
    type: 'ip',
    title: 'Public IP',
    sub: 'Standard Static IPv4',
    icon: '/icons/networking/10069-icon-service-Public-IP-Addresses.svg',
  },
];

const state = {
  region: null,
  currency: 'EUR',
  rows: [],
  diskTiers: { 'Standard SSD': [], 'Premium SSD': [] },
  backupDefaults: null,
  lastEstimate: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const uid = () => Math.random().toString(36).slice(2, 10);
const fmt = (n) => {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: state.currency }).format(n || 0);
  } catch {
    return `${(n || 0).toFixed(2)} ${state.currency}`;
  }
};

init();

async function init() {
  wireDisclaimer();
  await Promise.all([loadRegions(), loadCurrencies(), loadDiskTiers()]);
  renderServices();
  wireToolbar();
  wireBackupModal();
  pollStatus();
  applyEmptyState();
}

// ---------- Disclaimer ----------
function wireDisclaimer() {
  const modal = $('#disclaimerModal');
  if (sessionStorage.getItem('azureCalc.disclaimer') === 'accepted') {
    modal.hidden = true;
  }
  $('#disclaimerAcceptBtn').addEventListener('click', () => {
    sessionStorage.setItem('azureCalc.disclaimer', 'accepted');
    modal.hidden = true;
  });
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

async function pollStatus() {
  const pill = $('#statusPill');
  try {
    const s = await fetch('/api/status').then((x) => x.json());
    if (s.warming) {
      pill.textContent = 'Warming prices…';
      pill.className = 'status-pill warming';
      setTimeout(pollStatus, 1500);
    } else if (s.lastError) {
      pill.textContent = 'Price cache error';
      pill.className = 'status-pill error';
    } else {
      const cur = s.currencies.find((c) => c.currency === state.currency);
      pill.textContent = cur ? `VMs ${cur.vmCount} · Disks ${cur.diskCount} · Backup ${cur.backupCount}` : 'Ready';
      pill.className = 'status-pill ready';
    }
  } catch {
    pill.textContent = 'Status check failed';
    pill.className = 'status-pill error';
  }
}

// ---------- Service add-row strip ----------
function renderServices() {
  const grid = $('#servicesGrid');
  grid.innerHTML = '';
  for (const svc of SERVICES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'service-tile';
    btn.dataset.serviceType = svc.type;
    btn.innerHTML = `
      <img src="${svc.icon}" alt="" />
      <span class="st-body">
        <span class="st-title">${svc.title}</span>
        <span class="st-sub">${svc.sub}</span>
      </span>
      <span class="st-add" aria-hidden="true">+</span>
    `;
    btn.addEventListener('click', () => addRow(svc.type));
    grid.appendChild(btn);
  }
}

// ---------- Toolbar ----------
function wireToolbar() {
  $('#refreshPricesBtn').addEventListener('click', async () => {
    await fetch('/api/refresh-prices', { method: 'POST' });
    pollStatus();
  });
  $('#rvtoolsFile').addEventListener('change', onUploadRvtools);
  $('#estimateBtn').addEventListener('click', runEstimate);
  $('#currencySelect').addEventListener('change', pollStatus);
  $('#editBackupDefaultsBtn').addEventListener('click', editBackupDefaults);
}

function applyEmptyState() {
  $('#emptyState').hidden = state.rows.length > 0;
}

// ---------- Row factories ----------
function addRow(type, prefill = {}, insertAfterId = null) {
  const row = makeRow(type, prefill);
  if (insertAfterId) {
    const idx = state.rows.findIndex((r) => r.id === insertAfterId);
    state.rows.splice(idx + 1, 0, row);
  } else {
    state.rows.push(row);
  }
  renderRows();
  return row;
}

function makeRow(type, prefill = {}) {
  const id = uid();
  switch (type) {
    case 'vm':
      return {
        id,
        type: 'vm',
        name: prefill.name || `VM-${countRows('vm') + 1}`,
        vcpu: prefill.vcpu || 2,
        ramGiB: prefill.ramGiB || 8,
        os: prefill.os || 'linux',
        recommendedVm: null,
        reservation: 'payg',
        hoursPerMonth: 730,
        hybridBenefit: false,
        disks: (prefill.disks && prefill.disks.length
          ? prefill.disks
          : [{ label: 'OS disk', family: 'Standard SSD', sizeGiB: 128 }]
        ).map((d, idx) => ({
          id: uid(),
          label: d.label || (idx === 0 ? 'OS disk' : `Data disk ${idx}`),
          family: d.family || 'Standard SSD',
          sizeGiB: d.sizeGiB || 128,
          sku: null,
        })),
      };
    case 'ip':
      return {
        id,
        type: 'ip',
        name: prefill.name || `PublicIP-${countRows('ip') + 1}`,
        count: prefill.count || 1,
      };
    case 'backup': {
      const d = state.backupDefaults || { policy: 'daily', retentionDays: 30, redundancy: 'GRS', dailyChurnPct: 5 };
      return {
        id,
        type: 'backup',
        name: prefill.name || 'Backup',
        parentVmId: prefill.parentVmId || null,
        sourceSizeGiB: prefill.sourceSizeGiB || 128,
        policy: d.policy,
        retentionDays: d.retentionDays,
        redundancy: d.redundancy,
        dailyChurnPct: d.dailyChurnPct,
      };
    }
    case 'storage':
      return {
        id,
        type: 'storage',
        name: prefill.name || `storage-${countRows('storage') + 1}`,
        tier: prefill.tier || 'Hot',
        redundancy: prefill.redundancy || 'LRS',
        capacityGiB: prefill.capacityGiB || 100,
      };
    default:
      throw new Error(`Unknown row type: ${type}`);
  }
}

function countRows(type) {
  return state.rows.filter((r) => r.type === type).length;
}

function removeRow(id) {
  // Removing a VM also removes any backup row that referenced it.
  state.rows = state.rows.filter((r) => r.id !== id && r.parentVmId !== id);
  renderRows();
}

// ---------- Render ----------
function renderRows() {
  const list = $('#rowsList');
  list.innerHTML = '';
  for (const row of state.rows) list.appendChild(renderRow(row));
  applyEmptyState();
}

function renderRow(row) {
  switch (row.type) {
    case 'vm': return renderVmRow(row);
    case 'ip': return renderIpRow(row);
    case 'backup': return renderBackupRow(row);
    case 'storage': return renderStorageRow(row);
    default: return document.createElement('div');
  }
}

function commonWire(card, row) {
  card.dataset.rowId = row.id;
  const nameInput = card.querySelector('.row-name');
  nameInput.value = row.name;
  nameInput.addEventListener('input', () => { row.name = nameInput.value; });
  card.querySelector('.row-remove').addEventListener('click', () => removeRow(row.id));
  return { nameInput };
}

// ---------- VM row ----------
function renderVmRow(row) {
  const card = $('#vmRowTpl').content.firstElementChild.cloneNode(true);
  commonWire(card, row);

  const vcpu = card.querySelector('.vm-vcpu');
  const ram = card.querySelector('.vm-ram');
  const skuSel = card.querySelector('.vm-sku');
  const resSel = card.querySelector('.vm-reservation');
  const ahb = card.querySelector('.vm-ahb');
  const ahbWrap = card.querySelector('.ahb-wrap');
  const uptimeWrap = card.querySelector('.vm-uptime-wrap');
  const uptime = card.querySelector('.vm-uptime');
  const osBtns = $$('.os-btn', card);
  const disksList = card.querySelector('.disks-list');
  const addDiskBtn = card.querySelector('.add-disk-btn');
  const addBackupBtn = card.querySelector('.add-backup-btn');

  vcpu.value = row.vcpu;
  ram.value = row.ramGiB;
  resSel.value = row.reservation;
  ahb.checked = row.hybridBenefit;
  uptime.value = row.hoursPerMonth;
  osBtns.forEach((b) => b.setAttribute('aria-pressed', b.dataset.os === row.os));
  ahbWrap.classList.toggle('disabled', row.os !== 'windows');
  uptimeWrap.hidden = row.reservation !== 'payg';

  // Render every disk inside the VM card.
  row.disks.forEach((disk, idx) => disksList.appendChild(renderVmDisk(row, disk, idx)));

  vcpu.addEventListener('change', () => { row.vcpu = +vcpu.value || 0; refreshRecommendations(row, skuSel); });
  ram.addEventListener('change', () => { row.ramGiB = +ram.value || 0; refreshRecommendations(row, skuSel); });
  resSel.addEventListener('change', () => {
    row.reservation = resSel.value;
    uptimeWrap.hidden = row.reservation !== 'payg';
  });
  uptime.addEventListener('change', () => {
    let v = +uptime.value || 0;
    if (v < 0) v = 0; if (v > 730) v = 730;
    uptime.value = v;
    row.hoursPerMonth = v;
  });
  ahb.addEventListener('change', () => { row.hybridBenefit = ahb.checked; });
  osBtns.forEach((b) => b.addEventListener('click', () => {
    row.os = b.dataset.os;
    osBtns.forEach((o) => o.setAttribute('aria-pressed', o === b));
    ahbWrap.classList.toggle('disabled', row.os !== 'windows');
  }));
  skuSel.addEventListener('change', () => { row.recommendedVm = skuSel.value || null; });
  addBackupBtn.addEventListener('click', () => onAddBackup(row));
  addDiskBtn.addEventListener('click', () => {
    const disk = { id: uid(), label: `Data disk ${row.disks.length}`, family: 'Standard SSD', sizeGiB: 128, sku: null };
    row.disks.push(disk);
    disksList.appendChild(renderVmDisk(row, disk, row.disks.length - 1));
  });

  refreshRecommendations(row, skuSel);
  return card;
}

function renderVmDisk(vm, disk, idx) {
  const node = $('#vmDiskRowTpl').content.firstElementChild.cloneNode(true);
  node.dataset.diskId = disk.id;
  const isOs = idx === 0;
  const label = node.querySelector('.vm-disk-label');
  const family = node.querySelector('.vm-disk-family');
  const size = node.querySelector('.vm-disk-size');
  const sku = node.querySelector('.vm-disk-sku');
  const removeBtn = node.querySelector('.vm-disk-remove');

  label.value = disk.label;
  family.value = disk.family;
  size.value = disk.sizeGiB;

  // The OS disk cannot be removed nor relabelled (always called "OS disk") so the user
  // can clearly identify it and so backup math always finds the boot volume.
  if (isOs) {
    label.value = 'OS disk';
    label.readOnly = true;
    label.classList.add('locked');
    removeBtn.hidden = true;
    node.classList.add('os-disk');
  }

  recomputeSku();

  function recomputeSku() {
    const t = pickDiskTier(disk.family, disk.sizeGiB);
    disk.sku = t ? t.sku : null;
    sku.textContent = t ? t.sku : '—';
  }

  label.addEventListener('input', () => { if (!isOs) disk.label = label.value; });
  family.addEventListener('change', () => { disk.family = family.value; recomputeSku(); });
  size.addEventListener('change', () => { disk.sizeGiB = +size.value || 0; recomputeSku(); });
  removeBtn.addEventListener('click', () => {
    if (isOs) return;
    vm.disks = vm.disks.filter((d) => d.id !== disk.id);
    node.remove();
  });
  return node;
}

async function refreshRecommendations(row, skuSel) {
  try {
    const r = await fetch('/api/recommend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vcpu: row.vcpu, ramGiB: row.ramGiB }),
    }).then((x) => x.json());
    skuSel.innerHTML = '';
    if (!Array.isArray(r) || r.length === 0) {
      const opt = document.createElement('option'); opt.value = ''; opt.textContent = 'No match';
      skuSel.appendChild(opt);
      row.recommendedVm = null; return;
    }
    for (const rec of r) {
      const opt = document.createElement('option');
      opt.value = rec.armSkuName;
      opt.textContent = `${rec.armSkuName} — ${rec.vcpu}v / ${rec.ramGiB}GiB`;
      skuSel.appendChild(opt);
    }
    skuSel.value = r[0].armSkuName;
    row.recommendedVm = r[0].armSkuName;
  } catch (e) { console.error('recommend error', e); }
}

// ---------- Other row renderers ----------
function renderIpRow(row) {
  const card = $('#ipRowTpl').content.firstElementChild.cloneNode(true);
  commonWire(card, row);
  const count = card.querySelector('.ip-count');
  count.value = row.count;
  count.addEventListener('change', () => { row.count = +count.value || 1; });
  return card;
}

function renderBackupRow(row) {
  const card = $('#backupRowTpl').content.firstElementChild.cloneNode(true);
  commonWire(card, row);
  const size = card.querySelector('.bk-size');
  const policy = card.querySelector('.bk-policy');
  const ret = card.querySelector('.bk-retention');
  const red = card.querySelector('.bk-redundancy');
  const churn = card.querySelector('.bk-churn');
  size.value = row.sourceSizeGiB; policy.value = row.policy;
  ret.value = row.retentionDays; red.value = row.redundancy; churn.value = row.dailyChurnPct;
  size.addEventListener('change', () => { row.sourceSizeGiB = +size.value || 1; });
  policy.addEventListener('change', () => { row.policy = policy.value; });
  ret.addEventListener('change', () => { row.retentionDays = +ret.value || 30; });
  red.addEventListener('change', () => { row.redundancy = red.value; });
  churn.addEventListener('change', () => { row.dailyChurnPct = +churn.value || 0; });
  return card;
}

function renderStorageRow(row) {
  const card = $('#storageRowTpl').content.firstElementChild.cloneNode(true);
  commonWire(card, row);
  const tier = card.querySelector('.sa-tier');
  const red = card.querySelector('.sa-redundancy');
  const cap = card.querySelector('.sa-capacity');
  tier.value = row.tier; red.value = row.redundancy; cap.value = row.capacityGiB;
  tier.addEventListener('change', () => { row.tier = tier.value; });
  red.addEventListener('change', () => { row.redundancy = red.value; });
  cap.addEventListener('change', () => { row.capacityGiB = +cap.value || 0; });
  return card;
}

// ---------- Add Backup from a VM ----------
function onAddBackup(vm) {
  state.rows = state.rows.filter((r) => !(r.type === 'backup' && r.parentVmId === vm.id));
  const sourceSize = computeVmSourceSize(vm.id);
  const prefill = {
    name: `Backup - ${vm.name}`,
    parentVmId: vm.id,
    sourceSizeGiB: sourceSize,
  };

  if (!state.backupDefaults) {
    openBackupModal('defaults', { vmName: vm.name, onSave: (defaults) => {
      state.backupDefaults = defaults;
      refreshBackupDefaultsBtn();
      addRow('backup', prefill, vm.id);
    } });
    return;
  }
  addRow('backup', prefill, vm.id);
}

function computeVmSourceSize(vmId) {
  const vm = state.rows.find((r) => r.id === vmId);
  if (!vm) return 128;
  const total = (vm.disks || []).reduce((s, d) => s + (d.sizeGiB || 0), 0);
  return total || 128;
}

// ---------- Backup defaults modal ----------
let backupModalCtx = null;

function wireBackupModal() {
  $('#backupModalClose').addEventListener('click', closeBackupModal);
  $('#backupModal').addEventListener('click', (e) => {
    if (e.target.id === 'backupModal') closeBackupModal();
  });
  $('#backupSaveBtn').addEventListener('click', () => {
    const cfg = {
      policy: $('#backupPolicy').value,
      retentionDays: +$('#backupRetention').value || 30,
      redundancy: $('#backupRedundancy').value,
      dailyChurnPct: +$('#backupChurn').value || 5,
    };
    backupModalCtx?.onSave?.(cfg);
    closeBackupModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#backupModal').hidden) closeBackupModal();
  });
}

function openBackupModal(mode, ctx) {
  backupModalCtx = { mode, ...ctx };
  const seed = state.backupDefaults || { policy: 'daily', retentionDays: 30, redundancy: 'GRS', dailyChurnPct: 5 };
  $('#backupModalVmName').textContent = mode === 'defaults' ? `defaults${ctx?.vmName ? ` → ${ctx.vmName}` : ''}` : 'edit';
  $('#backupModalSubtitle').textContent =
    mode === 'defaults'
      ? 'These values will be reused as the default for every Backup you add. You can override them on any individual backup row later.'
      : 'Edit the saved defaults. Existing backup rows are not changed.';
  $('#backupSaveBtn').textContent = mode === 'defaults' ? 'Save defaults' : 'Save';
  $('#backupPolicy').value = seed.policy;
  $('#backupRetention').value = seed.retentionDays;
  $('#backupRedundancy').value = seed.redundancy;
  $('#backupChurn').value = seed.dailyChurnPct;
  $('#backupModal').hidden = false;
}

function closeBackupModal() {
  $('#backupModal').hidden = true;
  backupModalCtx = null;
}

function refreshBackupDefaultsBtn() {
  $('#editBackupDefaultsBtn').hidden = !state.backupDefaults;
}

function editBackupDefaults() {
  openBackupModal('defaults', { onSave: (cfg) => { state.backupDefaults = cfg; } });
}

// ---------- RVTools import ----------
async function onUploadRvtools(e) {
  const file = e.target.files[0];
  if (!file) return;
  const fd = new FormData(); fd.append('file', file);
  const r = await fetch('/api/upload', { method: 'POST', body: fd }).then((x) => x.json());
  if (r.error) { alert('Upload failed: ' + r.error); return; }

  state.rows = [];
  for (const v of r.vms || []) {
    // The server returns one entry per disk as `{ label, sizeGiB }`. We preserve every
    // disk as its own row inside the VM card so the user can tune them individually
    // — same behaviour as the ASR side of this app.
    const disks = (v.disks && v.disks.length ? v.disks : [{ label: 'OS disk', sizeGiB: 128 }])
      .map((d, idx) => ({
        label: idx === 0 ? 'OS disk' : (d.label || `Data disk ${idx}`),
        family: d.family || 'Standard SSD',
        sizeGiB: d.sizeGiB || 128,
      }));
    addRow('vm', {
      name: v.name,
      vcpu: v.vcpu || 2,
      ramGiB: v.ramGiB || 4,
      os: v.os === 'windows' ? 'windows' : 'linux',
      disks,
    });
  }
  e.target.value = '';
}

// ---------- Estimate ----------
async function runEstimate() {
  const payload = { region: state.region, currency: state.currency, rows: state.rows };
  const meta = $('#estimateMeta'); meta.textContent = 'Computing…';
  try {
    const r = await fetch('/api/azure/estimate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then((x) => x.json());
    if (r.error) throw new Error(r.error);
    state.lastEstimate = r;
    renderResults(r);
    meta.textContent = `Computed at ${new Date().toLocaleTimeString()}`;
    updateRowCosts(r);
  } catch (e) { meta.textContent = ''; alert('Estimate failed: ' + e.message); }
}

function updateRowCosts(r) {
  for (const item of r.items) {
    const card = document.querySelector(`.row-card[data-row-id="${item.id}"]`);
    if (card) card.querySelector('.row-cost').textContent = fmt(item.monthly);
  }
}

function renderResults(r) {
  const card = $('#resultsCard');
  card.hidden = false;
  $('#grandTotal').textContent = fmt(r.grandMonthly);
  $('#resultsMeta').textContent = `${r.region} · ${r.currency} · ${r.items.length} row(s)`;
  const body = $('#resultsBody');
  body.innerHTML = '';
  for (const item of r.items) {
    const block = document.createElement('div');
    block.className = 'result-row';
    block.innerHTML = `
      <div class="result-row-head">
        <span class="name">${escapeHtml(item.name)} <span class="muted">(${item.type})</span></span>
        <span class="total">${fmt(item.monthly)}</span>
      </div>
      ${item.lineItems.map((li) => `
        <div class="result-vm-line">
          <strong>${escapeHtml(li.category)}</strong>
          <span class="desc">${escapeHtml(li.detail || '')}</span>
          <span class="amount">${fmt(li.amount)}</span>
        </div>`).join('')}
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
