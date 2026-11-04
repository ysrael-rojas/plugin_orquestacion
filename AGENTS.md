# AGENTS.md — plugin de orquestación para OpenCode

Plugin TypeScript ESM para OpenCode V2 (arquitectura "Aiapaec"). OpenCode carga `src/index.ts` directamente: **no hay build de producción** y `tsconfig` solo cubre `src/`.

## Agent skills

### Issue tracker

Las specs y los tickets viven como markdown local en `.scratch/<feature>/` (no GitHub Issues). Ver `docs/agents/issue-tracker.md`.

### Triage labels

Vocabulario por defecto (rol = valor): el estado va en `Status:` y la categoría en `Category:` del ticket. Ver `docs/agents/triage-labels.md`.

### Domain docs

Layout single-context: `GLOSSARY.md` + `docs/adr/` en la raíz, creados de forma perezosa por `domain-modeling`. Ver `docs/agents/domain.md`.

## Comandos

- `pnpm test` — lint (Biome) + typecheck + bundle de pruebas con esbuild + `node --test` (92 pruebas, ~4 s). No necesita OpenCode corriendo.
- `pnpm run lint` — solo Biome (`biome.json`; `noExplicitAny`, `noNonNullAssertion` y `useOptionalChain` desactivadas por estilo del repo).
- `pnpm run typecheck` — solo `tsc --noEmit` (no cubre `scripts/`).
- `pnpm run agents:sync` — regenera `config/agents.json` desde `src/agents.ts`.
- `pnpm run agents:install` — además fusiona los agentes en `~/.config/opencode/opencode.json` (o `$OPENCODE_CONFIG`).
- `pnpm run skills:lock` — regenera `skills-lock.json` tras re-copiar skills del upstream (lock v1 del CLI `vercel-labs/skills`; ver `THIRD-PARTY-NOTICES.md`).
- Una sola prueba (bundlear y filtrar):
  ```powershell
  pnpm exec esbuild scripts/smoke.ts --bundle --platform=node --format=esm --outfile=.tmp/smoke.mjs; node --test --test-name-pattern "runner" .tmp/smoke.mjs
  ```
- No hay linter configurado.

## Arquitectura (lo no obvio)

