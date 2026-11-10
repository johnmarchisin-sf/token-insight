// Vanilla-JS dashboard — fetches /api/report and renders usage tracking views.

const $ = (id) => document.getElementById(id);

const fmtTokens = (n) => {
  if (n == null) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(Math.round(n));
};
const fmtInt = (n) => (n ?? 0).toLocaleString();
const fmtCost = (n) => {
  if (n == null || !isFinite(n)) return '$0.00';
  if (n < 0.005) return '$0.00';
  if (n < 1000) return '$' + n.toFixed(2);
  return '$' + Math.round(n).toLocaleString();
};
const fmtPct = (n) => `${(n * 100).toFixed(0)}%`;
const fmtDuration = (ms) => {
  if (ms < 0) ms = 0;
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
};
const truncate = (s, n) => {
  const oneline = String(s ?? '').replace(/\s+/g, ' ').trim();
  return oneline.length <= n ? oneline : oneline.slice(0, n - 1) + '…';
};

const charts = {};
const HOUR_LABELS = Array.from({ length: 24 }, (_, h) =>
  h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`
);

function toggleRateLimitUI(on) {
  // Show or hide all dashboard sections tied to 5-hour rate-limit framing
  // (active-window card, recent-blocks chart, peak KPI tile).
  for (const id of ['active-card', 'recent-blocks-card', 'kpi-peak-tile']) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.classList.toggle('hidden', !on);
  }
}

async function load() {
  $('subtitle').textContent = 'Loading…';
  let data;
  try {
    const res = await fetch('/api/report');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    data = await res.json();
  } catch (err) {
    $('subtitle').textContent = 'Failed to load: ' + err.message;
    return;
  }
  render(data);
}

function render(d) {
  $('subtitle').textContent = `Across all Claude Code workspaces · ${d.sessionCount} sessions`;
  $('generated-at').textContent = 'Generated ' + new Date(d.generatedAt).toLocaleString();

  const rateLimitOn = !!(d.profile && d.profile.rateLimitFraming);
  toggleRateLimitUI(rateLimitOn);

  renderRecommendations(d.recommendations || []);
  if (rateLimitOn) renderActive(d);
  $('kpi-today-tokens').textContent = fmtTokens(d.todayTotals.totalTokens);
  $('kpi-today-cost').textContent = fmtCost(d.todayTotals.cost || 0);
  $('kpi-today-sessions').textContent = fmtInt(d.todayTotals.sessionCount);
  $('kpi-total-cost').textContent = fmtCost(d.totals.cost || 0);
  $('kpi-total-tokens').textContent = fmtTokens(d.totals.totalTokens || 0) + ' tokens';
  $('kpi-peak').textContent = fmtTokens(d.peakRecent || 0);
  $('kpi-workspaces').textContent = fmtInt(d.byWorkspace.length);

  if (rateLimitOn) renderBlocksChart(d.recentBlocks, d.peakRecent);
  renderHoursChart(d.hourOfDay);
  renderDailyChart(d.byDay);
  renderWorkspaceChart(d.byWorkspace);
  renderModelChart(d.byModel);
  renderWorkspaceTable(d.byWorkspace);
  renderModelTable(d.byModel);
  renderWasteTable(d.waste);
  renderClusters(d.clusters, d.denylist || []);
  renderContextCards(d.contextReports || []);
  renderFileReadsTable(d.fileReads || []);
}

function renderRecommendations(recs) {
  const container = $('recs-list');
  if (!recs.length) {
    container.innerHTML = '<p style="color:var(--text-dim);margin:0">No recommendations right now — your usage looks tidy.</p>';
    return;
  }
  container.innerHTML = recs
    .slice(0, 12)
    .map((r) => recCardHtml(r))
    .join('');
  if (recs.length > 12) {
    container.innerHTML += `<p style="color:var(--text-dim);font-size:12px;margin-top:8px">${recs.length - 12} more — run <code>ti recommend</code> for the full list.</p>`;
  }
  wireRecCardEvents();
}

function recCardHtml(r) {
  const cid = r.evidence && r.evidence.clusterId ? String(r.evidence.clusterId) : '';
  const isSkill = r.kind === 'skill' && cid;
  const matched = isSkill && r.evidence && r.evidence.matchedSkill ? r.evidence.matchedSkill : null;
  const rep = isSkill ? truncate(r.evidence.representative || '', 320) : '';
  const ws = isSkill && Array.isArray(r.evidence.workspaces) ? r.evidence.workspaces : [];
  const ev = r.evidence || {};

  // Compact stats line — only show fields the rec actually has.
  const stats = [];
  if (isSkill && typeof ev.size === 'number') stats.push(`${ev.size}×`);
  if (isSkill && typeof ev.totalTokens === 'number') stats.push(`${fmtTokens(ev.totalTokens)} tok`);
  if (isSkill && ws.length) stats.push(`${ws.length} workspace${ws.length === 1 ? '' : 's'}`);
  const statsLine = stats.length ? `<span class="rec-stats">${stats.join(' · ')}</span>` : '';

  const inlineRep = isSkill
    ? `<div class="rec-cluster-rep">"${escapeHtml(rep)}"</div>
       ${ws.length ? `<div class="rec-workspaces">workspaces: ${escapeHtml(ws.join(', '))}</div>` : ''}`
    : '';
  const matchedBlock = matched
    ? `<div class="matched-skill">
         <div class="matched-skill-head">matched skill: <strong>${escapeHtml(matched.label)}</strong> <span class="matched-skill-source">(${escapeHtml(matched.source)})</span></div>
         <code class="matched-skill-path">${escapeHtml(matched.skillPath)}</code>
       </div>`
    : '';
  const hookSnippet = ev.hookSnippet ? String(ev.hookSnippet) : '';
  const hookId = `hook-${cid || Math.random().toString(36).slice(2, 8)}`;
  const hookBlock = hookSnippet
    ? `<div class="hook-snippet">
         <div class="hook-snippet-head">
           <span>settings.json snippet</span>
           <button class="copy-btn" data-target="${hookId}">📋 Copy</button>
         </div>
         <pre id="${hookId}">${escapeHtml(hookSnippet)}</pre>
       </div>`
    : '';
  const actions = isSkill
    ? matched
      ? `<div class="rec-actions">
           <button class="btn-hide" data-cid="${escapeHtml(cid)}" title="Hide — irrelevant match">👎 Hide</button>
         </div>`
      : `<div class="rec-actions">
           <button class="btn-hide" data-cid="${escapeHtml(cid)}" title="Hide — one-off, don't suggest again">👎 Hide</button>
           <button class="btn-draft" data-cid="${escapeHtml(cid)}" title="Open the SKILL.md scaffold">👍 Draft skill</button>
         </div>
         <details class="scaffold-panel" data-cid="${escapeHtml(cid)}" data-loaded="0">
           <summary class="scaffold-summary">Skill scaffold</summary>
           <div class="scaffold-body"><p class="scaffold-loading">Loading scaffold…</p></div>
         </details>`
    : '';
  // Auto-expand high-severity recs so the worst ones aren't hidden behind a click.
  const openAttr = r.severity === 'high' ? ' open' : '';
  return `
    <details class="rec ${r.severity}"${openAttr}${cid ? ` data-cid="${escapeHtml(cid)}"` : ''}>
      <summary class="rec-summary">
        <span class="severity">${r.severity}</span>
        <span class="rec-title">${escapeHtml(r.title)}</span>
        ${statsLine}
        <span class="kind">${escapeHtml(r.kind)}</span>
      </summary>
      <div class="rec-details">
        <div class="desc">${escapeHtml(r.body)}</div>
        ${inlineRep}
        ${matchedBlock}
        ${hookBlock}
        ${r.action && !isSkill ? `<div class="action">${escapeHtml(r.action)}</div>` : ''}
        ${actions}
      </div>
    </details>`;
}

function wireRecCardEvents() {
  const scope = document.getElementById('recs-list');
  if (!scope) return;
  for (const btn of scope.querySelectorAll('.btn-hide')) {
    btn.addEventListener('click', () => denyCluster(btn.dataset.cid, 'denied'));
  }
  for (const btn of scope.querySelectorAll('.btn-draft')) {
    btn.addEventListener('click', () => {
      const cid = btn.dataset.cid;
      const panel = scope.querySelector(`details.scaffold-panel[data-cid="${cid}"]`);
      if (panel) panel.open = true;
    });
  }
  for (const panel of scope.querySelectorAll('details.scaffold-panel')) {
    panel.addEventListener('toggle', () => {
      if (!panel.open) return;
      if (panel.dataset.loaded === '1') return;
      panel.dataset.loaded = '1';
      loadScaffold(panel.dataset.cid, panel);
    });
  }
  for (const btn of scope.querySelectorAll('.hook-snippet .copy-btn')) {
    btn.addEventListener('click', () => copyToClipboard(btn));
  }
}

async function denyCluster(cid, reason) {
  if (!cid) return;
  const card = document.querySelector(`.rec[data-cid="${cid}"]`);
  if (card) card.style.opacity = '0.4';
  try {
    const res = await fetch(`/api/cluster/${encodeURIComponent(cid)}/deny`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    if (card) card.remove();
    load();
  } catch (err) {
    if (card) card.style.opacity = '1';
    alert('Failed to hide: ' + err.message);
  }
}

async function unhideCluster(cid) {
  try {
    const res = await fetch(`/api/cluster/${encodeURIComponent(cid)}/deny`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    load();
  } catch (err) {
    alert('Failed to unhide: ' + err.message);
  }
}

async function loadScaffold(cid, panel) {
  const body = panel.querySelector('.scaffold-body');
  try {
    const res = await fetch(`/api/cluster/${encodeURIComponent(cid)}/scaffold`);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const s = await res.json();
    body.innerHTML = `
      <div class="scaffold-block">
        <div class="scaffold-block-head">
          <span>SKILL.md (${escapeHtml(s.slug)}-SKILL.md)</span>
          <button class="copy-btn" data-target="skill-${escapeHtml(cid)}">📋 Copy</button>
        </div>
        <pre id="skill-${escapeHtml(cid)}">${escapeHtml(s.skillBody)}</pre>
      </div>
      <div class="scaffold-block">
        <div class="scaffold-block-head">
          <span>Polish prompt</span>
          <button class="copy-btn" data-target="polish-${escapeHtml(cid)}">📋 Copy</button>
        </div>
        <pre id="polish-${escapeHtml(cid)}">${escapeHtml(s.polishPrompt)}</pre>
      </div>
      <button class="mark-created-btn" data-cid="${escapeHtml(cid)}">✓ Mark as created — hide from future runs</button>`;
    for (const cb of body.querySelectorAll('.copy-btn')) {
      cb.addEventListener('click', () => copyToClipboard(cb));
    }
    const mark = body.querySelector('.mark-created-btn');
    if (mark) mark.addEventListener('click', () => denyCluster(cid, 'created'));
  } catch (err) {
    body.innerHTML = `<p style="color:var(--danger)">Failed to load scaffold: ${escapeHtml(err.message)}</p>`;
  }
}

async function copyToClipboard(btn) {
  const target = document.getElementById(btn.dataset.target);
  if (!target) return;
  try {
    await navigator.clipboard.writeText(target.textContent || '');
    const original = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = original; }, 1200);
  } catch (err) {
    alert('Copy failed: ' + err.message);
  }
}

function renderContextCards(reports) {
  const container = $('context-cards');
  if (!reports.length) {
    container.innerHTML =
      '<p style="color:var(--text-dim);margin:0">No CLAUDE.md files found in your workspaces yet.</p>';
    return;
  }

  // Sort: most findings first, then biggest tokens.
  const findingCount = (r) =>
    (r.decayingSections?.length || 0) +
    (r.missingImports?.length || 0) +
    (r.bulkyImports?.length || 0) +
    (r.isDrifting ? 1 : 0) +
    (r.isStale ? 1 : 0);
  const sorted = [...reports].sort((a, b) => {
    const fc = findingCount(b) - findingCount(a);
    if (fc !== 0) return fc;
    return (b.totalEstimatedTokens || 0) - (a.totalEstimatedTokens || 0);
  });

  container.innerHTML = sorted.map(contextCardHtml).join('');
}

function contextCardHtml(r) {
  const lines = (r.files || []).reduce((s, f) => s + (f.lines || 0), 0);
  const ageLabel =
    r.daysSinceModified === undefined || r.daysSinceModified === null
      ? 'mtime unknown'
      : r.daysSinceModified === 0
      ? 'edited today'
      : `edited ${r.daysSinceModified}d ago`;
  const badge = r.isDrifting
    ? '<span class="badge drifting">drifting</span>'
    : r.isStale
    ? '<span class="badge stale">stale</span>'
    : '<span class="badge fresh">fresh</span>';
  const meta = [
    `${lines} lines`,
    `~${fmtTokens(r.totalEstimatedTokens || 0)} tok`,
    ageLabel,
  ].join(' · ');

  const findings = [];

  if (r.isDrifting && r.daysSinceModified != null) {
    findings.push(
      `<li><strong>Drifting</strong> — ${r.recentSessionCount} session(s) in this workspace since the last edit ${r.daysSinceModified}d ago` +
        `<div class="finding-action">→ quick read-and-update pass recommended</div></li>`
    );
  } else if (r.isStale && r.daysSinceModified != null) {
    findings.push(
      `<li><strong>Stale</strong> — not edited in ${r.daysSinceModified} days` +
        `<div class="finding-action">→ review for outdated content if the workspace is still active</div></li>`
    );
  }

  for (const sec of r.decayingSections || []) {
    findings.push(
      `<li>'<strong>${escapeHtml(sec.heading)}</strong>' lines ${sec.startLine}–${sec.endLine} ` +
        `(~${fmtTokens(sec.estimatedTokens)} tok)` +
        `<div class="finding-action">→ move to docs/STATUS.md</div></li>`
    );
  }

  if ((r.missingImports || []).length > 0) {
    const sample = r.missingImports
      .slice(0, 3)
      .map((m) => escapeHtml(m.reference))
      .join(', ');
    const more =
      r.missingImports.length > 3 ? ` <span class="hint">and ${r.missingImports.length - 3} more</span>` : '';
    findings.push(
      `<li><strong>${r.missingImports.length} stale @-import(s)</strong>: ${sample}${more}` +
        `<div class="finding-action">→ remove or fix the references</div></li>`
    );
  }

  if ((r.bulkyImports || []).length > 0) {
    const sample = r.bulkyImports
      .slice(0, 3)
      .map((b) => `${escapeHtml(b.reference)} (~${fmtTokens(b.estimatedTokens)} tok)`)
      .join(', ');
    const more =
      r.bulkyImports.length > 3 ? ` <span class="hint">and ${r.bulkyImports.length - 3} more</span>` : '';
    findings.push(
      `<li><strong>${r.bulkyImports.length} large @-import(s)</strong>: ${sample}${more}` +
        `<div class="finding-action">→ consider summarizing or loading on demand</div></li>`
    );
  }

  const findingsBlock =
    findings.length > 0
      ? `<ul class="findings">${findings.join('')}</ul>`
      : '<p class="no-findings">✓ No issues</p>';

  return (
    `<div class="context-card">` +
    `<div class="context-card-header">` +
    `<span class="context-ws">${escapeHtml(r.workspaceName)}</span>` +
    `<span class="context-meta">${meta}</span>` +
    badge +
    `</div>` +
    findingsBlock +
    `</div>`
  );
}

function renderFileReadsTable(reads) {
  if (!reads.length) {
    $('table-file-reads').innerHTML = '<tr><td>No high-frequency file reads detected yet.</td></tr>';
    return;
  }
  const rows = reads.slice(0, 12).map((f) => ({
    file: shortPath(f.filePath),
    reads: String(f.totalReads),
    sessions: String(f.sessionCount),
    avg: f.readsPerSessionAvg.toFixed(1),
  }));
  const headers = ['file', 'reads', 'sessions', 'avg'];
  let html = '<thead><tr>' + headers.map((h) => `<th${h !== 'file' ? ' class="num"' : ''}>${h}</th>`).join('') + '</tr></thead><tbody>';
  for (const r of rows) {
    html +=
      '<tr>' +
      headers
        .map((h) => `<td${h !== 'file' ? ' class="num"' : ''}>${escapeHtml(r[h])}</td>`)
        .join('') +
      '</tr>';
  }
  $('table-file-reads').innerHTML = html + '</tbody>';
}

function shortPath(fp) {
  const parts = String(fp).split('/').filter(Boolean);
  return parts.slice(-3).join('/');
}

function renderActive(d) {
  const a = d.activeBlock;
  const p = d.activeProjection;
  if (!a || !p) {
    $('active-empty').classList.remove('hidden');
    $('active-content').classList.add('hidden');
    return;
  }
  $('active-empty').classList.add('hidden');
  $('active-content').classList.remove('hidden');

  // Used + bar (color reflects danger).
  $('active-used').textContent = fmtTokens(a.totalTokens) + ' tok';
  const usedBar = $('active-used-bar');
  usedBar.style.width = Math.min(100, p.pctOfPeak * 100) + '%';
  usedBar.classList.remove('warn', 'danger');
  if (p.pctOfPeak > 0.9) usedBar.classList.add('danger');
  else if (p.pctOfPeak > 0.7) usedBar.classList.add('warn');
  $('active-used-sub').textContent = `${fmtPct(p.pctOfPeak)} of recent peak (${fmtTokens(p.peakRecent)})`;

  // Time elapsed + bar.
  const totalMs = p.elapsedMs + p.remainingMs;
  const elapsedPct = totalMs > 0 ? p.elapsedMs / totalMs : 0;
  $('active-elapsed').textContent = fmtDuration(p.elapsedMs);
  $('active-time-bar').style.width = Math.min(100, elapsedPct * 100) + '%';
  $('active-time-sub').textContent = `${fmtDuration(p.remainingMs)} until window resets`;

  // Velocity.
  $('active-velocity').textContent = fmtTokens(p.velocityTokensPerMin) + '/min';
  $('active-velocity-sub').textContent = 'tokens consumed per minute since window opened';

  // Projection.
  $('active-projected').textContent = fmtTokens(p.projectedTotal);
  $('active-projected-sub').textContent = `${fmtPct(p.pctOfPeakProjected)} of peak at this pace`;

  // Warning band.
  const warn = $('active-warning');
  warn.classList.remove('hidden', 'danger');
  if (p.pctOfPeakProjected > 1.2) {
    warn.classList.add('danger');
    warn.textContent = `At your current pace you'll exceed your recent peak by ${fmtPct(p.pctOfPeakProjected - 1)}. You're heading into rate-limit territory — consider closing heavy sessions or switching to a lighter task.`;
  } else if (p.pctOfPeakProjected > 1.0) {
    warn.textContent = `Projected to slightly exceed your recent peak. Watch for slowdowns toward the end of the window.`;
  } else if (p.pctOfPeak > 0.8) {
    warn.textContent = `Already past 80% of your typical peak window. Be deliberate about new long-running tasks.`;
  } else {
    warn.classList.add('hidden');
  }

  const fmtClock = (d) =>
    new Date(d).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const range = `${fmtClock(a.startedAt)} – ${fmtClock(a.endsAt)}`;
  const wsList = a.workspaces?.length ? a.workspaces.join(', ') : null;
  $('active-workspaces').textContent = wsList
    ? `window: ${range} · workspaces: ${wsList}`
    : `window: ${range}`;
}

function renderBlocksChart(blocks, peak) {
  const ordered = [...(blocks || [])].reverse(); // oldest -> newest left-to-right
  const labels = ordered.map((b) => {
    const d = new Date(b.startedAt);
    return d.toLocaleDateString([], { month: 'numeric', day: 'numeric' }) +
      ' ' +
      d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  });
  const values = ordered.map((b) => b.totalTokens);
  const pointRadii = ordered.map((b) => (b.isActive ? 6 : 3));
  const pointColors = ordered.map((b) => (b.isActive ? '#3fb950' : '#58a6ff'));
  const peakLine = peak ? ordered.map(() => peak) : null;

  const datasets = [
    {
      label: 'Tokens per 5h window',
      data: values,
      borderColor: '#58a6ff',
      backgroundColor: 'rgba(88, 166, 255, 0.18)',
      fill: true,
      tension: 0.3,
      pointRadius: pointRadii,
      pointBackgroundColor: pointColors,
      pointBorderColor: pointColors,
      borderWidth: 2,
    },
  ];
  if (peakLine) {
    datasets.push({
      label: 'recent peak',
      data: peakLine,
      borderColor: '#8b949e',
      borderDash: [5, 5],
      borderWidth: 1,
      pointRadius: 0,
      fill: false,
    });
  }

  const ctx = $('chart-blocks').getContext('2d');
  if (charts.blocks) charts.blocks.destroy();
  charts.blocks = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      ...chartBaseOptions(),
      plugins: {
        legend: { display: false },
        tooltip: {
          filter: (ctx) => ctx.datasetIndex === 0,
          callbacks: {
            label: (ctx) => fmtTokens(ctx.parsed.y) + ' tokens',
          },
        },
      },
      scales: {
        x: { ticks: { color: '#8b949e', maxRotation: 60, minRotation: 30 }, grid: { color: '#1f2630' } },
        y: {
          beginAtZero: true,
          ticks: { color: '#8b949e', callback: (v) => fmtTokens(v) },
          grid: { color: '#1f2630' },
        },
      },
    },
  });
}

function renderHoursChart(hours) {
  const ctx = $('chart-hours').getContext('2d');
  if (charts.hours) charts.hours.destroy();
  charts.hours = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: HOUR_LABELS,
      datasets: [
        {
          label: 'Tokens by hour of day',
          data: (hours || []).map((h) => h.totalTokens),
          backgroundColor: '#bc8cff',
        },
      ],
    },
    options: {
      ...chartBaseOptions(),
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => fmtTokens(ctx.parsed.y) + ' tokens' } },
      },
      scales: {
        x: { ticks: { color: '#8b949e' }, grid: { color: '#1f2630' } },
        y: {
          ticks: { color: '#8b949e', callback: (v) => fmtTokens(v) },
          grid: { color: '#1f2630' },
        },
      },
    },
  });
}

function renderDailyChart(byDay) {
  const ctx = $('chart-daily').getContext('2d');
  if (charts.daily) charts.daily.destroy();
  charts.daily = new Chart(ctx, {
    type: 'line',
    data: {
      labels: byDay.map((b) => b.label),
      datasets: [
        {
          label: 'Daily tokens',
          data: byDay.map((b) => b.totalTokens),
          borderColor: '#58a6ff',
          backgroundColor: 'rgba(88, 166, 255, 0.15)',
          fill: true,
          tension: 0.3,
          pointRadius: 3,
        },
      ],
    },
    options: {
      ...chartBaseOptions(),
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => fmtTokens(ctx.parsed.y) + ' tokens' } },
      },
      scales: {
        x: { ticks: { color: '#8b949e' }, grid: { color: '#1f2630' } },
        y: {
          ticks: { color: '#8b949e', callback: (v) => fmtTokens(v) },
          grid: { color: '#1f2630' },
        },
      },
    },
  });
}

function renderWorkspaceChart(byWorkspace) {
  // Sort by tokens (server already sorts by cost; resort here for clarity).
  const top = [...byWorkspace].sort((a, b) => b.totalTokens - a.totalTokens).slice(0, 12);
  const ctx = $('chart-workspaces').getContext('2d');
  if (charts.ws) charts.ws.destroy();
  charts.ws = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: top.map((b) => b.label),
      datasets: [
        {
          label: 'Tokens',
          data: top.map((b) => b.totalTokens),
          backgroundColor: '#58a6ff',
        },
      ],
    },
    options: {
      ...chartBaseOptions({ indexAxis: 'y' }),
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => fmtTokens(ctx.parsed.x) + ' tokens' } },
      },
      scales: {
        x: { ticks: { color: '#8b949e', callback: (v) => fmtTokens(v) }, grid: { color: '#1f2630' } },
        y: { ticks: { color: '#8b949e' }, grid: { color: '#1f2630' } },
      },
    },
  });
}

function renderModelChart(byModel) {
  const ctx = $('chart-models').getContext('2d');
  if (charts.model) charts.model.destroy();
  const palette = ['#58a6ff', '#3fb950', '#f0883e', '#bc8cff', '#f85149', '#8b949e'];
  charts.model = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: byModel.map((b) => b.label),
      datasets: [
        {
          data: byModel.map((b) => b.totalTokens),
          backgroundColor: byModel.map((_, i) => palette[i % palette.length]),
          borderColor: '#0d1117',
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { color: '#e6edf3' } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${fmtTokens(ctx.parsed)} tokens` } },
      },
    },
  });
}

