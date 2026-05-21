// Frontend logic for the ASR estimator.
// Vanilla ES modules. Uses global `anime` (loaded via CDN script tag).

const state = {
  vms: [],
  region: null,
  scenario: 'onprem',
  currency: 'EUR',
  lastEstimate: null,
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
  wireRouter();
  addBlankVm();
  route();
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
  el('#estimate').addEventListener('click', () => navigate('#/results'));
  el('#backToEditor').addEventListener('click', (e) => { e.preventDefault(); history.length > 1 ? history.back() : navigate('#/'); });
  el('#backToSummary').addEventListener('click', (e) => { e.preventDefault(); history.length > 1 ? history.back() : navigate('#/results'); });
  el('#refreshPrices').addEventListener('click', async () => {
    await fetch('/api/refresh-prices', { method: 'POST' });
    pollStatus(true);
  });
  el('#exportJson').addEventListener('click', exportProject);
  el('#importJsonFile').addEventListener('change', importProject);
  el('#downloadPdf').addEventListener('click', downloadEstimatePdf);
}

// ---------- Router ----------
function wireRouter() {
  window.addEventListener('hashchange', route);
}

function navigate(hash) {
  if (location.hash === hash) {
    route();
  } else {
    location.hash = hash;
  }
}

function route() {
  const hash = location.hash || '#/';
  if (hash === '#/' || hash === '' || hash === '#') {
    showView('editor');
    return;
  }
  if (hash === '#/results') {
    showView('results');
    showResultsSummary();
    // Trigger fresh estimate every time we land on the results page
    runEstimate();
    return;
  }
  if (hash.startsWith('#/results/')) {
    const id = decodeURIComponent(hash.slice('#/results/'.length));
    showView('results');
    showResultsDetail(id);
    return;
  }
  showView('editor');
}

function showView(name) {
  el('#editor').classList.toggle('hidden', name !== 'editor');
  el('#results-page').classList.toggle('hidden', name !== 'results');
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}

function showResultsSummary() {
  el('#resultsSummary').classList.remove('hidden');
  el('#resultsDetail').classList.add('hidden');
  el('#resultsTitle').textContent = 'Estimate';
}

