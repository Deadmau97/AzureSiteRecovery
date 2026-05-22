// Azure Calculator frontend — row-based model with searchable service catalog,
// global default settings, collapsible rows, dedicated results page (PDF + charts),
// and support for VPN Gateway / NAT Gateway / App Service Plan in addition to
// Virtual Machines, Public IPs, Storage Accounts and per-VM Backup.

// ---------- Service catalog ----------
// Each entry: { type, title, sub, icon, keywords[] }
// The catalog feeds both the tile grid and the search box. `keywords` are the
// extra terms the user might type that should still match the tile.
const CATALOG = [
  {
    type: 'vm',
    title: 'Virtual Machine',
    sub: 'Compute + OS / data disks',
    icon: '/icons/compute/10021-icon-service-Virtual-Machine.svg',
    keywords: ['vm', 'compute', 'instance', 'iaas', 'server'],
  },
  {
    type: 'storage',
    title: 'Storage Account',
    sub: 'Blob — Hot/Cool/Archive, LRS/GRS/ZRS',
    icon: '/icons/storage/10086-icon-service-Storage-Accounts.svg',
    keywords: ['blob', 'storage', 'account', 'bucket', 'object'],
  },
  {
    type: 'ip',
    title: 'Public IP',
    sub: 'Standard Static IPv4',
    icon: '/icons/networking/10069-icon-service-Public-IP-Addresses.svg',
    keywords: ['public', 'ip', 'network', 'ipv4', 'ipv6'],
  },
  {
    type: 'vpn',
    title: 'VPN Gateway',
    sub: 'Site-to-site VPN connectivity',
    icon: '/icons/networking/10063-icon-service-Virtual-Network-Gateways.svg',
    keywords: ['vpn', 'gateway', 's2s', 'site to site', 'network'],
  },
  {
    type: 'nat',
    title: 'NAT Gateway',
    sub: 'Outbound SNAT for subnets',
    icon: '/icons/networking/10310-icon-service-NAT.svg',
    keywords: ['nat', 'outbound', 'snat', 'egress', 'network'],
  },
  {
    type: 'appservice',
    title: 'App Service Plan',
    sub: 'Managed web/app hosting',
    icon: '/icons/compute/10035-icon-service-App-Services.svg',
    keywords: ['app service', 'web app', 'function', 'paas', 'hosting'],
  },
];

// ---------- Defaults (applied to every new row, overridable per-row) ----------
const FACTORY_DEFAULTS = {
  reservation: 'payg',
  uptimeHours: 730,
  hybridBenefit: false,
  os: 'linux',
  osDiskFamily: 'Standard SSD',
  osDiskSize: 128,
  dataDiskFamily: 'Standard SSD',
  dataDiskSize: 128,
  backupPolicy: 'daily',
  backupRetention: 30,
  backupRedundancy: 'GRS',
  backupChurn: 5,
  blobTier: 'Hot',
  blobRedundancy: 'LRS',
};

const state = {
  region: null,
  currency: 'EUR',
  rows: [],
  diskTiers: { 'Standard SSD': [], 'Premium SSD': [] },
  vpnSkus: [],
  appServiceSkus: [],
  defaults: loadDefaults(),
  lastEstimate: null,
  collapsedAll: false,
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
  await loadServiceCatalogs();
  renderServices();
  wireToolbar();
  wireDefaultsModal();
  wireResultsView();
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
  sel.addEventListener('change', async () => {
    state.region = sel.value;
    await loadServiceCatalogs();
  });
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
  sel.addEventListener('change', async () => {
    state.currency = sel.value;
    await loadServiceCatalogs();
    pollStatus();
  });
}

async function loadDiskTiers() {
  const [std, prem] = await Promise.all([
    fetch('/api/disk-tiers?family=Standard%20SSD').then((x) => x.json()),
    fetch('/api/disk-tiers?family=Premium%20SSD').then((x) => x.json()),
  ]);
  state.diskTiers['Standard SSD'] = std;
  state.diskTiers['Premium SSD'] = prem;
}

