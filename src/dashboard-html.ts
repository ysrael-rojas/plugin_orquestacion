/**
 * Página única del dashboard (contrato v4: árbol de ejecución).
 *
 * Todo el HTML/CSS/JS se ensambla desde strings TypeScript: sin bundler, sin
 * CDN, sin Tailwind. El estado llega ya formateado por `dashboard-view.ts`;
 * esta capa solo maqueta y escapa.
 *
 * Anti-ruido: por defecto se ve el árbol (título + chip agente·modelo + estado)
 * y todo lo demás (objetivo completo, detalle, tokens/costo, actividad) vive en
 * `<details>` colapsados. El JS embebido hace `fetch('/api/state')` cada 2.5 s y
 * repinta conservando qué `<details>` tenía abiertos el usuario.
 */

import {
  escapeHtml,
  formatChip,
  type DashboardActivityRow,
  type DashboardOrchestratorView,
  type DashboardRunView,
  type DashboardSessionNode,
  type DashboardState,
  type DashboardTaskRow,
} from "./dashboard-view"

/** Intervalo de refresco del polling. */
export const DASHBOARD_REFRESH_MS = 2500

/** URL que se muestra cuando el servidor no pasa una (por coherencia con `dashboardPort`). */
export const DEFAULT_DASHBOARD_URL = "http://127.0.0.1:4780"

export interface DashboardHtmlOptions {
  /** Intervalo de polling en ms (default 2500). */
  refreshMs?: number
  /** URL local mostrada en la cabecera y el pie. */
  url?: string
}

