/**
 * Client-side JS for the aggregate report. Maintainability rules:
 * - The inner JS contains NO backticks and NO "${" sequences, so this file can
 *   hold it in one String.raw template without escapes (string concat only).
 * - Organized as named top-level functions; the renderer smoke test asserts
 *   their presence to guard against accidental truncation.
 * - All aggregation (filters, dedupe, solve rates, Wilson CIs, rollups) runs
 *   here so filter changes re-aggregate live; dedupe mirrors
 *   dedupeNewestValid() in ../scan.ts — keep the two in sync.
 */
export const AGGREGATE_CLIENT_JS = String.raw`'use strict';
var DATA = JSON.parse(document.getElementById('report-data').textContent);
var GRADED = { passed: true, failed: true, timeout: true };
var STATUS_ORDER = ['passed', 'failed', 'error', 'timeout', 'skipped', 'incomplete'];
var BAR_OPACITY = [0.9, 0.62, 0.42, 0.28];

var state = {
  batches: {},
  agents: {},
  suites: {},
  statuses: {},
  disagreementsOnly: false,
  openDetail: null
};

function suiteOf(run) { return run.suite || '(no suite)'; }

function distinct(values) {
  var seen = {}, out = [];
  for (var i = 0; i < values.length; i++) {
    if (!seen[values[i]]) { seen[values[i]] = true; out.push(values[i]); }
  }
  return out;
}

function initState() {
  var init = DATA.initialState || {};
  var batchIds = init.batchIds && init.batchIds.length ? init.batchIds
    : DATA.batches.length ? [DATA.batches[0].batchId] : [];
  for (var i = 0; i < batchIds.length; i++) state.batches[batchIds[i]] = true;
  var agents = init.agents && init.agents.length ? init.agents : distinct(DATA.taskRuns.map(function (run) { return run.agentName; }));
  for (var a = 0; a < agents.length; a++) state.agents[agents[a]] = true;
  var suites = init.suites && init.suites.length ? init.suites : distinct(DATA.taskRuns.map(suiteOf));
  for (var s = 0; s < suites.length; s++) state.suites[suites[s]] = true;
  var statuses = init.statuses && init.statuses.length ? init.statuses : STATUS_ORDER;
  for (var t = 0; t < statuses.length; t++) state.statuses[statuses[t]] = true;
  state.disagreementsOnly = !!init.disagreementsOnly;
}

// ---------- formatting ----------

function esc(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtPct(p) { return Math.round(p * 100) + '%'; }

function fmtUSD(v) {
  if (v === undefined || v === null) return '—';
  return '$' + (v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(2));
}

function fmtTokens(n) {
  if (n === undefined || n === null) return '—';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(n);
}

function fmtDur(ms) {
  if (ms === undefined || ms === null) return '—';
  var s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  var m = Math.floor(s / 60);
  if (m < 60) return m + 'm' + String(s % 60).padStart(2, '0') + 's';
  return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') + 'm';
}

function fmtWhen(iso) {
  if (!iso) return '';
  return iso.slice(0, 16).replace('T', ' ');
}

// ---------- statistics ----------

function wilson(successes, trials, z) {
  z = z || 1.96;
  if (!trials) return null;
  var p = successes / trials;
  var denom = 1 + (z * z) / trials;
  var center = (p + (z * z) / (2 * trials)) / denom;
  var half = (z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials))) / denom;
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

function hashJitter(text) {
  var h = 2166136261;
  for (var i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 1000) / 1000;
}

// ---------- pipeline ----------

function sortStamp(run) { return run.startedAt || run.runId; }

// Mirrors dedupeNewestValid in scan.ts: graded verdicts beat errors, then newest wins.
function dedupe(runs) {
  var byKey = {};
  for (var i = 0; i < runs.length; i++) {
    var run = runs[i];
    var key = run.caseId + '|' + run.agentName + '|' + (run.attemptNumber || 0);
    var existing = byKey[key];
    if (!existing) { byKey[key] = run; continue; }
    var aGraded = !!GRADED[existing.status];
    var bGraded = !!GRADED[run.status];
    if (aGraded !== bGraded) { byKey[key] = aGraded ? existing : run; continue; }
    byKey[key] = sortStamp(existing) >= sortStamp(run) ? existing : run;
  }
  var out = [];
  for (var k in byKey) out.push(byKey[k]);
  return out;
}

function selectedCount(map) {
  var n = 0;
  for (var k in map) if (map[k]) n++;
  return n;
}

function applyFilters() {
  var runs = DATA.taskRuns.filter(function (run) {
    return state.batches[run.batchId] && state.agents[run.agentName]
      && state.suites[suiteOf(run)] && state.statuses[run.status];
  });
  // Always dedupe: within one batch it's a no-op (one run per case/agent/attempt),
  // and legacy day-buckets can hold superseded attempts that would skew rates.
  runs = dedupe(runs);
  if (state.disagreementsOnly) runs = keepDisagreements(runs);
  return runs;
}

function keepDisagreements(runs) {
  var verdicts = {};
  for (var i = 0; i < runs.length; i++) {
    var run = runs[i];
    if (!GRADED[run.status]) continue;
    if (!verdicts[run.caseId]) verdicts[run.caseId] = {};
    verdicts[run.caseId][run.pass ? 'pass' : 'fail'] = true;
  }
  return runs.filter(function (run) {
    var v = verdicts[run.caseId];
    return v && v.pass && v.fail;
  });
}

function aggregateByAgent(runs) {
  var byAgent = {};
  for (var i = 0; i < runs.length; i++) {
    var run = runs[i];
    var agent = byAgent[run.agentName];
    if (!agent) {
      agent = byAgent[run.agentName] = {
        name: run.agentName, trials: 0, passes: 0, runs: [], durations: [],
        totalCost: 0, costRuns: 0, cached: 0, input: 0, output: 0, totalTokens: 0, models: {}
      };
    }
    agent.runs.push(run);
    if (GRADED[run.status]) {
      agent.trials++;
      if (run.pass) agent.passes++;
      if (run.durationMs !== undefined) agent.durations.push(run.durationMs);
    }
    if (run.cost) {
      if (run.cost.totalCost !== undefined) { agent.totalCost += run.cost.totalCost; agent.costRuns++; }
      agent.cached += run.cost.cachedInputTokens || 0;
      agent.input += run.cost.inputTokens || 0;
      agent.output += run.cost.outputTokens || 0;
      agent.totalTokens += run.cost.totalTokens || 0;
    }
    var models = run.models || [];
    for (var m = 0; m < models.length; m++) agent.models[models[m]] = true;
  }
  var list = [];
  for (var name in byAgent) list.push(byAgent[name]);
  list.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
  return list;
}

function avg(values) {
  if (!values.length) return undefined;
  var total = 0;
  for (var i = 0; i < values.length; i++) total += values[i];
  return total / values.length;
}

// ---------- controls ----------

function renderControls() {
  var html = [];
  html.push('<div class="control-group"><h3>Runs (newest first)</h3>');
  for (var i = 0; i < DATA.batches.length; i++) {
    var batch = DATA.batches[i];
    var label = batch.label || batch.batchId;
    html.push('<label class="' + (batch.synthetic ? 'synthetic' : '') + '">'
      + '<input type="checkbox" data-kind="batches" data-key="' + esc(batch.batchId) + '"'
      + (state.batches[batch.batchId] ? ' checked' : '') + '> '
      + '<span>' + esc(label) + '</span>'
      + '<span class="when">' + esc(fmtWhen(batch.startedAt)) + '</span>'
      + '<span class="count">' + batch.runCount + '</span></label>');
  }
  html.push('</div>');
  html.push(controlGroup('Agents', 'agents', distinct(DATA.taskRuns.map(function (run) { return run.agentName; }))));
  var suites = distinct(DATA.taskRuns.map(suiteOf));
  if (suites.length > 1) html.push(controlGroup('Suites', 'suites', suites));
  html.push(controlGroup('Status', 'statuses', STATUS_ORDER.filter(function (status) {
    return DATA.taskRuns.some(function (run) { return run.status === status; });
  })));
  html.push('<div class="control-group"><h3>View</h3><label class="toggle-row">'
    + '<input type="checkbox" id="disagreements-toggle"' + (state.disagreementsOnly ? ' checked' : '') + '> '
    + 'Disagreements only</label></div>');
  var node = document.getElementById('controls');
  node.innerHTML = html.join('');
  node.addEventListener('change', function (event) {
    var target = event.target;
    if (target.id === 'disagreements-toggle') {
      state.disagreementsOnly = target.checked;
    } else if (target.dataset && target.dataset.kind) {
      state[target.dataset.kind][target.dataset.key] = target.checked;
    }
    renderAll();
  });
}

function controlGroup(title, kind, keys) {
  var html = ['<div class="control-group"><h3>' + esc(title) + '</h3>'];
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var count = DATA.taskRuns.filter(function (run) {
      return kind === 'agents' ? run.agentName === key : kind === 'suites' ? suiteOf(run) === key : run.status === key;
    }).length;
    html.push('<label><input type="checkbox" data-kind="' + kind + '" data-key="' + esc(key) + '"'
      + (state[kind][key] ? ' checked' : '') + '> <span>' + esc(key) + '</span>'
      + '<span class="count">' + count + '</span></label>');
  }
  html.push('</div>');
  return html.join('');
}

// ---------- KPI cards ----------

function renderKpis(agents) {
  var html = [];
  for (var i = 0; i < agents.length; i++) {
    var agent = agents[i];
    var rate = agent.trials ? agent.passes / agent.trials : 0;
    var ci = wilson(agent.passes, agent.trials);
    var ciText = ci ? '(' + fmtPct(ci.lo) + '–' + fmtPct(ci.hi) + ')' : '';
    var models = [];
    for (var model in agent.models) models.push(model);
    html.push('<div class="card"><h3>' + esc(agent.name) + '</h3>'
      + '<div class="models">' + esc(models.join(' + ') || '—') + '</div>'
      + '<div class="rate">' + (agent.trials ? fmtPct(rate) : '—')
      + '<span class="ci">' + esc(agent.passes + '/' + agent.trials + ' solved ' + ciText) + '</span></div>'
      + '<div class="kpis">'
      + '<div><b>' + fmtDur(avg(agent.durations)) + '</b><span>avg time</span></div>'
      + '<div><b>' + fmtUSD(agent.costRuns ? agent.totalCost : undefined) + '</b><span>total cost</span></div>'
      + '<div><b>' + fmtUSD(agent.costRuns ? agent.totalCost / agent.costRuns : undefined) + '</b><span>per task</span></div>'
      + '<div><b>' + fmtTokens(agent.totalTokens || undefined) + '</b><span>tokens</span></div>'
      + '</div></div>');
  }
  document.getElementById('kpi-cards').innerHTML = html.join('') || emptyNote();
}

function emptyNote() {
  return '<div class="empty">No runs match the current filters.</div>';
}

// ---------- solve-rate bars ----------

function renderSolveRate(agents, runs) {
  var node = document.getElementById('solve-rate-chart');
  if (!agents.length) { node.innerHTML = emptyNote(); return; }
  var suites = distinct(runs.map(suiteOf));
  var groups = [{ label: 'overall', agents: agents }];
  if (suites.length > 1) {
    for (var s = 0; s < suites.length; s++) {
      var suiteRuns = runs.filter(function (run) { return suiteOf(run) === suites[s]; });
      groups.push({ label: suites[s], agents: aggregateByAgent(suiteRuns) });
    }
  }
  var width = 560, pad = 36, chartH = 160, baseY = chartH + 16;
  var groupW = (width - pad * 2) / groups.length;
  var svg = [];
  svg.push('<svg viewBox="0 0 ' + width + ' ' + (baseY + 36) + '" xmlns="http://www.w3.org/2000/svg">');
  for (var g25 = 1; g25 <= 3; g25++) {
    var gy = baseY - (chartH * g25 * 0.25);
    svg.push('<line x1="' + pad + '" y1="' + gy + '" x2="' + (width - pad) + '" y2="' + gy + '" stroke="rgba(45,49,66,0.08)" stroke-width="0.8"/>');
    svg.push('<text x="' + (pad - 4) + '" y="' + (gy + 3) + '" text-anchor="end" class="axis">' + (g25 * 25) + '%</text>');
  }
  svg.push('<line x1="' + pad + '" y1="' + baseY + '" x2="' + (width - pad) + '" y2="' + baseY + '" stroke="#bfc0c0" stroke-width="1"/>');
  var agentNames = agents.map(function (agent) { return agent.name; });
  for (var gi = 0; gi < groups.length; gi++) {
    var group = groups[gi];
    var n = group.agents.length;
    var barW = Math.min(40, (groupW - 24) / Math.max(n, 1));
    var startX = pad + gi * groupW + (groupW - barW * n) / 2;
    for (var ai = 0; ai < group.agents.length; ai++) {
      var agent = group.agents[ai];
      var rate = agent.trials ? agent.passes / agent.trials : 0;
      var h = Math.round(chartH * rate);
      var x = startX + ai * barW;
      var opacity = BAR_OPACITY[agentNames.indexOf(agent.name) % BAR_OPACITY.length];
      svg.push('<rect x="' + x + '" y="' + (baseY - h) + '" width="' + (barW - 4) + '" height="' + h + '" fill="#2d3142" opacity="' + opacity + '"/>');
      var ci = wilson(agent.passes, agent.trials);
      if (ci) {
        var cx = x + (barW - 4) / 2;
        var loY = baseY - chartH * ci.lo, hiY = baseY - chartH * ci.hi;
        svg.push('<line x1="' + cx + '" y1="' + loY + '" x2="' + cx + '" y2="' + hiY + '" stroke="#4f5d75" stroke-width="1"/>');
        svg.push('<line x1="' + (cx - 3) + '" y1="' + hiY + '" x2="' + (cx + 3) + '" y2="' + hiY + '" stroke="#4f5d75" stroke-width="1"/>');
        svg.push('<line x1="' + (cx - 3) + '" y1="' + loY + '" x2="' + (cx + 3) + '" y2="' + loY + '" stroke="#4f5d75" stroke-width="1"/>');
      }
      svg.push('<text x="' + (x + (barW - 4) / 2) + '" y="' + (baseY - h - 6) + '" text-anchor="middle" class="val">' + fmtPct(rate) + '</text>');
    }
    svg.push('<text x="' + (pad + gi * groupW + groupW / 2) + '" y="' + (baseY + 16) + '" text-anchor="middle" class="axis">' + esc(group.label) + '</text>');
  }
  svg.push('</svg>');
  var legend = ['<div class="legend">'];
  for (var li = 0; li < agents.length; li++) {
    legend.push('<span><i style="background:#2d3142;opacity:' + BAR_OPACITY[li % BAR_OPACITY.length] + ';border-radius:2px"></i>' + esc(agents[li].name) + '</span>');
  }
  legend.push('</div>');
  node.innerHTML = svg.join('') + legend.join('');
}

// ---------- efficiency scatter ----------

function renderEfficiency(agents) {
  var node = document.getElementById('efficiency-chart');
  var points = agents.filter(function (agent) { return agent.trials > 0 && agent.costRuns > 0; });
  if (!points.length) { node.innerHTML = emptyNote(); return; }
  var width = 560, height = 220, padL = 44, padR = 24, padT = 16, padB = 36;
  var maxCost = 0;
  for (var i = 0; i < points.length; i++) {
    maxCost = Math.max(maxCost, points[i].totalCost / points[i].costRuns);
  }
  maxCost = maxCost * 1.25 || 1;
  function xPos(cost) { return padL + (cost / maxCost) * (width - padL - padR); }
  function yPos(rate) { return padT + (1 - rate) * (height - padT - padB); }
  var svg = ['<svg viewBox="0 0 ' + width + ' ' + height + '" xmlns="http://www.w3.org/2000/svg">'];
  for (var p25 = 0; p25 <= 4; p25++) {
    var gy = yPos(p25 * 0.25);
    svg.push('<line x1="' + padL + '" y1="' + gy + '" x2="' + (width - padR) + '" y2="' + gy + '" stroke="rgba(45,49,66,0.08)" stroke-width="0.8"/>');
    svg.push('<text x="' + (padL - 4) + '" y="' + (gy + 3) + '" text-anchor="end" class="axis">' + (p25 * 25) + '%</text>');
  }
  var ticks = 4;
  for (var t = 0; t <= ticks; t++) {
    var cost = (maxCost / ticks) * t;
    svg.push('<text x="' + xPos(cost) + '" y="' + (height - padB + 16) + '" text-anchor="middle" class="axis">' + fmtUSD(cost) + '</text>');
  }
  svg.push('<line x1="' + padL + '" y1="' + yPos(0) + '" x2="' + (width - padR) + '" y2="' + yPos(0) + '" stroke="#bfc0c0" stroke-width="1"/>');
  svg.push('<text x="' + (width - padR) + '" y="' + (height - 4) + '" text-anchor="end" class="axis">avg cost / task</text>');
  for (var pi = 0; pi < points.length; pi++) {
    var agent = points[pi];
    var rate = agent.passes / agent.trials;
    var cx = xPos(agent.totalCost / agent.costRuns);
    var ci = wilson(agent.passes, agent.trials);
    if (ci) {
      svg.push('<line x1="' + cx + '" y1="' + yPos(ci.lo) + '" x2="' + cx + '" y2="' + yPos(ci.hi) + '" stroke="#4f5d75" stroke-width="1"/>');
    }
    svg.push('<circle cx="' + cx + '" cy="' + yPos(rate) + '" r="5" fill="#2d3142"/>');
    svg.push('<text x="' + (cx + 10) + '" y="' + (yPos(rate) + 4) + '" class="name">' + esc(agent.name) + '</text>');
  }
  svg.push('</svg>');
  node.innerHTML = svg.join('') + '<div class="chart-note">↖ better: higher solve rate at lower cost · whiskers are 95% Wilson intervals</div>';
}

// ---------- matrix ----------

function renderMatrix(runs, agents) {
  var node = document.getElementById('matrix-table');
  if (!runs.length) { node.innerHTML = emptyNote(); return; }
  var agentNames = agents.map(function (agent) { return agent.name; });
  var byCase = {};
  for (var i = 0; i < runs.length; i++) {
    var run = runs[i];
    if (!byCase[run.caseId]) byCase[run.caseId] = { suite: suiteOf(run), cells: {} };
    if (!byCase[run.caseId].cells[run.agentName]) byCase[run.caseId].cells[run.agentName] = [];
    byCase[run.caseId].cells[run.agentName].push(run);
  }
  var caseIds = [];
  for (var caseId in byCase) caseIds.push(caseId);
  caseIds.sort(function (a, b) {
    var sa = byCase[a].suite, sb = byCase[b].suite;
    if (sa !== sb) return sa < sb ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  var maxCost = 0, maxDur = 0;
  for (var c = 0; c < caseIds.length; c++) {
    for (var a = 0; a < agentNames.length; a++) {
      var rep = representative(byCase[caseIds[c]].cells[agentNames[a]]);
      if (!rep) continue;
      if (rep.cost && rep.cost.totalCost) maxCost = Math.max(maxCost, rep.cost.totalCost);
      if (rep.durationMs) maxDur = Math.max(maxDur, rep.durationMs);
    }
  }
  var html = ['<table class="matrix"><thead><tr><th>task</th>'];
  for (var h = 0; h < agentNames.length; h++) html.push('<th>' + esc(agentNames[h]) + '</th>');
  html.push('</tr></thead><tbody>');
  var lastSuite = null;
  for (var ci = 0; ci < caseIds.length; ci++) {
    var entry = byCase[caseIds[ci]];
    if (entry.suite !== lastSuite) {
      lastSuite = entry.suite;
      html.push('<tr class="suite-row"><td colspan="' + (agentNames.length + 1) + '">' + esc(entry.suite) + '</td></tr>');
    }
    html.push('<tr><td class="case">' + esc(caseIds[ci]) + '</td>');
    for (var ai = 0; ai < agentNames.length; ai++) {
      var cellRuns = entry.cells[agentNames[ai]] || [];
      html.push(matrixCell(caseIds[ci], agentNames[ai], cellRuns, maxCost, maxDur));
    }
    html.push('</tr>');
    var open = state.openDetail;
    if (open && open.caseId === caseIds[ci]) {
      html.push('<tr class="detail"><td colspan="' + (agentNames.length + 1) + '">' + detailContent(entry.cells[open.agent] || []) + '</td></tr>');
    }
  }
  html.push('</tbody></table>');
  node.innerHTML = html.join('');
  node.querySelectorAll('td.cell').forEach(function (cell) {
    cell.addEventListener('click', function () {
      var caseId = cell.dataset.case, agent = cell.dataset.agent;
      var open = state.openDetail;
      state.openDetail = open && open.caseId === caseId && open.agent === agent ? null : { caseId: caseId, agent: agent };
      renderAll();
    });
  });
}

function representative(cellRuns) {
  if (!cellRuns || !cellRuns.length) return null;
  var best = cellRuns[0];
  for (var i = 1; i < cellRuns.length; i++) {
    if (cellRuns[i].pass && !best.pass) best = cellRuns[i];
    else if (cellRuns[i].pass === best.pass && sortStamp(cellRuns[i]) > sortStamp(best)) best = cellRuns[i];
  }
  return best;
}

function matrixCell(caseId, agent, cellRuns, maxCost, maxDur) {
  var rep = representative(cellRuns);
  if (!rep) return '<td class="cell" data-case="' + esc(caseId) + '" data-agent="' + esc(agent) + '"><span class="cell-meta">—</span></td>';
  var costPct = maxCost && rep.cost && rep.cost.totalCost ? Math.round((rep.cost.totalCost / maxCost) * 100) : 0;
  var durPct = maxDur && rep.durationMs ? Math.round((rep.durationMs / maxDur) * 100) : 0;
  var attempts = cellRuns.length > 1 ? ' ×' + cellRuns.length : '';
  return '<td class="cell" data-case="' + esc(caseId) + '" data-agent="' + esc(agent) + '">'
    + '<span class="dot ' + esc(rep.status) + '"></span>' + esc(rep.status) + attempts
    + ' <span class="cell-meta">' + fmtDur(rep.durationMs) + ' · ' + fmtUSD(rep.cost ? rep.cost.totalCost : undefined)
    + ' · ' + fmtTokens(rep.cost ? rep.cost.totalTokens : undefined) + '</span>'
    + '<div class="microbars"><div class="microbar cost"><i style="width:' + costPct + '%"></i></div>'
    + '<div class="microbar"><i style="width:' + durPct + '%"></i></div></div></td>';
}

function detailContent(cellRuns) {
  if (!cellRuns.length) return 'No runs.';
  var html = [];
  for (var i = 0; i < cellRuns.length; i++) {
    var run = cellRuns[i];
    var link = run.indexHref ? ' · <a href="' + esc(runHref(run)) + '">run report</a>' : '';
    html.push('<div>' + esc(run.runId) + ' — ' + esc(run.status)
      + (run.attemptNumber ? ' · attempt ' + run.attemptNumber : '')
      + ' · ' + fmtDur(run.durationMs) + ' · ' + fmtUSD(run.cost ? run.cost.totalCost : undefined)
      + ' · in ' + fmtTokens(run.cost ? run.cost.inputTokens : undefined)
      + ' / cached ' + fmtTokens(run.cost ? run.cost.cachedInputTokens : undefined)
      + ' / out ' + fmtTokens(run.cost ? run.cost.outputTokens : undefined)
      + ' · ' + esc((run.models || []).join(' + ') || run.model || '')
      + (run.error ? ' · ' + esc(run.error) : '') + link + '</div>');
  }
  return html.join('');
}

function runHref(run) {
  if (location.protocol === 'http:' || location.protocol === 'https:') {
    return '/runs/' + encodeURIComponent(run.runId) + '/index.html';
  }
  return run.indexHref;
}

// ---------- strip plots ----------

function renderStrip(nodeId, runs, agents, metric) {
  var node = document.getElementById(nodeId);
  var values = runs.filter(function (run) { return metricValue(run, metric) !== undefined && GRADED[run.status]; });
  if (!values.length || !agents.length) { node.innerHTML = emptyNote(); return; }
  var maxVal = 0;
  for (var i = 0; i < values.length; i++) maxVal = Math.max(maxVal, metricValue(values[i], metric));
  maxVal = maxVal * 1.05 || 1;
  var width = 560, rowH = 36, padL = 96, padR = 16, padT = 8;
  var height = padT + agents.length * rowH + 28;
  var svg = ['<svg viewBox="0 0 ' + width + ' ' + height + '" xmlns="http://www.w3.org/2000/svg">'];
  for (var ai = 0; ai < agents.length; ai++) {
    var rowY = padT + ai * rowH + rowH / 2;
    svg.push('<text x="' + (padL - 8) + '" y="' + (rowY + 4) + '" text-anchor="end" class="name">' + esc(agents[ai].name) + '</text>');
    svg.push('<line x1="' + padL + '" y1="' + rowY + '" x2="' + (width - padR) + '" y2="' + rowY + '" stroke="rgba(45,49,66,0.08)" stroke-width="0.8"/>');
    var agentRuns = values.filter(function (run) { return run.agentName === agents[ai].name; });
    for (var ri = 0; ri < agentRuns.length; ri++) {
      var run = agentRuns[ri];
      var x = padL + (metricValue(run, metric) / maxVal) * (width - padL - padR);
      var jitter = (hashJitter(run.runId) - 0.5) * 16;
      var fill = run.pass ? '#4f5d75' : '#eb6c36';
      svg.push('<circle cx="' + x + '" cy="' + (rowY + jitter) + '" r="4" fill="' + fill + '" opacity="0.75"><title>'
        + esc(run.caseId + ' — ' + (metric === 'cost' ? fmtUSD(metricValue(run, metric)) : fmtDur(metricValue(run, metric)))) + '</title></circle>');
    }
  }
  var baseY = padT + agents.length * rowH + 8;
  for (var t = 0; t <= 4; t++) {
    var val = (maxVal / 4) * t;
    var tx = padL + (val / maxVal) * (width - padL - padR);
    svg.push('<text x="' + tx + '" y="' + (baseY + 10) + '" text-anchor="middle" class="axis">'
      + (metric === 'cost' ? fmtUSD(val) : fmtDur(val)) + '</text>');
  }
  svg.push('</svg>');
  node.innerHTML = svg.join('')
    + '<div class="legend"><span><i style="background:#4f5d75"></i>solved</span><span><i style="background:#eb6c36"></i>failed</span></div>';
}

function metricValue(run, metric) {
  if (metric === 'cost') return run.cost ? run.cost.totalCost : undefined;
  return run.durationMs;
}

// ---------- token composition ----------

function renderTokens(agents) {
  var node = document.getElementById('token-bars');
  var withTokens = agents.filter(function (agent) { return agent.cached + agent.input + agent.output > 0; });
  if (!withTokens.length) { node.innerHTML = emptyNote(); return; }
  var maxTotal = 0;
  for (var i = 0; i < withTokens.length; i++) {
    maxTotal = Math.max(maxTotal, withTokens[i].cached + withTokens[i].input + withTokens[i].output);
  }
  var width = 1120, rowH = 32, padL = 96, padR = 80, padT = 4;
  var height = padT + withTokens.length * rowH + 8;
  var svg = ['<svg viewBox="0 0 ' + width + ' ' + height + '" xmlns="http://www.w3.org/2000/svg">'];
  var colors = { cached: '#7a8399', input: '#4f5d75', output: '#2d3142' };
  for (var ai = 0; ai < withTokens.length; ai++) {
    var agent = withTokens[ai];
    var total = agent.cached + agent.input + agent.output;
    var y = padT + ai * rowH + 6;
    var scale = (width - padL - padR) / maxTotal;
    var x = padL;
    svg.push('<text x="' + (padL - 8) + '" y="' + (y + 12) + '" text-anchor="end" class="name">' + esc(agent.name) + '</text>');
    var parts = [['cached', agent.cached], ['input', agent.input], ['output', agent.output]];
    for (var p = 0; p < parts.length; p++) {
      var w = parts[p][1] * scale;
      if (w > 0) {
        svg.push('<rect x="' + x + '" y="' + y + '" width="' + Math.max(w, 1) + '" height="16" fill="' + colors[parts[p][0]] + '"/>');
        x += w;
      }
    }
    svg.push('<text x="' + (x + 8) + '" y="' + (y + 12) + '" class="val">' + fmtTokens(total) + '</text>');
  }
  svg.push('</svg>');
  node.innerHTML = svg.join('')
    + '<div class="legend"><span><i style="background:#7a8399;border-radius:2px"></i>cached reads</span>'
    + '<span><i style="background:#4f5d75;border-radius:2px"></i>input</span>'
    + '<span><i style="background:#2d3142;border-radius:2px"></i>output</span></div>';
}

// ---------- top-level ----------

function renderAll() {
  var runs = applyFilters();
  var agents = aggregateByAgent(runs);
  renderKpis(agents);
  renderSolveRate(agents, runs);
  renderEfficiency(agents);
  renderMatrix(runs, agents);
  renderStrip('duration-strip', runs, agents, 'duration');
  renderStrip('cost-strip', runs, agents, 'cost');
  renderTokens(agents);
}

initState();
renderControls();
renderAll();
`;
