# AGENTS.md — plugin de orquestación para OpenCode

Plugin TypeScript ESM para OpenCode V2 (arquitectura "Aiapaec"). OpenCode carga `src/index.ts` directamente: **no hay build de producción** y `tsconfig` solo cubre `src/`.

## Comandos

- `pnpm test` — lint (Biome) + typecheck + bundle de pruebas con esbuild + `node --test` (40 pruebas, ~1 s). No necesita OpenCode corriendo.
- `pnpm run lint` — solo Biome (`biome.json`; `noExplicitAny`, `noNonNullAssertion` y `useOptionalChain` desactivadas por estilo del repo).
- `pnpm run typecheck` — solo `tsc --noEmit` (no cubre `scripts/`).
- `pnpm run agents:sync` — regenera `config/agents.json` desde `src/agents.ts`.
- `pnpm run agents:install` — además fusiona los agentes en `~/.config/opencode/opencode.json` (o `$OPENCODE_CONFIG`).
- Una sola prueba (bundlear y filtrar):
  ```powershell
  pnpm exec esbuild scripts/smoke.ts --bundle --platform=node --format=esm --outfile=.tmp/smoke.mjs; node --test --test-name-pattern "runner" .tmp/smoke.mjs
  ```
- No hay linter configurado.

## Arquitectura (lo no obvio)

- `src/index.ts` es el único entrypoint (`Plugin.define`, id `plugin-de-orquestacion-para-opencode`). Registra los namespaces `aiapaec` (orquestación) y `gentle` (solo `engram_status`), el comando `/engram-status`, y las skills del catálogo `.agents/skills/` vía `ctx.skill.transform` -> `SkillEditor.add`.
- Flujo: `aiapaec_orchestrate` inicia un run en segundo plano y devuelve `runId`; `runner.ts` ejecuta oleadas (por `dependsOn`) con `Promise.allSettled`; cada tarea crea una sesión hija con `parentID`; el avance se persiste en `ctx.storage` (`runs/<runId>`) y se consulta con `aiapaec_run_status`.
- Los agentes **no se pueden crear desde el plugin** (la API V2 no lo permite): viven en `opencode.json` → `agents`. `config/agents.json` es **generado** desde `src/agents.ts`; no editarlo a mano.
- **Catálogo de skills**: la fuente única de verdad está en `.agents/skills/` (hoy `grilling` y `grill-me`). Cada subdirectorio es el ID de la skill y contiene un `SKILL.md` con frontmatter (`name`, `description`, `disable-model-invocation`). Al cargar el plugin se registran automáticamente; `disable-model-invocation: true` se traduce a `autoinvoke: false` (solo invocable explícitamente). Se puede desactivar con la opción `skills: false`.
- Si cambias el nombre de una herramienta, actualiza también sus referencias en los prompts de `src/agents.ts` y regenera con `pnpm run agents:sync`.
- Tareas con `worktree: true` corren en un **git worktree aislado** (`<padre>/worktrees/<runId>-<taskId>`): la sesión hija usa `location.directory` = worktree y los dependientes reciben esa ruta en el prompt. `cleanupWorktrees` borra los de tareas exitosas; los fallidos se conservan.
- **planDocs**: cada orquestación genera un documento de plan vivo en `docs/plans/<runId>.md` del repo principal. Contiene la spec inicial, el avance tras cada oleada y el estado final (o `aborted`). La opción de plugin `planDocs` es `true` por defecto (`docs/plans/`), `false` lo desactiva y un `string` cambia la carpeta tras sanitizar que sea una subcarpeta relativa. La escritura inicial es *fail-hard*: aborta el run antes de crear sesiones si falla; las actualizaciones por oleada son *best-effort* y sus advertencias aparecen en `aiapaec_run_status` bajo **Advertencias del documento de plan**. `aiapaec_run_status` muestra la línea `Plan: docs/plans/<runId>.md`.
- Parte TUI en `src/tui.ts` (export `./tui`): comando `/aiapaec` y de paleta; usa diálogos del TUI (sin JSX/OpenTUI) y agrupa sesiones hijas por `runId` desde su metadata.
- **Dashboard web local**: `src/dashboard.ts` (servidor HTTP con `node:http`, sin dependencias nuevas; singleton, escucha SOLO en `127.0.0.1`, puerto de `dashboardPort` — default 4780, `0` desactivado). Con `EADDRINUSE` consulta `GET /api/health` del ocupante: instancia viva → cede con `console.warn`; huérfana → reintenta una vez. Endpoints `GET /` (página), `GET /api/state` (contrato versionado `DASHBOARD_STATE_VERSION = 2`) y `GET /api/health`; lee `recentRuns`/`getRun` de `ctx.storage`, no crea archivos. El view-model puro vive en `src/dashboard-view.ts` (progreso `cerradas/total`, filas por tarea, columna tokens/costo condicional, `escapeHtml`) y la página en `src/dashboard-html.ts` (CSS propio dark, spinner `pulse` 2 s con `prefers-reduced-motion`, polling 2500 ms). Todo el wiring de `src/index.ts` es try/catch best-effort y el `server.close()` va en el cleanup del setup. `aiapaec_orchestrate`/`aiapaec_run_status` muestran `Dashboard: http://127.0.0.1:<puerto>`.
- `scripts/smoke.ts` prueba con un `PluginCtx` mockeado (sin red). Si cambias el uso de la API, valida las formas contra `~/.config/opencode/node_modules/@opencode/plugin`.
- **Feed de actividad en vivo**: `src/activity.ts` (`ActivityFeed`) se suscribe best-effort a `ctx.event.subscribe()` (`V2Event`: `session.tool.input.started` da el nombre del tool y `session.tool.called` el `input`). `register(sessionID, label, { runId, taskId, role })` / `unregister` / `unregisterRun` los llaman las tools (`RunControl`): el orquestador al iniciar el run y cada hija en `onTaskStart` (el runner expone `sessionID` en ese callback). Guarda un ring buffer **en RAM de 8** `{ tool, summary, at }` por sesión con el primer argumento relevante truncado a **80** caracteres (nunca salidas completas) y se vacía al cerrar tarea/run. `getActivity`/`getLast`/`activityForTask`/`orchestratorActivity` alimentan el dashboard (`/api/state` **v2**: `activity` por tarea en vuelo + `active.orchestrator`) y la línea `última acción: <tool> → <summary> (hace Xs)` de `aiapaec_run_status`. Un evento roto no corta el bucle y las sesiones no registradas se ignoran.

