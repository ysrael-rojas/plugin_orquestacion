/**
 * Página única del dashboard.
 *
 * Todo el HTML/CSS/JS se ensambla desde strings TypeScript: sin bundler, sin
 * CDN, sin Tailwind. El estado llega ya formateado por `dashboard-view.ts`;
 * esta capa solo maqueta y escapa. El JS embebido hace `fetch('/api/state')`
 * cada 2500 ms y repinta de forma imperativa.
 */

import {
  escapeHtml,
  type DashboardActivityRow,
  type DashboardOrchestratorView,
  type DashboardRunView,
  type DashboardState,
  type DashboardTaskRow,
} from "./dashboard-view"

/** Intervalo de refresco del polling. */
export const DASHBOARD_REFRESH_MS = 2500

export interface DashboardHtmlOptions {
  /** Intervalo de polling en ms (default 2500). */
  refreshMs?: number
  /** URL local mostrada en el pie. */
  url?: string
}

/** Renderiza la página completa con el estado inicial ya pintado. */
export function renderDashboardHtml(
  state: DashboardState,
  options: DashboardHtmlOptions = {},
): string {
  const refreshMs = options.refreshMs ?? DASHBOARD_REFRESH_MS
  const footer = options.url ? `Servidor local · <span class="mono">${escapeHtml(options.url)}</span>` : "Servidor local"

  return [
    "<!doctype html>",
    '<html lang="es">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>Aiapaec · orquestaciones en vivo</title>",
    `<style>${STYLES}</style>`,
    "</head>",
    `<body data-refresh="${refreshMs}">`,
    "<header class=\"top\">",
    "<div>",
    "<h1>Aiapaec · orquestaciones en vivo</h1>",
    '<p class="sub">Dashboard local de runs y tareas · contrato de estado v' +
      escapeHtml(state.version) +
      "</p>",
    "</div>",
    '<div class="top-meta">',
    '<span id="conn" class="conn">en vivo</span>',
    '<span class="dim">·</span>',
    `<span id="updated" class="dim">actualizado ${escapeHtml(shortTime(state.generatedAt))}</span>`,
    "</div>",
    "</header>",
    "<main>",
    '<section class="panel" aria-labelledby="active-title">',
    '<h2 id="active-title">Run activo</h2>',
    `<div id="active">${renderActive(state)}</div>`,
    "</section>",
    '<section class="panel">',
    '<details id="history" class="history">',
    "<summary>Historial de runs anteriores (<span id=\"history-count\">" +
      escapeHtml(state.history.length) +
      "</span>)</summary>",
    `<div id="history-list">${renderHistory(state)}</div>`,
    "</details>",
    "</section>",
    "</main>",
    '<footer class="foot">' +
      footer +
      " · refresco cada " +
      escapeHtml(String((refreshMs / 1000).toFixed(1)).replace(".0", "")) +
      " s · solo <span class=\"mono\">127.0.0.1</span></footer>",
    "<noscript><p class=\"empty\">Sin JavaScript la página no se refresca sola: recarga manualmente.</p></noscript>",
    `<script>${renderClientScript(refreshMs)}</script>`,
    "</body>",
    "</html>",
  ].join("\n")
}

function renderActive(state: DashboardState): string {
  if (!state.active) {
    return '<p class="empty">No hay orquestaciones en curso. Cuando lances una con <span class="mono">aiapaec_orchestrate</span> aparecerá aquí.</p>'
  }
  return renderRunCard(state.active, state.showTokens, false)
}

function renderHistory(state: DashboardState): string {
  if (state.history.length === 0) {
    return '<p class="empty">Sin runs anteriores todavía.</p>'
  }
  return state.history
    .map((run) => renderRunCard(run, state.showTokens, true))
    .join("")
}

