---
runId: "RUN-ACTIVITY"
objective: "Implementar el feed de actividad en vivo (RUN-ACTIVITY): suscripción a eventos con ring buffer por sesión, últimas 8 acciones reales por tarea en curso y fila del orquestador en el dashboard (/api/state v2), línea \"última acción\" por tarea en run_status, todo best-effort. Validado con QA."
status: completed
baseBranch: dev
startedAt: "2026-11-02T01:16:12.204Z"
finishedAt: "2026-11-02T01:32:25.206Z"
---

## Contexto

Spec RUN-ACTIVITY (obs 290): feed de actividad en vivo para el dashboard Aiapaec. Repo: plugin OpenCode V2 TypeScript ESM en C:\dev\plugin_orquestacion (dev, pnpm, 49/49 pruebas, dashboard ya desplegado en 127.0.0.1:4780 con /api/state v1, polling 2.5s). Motivación: las tareas en curso parecían 'quietas'; el usuario quiere ver qué hace cada subagente (y el orquestador) en tiempo real. Hechos SDK verificados: ctx.event.subscribe() (EventDomain, AsyncIterable de V2Event del cliente @opencode/client — eventos como message.part.updated / session.status) y ctx.session.message.list/get. Agentes: coder corre deepseek-v4.1-flash (excelente en RUN-LIVEDASH).

## Tareas

| ID | Agente | Estado | Rama | Depende de |
|---|---|---|---|---|
| TASK-ACT-CODE | coder | ✅ succeeded | `feat/activity-feed` | — |
| TASK-ACT-QA | qa | ✅ succeeded | — | TASK-ACT-CODE |

## Avance por tarea

- **TASK-ACT-CODE** (✅ succeeded): Feed de actividad en vivo implementado: ActivityFeed con suscripción best-effort a eventos V2, ring buffer de 8 acciones por sesión (resumen truncado a 80), registro de orquestador e hijas desde el runner/tools, /api/state v2 con activity por tarea en vuelo y entrada orchestrator, render en dashboard con timeAgo y sección del orquestador, línea 'última acción' en run_status, 11 pruebas nuevas (60/60 en verde) y documentación actualizada.
- **TASK-ACT-QA** (✅ succeeded): QA aprobado con 2 desviaciones menores no bloqueantes. (1) pnpm test completo: 60/60 en verde (lint+typecheck limpios), cero regresiones. (2) /api/state v2 verificado por prueba con puerto efímero más revisión de código: activity por tarea in-flight, orchestrator solo en run activo, DASHBOARD_STATE_VERSION=2. (3) Ring buffer 8 con expulsión del más viejo (activity.ts:293-295) y truncado a 80 chars exactos (activity.ts:326-330). (4) Sesiones no registradas ignoradas (activity.ts:238-239, prueba presente). (5) Best-effort: evento que lanza no corta el bucle (activity.ts:114-118, prueba presente). (6) run_status muestra 'última acción' por tarea in-flight y la omite si no hay (tools.ts:763-769). (7) DESVIACIÓN: message.part.updated (activity.ts:230) no existe en ningún .d.ts del SDK @opencode/client actual (verificado en promise/generated/types.d.ts, effect/client.d.ts, effect/api/api.d.ts, effect/generated/client.d.ts, solid/data.d.ts); es fallback V1 sin efecto, el camino primario session.tool.input.started y session.tool.called SÍ está verificado contra los tipos con la forma esperada. (8) Sin outputs completos: solo tool+primer argumento truncado (activity.ts:321-323, keys SUMMARY_KEYS). (9) Register/unregister/unregisterRun completo en tools.ts:313,337,360,389 sin fugas para runs cerrados. (10) DESVIACIÓN: AGENTS.md:28 aún dice DASHBOARD_STATE_VERSION = 1; README:268-272 y flujo-de-trabajo.md:57 sí coherentes con v2. Evidencia: pnpm test → tests 60 / pass 60 / fail 0 (2.8s)