/** Renderiza la página completa con el estado inicial ya pintado. */
export function renderDashboardHtml(
  state: DashboardState,
  options: DashboardHtmlOptions = {},
): string {
  const refreshMs = options.refreshMs ?? DASHBOARD_REFRESH_MS
  const url = options.url ?? DEFAULT_DASHBOARD_URL

  return [
    "<!doctype html>",
    '<html lang="es">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>Aiapaec · árbol de ejecución</title>",
    `<style>${STYLES}</style>`,
    "</head>",
    `<body data-refresh="${refreshMs}">`,
    '<header class="top">',
    "<div>",
    "<h1>Aiapaec · árbol de ejecución</h1>",
    '<p class="sub">Servidor local · <span id="dash-url" class="mono url">' +
      escapeHtml(url) +
      "</span></p>",
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
    '<details id="history" class="history" data-state-id="history">',
    "<summary>Historial de runs anteriores (<span id=\"history-count\">" +
      escapeHtml(state.history.length) +
      "</span>)</summary>",
    `<div id="history-list">${renderHistory(state)}</div>`,
    "</details>",
    "</section>",
    "</main>",
    '<footer class="foot">' +
      'Servidor local · <span class="mono">' +
      escapeHtml(url) +
      "</span> · contrato de estado v" +
      escapeHtml(state.version) +
      " · refresco cada " +
      escapeHtml(String((refreshMs / 1000).toFixed(1)).replace(".0", "")) +
      ' s · solo <span class="mono">127.0.0.1</span></footer>',
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
  return state.history.map((run) => renderRunCard(run, state.showTokens, true)).join("")
}

/**
 * Un run completo. El activo se pinta como `<article>`; los del historial son
 * una línea compacta (`title · fecha · resultado`) dentro de un `<details>`.
 */
function renderRunCard(run: DashboardRunView, showTokens: boolean, collapsed: boolean): string {
  const title = [
    `<span class="glyph" aria-hidden="true">${escapeHtml(run.glyph)}</span>`,
    `<span class="node-title">${escapeHtml(run.title || run.objective || "(sin título)")}</span>`,
    renderProfileBadge(run.modelProfile),
    `<span class="status-text tone-${escapeHtml(run.tone)}">${escapeHtml(run.statusText)}</span>`,
    `<span class="progress-pill">${escapeHtml(run.progressLabel)}</span>`,
  ]
    .filter(Boolean)
    .join(" ")

  const body = [
    renderSpec(run),
    renderProgress(run),
    run.error ? `<p class="run-error">${escapeHtml(run.error)}</p>` : "",
    renderTree(run, showTokens),
  ]
    .filter(Boolean)
    .join("\n")

  if (collapsed) {
    return [
      `<details class="run-card tone-${escapeHtml(run.tone)}" data-state-id="run:${escapeHtml(run.runId)}">`,
      `<summary class="run-summary">${escapeHtml(run.compact)}${renderProfileBadge(run.modelProfile)}</summary>`,
      body,
      "</details>",
    ].join("\n")
  }

  return [
    `<article class="run-card active tone-${escapeHtml(run.tone)}">`,
    `<h3 class="run-title">${title}</h3>`,
    body,
    "</article>",
  ].join("\n")
}

/**
 * Badge discreto del perfil de modelos (`perfil: balanced`).
 *
 * Presentacional y tolerante: si el run no declara perfil —o el backend va un
 * paso por detrás y `/api/state` no trae el campo— devuelve cadena vacía y no
 * se pinta nada (el HTML queda idéntico al de antes de los perfiles).
 */
function renderProfileBadge(modelProfile?: string): string {
  const value = (modelProfile ?? "").trim()
  if (!value) return ""
  return `<span class="profile-badge">perfil: ${escapeHtml(value)}</span>`
}

/** Objetivo completo + metadatos del run, plegados (anti-ruido). */
function renderSpec(run: DashboardRunView): string {
  return [
    `<details class="run-spec" data-state-id="spec:${escapeHtml(run.runId)}">`,
    "<summary>objetivo completo</summary>",
    `<p class="run-objective">${escapeHtml(run.objective || "(sin objetivo)")}</p>`,
    '<p class="run-meta">',
    `<span class="mono run-id">${escapeHtml(run.runId)}</span>`,
    `<span class="dim">base ${escapeHtml(run.baseBranch || "—")}</span>`,
    `<span class="dim">inicio ${escapeHtml(shortTime(run.startedAt))}</span>`,
    `<span class="dim">duración ${escapeHtml(run.duration)}</span>`,
    "</p>",
    "</details>",
  ].join("")
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

/** Árbol del run: orquestador → tareas → sub-sesiones (cascada). */
function renderTree(run: DashboardRunView, showTokens: boolean): string {
  const orchestrator = run.orchestrator
  const tasks = run.tasks.map((task) => renderTaskNode(run, task, showTokens))
  const roots = (orchestrator?.subsessions ?? []).map((node) => renderSessionNode(node))
  const children = [...tasks, ...roots]
  const label = orchestrator?.label ?? "orquestador"

  const node = [
    '<li class="node node-orch">',
    renderNodeLine({
      glyph: "🧭",
      title: label,
      chip: formatChip(orchestrator?.agent ?? label, orchestrator?.model),
      statusText: "",
      tone: "pending",
      time: run.duration,
    }),
    orchestrator ? renderOrchestratorActivity(orchestrator) : "",
    children.length > 0 ? `<ul class="children">${children.join("")}</ul>` : "",
    "</li>",
  ]
    .filter(Boolean)
    .join("")

  return `<ul class="tree">${node}</ul>`
}

interface NodeLineParts {
  glyph: string
  title: string
  chip: string
  statusText: string
  tone: string
  running?: boolean
  qaLevel?: string
  time?: string
}

/** Línea de un nodo: glifo/spinner + título + chip agente·modelo + estado. */
function renderNodeLine(parts: NodeLineParts): string {
  const icon = parts.running
    ? '<span class="spinner pulse" aria-hidden="true"></span>'
    : `<span class="glyph" aria-hidden="true">${escapeHtml(parts.glyph)}</span>`

  return [
    '<div class="node-line">',
    icon,
    `<span class="node-title">${escapeHtml(parts.title)}</span>`,
    `<span class="chip">${escapeHtml(parts.chip)}</span>`,
    parts.qaLevel ? `<span class="qa-badge">${escapeHtml(parts.qaLevel)}</span>` : "",
    parts.statusText
      ? `<span class="status-text tone-${escapeHtml(parts.tone)}">${escapeHtml(parts.statusText)}</span>`
      : "",
    parts.time ? `<span class="dim node-time">${escapeHtml(parts.time)}</span>` : "",
    "</div>",
  ].join("")
}

function renderTaskNode(run: DashboardRunView, task: DashboardTaskRow, showTokens: boolean): string {
  const key = escapeHtml(`${run.runId}:${task.taskId}`)
  const details = [
    renderNodeLine({
      glyph: task.glyph,
      running: task.isRunning,
      title: task.title || task.taskId,
      chip: formatChip(task.agent, task.model),
      ...(task.qaLevel ? { qaLevel: task.qaLevel } : {}),
      statusText: task.statusText,
      tone: task.tone,
      time: task.time,
    }),
    renderTaskDetail(key, task),
    showTokens ? renderTaskTokens(key, task) : "",
    task.isRunning ? renderTaskActivity(key, task) : "",
    renderChildren(task.subsessions),
  ]
    .filter(Boolean)
    .join("")

  return `<li class="node node-task tone-${escapeHtml(task.tone)}">${details}</li>`
}

function renderTaskDetail(key: string, task: DashboardTaskRow): string {
  return [
    `<details class="node-detail" data-state-id="task:${key}">`,
    "<summary>detalle</summary>",
    `<p class="node-meta mono">${escapeHtml(task.taskId)} · rama ${escapeHtml(task.branch)}</p>`,
    `<p class="node-summary">${escapeHtml(task.summary || "—")}</p>`,
    "</details>",
  ].join("")
}

function renderTaskTokens(key: string, task: DashboardTaskRow): string {
  const value = [task.tokens, task.cost].filter(Boolean).join(" · ")
  if (!value) return ""
  return [
    `<details class="node-tokens" data-state-id="tok:${key}">`,
    "<summary>tokens / costo</summary>",
    `<span class="mono">${escapeHtml(value)}</span>`,
    "</details>",
  ].join("")
}

function renderTaskActivity(key: string, task: DashboardTaskRow): string {
  const items = task.activity ?? []
  return [
    `<details class="activity-row" data-state-id="act:${key}">`,
    `<summary>actividad (${escapeHtml(items.length)})</summary>`,
    renderActivityList(items, "sin actividad registrada"),
    "</details>",
  ].join("")
}

/** Sub-sesiones de una tarea (subagentes del subagente), anidadas. */
function renderChildren(nodes?: readonly DashboardSessionNode[]): string {
  if (!nodes || nodes.length === 0) return ""
  return `<ul class="children">${nodes.map((node) => renderSessionNode(node)).join("")}</ul>`
}

function renderSessionNode(node: DashboardSessionNode): string {
  const line = renderNodeLine({
    glyph: node.glyph,
    running: node.status === "running",
    title: node.title,
    chip: formatChip(node.agent, node.model),
    statusText: node.statusText,
    tone: node.tone,
  })
  return `<li class="node node-session tone-${escapeHtml(node.tone)}">${line}${renderChildren(node.children)}</li>`
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
    `<details class="orch-activity" data-state-id="orch:${escapeHtml(orchestrator.label)}">`,
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
 * Fuente del JS que conserva el estado `open`/`closed` de los `<details>` entre
 * repintados del polling.
 *
 * Se exporta para poder probarla sin navegador: `snapshotDetailsState()` lee lo
 * que el usuario abrió y `restoreDetailsState()` lo reaplica tras sustituir el
 * `innerHTML`. Sin esto el historial se colapsaba solo cada 2.5 s.
 */
export function renderDetailsStateScript(): string {
  return [
    "  var detailsOpen = Object.create(null);",
    "  function detailsNodes() {",
    '    return document.querySelectorAll("details[data-state-id]");',
    "  }",
    "  function snapshotDetailsState() {",
    "    var nodes = detailsNodes();",
    "    for (var i = 0; i < nodes.length; i++) {",
    '      var id = nodes[i].getAttribute("data-state-id");',
    "      if (!id) continue;",
    '      if (nodes[i].hasAttribute("open")) detailsOpen[id] = true;',
    "      else delete detailsOpen[id];",
    "    }",
    "  }",
    "  function restoreDetailsState() {",
    "    var nodes = detailsNodes();",
    "    for (var i = 0; i < nodes.length; i++) {",
    '      var id = nodes[i].getAttribute("data-state-id");',
    "      if (!id) continue;",
    '      if (detailsOpen[id]) nodes[i].setAttribute("open", "");',
    '      else nodes[i].removeAttribute("open");',
    "    }",
    "  }",
  ].join("\n")
}

/**
 * JS embebido. Recibe el estado ya formateado por el view-model, así que solo
 * compone la maqueta y escapa cada valor interpolado. Tolera estados v3 (sin
 * `title`/`model`/`subsessions`): los fallbacks evitan que la página rompa si el
 * backend va un paso por detrás.
 */
export function renderClientScript(refreshMs: number = DASHBOARD_REFRESH_MS): string {
  return [
    "(function () {",
    '  "use strict";',
    `  var REFRESH = ${Math.max(500, Math.floor(refreshMs))};`,
    renderDetailsStateScript(),
    "  function esc(value) {",
    '    return String(value === null || value === undefined ? "" : value)',
    '      .replace(/&/g, "&amp;")',
    '      .replace(/</g, "&lt;")',
    '      .replace(/>/g, "&gt;")',
    '      .replace(/"/g, "&quot;")',
    "      .replace(/'/g, '&#39;');",
    "  }",
    "  function chip(agent, model) {",
    '    var name = String(agent === null || agent === undefined ? "" : agent).trim() || "—";',
    '    var suffix = String(model === null || model === undefined ? "" : model).trim();',
    '    return suffix ? name + " · " + suffix : name;',
    "  }",
    "  function shortTime(iso) {",
    '    if (!iso) return "—";',
    '    var cleaned = String(iso).replace("T", " ").replace("Z", "").slice(0, 19);',
    '    return cleaned || "—";',
    "  }",
    "  function profileBadge(value) {",
    '    var text = String(value === null || value === undefined ? "" : value).trim();',
    '    return text ? \' <span class="profile-badge">perfil: \' + esc(text) + "</span>" : "";',
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
    "  function nodeLine(parts) {",
    "    var icon = parts.running",
    '      ? \'<span class="spinner pulse" aria-hidden="true"></span>\'',
    '      : \'<span class="glyph" aria-hidden="true">\' + esc(parts.glyph) + "</span>";',
    '    var html = \'<div class="node-line">\' + icon +',
    '      \'<span class="node-title">\' + esc(parts.title) + "</span>" +',
    '      \'<span class="chip">\' + esc(parts.chip) + "</span>";',
    "    if (parts.qaLevel) html += ' <span class=\"qa-badge\">' + esc(parts.qaLevel) + \"</span>\";",
    "    if (parts.statusText) {",
    '      html += \'<span class="status-text tone-\' + esc(parts.tone) + \'">\' + esc(parts.statusText) + "</span>";',
    "    }",
    '    if (parts.time) html += \'<span class="dim node-time">\' + esc(parts.time) + "</span>";',
    '    return html + "</div>";',
    "  }",
    "  function sessionNode(node) {",
    "    var line = nodeLine({",
    "      glyph: node.glyph,",
    '      running: node.status === "running",',
    "      title: node.title,",
    "      chip: chip(node.agent, node.model),",
    "      statusText: node.statusText,",
    "      tone: node.tone",
    "    });",
    '    return \'<li class="node node-session tone-\' + esc(node.tone) + \'">\' + line +',
    "      children(node.children) + \"</li>\";",
    "  }",
    "  function children(nodes) {",
    "    if (!nodes || nodes.length === 0) return \"\";",
    '    return \'<ul class="children">\' + nodes.map(sessionNode).join("") + "</ul>";',
    "  }",
    "  function taskNode(run, task, showTokens) {",
    '    var key = run.runId + ":" + task.taskId;',
    "    var html = '<li class=\"node node-task tone-' + esc(task.tone) + '\">' + nodeLine({",
    "      glyph: task.glyph,",
    "      running: task.isRunning,",
    "      title: task.title || task.taskId,",
    "      chip: chip(task.agent, task.model),",
    "      qaLevel: task.qaLevel,",
    "      statusText: task.statusText,",
    "      tone: task.tone,",
    "      time: task.time",
    "    });",
    "    html += '<details class=\"node-detail\" data-state-id=\"task:' + esc(key) + '\">' +",
    '      "<summary>detalle</summary>" +',
    '      \'<p class="node-meta mono">\' + esc(task.taskId) + " · rama " + esc(task.branch) + "</p>" +',
    '      \'<p class="node-summary">\' + esc(task.summary || "—") + "</p></details>";',
    "    if (showTokens && (task.tokens || task.cost)) {",
    "      var extra = [task.tokens, task.cost].filter(Boolean).join(\" · \");",
    "      html += '<details class=\"node-tokens\" data-state-id=\"tok:' + esc(key) + '\">' +",
    '        "<summary>tokens / costo</summary><span class=\\"mono\\">" + esc(extra) + "</span></details>";',
    "    }",
    "    if (task.isRunning) {",
    "      html += '<details class=\"activity-row\" data-state-id=\"act:' + esc(key) + '\">' +",
    '        "<summary>actividad (" + esc((task.activity || []).length) + ")</summary>" +',
    '        activityList(task.activity || [], "sin actividad registrada") + "</details>";',
    "    }",
    "    return html + children(task.subsessions) + \"</li>\";",
    "  }",
    "  function orchestratorActivity(orchestrator) {",
    "    if (!orchestrator) return \"\";",
    "    return '<details class=\"orch-activity\" data-state-id=\"orch:' + esc(orchestrator.label) + '\">' +",
    '      \'<summary>Actividad del \' + esc(orchestrator.label) + \' (<span class="dim">\' +',
    '      esc((orchestrator.activity || []).length) + \'</span>)</summary>\' +',
    '      activityList(orchestrator.activity || [], "sin actividad registrada") + "</details>";',
    "  }",
    "  function tree(run, showTokens) {",
    "    var orchestrator = run.orchestrator;",
    "    var label = orchestrator ? orchestrator.label : \"orquestador\";",
    "    var items = run.tasks.map(function (task) { return taskNode(run, task, showTokens); });",
    "    var nested = orchestrator && orchestrator.subsessions ? orchestrator.subsessions : [];",
    "    items = items.concat(nested.map(sessionNode));",
    "    var html = '<li class=\"node node-orch\">' + nodeLine({",
    '      glyph: "🧭",',
    "      title: label,",
    "      chip: chip((orchestrator && orchestrator.agent) || label, orchestrator && orchestrator.model),",
    '      statusText: "",',
    "      tone: \"pending\",",
    "      time: run.duration",
    "    }) + orchestratorActivity(orchestrator);",
    "    if (items.length > 0) {",
    '      html += \'<ul class="children">\' + items.join("") + "</ul>";',
    "    }",
    '    return \'<ul class="tree">\' + html + "</li></ul>";',
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
    "  function spec(run) {",
    "    return '<details class=\"run-spec\" data-state-id=\"spec:' + esc(run.runId) + '\">' +",
    '      "<summary>objetivo completo</summary>" +',
    '      \'<p class="run-objective">\' + esc(run.objective || "(sin objetivo)") + "</p>" +',
    '      \'<p class="run-meta"><span class="mono run-id">\' + esc(run.runId) +',
    '      \'</span><span class="dim">base \' + esc(run.baseBranch || "—") + \'</span>\' +',
    '      \'<span class="dim">inicio \' + esc(shortTime(run.startedAt)) + \'</span>\' +',
    '      \'<span class="dim">duración \' + esc(run.duration) + "</span></p></details>";',
    "  }",
    "  function title(run) {",
    '    return \'<span class="glyph" aria-hidden="true">\' + esc(run.glyph) + "</span> " +',
    '      \'<span class="node-title">\' + esc(run.title || run.objective || "(sin título)") + "</span> " +',
    "      profileBadge(run.modelProfile) +",
    '      \'<span class="status-text tone-\' + esc(run.tone) + \'">\' + esc(run.statusText) + "</span> " +',
    '      \'<span class="progress-pill">\' + esc(run.progressLabel) + "</span>";',
    "  }",
    "  function runBody(run, showTokens) {",
    "    return spec(run) + progress(run) +",
    '      (run.error ? \'<p class="run-error">\' + esc(run.error) + "</p>" : "") +',
    "      tree(run, showTokens);",
    "  }",
    "  function activeCard(run, showTokens) {",
    '    return \'<article class="run-card active tone-\' + esc(run.tone) + \'"><h3 class="run-title">\' + title(run) +',
    '      \'</h3>\' + runBody(run, showTokens) + "</article>";',
    "  }",
    "  function historyCard(run, showTokens) {",
    "    var label = run.compact || run.objective || run.runId;",
    '    return \'<details class="run-card tone-\' + esc(run.tone) + \'" data-state-id="run:\' + esc(run.runId) + \'">\' +',
    '      \'<summary class="run-summary">\' + esc(label) + profileBadge(run.modelProfile) + "</summary>" +',
    "      runBody(run, showTokens) + \"</details>\";",
    "  }",
    "  function paint(state) {",
    "    snapshotDetailsState();",
    '    var activeEl = document.getElementById("active");',
    '    if (activeEl) activeEl.innerHTML = state.active',
    "      ? activeCard(state.active, state.showTokens)",
    '      : \'<p class="empty">No hay orquestaciones en curso. Cuando lances una con <span class="mono">aiapaec_orchestrate</span> aparecerá aquí.</p>\';',
    '    var countEl = document.getElementById("history-count");',
    "    if (countEl) countEl.textContent = String(state.history.length);",
    '    var listEl = document.getElementById("history-list");',
    "    if (listEl) listEl.innerHTML = state.history.length",
    '      ? state.history.map(function (run) { return historyCard(run, state.showTokens); }).join("")',
    '      : \'<p class="empty">Sin runs anteriores todavía.</p>\';',
    "    restoreDetailsState();",
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
    '    return fetch("/api/state", { cache: "no-store" })',
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
.top h1 { margin: 0; font-size: 1.3rem; font-weight: 650; letter-spacing: -0.01em; }
.sub { margin: 0.25rem 0 0; color: var(--dim); font-size: 0.82rem; }
.url { color: var(--accent); }
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
.panel h2 { margin: 0 0 0.6rem; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.09em; color: var(--dim); font-weight: 600; }
.run-card.tone-ok { border-left: 3px solid var(--ok); padding-left: 0.7rem; }
.run-card.tone-failed { border-left: 3px solid var(--failed); padding-left: 0.7rem; }
.run-card.tone-run { border-left: 3px solid var(--run); padding-left: 0.7rem; }
.run-card.tone-aborted { border-left: 3px solid var(--aborted); padding-left: 0.7rem; }
.run-title { margin: 0 0 0.35rem; font-size: 1.05rem; font-weight: 600; display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.4rem; }
.run-summary { cursor: pointer; font-size: 0.92rem; padding: 0.15rem 0; color: var(--fg); }
.run-summary::marker { color: var(--dim); }
.node-title { font-weight: 650; }
.run-objective { margin: 0.3rem 0; font-size: 0.88rem; color: var(--fg); }
.run-meta { display: flex; flex-wrap: wrap; gap: 0.35rem 0.7rem; color: var(--dim); font-size: 0.78rem; margin: 0.2rem 0 0; word-break: break-word; }
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
.profile-badge {
  display: inline-block;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0 0.45rem;
  font-size: 0.72rem;
  color: var(--dim);
  white-space: nowrap;
  vertical-align: 0.05em;
}
.tone-run { color: var(--run); }
.tone-ok { color: var(--ok); }
.tone-failed { color: var(--failed); }
.tone-skipped { color: var(--skipped); }
.tone-warn { color: var(--warn); }
.tone-aborted { color: var(--aborted); }
.tone-pending { color: var(--dim); }
.progress { display: flex; align-items: center; gap: 0.6rem; margin: 0.3rem 0 0.7rem; font-size: 0.82rem; }
.progress-track { flex: 1; max-width: 320px; height: 7px; border-radius: 999px; background: var(--panel-soft); border: 1px solid var(--border); overflow: hidden; }
.progress-fill { height: 100%; background: linear-gradient(90deg, var(--accent), var(--ok)); }
.progress-label { font-variant-numeric: tabular-nums; font-weight: 650; }
.progress-pill { border: 1px solid var(--border); border-radius: 999px; padding: 0.05rem 0.5rem; font-size: 0.78rem; color: var(--dim); font-variant-numeric: tabular-nums; }
.tree, .children { list-style: none; margin: 0; padding: 0; }
.tree { border-top: 1px solid var(--border); padding-top: 0.55rem; }
.children { margin-left: 0.5rem; padding-left: 0.95rem; border-left: 1px solid var(--border); }
.node { position: relative; }
.children > .node { padding-left: 0.7rem; }
.children > .node::before {
  content: "";
  position: absolute;
  left: -0.95rem;
  top: 0.85rem;
  width: 0.62rem;
  border-top: 1px solid var(--border);
}
.node-line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.4rem; padding: 0.22rem 0; font-size: 0.88rem; }
.node-orch > .node-line .node-title { text-transform: lowercase; letter-spacing: 0.01em; color: var(--accent); }
.chip {
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0 0.45rem;
  font-size: 0.72rem;
  color: var(--dim);
  white-space: nowrap;
}
.node-time { font-size: 0.76rem; }
.run-spec, .node-detail, .node-tokens, .activity-row, .orch-activity { margin: 0.1rem 0 0.35rem 0.7rem; font-size: 0.8rem; }
.run-spec { margin-left: 0; }
details > summary { cursor: pointer; color: var(--dim); font-size: 0.78rem; }
details > summary::marker { color: var(--dim); }
details[open] > summary { margin-bottom: 0.25rem; }
.node-meta, .node-summary { margin: 0.15rem 0; }
.node-summary { color: var(--fg); overflow-wrap: anywhere; }
.empty { color: var(--dim); font-size: 0.88rem; padding: 0.4rem 0; }
.acts { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.18rem; font-size: 0.8rem; }
.act-item { display: flex; gap: 0.5rem; align-items: baseline; min-width: 0; }
.act-tool { color: var(--accent); white-space: nowrap; }
.act-summary { color: var(--fg); overflow-wrap: anywhere; }
.act-ago { white-space: nowrap; }
.act-empty { margin: 0; padding: 0.05rem 0; color: var(--dim); font-size: 0.78rem; font-style: italic; }
.history > summary { cursor: pointer; font-size: 0.9rem; color: var(--dim); font-weight: 600; }
.history[open] > summary { margin-bottom: 0.9rem; }
#history-list { display: grid; gap: 0.7rem; }
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
  .node-title { word-break: break-word; }
  .node-line { gap: 0.3rem; }
  .top { padding-top: 1.2rem; }
}
`