- `src/index.ts` es el único entrypoint (`Plugin.define`, id `plugin-de-orquestacion-para-opencode`). Registra los namespaces `aiapaec` (orquestación) y `gentle` (solo `engram_status`), el comando `/engram-status`, y las skills del catálogo `.agents/skills/` vía `ctx.skill.transform` -> `SkillEditor.add`.
- Flujo: `aiapaec_orchestrate` inicia un run en segundo plano y devuelve `runId`; `runner.ts` ejecuta oleadas (por `dependsOn`) con `Promise.allSettled`; cada tarea crea una sesión hija con `parentID`; el avance se persiste en `ctx.storage` (`runs/<runId>`) y se consulta con `aiapaec_run_status`.
- Los agentes **no se pueden crear desde el plugin** (la API V2 no lo permite): viven en `opencode.json` → `agents`. `config/agents.json` es **generado** desde `src/agents.ts`; no editarlo a mano.
- **Catálogo de skills**: la fuente única de verdad está en `.agents/skills/` (hoy **16 skills** vendorizadas de `mattpocock/skills`: `tdd`, `code-review`, `diagnosing-bugs`, `research`, `domain-modeling`, `codebase-design`, `grill-with-docs`, `to-spec`, `to-tickets`, `implement-spec`, `retro`, `triage`, `setup-matt-pocock-skills`, `grilling`, `grill-me` y `writing-for-agents`). Cada subdirectorio es el ID de la skill y contiene un `SKILL.md` con frontmatter (`name`, `description`, `disable-model-invocation`) más los documentos de soporte que ese `SKILL.md` referencia y un `agents/openai.yaml` (metadata upstream que el plugin no lee). Al cargar el plugin se registran automáticamente; `disable-model-invocation: true` se traduce a `autoinvoke: false` (solo invocable explícitamente: `grill-me`, `grill-with-docs`, `to-spec`, `to-tickets`, `implement-spec`, `retro`, `triage` y `setup-matt-pocock-skills`). Se puede desactivar con la opción `skills: false`.
- **Cadena de workflow (skills de ingeniería)**: `grill-with-docs` → `to-spec` → `to-tickets` → `implement-spec` → `retro`. Todas son explícitas: son puntos de control humanos, el agente no las dispara solo. `grill-with-docs` es un router (`grilling` + `domain-modeling`); `retro` depende de `writing-for-agents`. `to-spec`, `to-tickets` e `implement-spec` asumen un tracker configurado por `setup-matt-pocock-skills` (una vez por repo): escribe `docs/agents/issue-tracker.md`, el vocabulario de triage y el layout de docs de dominio. Sin esa configuración esas tres skills se detienen pidiendo ejecutar el setup.
- **`implement-spec` se traduce a `aiapaec_orchestrate`**: el SKILL.md upstream describe rama de integración, un worktree por ticket, frontera del grafo y `code-review` final — el mismo problema que resuelve el runner. Al ejecutarlo aquí, las aristas de bloqueo de cada ticket son `dependsOn`, cada ticket es una tarea con `worktree: true`, el merge a la rama de integración lo aprueba el humano y la validación final es una tarea `qa` con `skills: ["code-review"]`. No se lanzan subagentes sueltos: se pierde el run, el dashboard y `aiapaec_run_status`.
- **Procedencia de las skills**: son copias literales de `https://github.com/mattpocock/skills` (MIT, © 2026 Matt Pocock) al commit `4ae2317` (2026-10-31), aplanadas desde `skills/engineering/` y `skills/productivity/`. No se editan a mano: se re-copian del upstream. Licencia, commit y mapeo de frontmatter → `autoinvoke` en `.agents/skills/THIRD-PARTY-NOTICES.md`.
- Si cambias el nombre de una herramienta, actualiza también sus referencias en los prompts de `src/agents.ts` y regenera con `pnpm run agents:sync`.
- Tareas con `worktree: true` corren en un **git worktree aislado** (`<padre>/worktrees/<runId>-<taskId>`): la sesión hija usa `location.directory` = worktree y los dependientes reciben esa ruta en el prompt. `cleanupWorktrees` borra los de tareas exitosas; los fallidos se conservan.
- **planDocs**: cada orquestación genera un documento de plan vivo en `docs/plans/<runId>.md` del repo principal. Contiene la spec inicial (con `title` corto del run en el frontmatter y una columna **Título** por tarea, con fallback a `—`), el avance tras cada oleada y el estado final (o `aborted`). La opción de plugin `planDocs` es `true` por defecto (`docs/plans/`), `false` lo desactiva y un `string` cambia la carpeta tras sanitizar que sea una subcarpeta relativa. La escritura inicial es *fail-hard*: aborta el run antes de crear sesiones si falla; las actualizaciones por oleada son *best-effort* y sus advertencias aparecen en `aiapaec_run_status` bajo **Advertencias del documento de plan**. `PlanDocsState.inFlight` guarda objetos `InFlightTask` (no IDs): `taskStatusForPlan` compara `entry.taskId`. `aiapaec_run_status` muestra la línea `Plan: docs/plans/<runId>.md`.
- Parte TUI en `src/tui.ts` (export `./tui`): comando `/aiapaec` y de paleta; usa diálogos del TUI (sin JSX/OpenTUI) y agrupa sesiones hijas por `runId` desde su metadata.
- **Capa de datos del árbol (contrato v4)**: `TaskSpec.title?`, `RunRecord.title?`, `TaskResult.title?` y `TaskResult.model?`; `shortTitle` (primera línea, 60 caracteres) y `modelLabel` (`providerID/modelID#variant`) viven en `src/types.ts` porque los comparten runner, tools y dashboard. `RunRecord.inFlight` guarda objetos `InFlightTask` (`{ taskId, agent, model?, branch?, startedAt?, title? }`); `inFlightEntries` normaliza también el historial v3 (`string[]`). El runner resuelve el **modelo esperado** (`task.model` o `ctx.agent.get({ agentID }).data.model`) al crear la sesión y persiste el **modelo real** (`message.model` del assistant) al cerrar; un agente sin modelo se muestra como `default`. El título declarado manda y el fallback es la primera línea del `objective`. Nota de tipos: `InFlightTask` es `string & InFlightTaskFields` **solo** para que el view-model v3 (`dashboard-view.ts`, pendiente de la tarea de UI) siga compilando leyendo IDs; en runtime siempre es un objeto — constrúyelo con `toInFlightTask`, nunca asignes un string.
- **Dashboard web local**: `src/dashboard.ts` (servidor HTTP con `node:http`, sin dependencias nuevas; singleton, escucha SOLO en `127.0.0.1`, puerto de `dashboardPort` — default 4780, `0` desactivado). Con `EADDRINUSE` consulta `GET /api/health` del ocupante: instancia viva → cede con `console.warn`; huérfana → reintenta una vez. Endpoints `GET /` (página), `GET /api/state` (contrato versionado `DASHBOARD_STATE_VERSION = 4`) y `GET /api/health`; lee `recentRuns`/`getRun` de `ctx.storage`, no crea archivos. El view-model puro vive en `src/dashboard-view.ts` (progreso `cerradas/total`, filas por tarea con el badge `qaLevel`, columna tokens/costo condicional, `escapeHtml`; conserva su propia versión **v3**, porque `dashboard.ts` lo decora) y la página en `src/dashboard-html.ts` (CSS propio dark, spinner `pulse` 2 s con `prefers-reduced-motion`, polling 2500 ms). **Contrato v4 (árbol de ejecución)**: `buildTreeState(runs, now, feed)` en `src/dashboard.ts` parte del view-model v3 y decora cada nodo con `title`, `model` (`DEFAULT_MODEL_LABEL` = `"default"` si el agente no declara modelo), `inFlight` como **objetos** (`{ taskId, agent, model, branch?, startedAt? }`) y `subsessions` anidadas (`{ id, title, agent, model, role, taskId?, activity, subsessions }`, profundidad máxima `MAX_SESSION_DEPTH`). Al view-model se le pasan los runs con `inFlight: []`: las tareas en vuelo las añade `buildTreeState` (`pendingTask`), así el histórico v3 sigue leyéndose. Todo el wiring de `src/index.ts` es try/catch best-effort y el `server.close()` va en el cleanup del setup. `aiapaec_orchestrate`/`aiapaec_run_status` muestran `Dashboard: http://127.0.0.1:<puerto>`.
- `scripts/smoke.ts` prueba con un `PluginCtx` mockeado (sin red). Si cambias el uso de la API, valida las formas contra `~/.config/opencode/node_modules/@opencode/plugin`.
- **Feed de actividad en vivo**: `src/activity.ts` (`ActivityFeed`) se suscribe best-effort a `ctx.event.subscribe()` (`V2Event`: `session.tool.input.started` da el nombre del tool y `session.tool.called` el `input`). `register(sessionID, label, { runId, taskId, role, agent, model, title, parentID })` / `unregister` / `unregisterRun` los llaman las tools (`RunControl`): el orquestador al iniciar el run y cada hija en `onTaskStart` (el runner expone `sessionID`, `agent`, `model` esperado, `title` y `startedAt` en ese callback). **Cascada**: al llegar un `session.created` cuyo `parentID` ya está observado, la hija se registra sola con rol `sub` heredando run/tarea/agente y tomando modelo y título del evento (`metadata.title` del runner manda sobre el título de la sesión); el registro nunca degrada un rol ni pisa el título existente. Guarda un ring buffer **en RAM de 8** `{ tool, summary, at }` por sesión con el primer argumento relevante truncado a **80** caracteres (nunca salidas completas) y se vacía al cerrar tarea/run. `getActivity`/`getLast`/`activityForTask`/`orchestratorActivity` alimentan el dashboard y la línea `última acción: <tool> → <summary> (hace Xs)` de `aiapaec_run_status`; `sessionInfo`/`sessionsForRun`/`childrenOf` (con la actividad propia de cada sesión) alimentan el árbol v4. Un evento roto no corta el bucle y las sesiones no registradas (sin padre observado) se ignoran.
- **Niveles de QA (`qaLevel`)**: `TaskSpec.qaLevel` (`"L1" | "L2" | "L3"`, default `L2`) declara la profundidad de la validación de las tareas `qa`: `L1` smoke (solo `pnpm test` con evidencia del comando), `L2` estándar (validación contra el spec del contrato con evidencia: comando + salida y `archivo:línea` en desviaciones) y `L3` forense (L2 + supuestos técnicos contrastados con fuentes reales, p. ej. los `.d.ts` del SDK). `normalizeQaLevels` y `resolveQaLevel` viven en `src/contracts.ts`: un valor inválido **no aborta el plan**, cae a `L2` con aviso en la respuesta de `aiapaec_orchestrate` (`metadata.qaLevelWarnings`). `buildTaskPrompt` inyecta la definición operativa solo en tareas de agente `qa`. El runner no resuelve el nivel: la tool adjunta `TaskResult.qaLevel` (helper `withQaLevels` en `src/tools.ts`) antes de persistir, así que se ve como sufijo `qa · L2` en `aiapaec_run_status` y como badge `L2` junto al agente en el dashboard. `/api/state` sube a **v4** (el `qaLevel` por tarea entró en v3; v4 añade el árbol: `title`, `model`, `inFlight` objetos y `subsessions`).
- **Perfiles de modelos (`modelProfiles` / `modelProfile`)**: un perfil es `Record<agente, modelo>` (`orquestador`, `contexto`, `explorador`, `coder`, `qa`, `deployer`), con cada modelo en formato `providerID/modelID`. `BUILT_IN_MODEL_PROFILES`, `resolveModelProfiles`, `normalizeModelProfiles`, `profileModel` y `splitModelRef` viven en `src/types.ts` (puro, sin ciclos con `index.ts`); el setup fusiona built-in + usuario (`resolveModelProfiles`: mismo nombre → sobrescribe **agente a agente**, nombres nuevos → se añaden) y valida la opción `modelProfile` (si no existe, `console.warn` y se ignora). En `aiapaec_orchestrate`, el `modelProfile` del run manda sobre el default y un perfil inexistente **no aborta**: se avisa en la respuesta (`## ⚠️ Avisos de \`modelProfile\``, `metadata.modelProfileWarnings`) y el run sigue sin perfil. Precedencia del modelo por tarea: `task.model` > `perfil[agente]` > modelo del agente en `opencode.json`. El perfil efectivo se persiste en `RunRecord.modelProfile`, se muestra como `**Perfil:** <nombre>` en `aiapaec_run_status` (y en la respuesta de `orchestrate`) y va en el frontmatter del plan (`modelProfile: <nombre>`). El modelo del **orquestador** del perfil por defecto se aplica vía `ctx.agent.transform` (mock del `AgentEditor`: `list/get/update`), best-effort y solo para sesiones nuevas; su `dispose` va en el cleanup del setup.