function renderRunCard(run: DashboardRunView, showTokens: boolean, collapsed: boolean): string {
  const title = [
    `<span class="glyph" aria-hidden="true">${escapeHtml(run.glyph)}</span>`,
    `<span class="run-objective">${escapeHtml(run.objective || "(sin objetivo)")}</span>`,
    `<span class="status-text tone-${escapeHtml(run.tone)}">${escapeHtml(run.statusText)}</span>`,
    `<span class="progress-pill">${escapeHtml(run.progressLabel)}</span>`,
  ].join(" ")

  const details = [
    `<span class="mono run-id">${escapeHtml(run.runId)}</span>`,
    `<span class="dim">base ${escapeHtml(run.baseBranch || "—")}</span>`,
    `<span class="dim">inicio ${escapeHtml(shortTime(run.startedAt))}</span>`,
    `<span class="dim">duración ${escapeHtml(run.duration)}</span>`,
  ].join(" · ")

  const body = [
    renderProgress(run),
    run.error ? `<p class="run-error">${escapeHtml(run.error)}</p>` : "",
    run.orchestrator ? renderOrchestratorActivity(run.orchestrator) : "",
    renderTaskTable(run, showTokens),
  ]
    .filter(Boolean)
    .join("\n")

  if (collapsed) {
    return [
      `<details class="run-card tone-${escapeHtml(run.tone)}">`,
      `<summary class="run-summary">${title}</summary>`,
      `<div class="run-meta">${details}</div>`,
      body,
      "</details>",
    ].join("\n")
  }

  return [
    `<article class="run-card active tone-${escapeHtml(run.tone)}">`,
    `<h3 class="run-title">${title}</h3>`,
    `<div class="run-meta">${details}</div>`,
    body,
    "</article>",
  ].join("\n")
}

function renderProgress(run: DashboardRunView): string {
  const total = run.progressTotal
  const done = run.progressDone
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
  const text =
    total > 0
      ? `${done} de ${total} tareas cerradas`
      : "sin tareas registradas todavía"

  return [
    '<div class="progress">',
    `<div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}" aria-valuetext="${escapeHtml(text)}">`,
    `<div class="progress-fill" style="width:${percent}%"></div>`,
    "</div>",
    `<span class="progress-label">${escapeHtml(run.progressLabel)}</span>`,
    `<span class="dim">${escapeHtml(text)}</span>`,
    "</div>",
  ].join("")
}

function renderTaskTable(run: DashboardRunView, showTokens: boolean): string {
  const headers = ["ID", "Agente", "Estado", "Rama", "Tiempo"]
  if (showTokens) headers.push("Tokens / costo")

  const colspan = headers.length
  const rows = run.tasks.map((task) => renderTaskRow(task, showTokens, colspan))

  return [
    '<table class="tasks">',
    `<thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead>`,
    "<tbody>",
    rows.length > 0
      ? rows.join("\n")
      : `<tr><td class="empty" colspan="${colspan}">Sin tareas con resultado todavía.</td></tr>`,
    "</tbody>",
    "</table>",
  ].join("\n")
}

function renderTaskRow(task: DashboardTaskRow, showTokens: boolean, colspan: number): string {
  const statusIcon = task.isRunning
    ? '<span class="spinner pulse" aria-hidden="true"></span>'
    : `<span class="glyph" aria-hidden="true">${escapeHtml(task.glyph)}</span>`

  const cells = [
    `<td class="mono">${escapeHtml(task.taskId)}</td>`,
    `<td>${escapeHtml(task.agent)}${renderQaBadge(task.qaLevel)}</td>`,
    `<td class="status tone-${escapeHtml(task.tone)}">${statusIcon} <span class="status-text">${escapeHtml(task.statusText)}</span></td>`,
    `<td class="mono">${escapeHtml(task.branch)}</td>`,
    `<td class="num">${escapeHtml(task.time)}</td>`,
  ]
  if (showTokens) {
    const tokensCost = [task.tokens, task.cost].filter(Boolean).join(" · ")
    cells.push(`<td class="num">${escapeHtml(tokensCost || "—")}</td>`)
  }

  const title = task.summary ? ` title="${escapeHtml(task.summary)}"` : ""
  const row = `<tr${title}>${cells.join("")}</tr>`
  if (!task.isRunning) return row

  // Bajo cada tarea en curso se listan sus últimas acciones reales.
  return `${row}\n<tr class="activity-row"><td colspan="${colspan}">${renderActivityList(
    task.activity ?? [],
    "sin actividad registrada",
  )}</td></tr>`
}

