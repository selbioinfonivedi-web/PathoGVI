'use strict';
/*
 * GVI web tool front end.
 *
 * Division of responsibility, deliberately: every NUMBER this page reports comes from
 * POST /api/analyze, which runs the same GviPipeline the CLI runs. The client computes only
 * display geometry from the alignment the user supplied -- tree layout, which columns vary,
 * sliding-window diversity for the track, and the root-to-tip scatter. None of that is ever
 * presented as an index value; where the temporal panel needs a rate or an R^2 it takes the
 * server's, so there is exactly one source of truth for anything scientific.
 */

const $ = (id) => document.getElementById(id);
const state = { fasta: null, metadata: null, gff: null, result: null, aln: null, ready: false };

/* ============================ small helpers ============================ */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function showToast(msg, type) {
  const t = document.createElement('div');
  t.className = 'toast' + (type === 'success' ? ' success' : '');
  t.textContent = msg;
  $('toastContainer').appendChild(t);
  setTimeout(() => t.remove(), 3600);
}
function openModal(title, bodyHtml, footHtml) {
  $('modalTitle').innerHTML = title;
  $('modalBody').innerHTML = bodyHtml;
  const foot = $('modalFoot');
  foot.innerHTML = footHtml || '';
  foot.style.display = footHtml ? 'flex' : 'none';
  $('modalOverlay').classList.add('open');
}
function closeModal() { $('modalOverlay').classList.remove('open'); }
$('modalCloseBtn').addEventListener('click', closeModal);
$('modalOverlay').addEventListener('click', (e) => { if (e.target.id === 'modalOverlay') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

function download(filename, content, type) {
  const blob = new Blob([content], { type: type || 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  showToast('Downloaded ' + filename, 'success');
}
const fmt = (v, d) => (v == null || Number.isNaN(v)) ? '—' : Number(v).toFixed(d == null ? 4 : d);
function sig(v) {
  if (v == null) return '—';
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e6)) return Number(v).toExponential(3);
  return Number(v).toFixed(a < 1 ? 5 : 4);
}

/* ============================== tabs ============================== */
const TABS = ['input', 'overview', 'indices', 'phylogeny', 'genome', 'temporal', 'gating', 'report'];
const RESULT_TABS = TABS.slice(1);

function setTabsEnabled(on) {
  state.ready = on;
  RESULT_TABS.forEach((t) => {
    const tab = $('tab-' + t);
    tab.setAttribute('aria-disabled', on ? 'false' : 'true');
    tab.title = on ? '' : 'Run an analysis first';
  });
}
function activateTab(name, opts) {
  opts = opts || {};
  if (TABS.indexOf(name) === -1) name = 'input';
  if (name !== 'input' && !state.ready) return;
  TABS.forEach((t) => {
    const tab = $('tab-' + t), panel = $('panel-' + t), on = (t === name);
    tab.setAttribute('aria-selected', on ? 'true' : 'false');
    tab.tabIndex = on ? 0 : -1;
    panel.hidden = !on;
  });
  // SVG panels are laid out from measured width, so they are drawn on activation, never while hidden.
  if (name === 'phylogeny') drawTree();
  if (name === 'temporal') drawTemporal();
  if (name === 'genome') drawGenome();
  if (opts.focus !== false) $('tab-' + name).focus();
  document.querySelector('.content').scrollTop = 0;
}
document.querySelectorAll('.tabbar .tab').forEach((tab) => {
  tab.addEventListener('click', () => activateTab(tab.id.replace('tab-', ''), { focus: false }));
});
document.querySelector('.tabbar').addEventListener('keydown', (e) => {
  const cur = TABS.indexOf(document.activeElement.id.replace('tab-', ''));
  if (cur === -1) return;
  let next = null;
  if (e.key === 'ArrowRight') next = (cur + 1) % TABS.length;
  else if (e.key === 'ArrowLeft') next = (cur - 1 + TABS.length) % TABS.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = TABS.length - 1;
  if (next === null) return;
  e.preventDefault();
  while (next !== 0 && !state.ready) next = 0;
  activateTab(TABS[next]);
});

/* ========================= input handling ========================= */
function readFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('Could not read ' + file.name));
    r.readAsText(file);
  });
}
async function loadFasta(file) {
  const text = await readFile(file);
  const aln = parseFasta(text);
  if (aln.ids.length < 2) throw new Error('Need at least 2 sequences; found ' + aln.ids.length + '.');
  const lens = new Set(aln.ids.map((i) => aln.seqs[i].length));
  if (lens.size > 1) {
    throw new Error('Sequences are not the same length (' + [...lens].sort((a, b) => a - b).join(', ') +
      ' bp). This file is not aligned — align it first; every position-wise index assumes column i is homologous.');
  }
  state.fasta = text;
  state.aln = aln;
  $('fastaStatus').innerHTML = '<span class="loaded">' + esc(file.name) + '</span> · ' +
    aln.ids.length + ' sequences · ' + aln.length + ' bp';
  $('mSeqs').textContent = aln.ids.length;
  $('mSeqsSub').textContent = file.name;
  $('mLen').textContent = aln.length;
  runPreflight();
}

/*
 * Ask the server what it makes of this alignment, before the user commits to a full run.
 * Server-side deliberately: the thresholds and wording decide how a result is read, and a second
 * implementation here would drift from the Java one.
 */
async function runPreflight() {
  const box = $('preflightBox');
  if (!state.fasta) { box.classList.add('hidden'); return; }
  try {
    const res = await fetch('/api/preflight', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fasta: state.fasta, referenceId: $('referenceId').value.trim() || null })
    });
    if (!res.ok) { box.classList.add('hidden'); return; }
    const p = await res.json();
    const stats = `Lowest pairwise identity ${(p.minPairwiseIdentity * 100).toFixed(0)}% · ` +
                  `${p.fullyCoveredColumns} of ${p.length} columns covered by every sequence ` +
                  `(${(p.fullyCoveredFraction * 100).toFixed(0)}%)`;
    if (p.clean) {
      box.className = 'callout hidden';
      $('fastaStatus').innerHTML += ` · <span style="color:var(--green);">alignment looks usable</span>`;
      return;
    }
    box.className = 'callout warn';
    box.innerHTML = `<strong>Check this alignment before running.</strong> ${esc(stats)}` +
      p.findings.map((f) => `<p style="margin:8px 0 0;">${esc(f)}</p>`).join('');
  } catch (err) {
    box.classList.add('hidden');   // pre-flight is advisory; never block on it
  }
}
function parseFasta(text) {
  const seqs = {}, ids = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line[0] === '>') { cur = line.slice(1).split(/\s+/)[0]; ids.push(cur); seqs[cur] = ''; }
    else if (cur) seqs[cur] += line.toUpperCase();
  }
  return { ids, seqs, length: ids.length ? seqs[ids[0]].length : 0 };
}
function parseMetadata(text) {
  const rows = text.split(/\r?\n/).filter((l) => l.trim());
  if (!rows.length) return {};
  const head = rows[0].split(',').map((h) => h.trim().toLowerCase());
  const iId = head.indexOf('sequence_id'), iDate = head.indexOf('collection_date');
  const iLoc = head.indexOf('location'), iHost = head.indexOf('host');
  const out = {};
  for (const r of rows.slice(1)) {
    const c = r.split(',');
    const id = (c[iId] || '').trim();
    if (!id) continue;
    const date = iDate >= 0 ? (c[iDate] || '').trim() : '';
    let dec = null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (m) {
      const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
      const start = Date.UTC(+m[1], 0, 1);
      dec = +m[1] + (d - start) / (365.25 * 864e5);
    }
    out[id] = {
      date, decimal: dec,
      location: iLoc >= 0 ? (c[iLoc] || '').trim() : '',
      host: iHost >= 0 ? (c[iHost] || '').trim() : '',
      country: (iLoc >= 0 ? (c[iLoc] || '') : '').split(':')[0].trim()
    };
  }
  return out;
}