## Quirks de la API V2 (fáciles de romper)

- `ctx.tool.transform`: `input` es JSON Schema plano; `execute(input, context)`; `context.sessionID` es la sesión orquestadora (se usa como `parentID`).
- `ctx.session.create` acepta `agent`, `model` (`{ providerID, id }`), `permissions` y `parentID`.
- Permisos de sesión `[{ action, resource, effect }]`: se evalúan después de los del agente y gana la última coincidencia (orden importa: `deny "*"` antes de los `allow`).
- Estado MCP real: `{ data: [{ name, status: { status: "connected" } }] }` — la etiqueta está en `status.status`, no en `type`.
- `ctx.session.remove` existe en runtime aunque el tipo `SessionDomain` no lo liste (llamarlo con optional chaining).

## Operación y gotchas

- **Los modelos de los agentes deben ser IDs reales**, no nombres visibles: `nan/GLM-5.3-Flash` (display) no existe; el ID es `nan/glm5.3-flash`. Compruébalo con `opencode models`. Un modelo inválido crea la sesión hija y la cierra al instante: antes se veía como `unconfirmed` sin causa; ahora la tarea falla con "sin ningún mensaje del assistant".
- `taskTimeoutMs` tiene default de **20 min** (`0` lo desactiva). Antes no había límite y una tarea colgada congelaba la oleada. El avance se persiste **por tarea**, no al cerrar la oleada.
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

