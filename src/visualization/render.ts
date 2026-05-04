import type { RunReport, TestCaseAgentReportCell, VisualizationFormat } from './types.js';

export function renderReport(report: RunReport, format: VisualizationFormat): string {
  if (format === 'json') return `${JSON.stringify(report, null, 2)}\n`;
  if (format === 'csv') return renderCsv(report);
  return renderHtml(report);
}

export function renderHtml(report: RunReport): string {
  const headers = report.columns.map((column) => `<th>${escapeHtml(column.agentName)}${column.model ? `<br><small>${escapeHtml(column.model)}</small>` : ''}</th>`).join('');
  const rows = report.rows.map((row) => `<tr><th><span>${escapeHtml(row.testCaseId)}</span>${row.suite ? `<br><small>${escapeHtml(row.suite)}</small>` : ''}${row.description ? `<p>${escapeHtml(row.description)}</p>` : ''}</th>${report.columns.map((column) => renderCell(row.cells[column.key])).join('')}</tr>`).join('\n');
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Harness Evals Results</title>
<style>
body{font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:24px;color:#111827;background:#f9fafb}a{color:#2563eb}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:16px 0}.card{background:white;border:1px solid #e5e7eb;border-radius:10px;padding:12px}.card b{display:block;font-size:24px}.controls{margin:16px 0;display:flex;gap:8px;flex-wrap:wrap}button{border:1px solid #d1d5db;background:white;border-radius:999px;padding:6px 10px}table{border-collapse:collapse;width:100%;background:white}th,td{border:1px solid #e5e7eb;vertical-align:top;padding:10px}thead th{position:sticky;top:0;background:#f3f4f6}.status{display:inline-block;border-radius:999px;padding:2px 8px;font-weight:700}.passed{background:#dcfce7;color:#166534}.failed{background:#fee2e2;color:#991b1b}.error{background:#ffedd5;color:#9a3412}.skipped,.incomplete{background:#e5e7eb;color:#374151}details{margin-top:8px}pre{white-space:pre-wrap;word-break:break-word;background:#111827;color:#f9fafb;padding:8px;border-radius:8px;max-height:320px;overflow:auto}.meta{color:#4b5563;font-size:12px}.fail{color:#b91c1c}.ok{color:#166534}ul{padding-left:18px}
</style>
<script>
function filterRows(kind){for(const tr of document.querySelectorAll('tbody tr')){tr.style.display=kind==='all'||tr.dataset.statuses.includes(kind)?'':'none'}}
function sortRows(kind){const tbody=document.querySelector('tbody');[...tbody.rows].sort((a,b)=>{if(kind==='case')return a.dataset.case.localeCompare(b.dataset.case);return Number(a.dataset[kind]||0)-Number(b.dataset[kind]||0)}).forEach(row=>tbody.appendChild(row))}
</script>
</head>
<body>
<h1>Harness Evals Results: ${escapeHtml(report.status.toUpperCase())}</h1>
<div class="meta">Run ${escapeHtml(report.runId)}</div>
<section class="cards">
${card('Total', report.summary.total)}${card('Passed', report.summary.passed)}${card('Failed', report.summary.failed)}${card('Errors', report.summary.errors)}${card('Score', formatNumber(report.summary.score))}${card('Duration', formatMs(report.summary.durationMs))}${card('Cost', formatCost(report.summary.cost?.rollup?.totalCost, report.summary.cost?.currency ?? report.summary.cost?.rollup?.currency))}${card('Tokens', report.summary.tokenUsage?.totalTokens)}
</section>
<div class="controls"><button onclick="filterRows('all')">All</button><button onclick="filterRows('failed')">Failures</button><button onclick="filterRows('passed')">Passes</button><button onclick="filterRows('error')">Errors</button><button onclick="filterRows('skipped')">Skipped</button><button onclick="sortRows('case')">Sort case</button><button onclick="sortRows('score')">Sort score</button><button onclick="sortRows('duration')">Sort duration</button><button onclick="sortRows('cost')">Sort cost</button></div>
<table><thead><tr><th>Test case</th>${headers}</tr></thead><tbody>${report.rows.map((row) => {
    const cells = report.columns.map((column) => row.cells[column.key]).filter(Boolean);
    return `<tr data-case="${escapeAttr(row.testCaseId)}" data-statuses="${escapeAttr(cells.map((cell) => cell.status).join(' '))}" data-score="${minNumber(cells.map((cell) => cell.score))}" data-duration="${maxNumber(cells.map((cell) => cell.durationMs))}" data-cost="${maxNumber(cells.map((cell) => cell.cost?.rollup?.totalCost))}"><th>${escapeHtml(row.testCaseId)}${row.suite ? `<br><small>${escapeHtml(row.suite)}</small>` : ''}</th>${report.columns.map((column) => renderCell(row.cells[column.key])).join('')}</tr>`;
  }).join('\n')}</tbody></table>
</body></html>\n`;
}

export function renderCsv(report: RunReport): string {
  const header = ['runId', 'testCaseId', 'suite', 'agentName', 'adapter', 'provider', 'model', 'status', 'score', 'durationMs', 'totalAssertions', 'failedAssertions', 'requiredFailed', 'cost', 'totalTokens', 'runDir'];
  const rows = report.rows.flatMap((row) => report.columns.map((column) => {
    const cell = row.cells[column.key];
    if (!cell) return undefined;
    return [report.runId, row.testCaseId, row.suite, column.agentName, column.adapter, column.provider, column.model, cell.status, cell.score, cell.durationMs, cell.assertionSummary.total, cell.assertionSummary.failed, cell.assertionSummary.requiredFailed, cell.cost?.rollup?.totalCost, cell.tokenUsage?.totalTokens, cell.runDir].map(csvCell).join(',');
  }).filter((row): row is string => row !== undefined));
  return `${header.join(',')}\n${rows.join('\n')}\n`;
}

function renderCell(cell: TestCaseAgentReportCell | undefined): string {
  if (!cell) return '<td class="incomplete">not run</td>';
  const failedAssertions = (cell.details.assertions ?? []).filter((assertion) => isRecord(assertion) && assertion.pass !== true);
  const detailSections = [
    `<h4>Steps</h4><pre>${escapeHtml(JSON.stringify(cell.details.steps, null, 2))}</pre>`,
    cell.details.toolCalls !== undefined ? `<h4>Tool calls</h4><pre>${escapeHtml(JSON.stringify(cell.details.toolCalls, null, 2))}</pre>` : '',
    cell.details.mockCalls !== undefined ? `<h4>Mock calls</h4><pre>${escapeHtml(JSON.stringify(cell.details.mockCalls, null, 2))}</pre>` : '',
    cell.details.judgeResults !== undefined ? `<h4>Judge results</h4><pre>${escapeHtml(JSON.stringify(cell.details.judgeResults, null, 2))}</pre>` : '',
    cell.details.workspaceDiff !== undefined ? `<h4>Workspace diff</h4><pre>${escapeHtml(JSON.stringify(cell.details.workspaceDiff, null, 2))}</pre>` : '',
    cell.details.logs !== undefined ? `<h4>Logs</h4><ul>${cell.details.logs.map((log) => `<li><a href="${escapeAttr(log.href)}">${escapeHtml(log.label)}</a></li>`).join('')}</ul>` : '',
  ].join('');

  return `<td><span class="status ${cell.status}">${cell.status}</span>
<div>Score: ${escapeHtml(formatNumber(cell.score))}</div><div>Duration: ${escapeHtml(formatMs(cell.durationMs))}</div><div>Cost: ${escapeHtml(formatCost(cell.cost?.rollup?.totalCost, cell.cost?.currency ?? cell.cost?.rollup?.currency))}</div><div>Tokens: ${escapeHtml(String(cell.tokenUsage?.totalTokens ?? 'n/a'))}</div><div>Assertions: ${cell.assertionSummary.passed}/${cell.assertionSummary.total} (${cell.assertionSummary.requiredFailed} required failed)</div>${cell.runDir ? `<div><a href="${escapeAttr(cell.runDir)}">Run artifacts</a></div>` : ''}${cell.details.error ? `<div class="fail">${escapeHtml(cell.details.error)}</div>` : ''}
<details><summary>Details</summary>
${failedAssertions.length > 0 ? `<h4>Failed assertions</h4><ul>${failedAssertions.map((assertion) => `<li>${escapeHtml(JSON.stringify(assertion))}</li>`).join('')}</ul>` : ''}
${detailSections}</details></td>`;
}

function card(label: string, value: unknown): string {
  return `<div class="card"><span>${escapeHtml(label)}</span><b>${escapeHtml(String(value ?? 'n/a'))}</b></div>`;
}

function csvCell(value: unknown): string {
  const text = value === undefined || value === null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function formatNumber(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(3) : 'n/a';
}

function formatMs(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value} ms` : 'n/a';
}

function formatCost(value: unknown, currency = 'USD'): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(6)} ${currency}` : 'n/a';
}

function minNumber(values: Array<number | undefined>): number {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length > 0 ? Math.min(...present) : 0;
}

function maxNumber(values: Array<number | undefined>): number {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length > 0 ? Math.max(...present) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replaceAll("'", '&#39;');
}
