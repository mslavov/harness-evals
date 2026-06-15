import type { AggregateReportData } from './data.js';
import { AGGREGATE_CLIENT_JS } from './client.js';
import { AGGREGATE_CSS, FONTS_LINK } from './styles.js';

/**
 * Render the aggregate report as a single self-contained HTML file: data
 * embedded as JSON, vanilla JS + inline SVG charts, no external scripts.
 * Works from file:// and via the `view --port` static server.
 */
export function renderAggregateHtml(data: AggregateReportData): string {
  // <-escape so a "</script>" inside any data field can't close the tag.
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const warnings = data.warnings.length
    ? `<details class="warnings"><summary>${data.warnings.length} scan warning${data.warnings.length === 1 ? '' : 's'}</summary>${data.warnings.map((warning) => `<div>${escapeHtml(warning)}</div>`).join('')}</details>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Harness Evals — Benchmark Report</title>
${FONTS_LINK}
<style>${AGGREGATE_CSS}</style>
</head>
<body>
<main>
<header>
  <p class="eyebrow">Harness Evals · Aggregate Report</p>
  <h1>Benchmark report</h1>
  <div class="meta">${escapeHtml(data.workspace)} · generated ${escapeHtml(data.generatedAt)} · ${data.taskRuns.length} task runs in ${data.batches.length} runs</div>
  ${warnings}
</header>

<section>
  <h2>Select &amp; filter</h2>
  <div class="controls" id="controls"></div>
</section>

<section>
  <h2>Agents</h2>
  <div class="cards" id="kpi-cards"></div>
</section>

<section class="charts-row">
  <div class="chart-box"><h3>Solve rate</h3><div id="solve-rate-chart"></div></div>
  <div class="chart-box"><h3>Cost vs solve rate</h3><div id="efficiency-chart"></div></div>
</section>

<section>
  <h2>Agent × task matrix</h2>
  <div class="matrix-wrap"><div id="matrix-table"></div></div>
</section>

<section class="charts-row">
  <div class="chart-box"><h3>Duration per task</h3><div id="duration-strip"></div></div>
  <div class="chart-box"><h3>Cost per task</h3><div id="cost-strip"></div></div>
</section>

<section>
  <h2>Token composition</h2>
  <div class="chart-box"><div id="token-bars"></div></div>
</section>

<footer>harness-evals aggregate report · select runs above to merge or isolate sweeps · merged views keep the newest graded attempt per task and agent</footer>
</main>
<script type="application/json" id="report-data">${json}</script>
<script>${AGGREGATE_CLIENT_JS}</script>
</body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