async function loadServiceCatalogs() {
  // SKU lists for region-bound services. Fetched on region/currency change so the
  // dropdowns inside VPN / App Service rows always reflect the current selection.
  if (!state.region) return;
  try {
    const [vpn, app] = await Promise.all([
      fetch(`/api/azure/vpn-skus?region=${state.region}&currency=${state.currency}`).then((x) => x.json()),
      fetch(`/api/azure/appservice-skus?region=${state.region}&currency=${state.currency}`).then((x) => x.json()),
    ]);
    state.vpnSkus = vpn;
    state.appServiceSkus = app;
  } catch (e) {
    console.error('catalog fetch failed', e);
  }
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
      pill.textContent = cur ? `VMs ${cur.vmCount} · Disks ${cur.diskCount} · VPN ${cur.vpnGatewayCount} · AppSvc ${cur.appServicePlanCount}` : 'Ready';
      pill.className = 'status-pill ready';
    }
  } catch {
    pill.textContent = 'Status check failed';
    pill.className = 'status-pill error';
  }
}

// ---------- Service catalog rendering + search ----------
function renderServices(filter = '') {
  const grid = $('#servicesGrid');
  grid.innerHTML = '';
  const q = (filter || '').trim().toLowerCase();
  const matches = CATALOG.filter((svc) => {
    if (!q) return true;
    const hay = [svc.title, svc.sub, svc.type, ...(svc.keywords || [])].join(' ').toLowerCase();
    return hay.includes(q);
  });
  if (matches.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'services-empty muted';
    empty.textContent = `No service matches "${filter}".`;
    grid.appendChild(empty);
    return;
  }
  for (const svc of matches) {
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
    setTimeout(loadServiceCatalogs, 2000);
  });
  $('#rvtoolsFile').addEventListener('change', onUploadRvtools);
  $('#estimateBtn').addEventListener('click', runEstimate);
  $('#editDefaultsBtn').addEventListener('click', openDefaultsModal);
  $('#serviceSearch').addEventListener('input', (e) => renderServices(e.target.value));
  $('#toggleCollapseAllBtn').addEventListener('click', toggleCollapseAll);
}

function applyEmptyState() {
  $('#emptyState').hidden = state.rows.length > 0;
  $('#toggleCollapseAllBtn').hidden = state.rows.length === 0;
}

function toggleCollapseAll() {
  state.collapsedAll = !state.collapsedAll;
  $$('.row-card').forEach((card) => card.classList.toggle('collapsed', state.collapsedAll));
  $('#toggleCollapseAllBtn').textContent = state.collapsedAll ? 'Expand all' : 'Collapse all';
}

// ---------- Defaults (persisted in localStorage) ----------
function loadDefaults() {
  try {
    const raw = localStorage.getItem('azureCalc.defaults');
    if (!raw) return { ...FACTORY_DEFAULTS };
    return { ...FACTORY_DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...FACTORY_DEFAULTS };
  }
}

function saveDefaults() {
  localStorage.setItem('azureCalc.defaults', JSON.stringify(state.defaults));
}

function wireDefaultsModal() {
  const modal = $('#defaultsModal');
  $('#defaultsModalClose').addEventListener('click', () => (modal.hidden = true));
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.hidden = true; });

  $('#defaultsResetBtn').addEventListener('click', () => {
    state.defaults = { ...FACTORY_DEFAULTS };
    saveDefaults();
    fillDefaultsModal();
  });

  $('#defaultsSaveBtn').addEventListener('click', () => {
    state.defaults = readDefaultsModal();
    saveDefaults();
    modal.hidden = true;
  });
}

function openDefaultsModal() {
  fillDefaultsModal();
  $('#defaultsModal').hidden = false;
}

function fillDefaultsModal() {
  const d = state.defaults;
  $('#defReservation').value = d.reservation;
  $('#defUptime').value = d.uptimeHours;
  $('#defHybridBenefit').checked = d.hybridBenefit;
  $('#defOs').value = d.os;
  $('#defOsDiskFamily').value = d.osDiskFamily;
  $('#defOsDiskSize').value = d.osDiskSize;
  $('#defDataDiskFamily').value = d.dataDiskFamily;
  $('#defDataDiskSize').value = d.dataDiskSize;
  $('#defBackupPolicy').value = d.backupPolicy;
  $('#defBackupRetention').value = d.backupRetention;
  $('#defBackupRedundancy').value = d.backupRedundancy;
  $('#defBackupChurn').value = d.backupChurn;
  $('#defBlobTier').value = d.blobTier;
  $('#defBlobRedundancy').value = d.blobRedundancy;
}