const fastaDrop = $('fastaDrop');
$('fastaBrowse').addEventListener('click', () => $('fastaFile').click());
$('fastaFile').addEventListener('change', async (e) => {
  if (!e.target.files[0]) return;
  try { await loadFasta(e.target.files[0]); hideError(); } catch (err) { showError(err.message); }
});
['dragenter', 'dragover'].forEach((ev) => fastaDrop.addEventListener(ev, (e) => {
  e.preventDefault(); fastaDrop.classList.add('over');
}));
['dragleave', 'drop'].forEach((ev) => fastaDrop.addEventListener(ev, (e) => {
  e.preventDefault(); fastaDrop.classList.remove('over');
}));
fastaDrop.addEventListener('drop', async (e) => {
  const f = e.dataTransfer.files[0];
  if (!f) return;
  try { await loadFasta(f); hideError(); } catch (err) { showError(err.message); }
});
$('metadataFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (f) { state.metadata = await readFile(f); state.meta = parseMetadata(state.metadata); }
});
$('gffFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (f) state.gff = await readFile(f);
});
$('incidenceFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  state.incidence = await readFile(f);
  const rows = state.incidence.split(/\r?\n/).filter((l) => l.trim()).length - 1;
  showToast('Loaded ' + Math.max(rows, 0) + ' incidence rows — Re will use the Cori estimator', 'success');
});
function checkUnset() {
  const unset = !$('organismClass').value || !$('genomeType').value;
  $('unsetWarning').classList.toggle('hidden', !unset);
  $('mOrg').textContent = $('organismClass').value || '—';
  $('mGenome').textContent = ($('genomeType').value || '—').toUpperCase();
}
$('pathogenId').addEventListener('change', (e) => {
  const p = (state.pathogens || {})[e.target.value];
  if (p && p.tDays != null) {
    $('generationTime').value = p.tDays;
    showToast(`${p.displayName}: ${p.tDays} d (${p.confidence} confidence)`, 'success');
  }
});
$('organismClass').addEventListener('change', checkUnset);
$('genomeType').addEventListener('change', checkUnset);

function showError(msg) { const b = $('errorBox'); b.textContent = msg; b.classList.remove('hidden'); }
function hideError() { $('errorBox').classList.add('hidden'); }
function setBusy(on, text) {
  $('busy').classList.toggle('hidden', !on);
  if (text) $('busyText').textContent = text;
  $('runBtn').disabled = on;
  $('statusLabel').textContent = on ? 'computing…' : (state.result ? 'complete' : 'awaiting input');
  $('sbEngine').textContent = on ? 'pipeline running' : (state.result ? 'pipeline idle' : 'pipeline idle');
}

/* ========================= run the analysis ========================= */
async function run() {
  if (!state.fasta) { showError('Load an aligned multi-FASTA first — it is the one required input.'); return; }
  const indices = Array.from(document.querySelectorAll('.idxCheck:checked')).map((el) => el.value);
  if (indices.length === 0) { showError('Select at least one index to compute.'); return; }
  hideError();
  const slow = $('muMethod').value !== '' || $('dndsMethod').value === 'ml';
  setBusy(true, slow ? 'Running analysis (a slower estimator was selected, this can take a while)…' : 'Running analysis…');
  const body = {
    fasta: state.fasta,
    metadata: state.metadata || null,
    gff: state.gff || null,
    codonUsageSpecies: $('codonSpecies').value || null,
    incidence: state.incidence || null,
    generationTimeDays: $('generationTime').value ? Number($('generationTime').value) : null,
    pathogenId: $('pathogenId').value || null,
    referenceId: $('referenceId').value.trim() || null,
    referenceGc: $('referenceGc').value ? Number($('referenceGc').value) : null,
    gdMethod: $('gdMethod').value || null,
    organismClass: $('organismClass').value || null,
    genomeType: $('genomeType').value || null,
    trimToCovered: $('trimToCovered').checked,
    perSequence: $('perSequence').checked,
    indices: indices,
    highAccuracyMu: $('muMethod').value === 'high_accuracy',
    lsdMu: $('muMethod').value === 'lsd',
    relaxedClockMu: $('muMethod').value === 'relaxed_clock',
    bootstrapSupport: $('bootstrapSupport').checked,
    mlDnds: $('dndsMethod').value === 'ml',
    bdskyRe: $('reMethod').value !== 'phylodynamic_only',
    weights: $('weightScheme').value === 'custom' ? JSON.stringify({
      'mu': Number($('wMu').value),
      'Re': Number($('wRe').value),
      'pi': Number($('wPi').value),
      'MB': Number($('wMb').value),
      'dN/dS': Number($('wDnds').value),
      'GD': Number($('wGd').value),
      'CAI': Number($('wCai').value),
      'GC_Deviation': Number($('wGc').value),
      'RI': Number($('wRi').value)
    }) : null,
    auto: true
  };
  try {
    const res = await fetch('/api/analyze', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) { showError(data.error || ('Analysis failed (HTTP ' + res.status + ')')); setBusy(false); return; }
    state.result = data;
    renderAll(data);
    setTabsEnabled(true);
    setBusy(false);
    activateTab('overview', { focus: false });
    showToast('GVI = ' + fmt(data.gvi) + ' · ' + data.coverageSummary, 'success');
  } catch (err) {
    showError('Could not reach the analysis service: ' + err.message);
    setBusy(false);
  }
}
$('runBtn').addEventListener('click', run);
$('weightScheme').addEventListener('change', () => {
  $('customWeights').hidden = $('weightScheme').value !== 'custom';
});
$('idxAllBtn').addEventListener('click', () => {
  document.querySelectorAll('.idxCheck').forEach((el) => { el.checked = true; });
});
$('idxNoneBtn').addEventListener('click', () => {
  document.querySelectorAll('.idxCheck').forEach((el) => { el.checked = false; });
});
$('clearBtn').addEventListener('click', () => {
  state.fasta = state.metadata = state.gff = state.result = state.aln = state.incidence = null;
  state.meta = {};
  $('fastaStatus').textContent = 'No file loaded';
  $('preflightBox').classList.add('hidden');
  $('fastaFile').value = $('metadataFile').value = $('gffFile').value = '';
  $('incidenceFile').value = '';
  ['generationTime', 'referenceId', 'referenceGc'].forEach((i) => { $(i).value = ''; });
  $('pathogenId').value = ''; $('gdMethod').value = '';
  $('muMethod').value = ''; $('dndsMethod').value = ''; $('reMethod').value = '';
  $('bootstrapSupport').checked = false;
  document.querySelectorAll('.idxCheck').forEach((el) => { el.checked = true; });
  $('weightScheme').value = ''; $('customWeights').hidden = true;
  const defaultWeights = {wMu: 0.135, wRe: 0.30, wPi: 0.10, wMb: 0.215, wDnds: 0.15, wGd: 0.10, wCai: 0.0275, wGc: 0.0275, wRi: 0.035};
  Object.entries(defaultWeights).forEach(([id, v]) => { $(id).value = v; });
  ['mSeqs', 'mLen', 'mCov', 'mExcl'].forEach((i) => { $(i).textContent = '—'; });
  $('mSeqsSub').textContent = 'no alignment loaded';
  $('mCovSub').textContent = 'of the weighting scheme';
  $('mExclSub').textContent = 'indices gated out';
  $('sbGvi').textContent = $('sbCov').textContent = $('sbIdx').textContent = '—';
  setTabsEnabled(false);
  activateTab('input', { focus: false });
  hideError();
});

