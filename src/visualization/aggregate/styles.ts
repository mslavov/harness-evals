/**
 * Editorial design tokens (diagram-design skin): white-smoke paper, jet-black
 * ink, blue-slate muted, one atomic-tangerine accent reserved for
 * failures/attention. No shadows; hairline borders; 4px spacing grid;
 * Instrument Serif for the page title, Geist for labels, Geist Mono for
 * technical values.
 */
export const THEME_TOKENS = `:root {
  --paper: #f5f5f5;
  --paper-2: #ececec;
  --card: #ffffff;
  --ink: #2d3142;
  --muted: #4f5d75;
  --soft: #7a8399;
  --rule: rgba(45, 49, 66, 0.12);
  --rule-solid: #bfc0c0;
  --accent: #eb6c36;
  --accent-tint: rgba(235, 108, 54, 0.08);
  --pass: #5b7f6b;
  --pass-tint: rgba(91, 127, 107, 0.10);
  --serif: 'Instrument Serif', Georgia, 'Times New Roman', serif;
  --sans: 'Geist', -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif;
  --mono: 'Geist Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
}`;

export const FONTS_LINK = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500;600&display=swap" rel="stylesheet">`;

export const AGGREGATE_CSS = `${THEME_TOKENS}
* { box-sizing: border-box; }
body { margin: 0; padding: 32px 24px 48px; background: var(--paper); color: var(--ink); font: 14px/1.5 var(--sans); }
main { max-width: 1200px; margin: 0 auto; }
a { color: var(--muted); }

.eyebrow { font: 500 8px var(--mono); letter-spacing: 0.18em; text-transform: uppercase; color: var(--soft); margin: 0 0 4px; }
h1 { font: 400 1.75rem var(--serif); margin: 0 0 4px; }
.meta { font: 400 11px var(--mono); color: var(--soft); margin-bottom: 8px; }
section { margin-top: 32px; }
section > h2 { font: 500 9px var(--mono); letter-spacing: 0.18em; text-transform: uppercase; color: var(--muted); margin: 0 0 12px; border-bottom: 1px solid var(--rule); padding-bottom: 8px; }
.warnings { font: 400 11px var(--mono); color: var(--soft); margin-top: 8px; }
.warnings summary { cursor: pointer; }

/* Controls */
.controls { display: flex; flex-wrap: wrap; gap: 24px; padding: 16px; background: var(--card); border: 1px solid var(--rule); border-radius: 8px; }
.control-group { min-width: 160px; }
.control-group h3 { font: 500 8px var(--mono); letter-spacing: 0.18em; text-transform: uppercase; color: var(--soft); margin: 0 0 8px; }
.control-group label { display: flex; align-items: baseline; gap: 8px; font: 400 12px var(--sans); color: var(--ink); padding: 2px 0; cursor: pointer; }
.control-group label .count { font: 400 10px var(--mono); color: var(--soft); }
.control-group label .when { font: 400 10px var(--mono); color: var(--soft); }
.control-group label.synthetic { color: var(--soft); }
.control-group input { accent-color: var(--ink); margin: 0; position: relative; top: 1px; }
.toggle-row { display: flex; align-items: center; gap: 8px; font: 400 12px var(--sans); }

/* KPI cards */
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; }
.card { background: var(--card); border: 1px solid var(--rule); border-radius: 8px; padding: 16px 20px; }
.card h3 { font: 600 13px var(--sans); margin: 0 0 2px; }
.card .models { font: 400 9px var(--mono); color: var(--soft); margin-bottom: 12px; }
.card .rate { font: 400 32px var(--serif); }
.card .rate .ci { font: 400 10px var(--mono); color: var(--soft); margin-left: 8px; }
.card .kpis { display: flex; gap: 16px; margin-top: 12px; flex-wrap: wrap; }
.card .kpis div { display: flex; flex-direction: column; }
.card .kpis b { font: 500 13px var(--mono); color: var(--ink); font-weight: 500; }
.card .kpis span { font: 400 9px var(--mono); color: var(--soft); letter-spacing: 0.06em; text-transform: uppercase; }

/* Charts */
.charts-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.chart-box { background: var(--card); border: 1px solid var(--rule); border-radius: 8px; padding: 16px; }
.chart-box h3 { font: 500 9px var(--mono); letter-spacing: 0.18em; text-transform: uppercase; color: var(--muted); margin: 0 0 8px; }
.chart-box svg { width: 100%; height: auto; display: block; }
.chart-box svg text.axis { font: 400 9px var(--mono); fill: var(--soft); }
.chart-box svg text.val { font: 500 10px var(--mono); fill: var(--ink); }
.chart-box svg text.name { font: 600 11px var(--sans); fill: var(--ink); }
.chart-note { font: 400 10px var(--mono); color: var(--soft); margin-top: 8px; }
@media (max-width: 880px) { .charts-row { grid-template-columns: 1fr; } }

/* Matrix */
.matrix-wrap { background: var(--card); border: 1px solid var(--rule); border-radius: 8px; overflow-x: auto; }
table.matrix { border-collapse: collapse; width: 100%; }
table.matrix th, table.matrix td { padding: 8px 12px; border-bottom: 1px solid var(--rule); text-align: left; font-size: 12px; }
table.matrix thead th { font: 500 9px var(--mono); letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); background: var(--paper-2); }
table.matrix td.case { font: 400 11px var(--mono); white-space: nowrap; }
table.matrix tr.suite-row td { font: 500 8px var(--mono); letter-spacing: 0.18em; text-transform: uppercase; color: var(--soft); background: var(--paper-2); padding: 4px 12px; }
table.matrix td.cell { cursor: pointer; min-width: 160px; }
table.matrix td.cell:hover { background: var(--paper-2); }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 8px; position: relative; top: -1px; }
.dot.passed { background: var(--pass); }
.dot.failed { background: var(--accent); }
.dot.error { background: transparent; border: 1.2px solid var(--accent); }
.dot.skipped, .dot.incomplete, .dot.timeout { background: var(--soft); }
.cell-meta { font: 400 10px var(--mono); color: var(--soft); }
.microbars { margin-top: 4px; width: 120px; }
.microbar { height: 3px; border-radius: 2px; background: var(--paper-2); margin-top: 2px; position: relative; }
.microbar i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 2px; background: var(--muted); opacity: 0.55; }
.microbar.cost i { background: var(--ink); opacity: 0.4; }
tr.detail td { background: var(--paper-2); font: 400 11px var(--mono); color: var(--muted); }
tr.detail a { color: var(--ink); }

/* Strip plots + token bars share chart-box */
.legend { display: flex; gap: 16px; font: 400 10px var(--mono); color: var(--soft); margin-top: 8px; }
.legend i { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; }

footer { margin-top: 48px; border-top: 1px solid var(--rule); padding-top: 12px; font: 400 10px var(--mono); color: var(--soft); }

.empty { padding: 48px; text-align: center; color: var(--soft); font: 400 13px var(--sans); }

@media print {
  .controls, .warnings { display: none; }
  body { padding: 0; }
}`;
