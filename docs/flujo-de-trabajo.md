# Flujo de trabajo — Aiapaec

Cómo se usa el plugin de orquestación en el día a día (v0.8.3).

## Piezas

| Pieza | Qué es |
|---|---|
| **Orquestador** | Agente principal con el que hablas: planifica, delega y valida |
| **Subagentes** | `contexto` (memoria Engram), `explorador` (mapa del repo), `coder` (implementa), `qa` (pruebas), `deployer` (push/PR) |
| **`aiapaec_orchestrate`** | Arranca un run en segundo plano y devuelve el `runId` al instante |
| **`aiapaec_run_status`** | Estado del run: tareas en curso, cerradas, reportes y errores |
| **`aiapaec_run_abort`** | Cancela un run (interrumpe sesiones hijas; pendientes quedan `skipped`) |
| **`/orquestar`** | Atajo: tu petición se convierte en plan de orquestación |
| **`/aiapaec`** | Panel TUI: runs agrupados con objetivo y estado por tarea |
| **`http://127.0.0.1:4780`** | Dashboard web local: **árbol de ejecución** del run activo (título corto por nodo, agente · modelo, progreso, sub-sesiones anidadas, feed de actividad en vivo; refresco 2.5 s; `dashboardPort` configurable) |
| **`docs/plans/<runId>.md`** | Documento de plan vivo con contexto, título corto, tareas (columna **Título**) y avance |
| **`gentle_engram_status`** | Diagnóstico de Engram (conectado / sin conexión / ausente) |

## Flujo

```
TÚ                          ORQUESTADOR                    SUBAGENTES
 │  1. Describes la            │                              │
 │     petición ─────────────▶ │                              │
 │                             │ 2. contexto (memoria) y      │
 │                             │    explorador (repo)         │
 │                             │    en PARALELO ────────────▶ │
 │                             │ 3. Plan: worktree, scope,    │
 │                             │    permisos, dependsOn       │
 │  4. "iniciado" + runId      │ ◀── aiapaec_orchestrate      │
 │     (segundo plano)         │                              │
 │  5. run_status /aiapaec ──▶ │ ◀── avance en curso ─────────┤
 │                             │ 6. coder → worktree, rama    │
 │                             │    feat/<id> desde dev       │
 │                             │ 7. qa → pruebas + evidencia  │
 │                             │ 8. deployer → GATE de permiso│
 │  9. ⚠️ "¿permito el push?"  │◀──── push de la rama ────────┤
 │ 10. Reporte consolidado     │ ◀── run_status final ────────┤
 │ 11. TÚ decides el merge     │    (el plugin nunca mergea)  │
```

## Ejemplo

Con el agente **orquestador** (o `/orquestar`):

> Implementa el endpoint de login con JWT: busca contexto previo y explora el repo en paralelo; el coder implementa en `feat/TASK-101` con worktree; QA valida con pruebas; el deployer prepara el PR hacia `dev`.

## Qué ocurre por dentro

- **Aislamiento**: cada tarea con `worktree: true` corre en su propio git worktree (carpeta + rama), permitiendo varios coder en paralelo.
- **Scope real**: `strict_scope` bloquea ediciones fuera de `allowed_files`; `forbidden_files`, `write_files`, `bash` y `git commit` son reglas `deny` reales.
- **Validación**: sin reporte JSON con `status`, la tarea queda `unconfirmed` (⚠️) y sus dependientes no corren.
- **Niveles de QA**: cada tarea acepta `qaLevel` con tres profundidades —`L1` smoke (solo `pnpm test` con evidencia del comando), `L2` estándar (validación contra el spec con comando + salida y `archivo:línea` en las desviaciones) y `L3` forense (L2 + supuestos técnicos contrastados con fuentes reales, como los `.d.ts` del SDK)—. Default `L2`; un valor inválido cae a `L2` con aviso en la respuesta de `aiapaec_orchestrate`. La definición operativa llega en el prompt solo a las tareas de agente `qa`; el nivel efectivo aparece como `qa · L2` en `aiapaec_run_status` y como badge junto al agente en el dashboard.
- **Recuperación**: el run vive en el storage (`runs/<runId>`); si la llamada se interrumpe, `run_status` recupera el estado.
- **Documento de plan**: cada run escribe `docs/plans/<runId>.md` con contexto, título corto del run en el frontmatter, tabla de tareas (ID, agente, estado, rama, dependencias y **Título**) y avance; se actualiza por oleada y se marca `aborted` al cancelar.
- **Títulos y modelos (árbol v4)**: cada run y cada tarea aceptan `title` (campo opcional del `TaskSpec` y del input de `aiapaec_orchestrate`); si falta, se usa la primera línea del `objective` truncada a 60 caracteres. Cada nodo muestra `agente · modelo`: el modelo **esperado** sale del `model` de la tarea o del que declara el agente en `opencode.json` (`agent.get`), y al cerrar se sustituye por el **real** que reporta el assistant; si el agente no declara modelo, se muestra `default`.
- **Dashboard en vivo**: `http://127.0.0.1:4780` (solo loopback, opción `dashboardPort`) muestra el run activo como árbol: progreso `X/Y`, títulos cortos, `agente · modelo` por nodo, badge de nivel de QA, rama, tiempo, tokens/costo condicional, **sub-sesiones anidadas** y el historial plegado; se refresca cada 2.5 s. `aiapaec_orchestrate` y `aiapaec_run_status` incluyen la línea `Dashboard: http://127.0.0.1:<puerto>`. Si falla, la orquestación sigue igual: es best-effort.
- **Feed de actividad (con cascada)**: el plugin escucha los eventos de sesión y guarda en RAM las últimas **8 acciones** de cada sesión registrada (la orquestadora y cada tarea hija), como `tool` + argumento principal truncado a 80 caracteres. Además, cuando llega `session.created` de una sesión cuya padre ya se observa, la **sub-sesión se registra sola** (rol `sub`) con su agente, modelo y título: el árbol muestra las sesiones que abre un subagente sin instrumentar nada más. Se ve bajo cada tarea ⏳ del dashboard (`hace 5s`), en la sección «Actividad del orquestador» y en la línea `última acción: <tool> → <summary> (hace Xs)` de `aiapaec_run_status`. Nunca guarda salidas completas, no se persiste y no puede romper el run: un evento fallido se ignora. El contrato `/api/state` está en **v4** (v3 añadió `qaLevel` por tarea; v4 añade `title`, `model`, `inFlight` como objetos y `subsessions` anidadas).
- **Memoria**: las sesiones hijas llevan `parentID` (atribución al orquestador) y Engram guarda decisiones/hallazgos.