/* ============================ rendering ============================ */
/* Two palettes, deliberately separate.
 * BAR_COLOURS ranks one series and may fade into neutrals at the tail.
 * SERIES_COLOURS encodes identity (country, host) and must never contain an ink or border
 * tone: those read as "no category assigned" rather than as a category, which is exactly
 * what happened when the second country landed on the neutral #5B5647. */
const BAR_COLOURS = ['#2b6cb0', '#3182ce', '#4299e1', '#63b3ed', '#90cdf4', '#a0aec0', '#cbd5e0', '#d2d6dc', '#e8eaed'];
const SERIES_COLOURS = ['#2b6cb0', '#c05621', '#276749', '#c53030', '#b7791f', '#553c9a'];
const NO_CATEGORY = '#a0aec0';

function renderAll(d) {
  $('mCov').textContent = Math.round(d.effectiveWeightSum * 100) + '%';
  $('mCovSub').textContent = d.comparable ? 'comparable (\u2265 60%)' : 'BELOW the 60% floor';
  $('mExcl').textContent = d.exclusions.length || '0';
  $('mExclSub').textContent = d.exclusions.length
    ? d.exclusions.map((e) => e.key).join(', ') + ' gated out'
    : 'every index had usable data';
  $('sbGvi').textContent = fmt(d.gvi);
  $('sbCov').textContent = Math.round(d.effectiveWeightSum * 100) + '%';
  $('sbIdx').textContent = d.components.length + '/' + (d.components.length + d.exclusions.length);
  const gate = d.exclusions.length;
  $('gateBadge').textContent = gate;
  $('gateBadge').classList.toggle('hidden', gate === 0);
  renderOverview(d);
  renderIndices(d);
  renderGating(d);
  renderReport(d);
}

function renderOverview(d) {
  const max = Math.max(...d.components.map((c) => c.contribution), 1e-9);
  const bars = d.components.slice().sort((a, b) => b.contribution - a.contribution).map((c, i) => `
    <div class="bar-row"><span class="bar-name">${esc(c.key)}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${(c.contribution / max * 100).toFixed(1)}%;
        background:${BAR_COLOURS[i % BAR_COLOURS.length]};"></div></div>
      <span class="bar-val">${fmt(c.contribution, 5)}</span></div>`).join('');
  const rows = d.components.slice().sort((a, b) => b.contribution - a.contribution).map((c) => `
    <tr><td>${esc(c.key)}</td><td class="num">${sig(c.rawValue)}</td><td class="num">${fmt(c.normalizedValue)}</td>
    <td class="num">${fmt(c.effectiveWeight)}</td><td class="num">${fmt(c.contribution, 5)}</td></tr>`).join('');
  const notComparable = d.comparable ? '' : `
    <div class="callout danger" style="margin:0 24px 18px;">
      <strong>This score is not comparable against another dataset's.</strong>
      Only ${Math.round(d.effectiveWeightSum * 100)}% of the weighting scheme had usable data. The composite
      renormalises whichever indices survive, so it still lands in 0–1 and still looks like a GVI — but it is a
      different quantity from a fully-populated one. Read the Quality gating tab before quoting this number.
    </div>`;
  $('panel-overview').innerHTML = `
    <div class="hero">
      <div class="hero-score">
        <span class="score-eyebrow">Composite GVI</span>
        <div class="score-number-row"><span class="score-number">${fmt(d.gvi)}</span><span class="score-unit">/ 1.00</span></div>
        <span class="score-label" style="color:var(--text-sec);">${esc(d.coverageSummary)}</span>
        <div class="score-scale">
          <div class="scale-bar"><span style="background:#276749;"></span><span style="background:#b7791f;"></span><span style="background:#c05621;"></span><span style="background:#c53030;"></span></div>
          <div class="scale-ticks"><span>0</span><span>0.25</span><span>0.50</span><span>0.75</span><span>1.00</span></div>
          <div class="risk-marker" style="left:${(d.gvi * 100).toFixed(1)}%;"></div>
        </div>
        <div class="kv"><span>Comparability</span><span><strong style="color:${d.comparable ? 'var(--green)' : 'var(--red)'};">${d.comparable ? 'Comparable' : 'Not comparable'}</strong></span></div>
        <div class="kv"><span>β multiplier</span><span><strong>${d.betaGenomic == null ? '—' : '×' + fmt(d.betaGenomic, 3)}</strong></span></div>
        <div class="score-actions">
          <button class="btn btn-sm" id="ovFormulaBtn" type="button">View formula</button>
          <button class="btn btn-sm" id="ovJsonBtn" type="button">Download JSON</button>
        </div>
      </div>
      <div class="hero-detail">
        <div class="panel-head" style="padding-left:0;">
          <div class="panel-title-group"><span class="panel-title">Contribution by index</span>
          <span class="panel-sub">wᵢ × normalised value, summing to the composite</span></div>
        </div>
        ${bars}
        <div class="formula-line" style="margin-top:16px;">GVI(t) = w₁·μ + w₂·Re + w₃·π + w₄·MB + w₅·dN/dS + w₆·GD + w₇·CAI + w₈·RI &nbsp;(Σwᵢ = 1)</div>
      </div>
    </div>
    ${notComparable}
    <div class="panel"><div class="panel-head"><div class="panel-title-group">
      <span class="panel-title">Composite computation</span>
      <span class="panel-sub">raw → normalised → weighted contribution</span></div></div>
      <div class="panel-canvas"><table class="data-table">
        <thead><tr><th>Index</th><th class="num">Raw</th><th class="num">Normalised</th><th class="num">Weight</th><th class="num">Contribution</th></tr></thead>
        <tbody>${rows}<tr><td>Composite GVI</td><td class="num">—</td><td class="num">—</td><td class="num">1.0000</td><td class="num">${fmt(d.gvi, 5)}</td></tr></tbody>
      </table>
      ${d.betaExcludesRe ? '<p class="fig-caption" style="padding-left:0;">β_genomic re-runs the composite <em>without</em> Re: Re = β × infectious period by definition, so feeding a Re-inclusive index into a formula that produces a new β would count the same transmissibility signal twice.</p>' : ''}
      </div></div>`;
  $('ovFormulaBtn').addEventListener('click', openFormula);
  $('ovJsonBtn').addEventListener('click', () => download('gvi_result.json', JSON.stringify(d, null, 2), 'application/json'));
}