function renderWorkspaceTable(byWorkspace) {
  const rows = [...byWorkspace].sort((a, b) => b.totalTokens - a.totalTokens).slice(0, 20);
  $('table-workspaces').innerHTML = tableHtml(
    [
      { key: 'label', label: 'Workspace' },
      { key: 'totalTokens', label: 'Tokens', num: true, fmt: fmtTokens },
      { key: 'cost', label: 'Cost', num: true, fmt: fmtCost },
      { key: 'sessionCount', label: 'Sessions', num: true },
      { key: 'turnCount', label: 'Turns', num: true },
    ],
    rows
  );
}

function renderModelTable(byModel) {
  $('table-models').innerHTML = tableHtml(
    [
      { key: 'label', label: 'Model' },
      { key: 'totalTokens', label: 'Tokens', num: true, fmt: fmtTokens },
      { key: 'cost', label: 'Cost', num: true, fmt: fmtCost },
      { key: 'turnCount', label: 'Turns', num: true },
    ],
    byModel
  );
}

// Maps a waste-detector reason tag to a one-line action the user can take.
// Matches the tag's leading keyword so the suffix details (multipliers, %, etc.)
// don't break the lookup.
function tipForReason(reason) {
  if (reason.startsWith('outlier')) return 'Break work into smaller sessions.';
  if (reason.startsWith('cache-bloated')) return 'Trim CLAUDE.md / @-imports — context overhead is high.';
  if (reason.startsWith('bloated turns')) return 'Narrow Read ranges; use head_limit on Grep; avoid dumping huge tool outputs.';
  if (reason.startsWith('long idle gap')) return 'Start a fresh session instead of resuming after a long pause.';
  return '';
}