## Quirks de la API V2 (fáciles de romper)

- `ctx.tool.transform`: `input` es JSON Schema plano; `execute(input, context)`; `context.sessionID` es la sesión orquestadora (se usa como `parentID`).
- `ctx.session.create` acepta `agent`, `model` (`{ providerID, id }`), `permissions` y `parentID`.
- Permisos de sesión `[{ action, resource, effect }]`: se evalúan después de los del agente y gana la última coincidencia (orden importa: `deny "*"` antes de los `allow`).
- Estado MCP real: `{ data: [{ name, status: { status: "connected" } }] }` — la etiqueta está en `status.status`, no en `type`.
- `ctx.session.remove` existe en runtime aunque el tipo `SessionDomain` no lo liste (llamarlo con optional chaining).

## Operación y gotchas

- `mem_save` puede fallar con "could not resolve an authoritative OpenCode runtime session" cuando el servicio lleva mucho uptime o hubo recargas de plugins: ejecutar `opencode service restart` y probar en una sesión nueva (ver `docs/incidencias.md`).
- Si un cambio en `src/` no surte efecto en OpenCode, reiniciar el servicio (`opencode service restart`).
- `.engram/config.json` fija el proyecto de memoria en `plugin_orquestacion`; no cambiar `project_name` (historial unificado).
- No renombrar nada relacionado con Engram: herramienta `gentle_engram_status`, comando `/engram-status`, URLs `Gentleman-Programming/engram`.
- `.tmp/` y `.atl/` son artefactos generados (ignorados por git).
- Windows: los warnings LF→CRLF de git son normales.

## Git

- Rama de integración: `dev`. Trabajar en ramas `feat/*` derivadas de `dev`. Nunca push a `main`; el merge a `dev` lo aprueba el humano.
- Commits semánticos (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`).
- La rama base de las tareas orquestadas es `dev` (opción `baseBranch`).

## Configuración del plugin

- Opciones: `baseBranch` (default `dev`), `cleanupSessions` (default `false`), `skills` (default `true`).
- `skills: false` desactiva el registro automático de skills del catálogo `.agents/skills/`.
- Se carga desde `opencode.json` global: `plugins: ["C:/dev/plugin_orquestacion"]` + bloque `agents`.