function renderIndices(d) {
  const entries = Object.entries(d.indices || {});
  const rows = entries.map(([k, v]) => {
    const iv = v.interval
      ? `${fmt(v.interval.lower, 2)} – ${fmt(v.interval.upper, 2)}`
      : '<span style="color:var(--text-muted);">—</span>';
    return `<tr><td>${esc(k)}</td><td class="num">${sig(v.value != null ? v.value : v.primaryValue)}</td>
      <td class="num">${iv}</td><td>${esc(v.category || '')}</td></tr>`;
  }).join('');
  const sens = (d.sensitivity || []).slice().sort((a, b) => b.spread - a.spread).map((s) => `
    <tr><td>${esc(s.key)}</td><td class="num">${fmt(s.gviAtLowWeight)}</td><td class="num">${fmt(s.gviAtHighWeight)}</td><td class="num">${fmt(s.spread)}</td></tr>`).join('');
  $('panel-indices').innerHTML = `<div class="card">
    <table class="data-table"><caption>Index values against the specification's reference bands</caption>
      <thead><tr><th>Index</th><th class="num">Value</th><th class="num">95% interval</th><th>Reference-band classification</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4">No indices computed.</td></tr>'}</tbody></table>
    <p class="fig-caption" style="padding-left:0; border-top:none;">An interval is shown only where the estimator produces one. Re's is a profile-likelihood interval; on realistic tree sizes it is wide, and the width is the result.</p>
    ${sens ? `<table class="data-table" style="margin-top:26px;">
      <caption>Weight sensitivity — each weight perturbed ±20%</caption>
      <thead><tr><th>Index perturbed</th><th class="num">GVI low</th><th class="num">GVI high</th><th class="num">Spread</th></tr></thead>
      <tbody>${sens}</tbody></table>
      <p class="fig-caption" style="padding-left:0; margin-top:14px; border-top:none;">Base GVI = ${fmt(d.gvi)}. The weights are the specification's range midpoints — asserted, not fitted against any observed outcome. Report this spread alongside the score.</p>` : ''}</div>`;
}

function renderGating(d) {
  const excl = d.exclusions.map((e) => `
    <div class="exclusion"><h4>${esc(e.key)} excluded</h4><p>${esc(e.reason)}</p></div>`).join('');
  const skipped = (d.otherSkipped || []).map((s) => `<div class="warn-item">${esc(s)}</div>`).join('');
  const warns = (d.warnings || []).map((w) => `<div class="warn-item">${esc(w)}</div>`).join('');
  $('panel-gating').innerHTML = `<div class="card">
    <div class="coverage-note">
      <strong>${esc(d.coverageSummary)}.</strong>
      The composite renormalises whichever indices survive gating, so a score built from two indices and one
      built from nine both land in 0–1 and look alike. ${d.comparable
        ? 'This run cleared the 60% coverage floor, so it can be ranked against another dataset.'
        : 'This run did <em>not</em> clear the 60% coverage floor. Do not rank it against another dataset.'}
    </div>
    ${excl ? '<h3 style="font-size:12px; font-weight:600; color:var(--text-sec); text-transform:uppercase; letter-spacing:0.06em; padding-bottom:6px; border-bottom:1px solid var(--border-light); margin:0 0 12px;">Excluded from the score</h3>' + excl : '<p class="hint">No index was excluded — every one had usable data.</p>'}
    ${skipped ? '<h3 style="font-size:12px; font-weight:600; color:var(--text-sec); text-transform:uppercase; letter-spacing:0.06em; padding-bottom:6px; border-bottom:1px solid var(--border-light); margin:22px 0 12px;">Not computed</h3>' + skipped : ''}
    ${warns ? '<h3 style="font-size:12px; font-weight:600; color:var(--text-sec); text-transform:uppercase; letter-spacing:0.06em; padding-bottom:6px; border-bottom:1px solid var(--border-light); margin:22px 0 12px;">Warnings</h3>' + warns : ''}</div>`;
}

function renderReport(d) {
  $('panel-report').innerHTML = `<div class="card">
    <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:18px;">
      <button class="btn btn-primary btn-sm" id="rpJson" type="button">Download JSON</button>
      <button class="btn btn-sm" id="rpCsv" type="button">Download CSV</button>
      <button class="btn btn-sm" id="rpTxt" type="button">Download text report</button>
      <button class="btn btn-sm" id="rpTree" type="button">Export phylogeny (SVG)</button>
    </div>
    <pre class="report">${esc(d.report || '(no text report returned)')}</pre></div>`;
  $('rpJson').addEventListener('click', () => download('gvi_result.json', JSON.stringify(d, null, 2), 'application/json'));
  $('rpTxt').addEventListener('click', () => download('gvi_report.txt', d.report || '', 'text/plain'));
  $('rpCsv').addEventListener('click', () => {
    const head = 'index,raw_value,normalized,weight,contribution';
    const body = d.components.map((c) => [c.key, c.rawValue, c.normalizedValue, c.effectiveWeight, c.contribution].join(',')).join('\n');
    const gone = d.exclusions.map((e) => [e.key, '', '', '', 'EXCLUDED'].join(',')).join('\n');
    download('gvi_indices.csv', [head, body, gone].filter(Boolean).join('\n'), 'text/csv');
  });
  $('rpTree').addEventListener('click', () => {
    drawTree();
    const svg = $('treeSvg');
    if (!svg) { showToast('Load an alignment first.'); return; }
    download('gvi_phylogeny.svg',
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + svg.getAttribute('viewBox') + '">' +
      '<rect width="100%" height="100%" fill="#FFFFFF"/>' + svg.innerHTML + '</svg>', 'image/svg+xml');
  });
}