function renderWasteTable(waste) {
  if (!waste || waste.length === 0) {
    $('table-waste').innerHTML = '<tr><td>No flagged sessions yet.</td></tr>';
    return;
  }
  const rows = waste.slice(0, 25).map((w) => {
    const tips = w.reasons
      .map(tipForReason)
      .filter(Boolean)
      .map((t) => `<div class="tip">${escapeHtml(t)}</div>`)
      .join('');
    return {
      workspace: escapeHtml(w.workspaceName),
      when: escapeHtml(new Date(w.startedAt).toLocaleString()),
      tokens: escapeHtml(fmtTokens(w.totalTokens)),
      why: w.reasons.map((r) => `<span class="tag warn">${escapeHtml(r)}</span>`).join(' '),
      todo: tips || '<span class="tip-none">—</span>',
    };
  });
  const headers = ['workspace', 'when', 'tokens', 'why', 'todo'];
  const headerLabels = { workspace: 'workspace', when: 'when', tokens: 'tokens', why: 'why', todo: 'what to do' };
  let html =
    '<thead><tr>' +
    headers.map((h) => `<th${h === 'tokens' ? ' class="num"' : ''}>${headerLabels[h]}</th>`).join('') +
    '</tr></thead><tbody>';
  for (const r of rows) {
    html +=
      '<tr>' +
      headers
        .map((h) => `<td${h === 'tokens' ? ' class="num"' : ''}>${r[h]}</td>`)
        .join('') +
      '</tr>';
  }
  html += '</tbody>';
  $('table-waste').innerHTML = html;
}