function readDefaultsModal() {
  return {
    reservation: $('#defReservation').value,
    uptimeHours: +$('#defUptime').value || 730,
    hybridBenefit: $('#defHybridBenefit').checked,
    os: $('#defOs').value,
    osDiskFamily: $('#defOsDiskFamily').value,
    osDiskSize: +$('#defOsDiskSize').value || 128,
    dataDiskFamily: $('#defDataDiskFamily').value,
    dataDiskSize: +$('#defDataDiskSize').value || 128,
    backupPolicy: $('#defBackupPolicy').value,
    backupRetention: +$('#defBackupRetention').value || 30,
    backupRedundancy: $('#defBackupRedundancy').value,
    backupChurn: +$('#defBackupChurn').value || 5,
    blobTier: $('#defBlobTier').value,
    blobRedundancy: $('#defBlobRedundancy').value,
  };
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
  const d = state.defaults;
  switch (type) {
    case 'vm':
      return {
        id,
        type: 'vm',
        name: prefill.name || `VM-${countRows('vm') + 1}`,
        vcpu: prefill.vcpu || 2,
        ramGiB: prefill.ramGiB || 8,
        os: prefill.os || d.os,
        recommendedVm: null,
        reservation: d.reservation,
        hoursPerMonth: d.uptimeHours,
        hybridBenefit: d.hybridBenefit,
        disks: (prefill.disks && prefill.disks.length
          ? prefill.disks
          : [{ label: 'OS disk', family: d.osDiskFamily, sizeGiB: d.osDiskSize }]
        ).map((diskSpec, idx) => ({
          id: uid(),
          label: diskSpec.label || (idx === 0 ? 'OS disk' : `Data disk ${idx}`),
          family: diskSpec.family || (idx === 0 ? d.osDiskFamily : d.dataDiskFamily),
          sizeGiB: diskSpec.sizeGiB || (idx === 0 ? d.osDiskSize : d.dataDiskSize),
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
    case 'backup':
      return {
        id,
        type: 'backup',
        name: prefill.name || 'Backup',
        parentVmId: prefill.parentVmId || null,
        sourceSizeGiB: prefill.sourceSizeGiB || 128,
        policy: d.backupPolicy,
        retentionDays: d.backupRetention,
        redundancy: d.backupRedundancy,
        dailyChurnPct: d.backupChurn,
      };
    case 'storage':
      return {
        id,
        type: 'storage',
        name: prefill.name || `storage-${countRows('storage') + 1}`,
        tier: d.blobTier,
        redundancy: d.blobRedundancy,
        capacityGiB: prefill.capacityGiB || 100,
      };
    case 'vpn':
      return {
        id,
        type: 'vpn',
        name: prefill.name || `vpn-gw-${countRows('vpn') + 1}`,
        skuName: state.vpnSkus[0]?.skuName || null,
      };
    case 'nat':
      return {
        id,
        type: 'nat',
        name: prefill.name || `nat-gw-${countRows('nat') + 1}`,
        dataProcessedGiB: 100,
      };
    case 'appservice': {
      const first = state.appServiceSkus[0];
      return {
        id,
        type: 'appservice',
        name: prefill.name || `app-plan-${countRows('appservice') + 1}`,
        productName: first?.productName || null,
        skuName: first?.skuName || null,
        instances: 1,
      };
    }
    default:
      throw new Error(`Unknown row type: ${type}`);
  }
}

function countRows(type) {
  return state.rows.filter((r) => r.type === type).length;
}

function removeRow(id) {
  state.rows = state.rows.filter((r) => r.id !== id && r.parentVmId !== id);
  renderRows();
}

// ---------- Render ----------
function renderRows() {
  const list = $('#rowsList');
  list.innerHTML = '';
  for (const row of state.rows) list.appendChild(renderRow(row));
  applyEmptyState();
  updateRowCosts();
}

function updateRowCosts() {
  // Reflect monthly cost from last estimate into the row header (visible even when collapsed).
  if (!state.lastEstimate) return;
  const byId = new Map();
  for (const item of state.lastEstimate.items) byId.set(item.id, item.monthly);
  $$('.row-card').forEach((card) => {
    const cost = byId.get(card.dataset.rowId);
    const span = card.querySelector('.row-cost');
    if (span && typeof cost === 'number') {
      span.textContent = fmt(cost);
      span.classList.remove('muted');
    }
  });
}

function renderRow(row) {
  switch (row.type) {
    case 'vm': return renderVmRow(row);
    case 'ip': return renderIpRow(row);
    case 'backup': return renderBackupRow(row);
    case 'storage': return renderStorageRow(row);
    case 'vpn': return renderVpnRow(row);
    case 'nat': return renderNatRow(row);
    case 'appservice': return renderAppServiceRow(row);
    default: return document.createElement('div');
  }
}

function commonWire(card, row) {
  card.dataset.rowId = row.id;
  if (state.collapsedAll) card.classList.add('collapsed');
  const nameInput = card.querySelector('.row-name');
  nameInput.value = row.name;
  nameInput.addEventListener('input', () => { row.name = nameInput.value; });
  card.querySelector('.row-remove').addEventListener('click', () => removeRow(row.id));
  const collapseBtn = card.querySelector('.row-collapse');
  if (collapseBtn) collapseBtn.addEventListener('click', () => card.classList.toggle('collapsed'));
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
    const d = state.defaults;
    const disk = { id: uid(), label: `Data disk ${row.disks.length}`, family: d.dataDiskFamily, sizeGiB: d.dataDiskSize, sku: null };
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

function renderVpnRow(row) {
  const card = $('#vpnRowTpl').content.firstElementChild.cloneNode(true);
  commonWire(card, row);
  const sel = card.querySelector('.vpn-sku');
  sel.innerHTML = '';
  if (state.vpnSkus.length === 0) {
    const opt = document.createElement('option'); opt.value = ''; opt.textContent = '(no SKUs found in region)';
    sel.appendChild(opt);
  } else {
    for (const s of state.vpnSkus) {
      const opt = document.createElement('option');
      opt.value = s.skuName;
      opt.textContent = `${s.skuName} — ${fmt(s.hourly * 730)} /mo`;
      sel.appendChild(opt);
    }
  }
  if (row.skuName) sel.value = row.skuName; else row.skuName = sel.value || null;
  sel.addEventListener('change', () => { row.skuName = sel.value || null; });
  return card;
}

function renderNatRow(row) {
  const card = $('#natRowTpl').content.firstElementChild.cloneNode(true);
  commonWire(card, row);
  const data = card.querySelector('.nat-data');
  data.value = row.dataProcessedGiB;
  data.addEventListener('change', () => { row.dataProcessedGiB = +data.value || 0; });
  return card;
}

function renderAppServiceRow(row) {
  const card = $('#appserviceRowTpl').content.firstElementChild.cloneNode(true);
  commonWire(card, row);
  const sel = card.querySelector('.app-sku');
  const inst = card.querySelector('.app-instances');
  sel.innerHTML = '';
  if (state.appServiceSkus.length === 0) {
    const opt = document.createElement('option'); opt.value = ''; opt.textContent = '(no SKUs found in region)';
    sel.appendChild(opt);
  } else {
    for (const s of state.appServiceSkus) {
      const opt = document.createElement('option');
      opt.value = JSON.stringify({ productName: s.productName, skuName: s.skuName });
      opt.textContent = `${s.key} — ${fmt(s.hourly * 730)} /mo`;
      sel.appendChild(opt);
    }
    if (row.productName && row.skuName) {
      sel.value = JSON.stringify({ productName: row.productName, skuName: row.skuName });
    } else {
      const parsed = JSON.parse(sel.value);
      row.productName = parsed.productName; row.skuName = parsed.skuName;
    }
  }
  inst.value = row.instances;
  sel.addEventListener('change', () => {
    if (!sel.value) return;
    const parsed = JSON.parse(sel.value);
    row.productName = parsed.productName; row.skuName = parsed.skuName;
  });
  inst.addEventListener('change', () => { row.instances = +inst.value || 1; });
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
  addRow('backup', prefill, vm.id);
}

function computeVmSourceSize(vmId) {
  const vm = state.rows.find((r) => r.id === vmId);
  if (!vm) return 128;
  const total = (vm.disks || []).reduce((s, d) => s + (d.sizeGiB || 0), 0);
  return total || 128;
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
    const disks = (v.disks && v.disks.length ? v.disks : [{ label: 'OS disk', sizeGiB: state.defaults.osDiskSize }])
      .map((d, idx) => ({
        label: idx === 0 ? 'OS disk' : (d.label || `Data disk ${idx}`),
        family: d.family || (idx === 0 ? state.defaults.osDiskFamily : state.defaults.dataDiskFamily),
        sizeGiB: d.sizeGiB || (idx === 0 ? state.defaults.osDiskSize : state.defaults.dataDiskSize),
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

// ---------- Estimate + Results page ----------
function wireResultsView() {
  $('#backToBuilderBtn').addEventListener('click', () => {
    $('#resultsView').hidden = true;
    $('#builderView').hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  $('#downloadPdfBtn').addEventListener('click', downloadEstimatePdf);
}

async function runEstimate() {
  if (state.rows.length === 0) {
    alert('Add at least one service before calculating.');
    return;
  }
  const payload = { region: state.region, currency: state.currency, rows: state.rows };
  const meta = $('#estimateMeta'); meta.textContent = 'Computing…';
  try {
    const r = await fetch('/api/azure/estimate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then((x) => x.json());
    if (r.error) throw new Error(r.error);
    state.lastEstimate = r;
    showResultsView(r);
    updateRowCosts();
    meta.textContent = `Computed at ${new Date().toLocaleTimeString()}`;
  } catch (e) { meta.textContent = ''; alert('Estimate failed: ' + e.message); }
}

function showResultsView(r) {
  $('#builderView').hidden = true;
  $('#resultsView').hidden = false;
  window.scrollTo({ top: 0 });

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
  renderCharts(r);
}

// ---------- Charts ----------
let chartByType = null;
let chartByItem = null;

function renderCharts(r) {
  if (typeof Chart === 'undefined') return;

  // Group by service type.
  const byType = {};
  for (const item of r.items) byType[item.type] = (byType[item.type] || 0) + item.monthly;
  const typeLabels = Object.keys(byType);
  const typeData = typeLabels.map((k) => +byType[k].toFixed(2));

  // Top 10 individual items.
  const sortedItems = [...r.items].filter((i) => i.monthly > 0).sort((a, b) => b.monthly - a.monthly).slice(0, 10);

  if (chartByType) chartByType.destroy();
  if (chartByItem) chartByItem.destroy();

  chartByType = new Chart($('#chartByType'), {
    type: 'doughnut',
    data: {
      labels: typeLabels,
      datasets: [{
        data: typeData,
        backgroundColor: ['#6ea8ff', '#b48cff', '#46d39a', '#f5a623', '#ff6b9d', '#7fdfff', '#ffb900'],
        borderWidth: 0,
      }],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { position: 'right', labels: { color: '#cfd6f5' } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${fmt(ctx.parsed)}` } },
      },
    },
  });

  chartByItem = new Chart($('#chartByItem'), {
    type: 'bar',
    data: {
      labels: sortedItems.map((i) => i.name),
      datasets: [{
        label: 'Monthly cost',
        data: sortedItems.map((i) => +i.monthly.toFixed(2)),
        backgroundColor: '#6ea8ff',
        borderRadius: 6,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => fmt(ctx.parsed.x) } },
      },
      scales: {
        x: { ticks: { color: '#cfd6f5', callback: (v) => fmt(v) }, grid: { color: 'rgba(255,255,255,0.05)' } },
        y: { ticks: { color: '#cfd6f5' }, grid: { display: false } },
      },
    },
  });
}

// ---------- PDF export ----------
function downloadEstimatePdf() {
  if (typeof pdfMake === 'undefined') {
    alert('PDF library not loaded. Check your internet connection.');
    return;
  }
  const data = state.lastEstimate;
  if (!data) return;

  const filename = `azure-estimate-${data.region}-${new Date().toISOString().slice(0, 10)}.pdf`;

  const itemsRows = [
    [
      { text: 'Item', style: 'th' },
      { text: 'Type', style: 'th' },
      { text: 'Monthly', style: 'th', alignment: 'right' },
    ],
    ...data.items.map((i) => [
      { text: i.name, style: 'td' },
      { text: i.type, style: 'td' },
      { text: fmt(i.monthly), style: 'td', alignment: 'right' },
    ]),
    [
      { text: 'TOTAL', style: 'tdBold', colSpan: 2 }, {},
      { text: fmt(data.grandMonthly), style: 'tdBold', alignment: 'right' },
    ],
  ];

  const lineItemSections = data.items.flatMap((i) => {
    if (!i.lineItems.length) return [];
    return [
      { text: `${i.name} (${i.type}) — ${fmt(i.monthly)}`, style: 'h3', margin: [0, 10, 0, 4] },
      {
        table: {
          widths: ['*', '*', 80],
          body: [
            [
              { text: 'Category', style: 'th' },
              { text: 'Detail', style: 'th' },
              { text: 'Amount', style: 'th', alignment: 'right' },
            ],
            ...i.lineItems.map((li) => [
              { text: li.category, style: 'td' },
              { text: li.detail || '', style: 'td' },
              { text: fmt(li.amount), style: 'td', alignment: 'right' },
            ]),
          ],
        },
        layout: { hLineColor: '#d6dbf0', vLineColor: '#d6dbf0' },
      },
    ];
  });

  const doc = {
    pageMargins: [40, 50, 40, 50],
    content: [
      { text: 'Azure Calculator — Estimate', style: 'h1' },
      { text: `Generated ${new Date().toLocaleString()}`, style: 'sub', margin: [0, 0, 0, 10] },
      {
        table: {
          widths: [80, '*'],
          body: [
            [{ text: 'Region', style: 'metaKey' }, { text: data.region, style: 'metaVal' }],
            [{ text: 'Currency', style: 'metaKey' }, { text: data.currency, style: 'metaVal' }],
            [{ text: 'Rows', style: 'metaKey' }, { text: String(data.items.length), style: 'metaVal' }],
            [{ text: 'Grand total', style: 'metaKey' }, { text: fmt(data.grandMonthly), style: 'metaVal' }],
          ],
        },
        layout: 'noBorders',
        margin: [0, 0, 0, 14],
      },
      { text: 'Summary', style: 'h2' },
      {
        table: { headerRows: 1, widths: ['*', 80, 80], body: itemsRows },
        layout: { hLineColor: '#d6dbf0', vLineColor: '#d6dbf0' },
      },
      { text: 'Per-item breakdown', style: 'h2', margin: [0, 16, 0, 6] },
      ...lineItemSections,
      ...(data.warnings && data.warnings.length
        ? [
            { text: 'Warnings', style: 'h2', margin: [0, 14, 0, 6] },
            { ul: data.warnings, style: 'td' },
          ]
        : []),
      {
        text: 'Estimates only — derived from public Azure Retail Prices. Real invoices may differ.',
        style: 'sub',
        margin: [0, 18, 0, 0],
      },
    ],
    styles: {
      h1: { fontSize: 18, bold: true, color: '#1a2347' },
      h2: { fontSize: 14, bold: true, color: '#1a2347', margin: [0, 10, 0, 6] },
      h3: { fontSize: 12, bold: true, color: '#1a2347' },
      sub: { fontSize: 9, color: '#6b7591', italics: true },
      th: { bold: true, fillColor: '#eef1ff', color: '#1a2347', margin: [4, 4, 4, 4] },
      td: { color: '#1a2347', fontSize: 10, margin: [4, 3, 4, 3] },
      tdBold: { bold: true, color: '#1a2347', fontSize: 10, margin: [4, 3, 4, 3] },
      metaKey: { color: '#6b7591', fontSize: 10, margin: [0, 1, 0, 1] },
      metaVal: { color: '#1a2347', fontSize: 10, bold: true, margin: [0, 1, 0, 1] },
    },
  };

  pdfMake.createPdf(doc).download(filename);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