function openFormula() {
  const d = state.result;
  const rows = d.components.map((c) =>
    `<div class="kv"><span>${esc(c.key)}</span><span>${fmt(c.normalizedValue)} × ${fmt(c.effectiveWeight)} = ${fmt(c.contribution, 5)}</span></div>`).join('');
  openModal('Composite GVI — specification § GVI 2.0', `
    <div class="formula-line" style="margin:0 0 12px;">GVI(t) = w₁·μ + w₂·Re + w₃·π + w₄·MB + w₅·dN/dS + w₆·GD + w₇·CAI + w₈·RI</div>
    <p style="font-size:12.5px; color:var(--text-sec); line-height:1.6;">Each parameter is scaled 0–1 by min-max
    normalisation against its reference range and clamped, so an outlier saturates rather than distorting the
    composite. Weights sum to 1. When an index fails quality gating it is dropped and the surviving weights are
    renormalised — which is why the effective weights below may differ from the configured ones.</p>
    ${rows}
    <div class="kv" style="border-top:1px solid var(--ink); margin-top:6px; padding-top:8px;"><span><strong>Composite GVI</strong></span><span><strong>${fmt(d.gvi, 5)}</strong></span></div>`);
}
$('formulaBtn').addEventListener('click', () => {
  if (!state.result) { showToast('Run an analysis first.'); return; }
  openFormula();
});

/* ===================== alignment geometry (display only) =====================
 * Everything below derives picture coordinates from the alignment the user loaded.
 * It computes no index and reports no rate: where a number is shown it comes from
 * state.result, i.e. from the server's pipeline run.
 */
function pairwiseMatrix(aln) {
  const D = {};
  for (const a of aln.ids) {
    D[a] = {};
    for (const b of aln.ids) {
      if (a === b) { D[a][b] = 0; continue; }
      if (D[b] && D[b][a] != null) { D[a][b] = D[b][a]; continue; }
      const x = aln.seqs[a], y = aln.seqs[b];
      let n = 0, diff = 0;
      for (let i = 0; i < x.length; i++) {
        if ('ACGT'.includes(x[i]) && 'ACGT'.includes(y[i])) { n++; if (x[i] !== y[i]) diff++; }
      }
      D[a][b] = n ? diff / n : 0;
    }
  }
  return D;
}
function neighbourJoining(ids, D) {
  const node = {};
  ids.forEach((i) => { node[i] = { name: i, leaf: true }; });
  let active = ids.slice();
  const d = {};
  ids.forEach((a) => { d[a] = Object.assign({}, D[a]); });
  let counter = 0;
  while (active.length > 2) {
    const n = active.length;
    const r = {};
    active.forEach((i) => {
      r[i] = active.reduce((s, j) => s + (j === i ? 0 : d[i][j]), 0) / (n - 2);
    });
    let best = null;
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const a = active[i], b = active[j];
        const q = d[a][b] - r[a] - r[b];
        if (!best || q < best.q) best = { q, a, b };
      }
    }
    const { a, b } = best;
    const la = (d[a][b] + r[a] - r[b]) / 2;
    const name = 'n' + (++counter);
    node[name] = { name, leaf: false, children: [
      { node: node[a], len: Math.max(la, 0) },
      { node: node[b], len: Math.max(d[a][b] - la, 0) }] };
    d[name] = {};
    active.forEach((c) => {
      if (c === a || c === b) return;
      const v = (d[a][c] + d[b][c] - d[a][b]) / 2;
      d[name][c] = v; d[c][name] = v;
    });
    d[name][name] = 0;
    active = active.filter((x) => x !== a && x !== b).concat(name);
  }
  const [a, b] = active;
  return { name: 'root', leaf: false, children: [
    { node: node[a], len: d[a][b] / 2 }, { node: node[b], len: d[a][b] / 2 }] };
}
function buildGeometry() {
  const aln = state.aln;
  if (!aln) return null;
  if (state.geom && state.geom.for === aln) return state.geom;
  const D = pairwiseMatrix(aln);
  const tree = neighbourJoining(aln.ids, D);
  const sites = [];
  const PUR = 'AG', PYR = 'CT';
  for (let j = 0; j < aln.length; j++) {
    const obs = new Set();
    for (const id of aln.ids) { const c = aln.seqs[id][j]; if ('ACGT'.includes(c)) obs.add(c); }
    if (obs.size > 1) {
      const all = [...obs];
      const kind = all.every((c) => PUR.includes(c)) || all.every((c) => PYR.includes(c)) ? 'transition' : 'transversion';
      sites.push({ pos: j + 1, kind, alleles: all.sort().join('') });
    }
  }
  const W = Math.max(20, Math.round(aln.length / 12)), STEP = Math.max(5, Math.round(W / 4));
  const windows = [];
  for (let s = 0; s + W <= aln.length; s += STEP) {
    let tot = 0, cnt = 0;
    for (let i = 0; i < aln.ids.length; i++) {
      for (let k = i + 1; k < aln.ids.length; k++) {
        const x = aln.seqs[aln.ids[i]], y = aln.seqs[aln.ids[k]];
        let n = 0, diff = 0;
        for (let j = s; j < s + W; j++) {
          if ('ACGT'.includes(x[j]) && 'ACGT'.includes(y[j])) { n++; if (x[j] !== y[j]) diff++; }
        }
        if (n) { tot += diff / n; cnt++; }
      }
    }
    windows.push({ start: s + 1, end: s + W, pi: cnt ? tot / cnt : 0 });
  }
  // Root-to-tip: divergence from the reference the server used, against collection date.
  const meta = state.meta || {};
  const root = aln.ids[0];
  const rtt = aln.ids.map((id) => {
    const p = D[root][id];
    const jc = (p > 0 && 1 - 4 * p / 3 > 0) ? -0.75 * Math.log(1 - 4 * p / 3) : p;
    const m = meta[id] || {};
    return { id, p, jc, decimal: m.decimal, date: m.date || '', country: m.country || '', host: m.host || '' };
  }).filter((r) => r.decimal != null).sort((a, b) => a.decimal - b.decimal);
  state.geom = { for: aln, D, tree, sites, windows, rtt, root, windowSize: W };
  return state.geom;
}
function countryPalette(rtt) {
  const cs = [...new Set(rtt.map((r) => r.country).filter(Boolean))];
  const map = {};
  cs.forEach((c, i) => { map[c] = SERIES_COLOURS[i % SERIES_COLOURS.length]; });
  return map;
}