function showResultsDetail(vmId) {
  el('#resultsSummary').classList.add('hidden');
  el('#resultsDetail').classList.remove('hidden');
  el('#resultsTitle').textContent = 'VM detail';

  if (!state.lastEstimate) {
    // Need data first — run estimate then come back
    el('#vmDetailContent').innerHTML = '<div class="loading">Calculating…</div>';
    runEstimate().then(() => renderVmDetail(vmId));
    return;
  }
  renderVmDetail(vmId);
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
      ? prefill.disks.map((d) => ({ id: uid(), label: d.label || 'Disk', sizeGiB: d.sizeGiB || 128, family: d.family || 'Standard SSD' }))
      : [{ id: uid(), label: 'OS disk', sizeGiB: 128, family: 'Standard SSD' }],
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
  // Graphical OS toggle (Linux / Windows icon buttons)
  const osBtns = elAll('.os-btn', node);
  const syncOsBtns = () => osBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.os === vm.os)));
  syncOsBtns();
  osBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      vm.os = btn.dataset.os;
      syncOsBtns();
    });
  });
  el('.remove', node).addEventListener('click', () => removeVm(vm.id));
  el('.add-disk', node).addEventListener('click', () => {
    const disk = { id: uid(), label: `Disk ${vm.disks.length + 1}`, sizeGiB: 128, family: 'Standard SSD' };
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
  el('#resultsLoading').classList.remove('hidden');
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
      return null;
    }

    state.lastEstimate = data;
    el('#resultsMeta').textContent =
      `${data.armRegionName} · ${data.scenario === 'a2a' ? 'Azure → Azure' : 'On-prem → Azure'} · ${data.currency}`;

    animateValue('#totalMonthly', data.totals.monthly);
    animateValue('#totalTest', data.totals.testFailover24h);
    renderSummaryList(data.perVm);
    showWarnings(data.warnings || []);
    return data;
  } finally {
    el('#resultsLoading').classList.add('hidden');
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

function renderSummaryList(perVm) {
  const root = el('#vmSummaryList');
  root.innerHTML = '';
  for (const v of perVm) {
    const row = document.createElement('div');
    row.className = 'vm-summary-row';
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.innerHTML = `
      <div>
        <div class="name">${escapeHtml(v.name)}</div>
        <div class="sub">${v.lineItems.monthly.length} monthly items · ${v.lineItems.test.length} test items</div>
      </div>
      <div>
        <div class="cost-label">Monthly</div>
        <div class="cost-value">${fmt(v.monthlyTotal)}</div>
      </div>
      <div>
        <div class="cost-label">Test DR (24h)</div>
        <div class="cost-value">${fmt(v.testTotal)}</div>
      </div>
      <div class="chev">›</div>
    `;
    const open = () => navigate(`#/results/${encodeURIComponent(v.vmId)}`);
    row.addEventListener('click', open);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    root.appendChild(row);
  }
  anime({ targets: '.vm-summary-row', opacity: [0, 1], translateY: [10, 0], delay: anime.stagger(50), duration: 320, easing: 'easeOutQuad' });
}

function renderVmDetail(vmId) {
  const data = state.lastEstimate;
  if (!data) return;
  const v = data.perVm.find((x) => x.vmId === vmId);
  const root = el('#vmDetailContent');
  if (!v) {
    root.innerHTML = '<div class="loading">VM not found in current estimate.</div>';
    return;
  }
  root.innerHTML = `
    <div class="result-card">
      <h4>${escapeHtml(v.name)}</h4>
      <div class="row"><span class="desc">Monthly total</span><strong class="amount">${fmt(v.monthlyTotal)}</strong></div>
      <div class="row"><span class="desc">24h Test DR total</span><strong class="amount">${fmt(v.testTotal)}</strong></div>
      <div class="group">
        <div class="group-title">Monthly line items</div>
        ${v.lineItems.monthly.map(li => `<div class="row"><span class="desc">${escapeHtml(li.category)} — ${escapeHtml(li.detail || '')}</span><span class="amount">${fmt(li.amount)}</span></div>`).join('')}
      </div>
      <div class="group">
        <div class="group-title">Test DR line items</div>
        ${v.lineItems.test.map(li => `<div class="row"><span class="desc">${escapeHtml(li.category)} — ${escapeHtml(li.detail || '')}</span><span class="amount">${li.info != null ? `(${fmt(li.info)}/mo)` : fmt(li.amount)}</span></div>`).join('')}
      </div>
    </div>
  `;
  anime({ targets: '#vmDetailContent .result-card', opacity: [0, 1], translateY: [10, 0], duration: 320, easing: 'easeOutQuad' });
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

// ---------- PDF download ----------
async function downloadEstimatePdf() {
  // Ensure we have a fresh estimate to print
  if (!state.lastEstimate) {
    showWarnings(['Generating estimate before exporting…']);
    await runEstimate();
  }
  const data = state.lastEstimate;
  if (!data) return;

  if (typeof pdfMake === 'undefined') {
    showWarnings(['PDF library failed to load. Check your internet connection and retry.']);
    return;
  }

  const doc = buildPdfDoc(data);
  const filename = `asr-estimate-${data.armRegionName}-${new Date().toISOString().slice(0,10)}.pdf`;
  pdfMake.createPdf(doc).download(filename);
}

function buildPdfDoc(data) {
  const colors = {
    text: '#1a2347',
    muted: '#6b7591',
    accent: '#6ea8ff',
    accent2: '#b48cff',
    line: '#d6dbf0',
  };

  const scenarioLabel = data.scenario === 'a2a' ? 'Azure → Azure' : 'On-prem → Azure';
  const generated = new Date().toLocaleString();

  // ----- Page 1: summary -----
  const summaryRows = [
    [
      { text: 'VM', style: 'th' },
      { text: 'DR target', style: 'th' },
      { text: 'OS', style: 'th' },
      { text: 'Monthly', style: 'th', alignment: 'right' },
      { text: 'Test DR (24h)', style: 'th', alignment: 'right' },
    ],
    ...data.perVm.map((v) => {
      const sourceVm = state.vms.find((sv) => sv.id === v.vmId);
      const os = sourceVm?.os === 'windows' ? 'Windows' : 'Linux';
      const target = sourceVm?.recommendedVm || '—';
      return [
        { text: v.name, style: 'td' },
        { text: target, style: 'td' },
        { text: os, style: 'td' },
        { text: fmt(v.monthlyTotal), style: 'td', alignment: 'right' },
        { text: fmt(v.testTotal), style: 'td', alignment: 'right' },
      ];
    }),
    [
      { text: 'TOTAL', style: 'tdBold', colSpan: 3 }, {}, {},
      { text: fmt(data.totals.monthly), style: 'tdBold', alignment: 'right' },
      { text: fmt(data.totals.testFailover24h), style: 'tdBold', alignment: 'right' },
    ],
  ];

  const content = [
    { text: 'Azure Site Recovery — Estimate', style: 'h1' },
    { text: `Generated ${generated}`, style: 'sub' },

    {
      style: 'metaTable',
      table: {
        widths: [90, '*'],
        body: [
          [{ text: 'Region', style: 'metaKey' }, { text: data.armRegionName, style: 'metaVal' }],
          [{ text: 'Scenario', style: 'metaKey' }, { text: scenarioLabel, style: 'metaVal' }],
          [{ text: 'Currency', style: 'metaKey' }, { text: data.currency, style: 'metaVal' }],
          [{ text: 'VMs', style: 'metaKey' }, { text: String(data.perVm.length), style: 'metaVal' }],
        ],
      },
      layout: 'noBorders',
      margin: [0, 0, 0, 14],
    },

    {
      columns: [
        {
          width: '*',
          stack: [
            { text: 'Monthly ASR cost', style: 'totalLabel' },
            { text: fmt(data.totals.monthly), style: 'totalValue' },
          ],
          margin: [0, 0, 8, 0],
        },
        {
          width: '*',
          stack: [
            { text: '24h Test DR cost', style: 'totalLabel', color: colors.accent2 },
            { text: fmt(data.totals.testFailover24h), style: 'totalValueAccent' },
          ],
          margin: [8, 0, 0, 0],
        },
      ],
      margin: [0, 6, 0, 18],
    },

    { text: 'Per-VM summary', style: 'h2', margin: [0, 6, 0, 6] },
    {
      table: { headerRows: 1, widths: ['*', 110, 50, 75, 75], body: summaryRows },
      layout: {
        hLineColor: () => colors.line,
        vLineColor: () => colors.line,
        hLineWidth: (i) => (i === 0 || i === 1 ? 0.8 : 0.3),
        vLineWidth: () => 0,
        paddingTop: () => 6,
        paddingBottom: () => 6,
      },
    },

    ...(data.warnings && data.warnings.length
      ? [
          { text: 'Notes', style: 'h2', margin: [0, 18, 0, 4] },
          { ul: data.warnings.map((w) => ({ text: w, fontSize: 9, color: colors.muted })) },
        ]
      : []),
  ];

  // ----- Page 2..N: per-VM detail -----
  data.perVm.forEach((v, idx) => {
    const sourceVm = state.vms.find((sv) => sv.id === v.vmId);
    const target = sourceVm?.recommendedVm || '—';
    const os = sourceVm?.os === 'windows' ? 'Windows' : 'Linux';

    content.push({ text: '', pageBreak: 'before' });
    content.push({ text: v.name, style: 'h1' });
    content.push({
      style: 'metaTable',
      table: {
        widths: [90, '*'],
        body: [
          [{ text: 'DR target VM', style: 'metaKey' }, { text: target, style: 'metaVal' }],
          [{ text: 'Operating system', style: 'metaKey' }, { text: os, style: 'metaVal' }],
          [{ text: 'Source vCPU / RAM', style: 'metaKey' }, { text: `${sourceVm?.vcpu || '—'} vCPU · ${sourceVm?.ramGiB || '—'} GiB`, style: 'metaVal' }],
          [{ text: 'Disks', style: 'metaKey' }, { text: String((sourceVm?.disks || []).length), style: 'metaVal' }],
        ],
      },
      layout: 'noBorders',
      margin: [0, 0, 0, 14],
    });

    content.push({
      columns: [
        { width: '*', stack: [{ text: 'Monthly total', style: 'totalLabel' }, { text: fmt(v.monthlyTotal), style: 'totalValueSm' }] },
        { width: '*', stack: [{ text: 'Test DR (24h)', style: 'totalLabel', color: colors.accent2 }, { text: fmt(v.testTotal), style: 'totalValueSmAccent' }] },
      ],
      margin: [0, 0, 0, 16],
    });

    content.push({ text: 'Monthly line items', style: 'h2', margin: [0, 4, 0, 4] });
    content.push(lineItemTable(v.lineItems.monthly, colors));

    content.push({ text: 'Test DR (24h) line items', style: 'h2', margin: [0, 14, 0, 4] });
    content.push(lineItemTable(v.lineItems.test, colors, true));
  });

  return {
    pageSize: 'A4',
    pageMargins: [40, 50, 40, 50],
    info: { title: 'ASR Estimate', subject: `ASR estimate for ${data.armRegionName}`, creator: 'ASR Estimator' },
    footer: (page, total) => ({
      columns: [
        { text: 'Azure Site Recovery Estimator', alignment: 'left', margin: [40, 0], fontSize: 8, color: colors.muted },
        { text: `${page} / ${total}`, alignment: 'right', margin: [0, 0, 40, 0], fontSize: 8, color: colors.muted },
      ],
      margin: [0, 20, 0, 0],
    }),
    content,
    defaultStyle: { fontSize: 10, color: colors.text },
    styles: {
      h1: { fontSize: 22, bold: true, margin: [0, 0, 0, 4], color: colors.text },
      h2: { fontSize: 13, bold: true, color: colors.text },
      sub: { fontSize: 9, color: colors.muted, margin: [0, 0, 0, 14] },
      metaTable: { fontSize: 9 },
      metaKey: { color: colors.muted, fontSize: 9, margin: [0, 2, 0, 2] },
      metaVal: { fontSize: 10, margin: [0, 2, 0, 2] },
      totalLabel: { fontSize: 9, color: colors.muted, characterSpacing: 0.5 },
      totalValue: { fontSize: 22, bold: true, color: colors.accent, margin: [0, 2, 0, 0] },
      totalValueAccent: { fontSize: 22, bold: true, color: colors.accent2, margin: [0, 2, 0, 0] },
      totalValueSm: { fontSize: 16, bold: true, color: colors.accent, margin: [0, 2, 0, 0] },
      totalValueSmAccent: { fontSize: 16, bold: true, color: colors.accent2, margin: [0, 2, 0, 0] },
      th: { bold: true, fontSize: 9, color: colors.muted, characterSpacing: 0.4 },
      td: { fontSize: 9 },
      tdBold: { fontSize: 10, bold: true },
    },
  };
}

function lineItemTable(items, colors, isTest = false) {
  const body = [
    [
      { text: 'Category', style: 'th' },
      { text: 'Detail', style: 'th' },
      { text: 'Amount', style: 'th', alignment: 'right' },
    ],
    ...items.map((li) => [
      { text: li.category, style: 'td' },
      { text: li.detail || '', style: 'td', color: colors.muted },
      {
        text: li.info != null ? `(${fmt(li.info)}/mo)` : fmt(li.amount),
        style: 'td',
        alignment: 'right',
      },
    ]),
  ];
  if (!isTest) {
    // Show monthly sum
    const total = items.reduce((s, li) => s + (li.info != null ? 0 : li.amount), 0);
    body.push([
      { text: 'Subtotal', style: 'tdBold', colSpan: 2 }, {},
      { text: fmt(total), style: 'tdBold', alignment: 'right' },
    ]);
  } else {
    const total = items.reduce((s, li) => s + (li.info != null ? 0 : li.amount), 0);
    body.push([
      { text: 'Subtotal (24h)', style: 'tdBold', colSpan: 2 }, {},
      { text: fmt(total), style: 'tdBold', alignment: 'right' },
    ]);
  }
  return {
    table: { headerRows: 1, widths: [130, '*', 75], body },
    layout: {
      hLineColor: () => colors.line,
      vLineColor: () => colors.line,
      hLineWidth: (i) => (i === 0 || i === 1 ? 0.8 : 0.3),
      vLineWidth: () => 0,
      paddingTop: () => 5,
      paddingBottom: () => 5,
    },
  };
}