function renderClusters(clusters, denylist) {
  const container = $('clusters');
  const hiddenHtml = denylist.length
    ? `<details class="hidden-clusters">
         <summary>Hidden (${denylist.length}) — show</summary>
         <div class="hidden-list">
           ${denylist.map((e) => `
             <div class="hidden-entry" data-cid="${escapeHtml(e.id)}">
               <div class="meta">
                 <span class="tag">${escapeHtml(e.reason)}</span>
                 <span class="hidden-id">${escapeHtml(e.id)}</span>
                 <span class="hidden-date">${escapeHtml(new Date(e.addedAt).toLocaleString())}</span>
               </div>
               <div class="hidden-rep">${escapeHtml(truncate(e.repExcerpt, 240))}</div>
               <button class="btn-unhide" data-cid="${escapeHtml(e.id)}">↺ Unhide</button>
             </div>`).join('')}
         </div>
       </details>`
    : '';
  if (!clusters || clusters.length === 0) {
    container.innerHTML = hiddenHtml + '<p style="color:var(--text-dim)">No recurring patterns surfaced yet — give it more usage history.</p>';
    wireUnhideEvents(container);
    return;
  }
  container.innerHTML = hiddenHtml + clusters
    .map(
      (c, i) => `
    <div class="cluster">
      <div class="meta">
        <span><strong>#${i + 1}</strong></span>
        <span><strong>${c.size}</strong> repetitions</span>
        <span><strong>${fmtTokens(c.totalTokens)}</strong> tokens</span>
        <span>workspaces: ${c.workspaces.map((w) => `<span class="tag">${escapeHtml(w)}</span>`).join('')}</span>
      </div>
      <div class="rep">${escapeHtml(truncate(c.representative, 600))}</div>
      <details>
        <summary>${c.examplePrompts.length} example prompts</summary>
        <div class="examples">
          ${c.examplePrompts.map((p) => `<p>${escapeHtml(truncate(p, 400))}</p>`).join('')}
        </div>
      </details>
    </div>`
    )
    .join('');
  wireUnhideEvents(container);
}