/* --------------------------- phylogeny --------------------------- */
function drawTree() {
  const g = buildGeometry();
  const panel = $('panel-phylogeny');
  if (!g) { panel.innerHTML = '<div class="empty-state"><h3>No alignment</h3><p>Load a FASTA to see the tree.</p></div>'; return; }
  if (!panel.querySelector('#treeSvg')) {
    panel.innerHTML = `<div class="panel">
      <div class="panel-head"><div class="panel-title-group">
        <span class="panel-title">Phylogenetic inference</span>
        <span class="panel-sub">neighbour-joining on p-distances · ${state.aln.ids.length} taxa · rooted at ${esc(g.root)}</span></div>
        <div class="panel-controls"><select class="ctl" id="treeColour">
          <option value="country">Colour by · country</option><option value="host">Colour by · host</option><option value="none">No colouring</option>
        </select></div></div>
      <div class="panel-canvas"><svg id="treeSvg" width="100%" height="320" viewBox="0 0 1400 320" preserveAspectRatio="xMidYMid meet"></svg>
      <div class="clade-legend" id="treeLegend"></div></div>
      <p class="fig-caption">Neighbour-joining tree of ${state.aln.ids.length} sequences (${state.aln.length} bp), built on uncorrected p-distances in the browser for display. The indices reported elsewhere come from the server's own tree.</p>
    </div>`;
    $('treeColour').addEventListener('change', drawTree);
  }
  const mode = ($('treeColour') || {}).value || 'country';
  const meta = state.meta || {};
  const cpal = countryPalette(Object.values(meta).length ? Object.keys(meta).map((id) => ({ country: (meta[id] || {}).country })) : []);
  const hosts = [...new Set(Object.values(meta).map((m) => m.host).filter(Boolean))];
  const hpal = {}; hosts.forEach((h, i) => { hpal[h] = SERIES_COLOURS[i % SERIES_COLOURS.length]; });
  const colourOf = (id) => {
    const m = meta[id] || {};
    if (mode === 'country') return cpal[m.country] || NO_CATEGORY;
    if (mode === 'host') return hpal[m.host] || NO_CATEGORY;
    return '#4a5568';
  };
  const leaves = [];
  (function walk(n) { if (n.leaf) { leaves.push(n); return; } n.children.forEach((c) => walk(c.node)); })(g.tree);
  let maxDepth = 0;
  (function depth(n, dd) { n._d = dd; if (dd > maxDepth) maxDepth = dd; if (!n.leaf) n.children.forEach((c) => depth(c.node, dd + c.len)); })(g.tree, 0);
  const yOf = {}; leaves.forEach((l, i) => { yOf[l.name] = i; });
  (function assignY(n) {
    if (n.leaf) { n._y = yOf[n.name]; return n._y; }
    const ys = n.children.map((c) => assignY(c.node));
    n._y = ys.reduce((a, b) => a + b, 0) / ys.length; return n._y;
  })(g.tree);
  const x0 = 30, x1 = Math.min(900, 300 + leaves.length * 40), top = 24, rowH = Math.max(18, Math.min(30, 260 / leaves.length));
  const sx = (v) => x0 + (maxDepth ? v / maxDepth : 0) * (x1 - x0);
  const sy = (v) => top + v * rowH;
  let out = '';
  (function draw(n) {
    if (n.leaf) return;
    const ys = n.children.map((c) => sy(c.node._y));
    out += `<line x1="${sx(n._d).toFixed(1)}" y1="${Math.min(...ys).toFixed(1)}" x2="${sx(n._d).toFixed(1)}" y2="${Math.max(...ys).toFixed(1)}" stroke="#cbd5e0" stroke-width="1.4"/>`;
    n.children.forEach((c) => {
      const cn = c.node;
      out += `<line x1="${sx(n._d).toFixed(1)}" y1="${sy(cn._y).toFixed(1)}" x2="${sx(cn._d).toFixed(1)}" y2="${sy(cn._y).toFixed(1)}" stroke="${cn.leaf ? colourOf(cn.name) : '#cbd5e0'}" stroke-width="${cn.leaf ? 2.2 : 1.4}"/>`;
      draw(cn);
    });
  })(g.tree);
  leaves.forEach((l) => {
    const y = sy(l._y), m = meta[l.name] || {};
    out += `<circle cx="${sx(l._d).toFixed(1)}" cy="${y.toFixed(1)}" r="4" fill="${colourOf(l.name)}"/>`;
    out += `<text x="${(sx(l._d) + 10).toFixed(1)}" y="${(y + 4).toFixed(1)}" font-family="SF Mono, Cascadia Code, Fira Code, ui-monospace, monospace" font-size="12" fill="#1a202c">${esc(l.name)}</text>`;
    if (m.date) out += `<text x="${x1 + 190}" y="${(y + 4).toFixed(1)}" font-family="SF Mono, Cascadia Code, Fira Code, ui-monospace, monospace" font-size="11" fill="#4a5568">${esc(m.date)}</text>`;
    if (m.location) out += `<text x="${x1 + 300}" y="${(y + 4).toFixed(1)}" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif" font-size="11" fill="#a0aec0">${esc(m.location)}</text>`;
  });
  const rawUnit = maxDepth / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(rawUnit)));
  const unit = (rawUnit / mag >= 5 ? 5 : rawUnit / mag >= 2 ? 2 : 1) * mag;
  const by = top + leaves.length * rowH + 16;
  out += `<line x1="${x0}" y1="${by}" x2="${(x0 + (unit / maxDepth) * (x1 - x0)).toFixed(1)}" y2="${by}" stroke="#4a5568" stroke-width="1.4"/>` +
         `<text x="${x0}" y="${by + 15}" font-family="SF Mono, Cascadia Code, Fira Code, ui-monospace, monospace" font-size="11" fill="#4a5568">${unit >= 0.01 ? unit.toFixed(3) : unit.toExponential(1)} substitutions/site</text>`;
  const svg = $('treeSvg');
  svg.setAttribute('viewBox', `0 0 1400 ${by + 28}`);
  svg.innerHTML = out;
  const pal = mode === 'host' ? hpal : (mode === 'country' ? cpal : {});
  $('treeLegend').innerHTML = Object.keys(pal).map((k) =>
    `<span class="legend-item" style="cursor:default;"><span class="clade-dot" style="background:${pal[k]};"></span>${esc(k)}</span>`).join('');
}

