# AGENTS.md — plugin de orquestación para OpenCode

Plugin TypeScript ESM para OpenCode V2 (arquitectura "Aiapaec"). OpenCode carga `src/index.ts` directamente: **no hay build de producción** y `tsconfig` solo cubre `src/`.

## Comandos

- `npm test` — lint (Biome) + typecheck + bundle de pruebas con esbuild + `node --test` (10 pruebas, ~1 s). No necesita OpenCode corriendo.
- `npm run lint` — solo Biome (`biome.json`; `noExplicitAny`, `noNonNullAssertion` y `useOptionalChain` desactivadas por estilo del repo).
- `npm run typecheck` — solo `tsc --noEmit` (no cubre `scripts/`).
- `npm run agents:sync` — regenera `config/agents.json` desde `src/agents.ts`.
- `npm run agents:install` — además fusiona los agentes en `~/.config/opencode/opencode.json` (o `$OPENCODE_CONFIG`).
- Una sola prueba (bundlear y filtrar):
  ```powershell
  npx esbuild scripts/smoke.ts --bundle --platform=node --format=esm --outfile=.tmp/smoke.mjs; node --test --test-name-pattern "runner" .tmp/smoke.mjs
  ```
- No hay linter configurado.

## Arquitectura (lo no obvio)

- `src/index.ts` es el único entrypoint (`Plugin.define`, id `plugin-de-orquestacion-para-opencode`). Registra los namespaces `aiapaec` (orquestación) y `gentle` (solo `engram_status`), y el comando `/engram-status`.
- Flujo: `aiapaec_orchestrate` inicia un run en segundo plano y devuelve `runId`; `runner.ts` ejecuta oleadas (por `dependsOn`) con `Promise.allSettled`; cada tarea crea una sesión hija con `parentID`; el avance se persiste en `ctx.storage` (`runs/<runId>`) y se consulta con `aiapaec_run_status`.
- Los agentes **no se pueden crear desde el plugin** (la API V2 no lo permite): viven en `opencode.json` → `agents`. `config/agents.json` es **generado** desde `src/agents.ts`; no editarlo a mano.
- Si cambias el nombre de una herramienta, actualiza también sus referencias en los prompts de `src/agents.ts` y regenera con `npm run agents:sync`.
- Tareas con `worktree: true` corren en un **git worktree aislado** (`<padre>/worktrees/<runId>-<taskId>`): la sesión hija usa `location.directory` = worktree y los dependientes reciben esa ruta en el prompt. `cleanupWorktrees` borra los de tareas exitosas; los fallidos se conservan.
- Parte TUI en `src/tui.ts` (export `./tui`): comando `/aiapaec` y de paleta; usa diálogos del TUI (sin JSX/OpenTUI) y agrupa sesiones hijas por `runId` desde su metadata.
- `scripts/smoke.ts` prueba con un `PluginCtx` mockeado (sin red). Si cambias el uso de la API, valida las formas contra `~/.config/opencode/node_modules/@opencode/plugin`.

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

- Opciones: `baseBranch` (default `dev`), `cleanupSessions` (default `false`).
- Se carga desde `opencode.json` global: `plugins: ["C:/dev/plugin_orquestacion"]` + bloque `agents`.
