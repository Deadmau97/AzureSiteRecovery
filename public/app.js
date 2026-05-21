// Frontend logic for the ASR estimator.
// Vanilla ES modules. Uses global `anime` (loaded via CDN script tag).

const state = {
  vms: [],
  region: null,
  scenario: 'onprem',
  currency: 'EUR',
};

const el = (s, r = document) => r.querySelector(s);
const elAll = (s, r = document) => Array.from(r.querySelectorAll(s));
const fmt = (n) => {
  const cur = state.currency;
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }).format(n);
  } catch {
    return `${n.toFixed(2)} ${cur}`;
  }
};
const uid = () => Math.random().toString(36).slice(2, 10);

// ---------- Boot ----------
init();

async function init() {
  await loadRegions();
  await loadCurrencies();
  pollStatus();
  wireToolbar();
  addBlankVm();
}

async function loadRegions() {
  const r = await fetch('/api/regions').then((x) => x.json());
  const sel = el('#region');
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
  const sel = el('#currency');
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

function wireToolbar() {
  el('#scenario').addEventListener('change', (e) => (state.scenario = e.target.value));
  el('#addVm').addEventListener('click', () => addBlankVm());
  el('#rvtoolsFile').addEventListener('change', onUploadRvtools);
  el('#estimate').addEventListener('click', runEstimate);
  el('#refreshPrices').addEventListener('click', async () => {
    await fetch('/api/refresh-prices', { method: 'POST' });
    pollStatus(true);
  });
  el('#exportJson').addEventListener('click', exportProject);
  el('#importJsonFile').addEventListener('change', importProject);
}

async function pollStatus(force = false) {
  const status = el('#status');
  for (let i = 0; i < 120; i++) {
    const s = await fetch('/api/status').then((x) => x.json());
    if (s.lastError) {
      status.textContent = `prices: error`;
      status.className = 'status error';
      status.title = s.lastError;
      return;
    }
    const ready =
      !s.warming && s.currencies.length > 0 && s.currencies.every((c) => c.vmCount > 0);
    if (s.warming) {
      status.textContent = 'prices: warming…';
      status.className = 'status warming';
    } else if (ready) {
      status.textContent = `prices: ready (${s.currencies.map((c) => c.currency).join(', ')})`;
      status.className = 'status ready';
      status.title = s.currencies
        .map(
          (c) =>
            `${c.currency}: vms=${c.vmCount} disks=${c.diskCount} asr=${c.asrCount} cache=${c.cacheStoreCount} ip=${c.publicIpCount}`
        )
        .join('\n');
      if (!force) return;
    } else {
      status.textContent = 'prices: idle';
      status.className = 'status';
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// ---------- VM management ----------
function addBlankVm(prefill = {}) {
  const vm = {
    id: uid(),
    name: prefill.name || `vm-${state.vms.length + 1}`,
    vcpu: prefill.vcpu || 2,
    ramGiB: prefill.ramGiB || 8,
    os: prefill.os || 'linux',
    powered: prefill.powered ?? true,
    disks: (prefill.disks && prefill.disks.length)
      ? prefill.disks.map((d) => ({ id: uid(), label: d.label || 'Disk', sizeGiB: d.sizeGiB || 128, family: d.family || 'Premium SSD' }))
      : [{ id: uid(), label: 'OS disk', sizeGiB: 128, family: 'Premium SSD' }],
    recommendedVm: prefill.recommendedVm || null,
  };
  state.vms.push(vm);
  renderVmCard(vm);
}

function renderVmCard(vm) {
  const tpl = el('#vmCardTpl');
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.dataset.vmId = vm.id;
  el('.vm-name', node).value = vm.name;
  el('.vm-vcpu', node).value = vm.vcpu;
  el('.vm-ram', node).value = vm.ramGiB;
  elAll('input[name=os]', node).forEach((r) => (r.checked = r.value === vm.os));
  el('.vm-target-input', node).value = vm.recommendedVm || '';

  // Listeners
  el('.vm-name', node).addEventListener('input', (e) => (vm.name = e.target.value));
  el('.vm-vcpu', node).addEventListener('input', (e) => {
    vm.vcpu = Number(e.target.value) || 0;
    refreshSuggestions(vm, node);
  });
  el('.vm-ram', node).addEventListener('input', (e) => {
    vm.ramGiB = Number(e.target.value) || 0;
    refreshSuggestions(vm, node);
  });
  elAll('input[name=os]', node).forEach((r) =>
    r.addEventListener('change', () => (vm.os = r.checked ? r.value : vm.os))
  );
  el('.remove', node).addEventListener('click', () => removeVm(vm.id));
  el('.add-disk', node).addEventListener('click', () => {
    const disk = { id: uid(), label: `Disk ${vm.disks.length + 1}`, sizeGiB: 128, family: 'Premium SSD' };
    vm.disks.push(disk);
    appendDiskRow(disk, vm, node);
  });

  // Target VM search/select
  const tInput = el('.vm-target-input', node);
  const tResults = el('.vm-target-results', node);
  tInput.addEventListener('focus', () => searchTarget(tInput, tResults, vm));
  tInput.addEventListener('input', () => searchTarget(tInput, tResults, vm));
  tInput.addEventListener('blur', () => setTimeout(() => tResults.classList.add('hidden'), 180));
  tInput.addEventListener('change', () => {
    vm.recommendedVm = tInput.value || null;
  });

  // Existing disks
  for (const disk of vm.disks) appendDiskRow(disk, vm, node);

  el('#vmList').appendChild(node);
  anime({ targets: node, opacity: [0, 1], translateY: [10, 0], duration: 320, easing: 'easeOutQuad' });
  refreshSuggestions(vm, node);
}

function appendDiskRow(disk, vm, vmNode) {
  const tpl = el('#diskRowTpl');
  const row = tpl.content.firstElementChild.cloneNode(true);
  row.dataset.diskId = disk.id;
  el('.disk-label', row).value = disk.label;
  el('.disk-size', row).value = disk.sizeGiB;
  el('.disk-family', row).value = disk.family;

  const updateTier = () => {
    const sz = Number(disk.sizeGiB) || 0;
    el('.disk-tier', row).textContent = sz > 0 ? `→ ${pickTierLabel(sz, disk.family)}` : '';
  };
  updateTier();

  el('.disk-label', row).addEventListener('input', (e) => (disk.label = e.target.value));
  el('.disk-size', row).addEventListener('input', (e) => {
    disk.sizeGiB = Number(e.target.value) || 0;
    updateTier();
  });
  el('.disk-family', row).addEventListener('change', (e) => {
    disk.family = e.target.value;
    updateTier();
  });
  el('.disk-remove', row).addEventListener('click', () => {
    vm.disks = vm.disks.filter((d) => d.id !== disk.id);
    row.remove();
  });
  el('.disk-list', vmNode).appendChild(row);
}

function pickTierLabel(sizeGiB, family) {
  const P = [[4,'P1'],[8,'P2'],[16,'P3'],[32,'P4'],[64,'P6'],[128,'P10'],[256,'P15'],[512,'P20'],[1024,'P30'],[2048,'P40'],[4096,'P50'],[8192,'P60'],[16384,'P70'],[32767,'P80']];
  const E = [[4,'E1'],[8,'E2'],[16,'E3'],[32,'E4'],[64,'E6'],[128,'E10'],[256,'E15'],[512,'E20'],[1024,'E30'],[2048,'E40'],[4096,'E50'],[8192,'E60'],[16384,'E70'],[32767,'E80']];
  const table = family === 'Premium SSD' ? P : E;
  for (const [c, sku] of table) if (sizeGiB <= c) return `${sku} (${c} GiB)`;
  return 'oversize';
}

function removeVm(id) {
  const node = el(`[data-vm-id="${id}"]`);
  if (!node) return;
  anime({
    targets: node,
    opacity: 0,
    translateX: -16,
    duration: 220,
    easing: 'easeInQuad',
    complete: () => node.remove(),
  });
  state.vms = state.vms.filter((v) => v.id !== id);
}

async function refreshSuggestions(vm, node) {
  const list = el('.vm-suggestions', node);
  list.innerHTML = '<li class="muted">loading…</li>';
  try {
    const recs = await fetch('/api/recommend', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vcpu: vm.vcpu, ramGiB: vm.ramGiB }),
    }).then((r) => r.json());
    list.innerHTML = '';
    recs.forEach((r, i) => {
      const li = document.createElement('li');
      li.textContent = `${r.armSkuName} (${r.vcpu}vCPU/${r.ramGiB}GiB)`;
      li.title = `gen v${r.generation} · ${r.vendor} · +${r.vcpuOverhead}vCPU/+${r.ramOverhead.toFixed(1)}GiB`;
      if (i === 0) li.classList.add('best');
      li.addEventListener('click', () => {
        vm.recommendedVm = r.armSkuName;
        el('.vm-target-input', node).value = r.armSkuName;
      });
      list.appendChild(li);
    });
    if (recs[0] && !vm.recommendedVm) {
      vm.recommendedVm = recs[0].armSkuName;
      el('.vm-target-input', node).value = recs[0].armSkuName;
    }
  } catch (e) {
    list.innerHTML = `<li class="muted">error</li>`;
  }
}

async function searchTarget(input, results, vm) {
  const q = input.value.trim();
  const data = await fetch(`/api/vm-search?q=${encodeURIComponent(q)}`).then((r) => r.json());
  results.innerHTML = '';
  data.slice(0, 30).forEach((r) => {
    const li = document.createElement('li');
    li.textContent = `${r.armSkuName} — ${r.vcpu}vCPU / ${r.ramGiB}GiB${r.specialty ? ' · specialty' : ''}`;
    li.addEventListener('mousedown', () => {
      vm.recommendedVm = r.armSkuName;
      input.value = r.armSkuName;
      results.classList.add('hidden');
    });
    results.appendChild(li);
  });
  results.classList.toggle('hidden', data.length === 0);
}

// ---------- Upload ----------
async function onUploadRvtools(e) {
  const file = e.target.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  const data = await fetch('/api/upload', { method: 'POST', body: fd }).then((r) => r.json());
  if (data.error) return showWarnings([data.error]);

  // Replace current VMs
  state.vms = [];
  el('#vmList').innerHTML = '';
  for (const v of data.vms) {
    addBlankVm({
      name: v.name,
      vcpu: v.vcpu || 2,
      ramGiB: v.ramGiB || 8,
      os: v.os || 'linux',
      disks: v.disks && v.disks.length ? v.disks : null,
    });
  }
  if (data.warnings && data.warnings.length) showWarnings(data.warnings);
  e.target.value = '';
}

// ---------- Estimate ----------
async function runEstimate() {
  el('#estimate').disabled = true;
  try {
    const payload = {
      currency: state.currency,
      armRegionName: state.region,
      scenario: state.scenario,
      vms: state.vms,
    };
    const data = await fetch('/api/estimate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).then((r) => r.json());

    if (data.error) {
      showWarnings([data.error]);
      return;
    }

    el('#results').classList.remove('hidden');
    animateValue('#totalMonthly', data.totals.monthly);
    animateValue('#totalTest', data.totals.testFailover24h);
    renderPerVm(data.perVm);
    showWarnings(data.warnings || []);
  } finally {
    el('#estimate').disabled = false;
  }
}

function animateValue(selector, target) {
  const node = el(selector);
  const obj = { v: 0 };
  anime({
    targets: obj,
    v: target,
    duration: 900,
    easing: 'easeOutCubic',
    update: () => (node.textContent = fmt(obj.v)),
  });
}

function renderPerVm(perVm) {
  const root = el('#perVmResults');
  root.innerHTML = '';
  for (const v of perVm) {
    const card = document.createElement('div');
    card.className = 'result-card';
    card.innerHTML = `
      <h4>${escapeHtml(v.name)}</h4>
      <div class="row"><span>Monthly total</span><strong>${fmt(v.monthlyTotal)}</strong></div>
      <div class="row"><span>24h Test DR total</span><strong>${fmt(v.testTotal)}</strong></div>
      <div class="group">
        <div class="group-title">Monthly line items</div>
        ${v.lineItems.monthly.map(li => `<div class="row"><span>${escapeHtml(li.category)} — ${escapeHtml(li.detail || '')}</span><span>${fmt(li.amount)}</span></div>`).join('')}
      </div>
      <div class="group">
        <div class="group-title">Test DR line items</div>
        ${v.lineItems.test.map(li => `<div class="row"><span>${escapeHtml(li.category)} — ${escapeHtml(li.detail || '')}</span><span>${li.info != null ? `(${fmt(li.info)}/mo)` : fmt(li.amount)}</span></div>`).join('')}
      </div>
    `;
    root.appendChild(card);
  }
  anime({ targets: '#perVmResults .result-card', opacity: [0, 1], translateY: [10, 0], delay: anime.stagger(60), duration: 320, easing: 'easeOutQuad' });
}

function showWarnings(list) {
  const root = el('#warnings');
  if (!list || list.length === 0) { root.classList.add('hidden'); root.innerHTML = ''; return; }
  root.classList.remove('hidden');
  root.innerHTML = `<strong>Notes</strong><ul>${list.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ---------- Project export/import ----------
function exportProject() {
  const blob = new Blob([JSON.stringify({
    version: 1,
    region: state.region,
    scenario: state.scenario,
    currency: state.currency,
    vms: state.vms,
  }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `asr-project-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importProject(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    state.vms = [];
    el('#vmList').innerHTML = '';
    if (data.region) { state.region = data.region; el('#region').value = data.region; }
    if (data.scenario) { state.scenario = data.scenario; el('#scenario').value = data.scenario; }
    if (data.currency) { state.currency = data.currency; el('#currency').value = data.currency; }
    for (const v of data.vms || []) addBlankVm(v);
  } catch (err) {
    showWarnings([`Import failed: ${err.message}`]);
  }
  e.target.value = '';
}