/** Badge discreto con el nivel de QA de la tarea ("L1"/"L2"/"L3"). */
function renderQaBadge(qaLevel?: string): string {
  return qaLevel ? ` <span class="qa-badge">${escapeHtml(qaLevel)}</span>` : ""
}

/** Lista de acciones (tool + resumen + "hace Xs"). */
function renderActivityList(items: readonly DashboardActivityRow[], emptyText: string): string {
  if (items.length === 0) {
    return `<p class="act-empty">${escapeHtml(emptyText)}</p>`
  }
  const entries = items.map((item) =>
    [
      '<li class="act-item">',
      `<span class="mono act-tool">${escapeHtml(item.tool)}</span>`,
      item.summary ? `<span class="act-summary">${escapeHtml(item.summary)}</span>` : "",
      `<span class="dim act-ago">${escapeHtml(item.ago)}</span>`,
      "</li>",
    ].join(" "),
  )
  return `<ul class="acts">${entries.join("")}</ul>`
}

/** Sección plegable con la actividad de la sesión orquestadora. */
function renderOrchestratorActivity(orchestrator: DashboardOrchestratorView): string {
  return [
    '<details class="orch-activity">',
    `<summary>Actividad del ${escapeHtml(orchestrator.label)} (<span class="dim">${escapeHtml(
      String(orchestrator.activity.length),
    )}</span>)</summary>`,
    renderActivityList(orchestrator.activity, "sin actividad registrada"),
    "</details>",
  ].join("")
}

function shortTime(iso: string): string {
  if (!iso) return "—"
  const cleaned = iso.replace("T", " ").replace("Z", "").slice(0, 19)
  return cleaned || "—"
}

/**
 * JS embebido. Recibe el estado ya formateado por el view-model, así que solo
 * compone la maqueta y escapa cada valor interpolado.
 */