function wireUnhideEvents(scope) {
  for (const btn of scope.querySelectorAll('.btn-unhide')) {
    btn.addEventListener('click', () => unhideCluster(btn.dataset.cid));
  }
}

function tableHtml(cols, rows) {
  let html =
    '<thead><tr>' +
    cols.map((c) => `<th${c.num ? ' class="num"' : ''}>${c.label}</th>`).join('') +
    '</tr></thead><tbody>';
  for (const r of rows) {
    html +=
      '<tr>' +
      cols
        .map((c) => {
          const raw = r[c.key];
          const v = c.fmt ? c.fmt(raw) : raw;
          return `<td${c.num ? ' class="num"' : ''}>${escapeHtml(String(v ?? ''))}</td>`;
        })
        .join('') +
      '</tr>';
  }
  return html + '</tbody>';
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function chartBaseOptions(extra = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { labels: { color: '#e6edf3' } } },
    scales: {
      x: { ticks: { color: '#8b949e' }, grid: { color: '#1f2630' } },
      y: { ticks: { color: '#8b949e' }, grid: { color: '#1f2630' } },
    },
    ...extra,
  };
}

$('refresh').addEventListener('click', load);
load();

// Auto-refresh active window every 30s so the live view stays accurate.
setInterval(load, 30_000);