/* ---------------------------- genome ---------------------------- */
function drawGenome() {
  const g = buildGeometry();
  const panel = $('panel-genome');
  if (!g) { panel.innerHTML = '<div class="empty-state"><h3>No alignment</h3><p>Load a FASTA to see the genome track.</p></div>'; return; }
  if (!panel.querySelector('#variantRow')) {
    panel.innerHTML = `<div class="panel">
      <div class="panel-head"><div class="panel-title-group">
        <span class="panel-title">Genome explorer</span>
        <span class="panel-sub">${state.aln.length} bp · ${g.sites.length} variable sites</span></div>
        <div class="panel-controls"><div class="toggle-group" id="genomeMode">
          <button class="active" data-mode="variants" type="button">Variable sites</button>
          <button data-mode="diversity" type="button">Diversity (π)</button>
          <button data-mode="codon" type="button">Codon position</button></div></div></div>
      <div class="panel-canvas">
        <div class="variant-row" id="variantRow"></div>
        <div class="axis-row"><span>1 bp</span><span>${Math.round(state.aln.length / 2)}</span><span>${state.aln.length} bp</span></div>
        <div class="clade-legend" id="genomeLegend"></div></div>
      <p class="fig-caption" id="genomeCaption"></p></div>`;
    panel.querySelectorAll('#genomeMode button').forEach((b) => b.addEventListener('click', () => {
      panel.querySelectorAll('#genomeMode button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active'); drawGenome();
    }));
  }
  const mode = (panel.querySelector('#genomeMode button.active') || {}).dataset?.mode || 'variants';
  const L = state.aln.length, row = $('variantRow'), leg = $('genomeLegend'), cap = $('genomeCaption');
  if (mode === 'diversity') {
    const mx = Math.max(...g.windows.map((w) => w.pi), 1e-9);
    row.innerHTML = g.windows.map((w) => {
      const t = w.pi / mx, h = 6 + t * 30;
      return `<div class="diversity-bar" title="${w.start}–${w.end} bp · π=${w.pi.toFixed(5)}" style="left:${((w.start - 1) / L * 100).toFixed(2)}%; width:${(g.windowSize / L * 100).toFixed(2)}%; height:${h.toFixed(1)}px; background:rgb(${Math.round(235 + (43 - 235) * t)},${Math.round(244 + (108 - 244) * t)},${Math.round(255 + (176 - 255) * t)});"></div>`;
    }).join('');
    leg.innerHTML = `<span class="legend-item" style="cursor:default;"><span class="clade-dot" style="background:#ebf4ff;border:1px solid var(--border);"></span>π low</span><span class="legend-item" style="cursor:default;"><span class="clade-dot" style="background:#2b6cb0;"></span>π high (max ${mx.toFixed(5)})</span>`;
    cap.innerHTML = `Pairwise diversity in ${g.windowSize} bp sliding windows. The dataset-wide π reported on the Indices tab is the server's, computed over the whole alignment.`;
  } else if (mode === 'codon') {
    const cols = ['#2b6cb0', '#c05621', '#276749'], counts = [0, 0, 0];
    row.innerHTML = g.sites.map((s) => {
      const cp = (s.pos - 1) % 3; counts[cp]++;
      return `<div class="variant-tick" title="position ${s.pos} · codon position ${cp + 1}" style="left:${((s.pos - 1) / L * 100).toFixed(3)}%; background:${cols[cp]};"></div>`;
    }).join('');
    leg.innerHTML = counts.map((n, i) => `<span class="legend-item" style="cursor:default;"><span class="clade-dot" style="background:${cols[i]};"></span>codon position ${i + 1} (${n})</span>`).join('');
    cap.innerHTML = `Variable sites by position within the codon, counted from the start of the alignment. A third-position excess is the signature of purifying selection — read dN/dS on the Indices tab for the tested answer.`;
  } else {
    const ts = g.sites.filter((s) => s.kind === 'transition').length, tv = g.sites.length - ts;
    row.innerHTML = g.sites.map((s) =>
      `<div class="variant-tick" title="position ${s.pos} · ${s.alleles} · ${s.kind}" style="left:${((s.pos - 1) / L * 100).toFixed(3)}%; background:${s.kind === 'transition' ? '#c05621' : '#2b6cb0'};"></div>`).join('');
    leg.innerHTML = `<span class="legend-item" style="cursor:default;"><span class="clade-dot" style="background:#c05621;"></span>transition (${ts})</span><span class="legend-item" style="cursor:default;"><span class="clade-dot" style="background:#2b6cb0;"></span>transversion (${tv})</span>`;
    cap.innerHTML = `All ${g.sites.length} variable sites across the ${L} bp alignment. Transitions outnumber transversions ${ts}:${tv}${tv ? ' (ratio ' + (ts / tv).toFixed(2) + ')' : ''}.`;
  }
}

/* --------------------------- temporal --------------------------- */
function drawTemporal() {
  const g = buildGeometry();
  const panel = $('panel-temporal');
  const d = state.result;
  if (!g || !g.rtt.length) {
    panel.innerHTML = `<div class="empty-state"><h3>No dated sequences</h3>
      <p>Root-to-tip regression needs collection dates. Supply a metadata CSV with a
      <code>collection_date</code> column — without it μ cannot be estimated at all.</p></div>`;
    return;
  }
  const muInfo = (d && d.indices && (d.indices['mu'] || d.indices['μ'])) || null;
  const excluded = d ? d.exclusions.find((e) => /^mu$/i.test(e.key)) : null;
  panel.innerHTML = `<div class="panel">
    <div class="panel-head"><div class="panel-title-group">
      <span class="panel-title">Temporal signal — root-to-tip</span>
      <span class="panel-sub">divergence from ${esc(g.root)} against collection date</span></div>
      <span class="panel-sub" style="font-family:var(--font-mono);">${g.rtt.length} dated sequences</span></div>
    <div class="panel-canvas"><svg id="temporalSvg" width="100%" height="330" viewBox="0 0 1400 330" preserveAspectRatio="xMidYMid meet"></svg></div>
    <p class="fig-caption">${excluded
      ? '<strong>μ was excluded.</strong> ' + esc(excluded.reason)
      : (muInfo ? 'μ = ' + sig(muInfo.primaryValue) + ' — ' + esc(muInfo.category || '') : 'Points are the browser\'s display fit; μ itself is the server\'s estimate.')}</p></div>`;
  const rtt = g.rtt, svg = $('temporalSvg');
  const W = 1400, H = 330, ml = 96, mr = 40, mt = 24, mb = 56;
  const xs = rtt.map((r) => r.decimal), ys = rtt.map((r) => r.jc);
  const xmin = Math.min(...xs) - 0.6, xmax = Math.max(...xs) + 0.6, ymax = Math.max(...ys) * 1.18 || 1;
  const px = (x) => ml + (x - xmin) / (xmax - xmin) * (W - ml - mr);
  const py = (y) => H - mb - y / ymax * (H - mt - mb);
  let o = '';
  const step = Math.pow(10, Math.floor(Math.log10(ymax))) / (ymax / Math.pow(10, Math.floor(Math.log10(ymax))) > 5 ? 1 : 2);
  for (let v = 0; v <= ymax; v += step) {
    o += `<line x1="${ml}" y1="${py(v).toFixed(1)}" x2="${W - mr}" y2="${py(v).toFixed(1)}" stroke="#e8eaed" stroke-width="1"/>` +
         `<text x="${ml - 10}" y="${(py(v) + 4).toFixed(1)}" text-anchor="end" font-family="SF Mono, Cascadia Code, Fira Code, ui-monospace, monospace" font-size="11" fill="#a0aec0">${v.toFixed(3)}</text>`;
  }
  for (let y = Math.ceil(xmin); y <= Math.floor(xmax); y++) {
    o += `<text x="${px(y).toFixed(1)}" y="${H - mb + 20}" text-anchor="middle" font-family="SF Mono, Cascadia Code, Fira Code, ui-monospace, monospace" font-size="11" fill="#a0aec0">${y}</text>`;
  }
  const n = rtt.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  const sxx = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  const slope = sxx ? xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / sxx : 0;
  const icept = my - slope * mx;
  o += `<line x1="${px(xmin).toFixed(1)}" y1="${py(Math.max(0, icept + slope * xmin)).toFixed(1)}" x2="${px(xmax).toFixed(1)}" y2="${py(Math.max(0, icept + slope * xmax)).toFixed(1)}" stroke="${excluded ? '#c53030' : '#276749'}" stroke-width="2" stroke-dasharray="${excluded ? '7 5' : '0'}"/>`;
  const cpal = countryPalette(rtt);
  rtt.forEach((r) => {
    o += `<circle cx="${px(r.decimal).toFixed(1)}" cy="${py(r.jc).toFixed(1)}" r="6" fill="${cpal[r.country] || NO_CATEGORY}" stroke="#FFFFFF" stroke-width="1.5"><title>${esc(r.id)} · ${esc(r.date)} · divergence ${r.jc.toFixed(5)}</title></circle>`;
  });
  o += `<text transform="translate(26,${H / 2}) rotate(-90)" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif" font-size="12" fill="#4a5568">Divergence from root (Jukes-Cantor)</text>`;
  if (excluded) {
    o += `<rect x="${ml + 18}" y="${mt + 8}" width="330" height="46" fill="#fff5f5" stroke="#c53030" stroke-width="1"/>` +
         `<text x="${ml + 32}" y="${mt + 30}" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif" font-size="12.5" font-weight="600" fill="#1a202c">Slope rejected — μ excluded from the composite</text>` +
         `<text x="${ml + 32}" y="${mt + 47}" font-family="SF Mono, Cascadia Code, Fira Code, ui-monospace, monospace" font-size="11" fill="#c53030">see Quality gating for the test result</text>`;
  }
  o += `<line x1="${ml}" y1="${H - mb}" x2="${W - mr}" y2="${H - mb}" stroke="#4a5568" stroke-width="1.2"/>` +
       `<line x1="${ml}" y1="${mt}" x2="${ml}" y2="${H - mb}" stroke="#4a5568" stroke-width="1.2"/>`;
  svg.innerHTML = o;
}