export function renderClientScript(refreshMs: number = DASHBOARD_REFRESH_MS): string {
  return [
    "(function () {",
    '  "use strict";',
    `  var REFRESH = ${Math.max(500, Math.floor(refreshMs))};`,
    "  function esc(value) {",
    '    return String(value === null || value === undefined ? "" : value)',
    '      .replace(/&/g, "&amp;")',
    '      .replace(/</g, "&lt;")',
    '      .replace(/>/g, "&gt;")',
    '      .replace(/"/g, "&quot;")',
    "      .replace(/'/g, '&#39;');",
    "  }",
    "  function statusCell(task) {",
    "    var icon = task.isRunning",
    '      ? \'<span class="spinner pulse" aria-hidden="true"></span>\'',
    '      : \'<span class="glyph" aria-hidden="true">\' + esc(task.glyph) + "</span>";',
    '    return \'<td class="status tone-\' + esc(task.tone) + \'">\' + icon +',
    '      \' <span class="status-text">\' + esc(task.statusText) + "</span></td>";',
    "  }",
    "  function activityList(items, emptyText) {",
    "    if (!items || items.length === 0) {",
    '      return \'<p class="act-empty">\' + esc(emptyText) + "</p>";',
    "    }",
    "    var entries = items.map(function (item) {",
    "      return [",
    '        \'<li class="act-item">\',',
    '        \'<span class="mono act-tool">\' + esc(item.tool) + "</span>",',
    '        item.summary ? \'<span class="act-summary">\' + esc(item.summary) + "</span>" : "",',
    '        \'<span class="dim act-ago">\' + esc(item.ago) + "</span>",',
    '        "</li>"',
    '      ].join(" ");',
    "    });",
    '    return \'<ul class="acts">\' + entries.join("") + "</ul>";',
    "  }",
    "  function taskRow(task, showTokens, colspan) {",
    "    var cells = [",
    '      \'<td class="mono">\' + esc(task.taskId) + "</td>",',
    '      "<td>" + esc(task.agent) +',
    '        (task.qaLevel ? \' <span class="qa-badge">\' + esc(task.qaLevel) + "</span>" : "") + "</td>",',
    "      statusCell(task),",
    '      \'<td class="mono">\' + esc(task.branch) + "</td>",',
    '      \'<td class="num">\' + esc(task.time) + "</td>"',
    "    ];",
    "    if (showTokens) {",
    "      var extra = [task.tokens, task.cost].filter(Boolean).join(\" · \") || \"—\";",
    '      cells.push(\'<td class="num">\' + esc(extra) + "</td>");',
    "    }",
    '    var title = task.summary ? \' title="\' + esc(task.summary) + \'"\' : "";',
    '    var row = "<tr" + title + ">" + cells.join("") + "</tr>";',
    "    if (!task.isRunning) return row;",
    '    return row + \'<tr class="activity-row"><td colspan="\' + colspan + \'">\' +',
    '      activityList(task.activity || [], "sin actividad registrada") + "</td></tr>";',
    "  }",
    "  function orchestratorActivity(orchestrator) {",
    "    if (!orchestrator) return \"\";",
    '    return \'<details class="orch-activity"><summary>Actividad del \' + esc(orchestrator.label) +',
    '      \' (<span class="dim">\' + esc((orchestrator.activity || []).length) + \'</span>)</summary>\' +',
    '      activityList(orchestrator.activity || [], "sin actividad registrada") + "</details>";',
    "  }",
    "  function taskTable(run, showTokens) {",
    '    var headers = ["ID", "Agente", "Estado", "Rama", "Tiempo"];',
    '    if (showTokens) headers.push("Tokens / costo");',
    "    var head = headers.map(function (header) {",
    '      return "<th>" + esc(header) + "</th>";',
    '    }).join("");',
    "    var rows = run.tasks.map(function (task) { return taskRow(task, showTokens, headers.length); });",
    '    if (rows.length === 0) {',
    '      rows.push(\'<tr><td class="empty" colspan="\' + headers.length + \'">Sin tareas con resultado todavía.</td></tr>\');',
    "    }",
    '    return \'<table class="tasks"><thead><tr>\' + head + "</tr></thead><tbody>" + rows.join("") + "</tbody></table>";',
    "  }",
    "  function progress(run) {",
    "    var total = run.progressTotal;",
    "    var done = run.progressDone;",
    "    var percent = total > 0 ? Math.min(100, Math.round(done / total * 100)) : 0;",
    '    var text = total > 0 ? done + " de " + total + " tareas cerradas" : "sin tareas registradas todavía";',
    '    return \'<div class="progress"><div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="\' + esc(total) +',
    '      \'" aria-valuenow="\' + esc(done) + \'" aria-valuetext="\' + esc(text) + \'"><div class="progress-fill" style="width:\' + percent +',
    '      \'%"></div></div><span class="progress-label">\' + esc(run.progressLabel) + \'</span><span class="dim">\' + esc(text) + "</span></div>";',
    "  }",
    "  function title(run) {",
    '    return \'<span class="glyph" aria-hidden="true">\' + esc(run.glyph) + "</span> " +',
    '      \'<span class="run-objective">\' + esc(run.objective || "(sin objetivo)") + "</span> " +',
    '      \'<span class="status-text tone-\' + esc(run.tone) + \'">\' + esc(run.statusText) + "</span> " +',
    '      \'<span class="progress-pill">\' + esc(run.progressLabel) + "</span>";',
    "  }",
    "  function meta(run) {",
    '    return \'<span class="mono run-id">\' + esc(run.runId) + \'</span> · <span class="dim">base \' +',
    '      esc(run.baseBranch || "—") + \'</span> · <span class="dim">inicio \' + esc(run.startedAt.replace("T", " ").slice(0, 19)) +',
    '      \'</span> · <span class="dim">duración \' + esc(run.duration) + "</span>";',
    "  }",
    "  function runBody(run, showTokens) {",
    '    return progress(run) + (run.error ? \'<p class="run-error">\' + esc(run.error) + "</p>" : "") +',
    "      orchestratorActivity(run.orchestrator) + taskTable(run, showTokens);",
    "  }",
    "  function activeCard(run, showTokens) {",
    '    return \'<article class="run-card active tone-\' + esc(run.tone) + \'"><h3 class="run-title">\' + title(run) +',
    '      \'</h3><div class="run-meta">\' + meta(run) + "</div>" + runBody(run, showTokens) + "</article>";',
    "  }",
    "  function historyCard(run, showTokens) {",
    '    return \'<details class="run-card tone-\' + esc(run.tone) + \'"><summary class="run-summary">\' + title(run) +',
    '      \'</summary><div class="run-meta">\' + meta(run) + "</div>" + runBody(run, showTokens) + "</details>";',
    "  }",
    "  function paint(state) {",
    '    var activeEl = document.getElementById("active");',
    '    activeEl.innerHTML = state.active',
    '      ? activeCard(state.active, state.showTokens)',
    '      : \'<p class="empty">No hay orquestaciones en curso. Cuando lances una con <span class="mono">aiapaec_orchestrate</span> aparecerá aquí.</p>\';',
    '    var countEl = document.getElementById("history-count");',
    "    if (countEl) countEl.textContent = String(state.history.length);",
    '    var listEl = document.getElementById("history-list");',
    "    listEl.innerHTML = state.history.length",
    '      ? state.history.map(function (run) { return historyCard(run, state.showTokens); }).join("")',
    '      : \'<p class="empty">Sin runs anteriores todavía.</p>\';',
    '    var updatedEl = document.getElementById("updated");',
    '    if (updatedEl) updatedEl.textContent = "actualizado " + new Date(state.generatedAt).toLocaleTimeString();',
    "    setConnection(true);",
    "  }",
    "  function setConnection(ok) {",
    '    var el = document.getElementById("conn");',
    "    if (!el) return;",
    '    el.textContent = ok ? "en vivo" : "sin conexión";',
    '    el.className = "conn " + (ok ? "ok" : "down");',
    "  }",
    "  function refresh() {",
    "    return fetch(\"/api/state\", { cache: \"no-store\" })",
    "      .then(function (response) {",
    '        if (!response.ok) throw new Error("HTTP " + response.status);',
    "        return response.json();",
    "      })",
    "      .then(paint)",
    "      .catch(function () { setConnection(false); });",
    "  }",
    "  refresh();",
    "  setInterval(refresh, REFRESH);",
    "})();",
  ].join("\n")
}