## Skills por tarea (`skills`)

El orquestador declara `skills: string[]` por tarea (campo opcional del `TaskSpec`). No se
autodetectan: es una decisión explícita y determinista que viaja en el prompt («## Skills a
aplicar») y en el resultado (`run_status` la muestra como sufijo, p. ej. `coder · L2 · tdd`). Si la
skill no está instalada, el subagente aplica su disciplina igualmente; un valor inválido se
descarta sin abortar el plan.

| Tipo de tarea | `skills` sugeridas | Por qué |
|---|---|---|
| Código nuevo o refactor | `tdd` | Prueba primero; el ciclo rojo→verde→refactor deja evidencia |
| Bug | `diagnosing-bugs` + `tdd` | Primero reproducir y aislar la causa; luego el test que la fija |
| QA `L1` | ninguna | Smoke: solo `pnpm test` con evidencia del comando |
| QA `L2` | `code-review` | Validación estándar contra el spec del contrato |
| QA `L3` | `code-review` + `research` | Forense: además contrasta supuestos con fuentes reales |
| Diseño / arquitectura | `domain-modeling` + `codebase-design` | Modelar el dominio antes de decidir la estructura |

## Política de grilling

`grilling` es el motor de entrevista; `grill-me` y `grill-with-docs` son sus envoltorios. La
elección la hace el orquestador **al planificar** y la anuncia en el plan (no la pregunta por
defecto):

| Situación | Skill | Artefactos |
|---|---|---|
| Decisión de arquitectura o estructural | `grill-with-docs` | `GLOSSARY.md` + ADRs en `docs/adr/` |
| Decisión chica o acotada | `grill-me` | Conversación, sin documentos |

Ambas son **human-invocables** (`disable-model-invocation: true`): el agente no las dispara por
su cuenta, las invoca el humano cuando el plan las anuncia. Ver «Cadena de skills» para lo que
ocurre después.

## Cadena de skills (spec → tickets → implementación)

Las skills de ingeniería de Matt Pocock se encadenan. Todas son explícitas
(`disable-model-invocation: true`): cada paso es un punto de control humano, el agente no las
dispara solo. Lo que asumen (tracker y docs de dominio) está en `docs/agents/` y lo genera una
vez `setup-matt-pocock-skills`.

| Paso | Skill | Qué produce |
|---|---|---|
| 1 | `grill-with-docs` | Plan afilado + términos en `GLOSSARY.md` y ADRs en `docs/adr/` |
| 2 | `to-spec` | `.scratch/<feature>/spec.md` (problema, solución, historias, decisiones) |
| 3 | `to-tickets` | `.scratch/<feature>/issues/NN-slug.md`: un tracer-bullet por ticket con `Blocked by:` |
| 4 | `implement-spec` | Implementación del grafo de tickets |
| 5 | `retro` | Retrospectiva sobre el entorno del agente (usa `writing-for-agents`) |

Cada ticket es una rebanada **vertical**: corta todas las capas y se puede demostrar sola. La
línea `Blocked by:` es lo que convierte la lista de tickets en un grafo con frontera.

### `implement-spec` sobre `aiapaec_orchestrate`

El `SKILL.md` upstream habla de rama de integración, worktrees y subagentes sueltos. Aquí se
traduce al runner, que ya resuelve exactamente eso:

| Upstream (`implement-spec`) | Aquí |
|---|---|
| Un *implementer subagent* por ticket | Una tarea `coder` con `worktree: true` |
| `Blocked by:` del ticket | `dependsOn` con los IDs de esas tareas |
| Frontera del grafo | Lo que el runner lanza en cada oleada |
| Rama de integración | `baseBranch` (por defecto `dev`) |
| Merge del ticket a la integración | Gate de permiso humano |
| `code-review` al cerrar | Tarea `qa` con `skills: ["code-review"]` |