/* ============================ self-test ============================ */
$('selfTestBtn').addEventListener('click', async () => {
  openModal('Self-test', '<div class="busy"><span class="spinner"></span> Running the bundled diagnostic suite…</div>');
  try {
    const res = await fetch('/api/self-test', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) { $('modalBody').innerHTML = `<div class="callout danger">${esc(data.error)}</div>`; return; }
    $('modalBody').innerHTML =
      `<div class="callout ${data.allPassed ? '' : 'danger'}"><strong>${data.allPassed ? 'All self-tests passed.' : 'Some self-tests FAILED.'}</strong>
       ${data.allPassed ? ' This installation computes all 8 indices correctly.' : ' Do not trust results from this installation.'}</div>` +
      data.cases.map((c) => `<div class="kv"><span>${esc(c.name)}</span><span><strong style="color:${c.passed ? 'var(--green)' : 'var(--red)'};">${c.passed ? 'PASS' : 'FAIL'}</strong></span></div>`).join('');
  } catch (err) {
    $('modalBody').innerHTML = `<div class="callout danger">${esc(err.message)}</div>`;
  }
});

/* ============================== boot ============================== */
(async function boot() {
  setTabsEnabled(false);
  activateTab('input', { focus: false });
  checkUnset();
  try {
    const res = await fetch('/api/codon-species');
    const data = await res.json();
    const sel = $('codonSpecies');
    for (const s of data.species) {
      const opt = document.createElement('option');
      opt.value = s; opt.textContent = s.replace(/_/g, ' ');
      sel.appendChild(opt);
    }
  } catch (err) {
    $('codonSpecies').insertAdjacentHTML('beforeend', '<option disabled>could not load list</option>');
  }
  try {
    const res = await fetch('/api/pathogens');
    const data = await res.json();
    const sel = $('pathogenId');
    state.pathogens = {};
    for (const p of data.pathogens) {
      state.pathogens[p.pathogenId] = p;
      const opt = document.createElement('option');
      opt.value = p.pathogenId;
      // Say plainly which entries carry a usable value; an unusable one is not a failure to hide.
      opt.textContent = p.tDays != null
        ? `${p.displayName} — ${p.tDays} d (${p.confidence})`
        : `${p.displayName} — no value in table`;
      opt.disabled = p.tDays == null;
      sel.appendChild(opt);
    }
  } catch (err) {
    $('pathogenId').insertAdjacentHTML('beforeend', '<option disabled>could not load table</option>');
  }
  try {
    const res = await fetch('/api/health');
    const h = await res.json();
    $('engineLabel').textContent = 'local pipeline v' + h.version;
  } catch (err) { $('engineLabel').textContent = 'unreachable'; }
})();

/* Paste fallback. The file picker is the common path, but a user working over SSH or
   copying an alignment out of another tool has no file to point at -- the original
   interface offered this and dropping it was a regression. */
(function pasteFallback() {
  const useFasta = $('fastaUse');
  if (useFasta) {
    useFasta.addEventListener('click', () => {
      const text = $('fastaText').value.trim();
      if (!text) { showError('Nothing pasted.'); return; }
      try {
        const aln = parseFasta(text);
        if (aln.ids.length < 2) throw new Error('Need at least 2 sequences; found ' + aln.ids.length + '.');
        const lens = new Set(aln.ids.map((i) => aln.seqs[i].length));
        if (lens.size > 1) {
          throw new Error('Sequences are not the same length (' + [...lens].sort((a, b) => a - b).join(', ') +
            ' bp). This file is not aligned — align it first.');
        }
        state.fasta = text; state.aln = aln; state.geom = null;
        $('fastaStatus').innerHTML = '<span class="loaded">pasted</span> · ' + aln.ids.length +
          ' sequences · ' + aln.length + ' bp';
        $('mSeqs').textContent = aln.ids.length;
        $('mSeqsSub').textContent = 'pasted';
        $('mLen').textContent = aln.length;
        runPreflight();
        hideError();
        showToast('Loaded ' + aln.ids.length + ' sequences', 'success');
      } catch (err) { showError(err.message); }
    });
  }
  const useMeta = $('metadataUse');
  if (useMeta) {
    useMeta.addEventListener('click', () => {
      const text = $('metadataText').value.trim();
      if (!text) { showError('Nothing pasted.'); return; }
      state.metadata = text; state.meta = parseMetadata(text); state.geom = null;
      const dated = Object.values(state.meta).filter((m) => m.decimal != null).length;
      showToast('Loaded metadata for ' + Object.keys(state.meta).length + ' sequences (' + dated + ' dated)', 'success');
      hideError();
    });
  }
})();