- Opciones: `baseBranch` (default `dev`), `cleanupSessions` (default `false`), `skills` (default `true`), `modelProfiles` y `modelProfile`.
- `skills: false` desactiva el registro automático de skills del catálogo `.agents/skills/`.
- **Perfiles de modelos**: `modelProfiles` define perfiles propios (`Record<perfil, Record<agente, modelo>>`) que se fusionan con los built-in `high`, `balanced`, `low` y `free` (un perfil con el mismo nombre sobrescribe agente a agente). `modelProfile` elige el default del plugin; el run puede sobreescribirlo con el parámetro `modelProfile` de `aiapaec_orchestrate`. Sin `modelProfile`, no hay perfil y cada agente usa su modelo de `opencode.json`. El default fija además el modelo del `orquestador` vía `ctx.agent.transform`.
- Se carga desde `opencode.json` global: `plugins: ["C:/dev/plugin_orquestacion"]` + bloque `agents`.

```jsonc
{
  "plugins": [
    {
      "package": "C:/dev/plugin_orquestacion",
      "options": {
        "baseBranch": "dev",
        "modelProfile": "balanced",
        "modelProfiles": {
          // Sobrescribe el built-in "balanced" para coder y qa.
          "balanced": { "coder": "opencode-go/kimi-k3.1-pro", "qa": "opencode-go/glm-5.3" },
          // Perfil propio, seleccionable por run con modelProfile: "barato".
          "barato": { "orquestador": "opencode-go/glm-5.3-flash", "coder": "opencode-go/mimo-v2.6-flash" }
        }
      }
    }
  ]
}
```