const STYLES = `
:root {
  color-scheme: dark;
  --bg: #0b0f14;
  --panel: #121820;
  --panel-soft: #0f151c;
  --border: #263140;
  --fg: #e6edf3;
  --dim: #93a1b1;
  --run: #f0b429;
  --ok: #4ade80;
  --failed: #f87171;
  --skipped: #8b98a8;
  --warn: #fbbf24;
  --aborted: #a78bfa;
  --accent: #58a6ff;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--bg);
  color: var(--fg);
  font-family: ui-sans-serif, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 15px;
  line-height: 1.5;
}
.mono { font-family: ui-monospace, SFMono-Regular, "Cascadia Mono", Consolas, monospace; font-size: 0.92em; }
.dim { color: var(--dim); }
.top {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 1rem;
  max-width: 1080px;
  margin: 0 auto;
  padding: 1.8rem 1.25rem 0.5rem;
}
.top h1 { margin: 0; font-size: 1.35rem; font-weight: 650; letter-spacing: -0.01em; }
.sub { margin: 0.25rem 0 0; color: var(--dim); font-size: 0.85rem; }
.top-meta { display: flex; align-items: center; gap: 0.5rem; font-size: 0.82rem; }
.conn { border: 1px solid var(--border); border-radius: 999px; padding: 0.1rem 0.55rem; color: var(--dim); }
.conn.ok { color: var(--ok); border-color: rgba(74, 222, 128, 0.4); }
.conn.down { color: var(--failed); border-color: rgba(248, 113, 113, 0.45); }
main { max-width: 1080px; margin: 0 auto; padding: 0.75rem 1.25rem 2rem; display: grid; gap: 1rem; }
.panel {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 1rem 1.1rem 1.1rem;
}
.panel h2 { margin: 0 0 0.75rem; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.09em; color: var(--dim); font-weight: 600; }
.run-card { border-top: 1px solid var(--border); padding-top: 0.9rem; }
.run-card:first-child { border-top: 0; padding-top: 0; }
.run-card.active { border-top: 0; padding-top: 0; }
.run-title { margin: 0 0 0.35rem; font-size: 1.05rem; font-weight: 600; }
.run-summary { cursor: pointer; font-size: 0.98rem; padding: 0.15rem 0; }
.run-summary::marker { color: var(--dim); }
.run-objective { font-weight: 600; }
.run-meta { color: var(--dim); font-size: 0.78rem; margin: 0.15rem 0 0.6rem; word-break: break-word; }
.run-id { color: var(--fg); }
.run-error { margin: 0.5rem 0; color: var(--failed); font-size: 0.84rem; }
.status-text { font-weight: 600; }
.qa-badge {
  display: inline-block;
  margin-left: 0.35rem;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0 0.4rem;
  font-size: 0.72rem;
  font-variant-numeric: tabular-nums;
  color: var(--dim);
  vertical-align: 0.05em;
}
.tone-run { color: var(--run); }
.tone-ok { color: var(--ok); }
.tone-failed { color: var(--failed); }
.tone-skipped { color: var(--skipped); }
.tone-warn { color: var(--warn); }
.tone-aborted { color: var(--aborted); }
.tone-pending { color: var(--dim); }
.progress { display: flex; align-items: center; gap: 0.6rem; margin: 0.2rem 0 0.7rem; font-size: 0.82rem; }
.progress-track { flex: 1; max-width: 320px; height: 7px; border-radius: 999px; background: var(--panel-soft); border: 1px solid var(--border); overflow: hidden; }
.progress-fill { height: 100%; background: linear-gradient(90deg, var(--accent), var(--ok)); }
.progress-label { font-variant-numeric: tabular-nums; font-weight: 650; }
.progress-pill { border: 1px solid var(--border); border-radius: 999px; padding: 0.05rem 0.5rem; font-size: 0.78rem; color: var(--dim); font-variant-numeric: tabular-nums; }
.tasks { width: 100%; border-collapse: collapse; font-size: 0.86rem; }
.tasks th {
  text-align: left;
  font-weight: 600;
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--dim);
  padding: 0.45rem 0.6rem;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
.tasks td { padding: 0.45rem 0.6rem; border-bottom: 1px solid rgba(38, 49, 64, 0.55); vertical-align: top; }
.tasks tbody tr:last-child td { border-bottom: 0; }
.tasks tbody tr:hover td { background: rgba(88, 166, 255, 0.05); }
.tasks .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.tasks .status { white-space: nowrap; }
.empty { color: var(--dim); font-size: 0.88rem; padding: 0.4rem 0; }
.activity-row td { padding: 0 0.6rem 0.55rem; border-bottom: 1px solid rgba(38, 49, 64, 0.55); background: rgba(88, 166, 255, 0.03); }
.acts { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.18rem; font-size: 0.8rem; }
.act-item { display: flex; gap: 0.5rem; align-items: baseline; min-width: 0; }
.act-tool { color: var(--accent); white-space: nowrap; }
.act-summary { color: var(--fg); overflow-wrap: anywhere; }
.act-ago { white-space: nowrap; }
.act-empty { margin: 0; padding: 0.05rem 0; color: var(--dim); font-size: 0.78rem; font-style: italic; }
.orch-activity { margin: 0.1rem 0 0.7rem; font-size: 0.82rem; }
.orch-activity > summary { cursor: pointer; color: var(--dim); font-size: 0.78rem; }
.orch-activity > summary::marker { color: var(--dim); }
.orch-activity[open] > summary { margin-bottom: 0.35rem; }
.history summary { cursor: pointer; font-size: 0.9rem; color: var(--dim); font-weight: 600; }
.history summary::marker { color: var(--dim); }
.history[open] summary { margin-bottom: 0.9rem; }
.foot { max-width: 1080px; margin: 0 auto; padding: 0 1.25rem 2rem; color: var(--dim); font-size: 0.75rem; }
.spinner {
  display: inline-block;
  width: 0.62em;
  height: 0.62em;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  vertical-align: -0.02em;
}
.pulse { animation: pulse 2s ease-in-out infinite; }
@keyframes pulse {
  0%, 100% { opacity: 0.35; transform: scale(0.82); }
  50% { opacity: 1; transform: scale(1.12); }
}
@media (prefers-reduced-motion: reduce) {
  .pulse { animation: none; opacity: 1; transform: none; }
}
@media (max-width: 720px) {
  .tasks .mono { word-break: break-all; }
  .top { padding-top: 1.2rem; }
}
`