Ejemplo con dos tickets independientes y uno que los bloquea:

```jsonc
tasks: [
  { id: "T1", agent: "coder", worktree: true, title: "…", objective: "issues/01-…" },
  { id: "T2", agent: "coder", worktree: true, title: "…", objective: "issues/02-…" },
  { id: "T3", agent: "coder", worktree: true, title: "…", objective: "issues/03-…", dependsOn: ["T1", "T2"] }
]
```

Nunca se lanzan subagentes sueltos: se pierden el run, el dashboard y `aiapaec_run_status`.

## Reglas de operación

1. **Merge**: el plugin nunca mergea a `dev` ni toca `main`; el deployer prepara el PR y pide aprobación.
2. **`mem_save` falla con "authoritative session"**: `opencode service restart` y sesión nueva (ver `docs/incidencias.md`).
3. **Opciones**: `baseBranch` (dev), `taskTimeoutMs`, `runHistory` (50), `cleanupSessions`, `cleanupWorktrees`, `worktreeParent`, `dashboardPort` (4780; `0` desactiva el dashboard), `modelProfiles` y `modelProfile` (ver «Perfiles de modelos»).

## Perfiles de modelos

Un **perfil** es una tabla `agente → modelo` (`orquestador`, `contexto`, `explorador`, `coder`, `qa`,
`deployer`); cada modelo se escribe como `providerID/modelID`. Trae cuatro perfiles built-in que se
pueden usar tal cual:

| Perfil | Orquestador | Coder | `qa` / `explorador` / `contexto` | Deployer |
|---|---|---|---|---|
| `high` | `gemini-4-argon` | `kimi-k3.1-pro` | `glm-5.3` | `deepseek-v4-pro` |
| `balanced` | `glm-5.3` | `kimi-k2.7-code` | `glm-5.3-flash` | `deepseek-v4.1-flash` |
| `low` | `glm-5.3-flash` | `deepseek-v4.1-flash` | `mimo-v2.6-flash` | `mimo-v2.6-flash` |
| `free` | `beam-free` | `beam-free` | `beam-free` | `beam-free` |

(Todos con prefijo `opencode-go/`.) Cómo se eligen:

1. **Default del plugin**: opción `modelProfile` en `opencode.json`. Si no existe ese perfil, se
   ignora con un warning y cada agente usa su modelo declarado.
2. **Por run**: el parámetro `modelProfile` de `aiapaec_orchestrate` manda sobre el default.
3. **Por tarea**: el `model` de una tarea manda sobre el perfil (`task.model` > perfil > agente).

Un perfil inexistente **nunca aborta el run**: la respuesta trae una sección «Avisos de
`modelProfile`» y el run corre sin perfil. El perfil efectivo se ve como `**Perfil:** balanced` en
`aiapaec_run_status`, queda en el frontmatter del plan (`modelProfile: balanced`) y el modelo del
**orquestador** del perfil por defecto se aplica vía `ctx.agent.transform` (solo sesiones nuevas).

Configuración típica en `opencode.json` (se fusiona con los built-in; un perfil con el mismo nombre
se sobrescribe agente a agente):

```jsonc
{
  "plugins": [
    {
      "package": "C:/dev/plugin_orquestacion",
      "options": {
        "modelProfile": "balanced",
        "modelProfiles": {
          "balanced": { "coder": "opencode-go/kimi-k3.1-pro" },   // solo cambia el coder
          "barato":   { "coder": "opencode-go/mimo-v2.6-flash" }  // perfil propio
        }
      }
    }
  ]
}
```

Y para un run concreto: `aiapaec_orchestrate` con `modelProfile: "barato"`.

## Recetario rápido

| Quiero… | Pídele al orquestador… |
|---|---|
| Analizar sin tocar nada | Tareas solo `contexto`/`explorador`, `write_files: false` |
| Implementar con aislamiento | `coder` con `worktree: true`, `strict_scope` y `allowed_files` |
| Dos features en paralelo | Dos tareas `coder` independientes (sin `dependsOn`), ambas con `worktree` |
| Validar antes de publicar | `qa` con `dependsOn` del coder, `write_files: false` |
| Validar rápido un cambio trivial | `qa` con `qaLevel: "L1"` (solo `pnpm test`) |
| Validación forense (APIs/eventos del SDK) | `qa` con `qaLevel: "L3"` (contrasta supuestos con los `.d.ts`) |
| Forzar una disciplina (TDD, review) | Declarar `skills: ["tdd"]` en la tarea (ver «Skills por tarea») |
| Nombres cortos en el árbol | Declarar `title` en el run y en cada tarea |
| Preparar PR | `deployer` con `push_to_remote: true` (gate de permiso) y `human_approval_required` |
| Cancelar algo en curso | `aiapaec_run_abort` con el `runId` |
| Ver historial | `aiapaec_run_status` sin argumentos, o `/aiapaec` en el TUI |
