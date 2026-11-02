---
runId: "RUN-MPROFILES"
title: "Perfiles de modelos para orquestación: built-ins high/balan…"
objective: "Perfiles de modelos para orquestación: built-ins high/balanced/low/free + n personalizados, default por opción y override por run, orquestador incluido vía agent.transform, badge visible. Coder core ∥ coder badge + QA L2."
status: completed
baseBranch: dev
startedAt: "2026-11-02T06:19:37.621Z"
finishedAt: "2026-11-02T06:34:09.920Z"
---

## Contexto

RUN-MPROFILES: perfiles de modelos (built-ins + n customs). Repo: C:\dev\plugin_orquestacion (dev, pnpm, 86/86). Hechos: ctx.agent.transform existe (AgentEditor update de model); runner ya resuelve modelo esperado (runner.ts ~315); TaskSpec.model existe. Tabla built-ins EXACTA en obs 313 (leerla con mem_get_observation si hace falta detalle). smoke.ts SOLO lo toca TASK-MP-CORE. Docs: CORE→AGENTS+flujo, UI→README.

## Tareas

| ID | Agente | Estado | Rama | Depende de | Título |
|---|---|---|---|---|---|
| TASK-MP-CORE | coder | ✅ succeeded | `feat/mprofiles-core` | — | Núcleo de perfiles: (1) types.ts: ModelProfile = Record<age… |
| TASK-MP-UI | coder | ✅ succeeded | `feat/mprofiles-ui` | — | Badge de perfil en dashboard (SIN tocar smoke.ts — tests lo… |
| TASK-MP-QA | qa | ✅ succeeded | — | TASK-MP-CORE, TASK-MP-UI | QA L2 sobre ambas ramas: (1) pnpm test verde en cada una (C… |

## Avance por tarea

- **TASK-MP-CORE** (✅ succeeded): Núcleo de perfiles de modelos implementado en feat/mprofiles-core sobre dev (5 commits semánticos). (1) src/types.ts: ModelProfile, BUILT_IN_MODEL_PROFILES (high/balanced/low/free con los modelos exactos del contrato, proveedor opencode-go), resolveModelProfiles (fusión built-in+usuario: mismo nombre sobrescribe agente a agente, nombres nuevos se añaden), normalizeModelProfiles, profileModel, splitModelRef y normalizeModelProfileName; PluginOptions.modelProfiles/modelProfile y PluginCtx.agent.transform (opcional). (2) src/index.ts: fusiona perfiles en setup, valida el modelProfile default (inexistente -> console.warn y se ignora) y aplica el modelo del orquestador vía ctx.agent.transform con AgentEditor (list/update), best-effort y con dispose en el cleanup. (3) src/tools.ts: parámetro modelProfile en el schema de orchestrate (run > default), aviso tipo qaLevelWarnings ('## Avisos de modelProfile' + metadata.modelProfileWarnings) que nunca aborta, precedencia task.model > perfil[agente] > agente, RunRecord.modelProfile persistido y línea '**Perfil:** X' en orchestrate y run_status (+metadata). (4) src/plandocs.ts: modelProfile en el frontmatter del plan. (5) src/runner.ts: parseModelRef reutiliza splitModelRef (mismo error). (6) scripts/smoke.ts: 6 pruebas nuevas (built-ins+fusión, precedencia/persistencia/run_status, aviso no-aborta, override por run con perfil propio, agent.transform del default y casos sin perfil, frontmatter del plan con y sin perfil) más mock de agent.transform. (7) Docs: AGENTS.md (bullet de arquitectura, opciones y ejemplo de opencode.json) y docs/flujo-de-trabajo.md (tabla de perfiles, orden de precedencia y ejemplo). pnpm test: 92/92 verde (86 baseline + 6 nuevas). Sin push ni merge.
- **TASK-MP-UI** (✅ succeeded): Badge 'perfil: X' en el dashboard: el view-model expone run.modelProfile (tolerante a string u objeto, activo e historial) y el HTML lo pinta como chip discreto junto al título del run activo y en la línea del historial, también en el repintado del cliente; sin perfil no se pinta nada. README documenta opciones modelProfile/modelProfiles, tabla built-in high/balanced/low/free, precedencia y ejemplo de opencode.json. pnpm test 86/86, sin tocar smoke.ts.
- **TASK-MP-QA** (✅ succeeded): QA L2 aprobado: pnpm test verde en CORE (92/92) y UI (86/86); integración en .tmp (e7e2aef, merge sin conflictos) 92/92; badge 'perfil: X' renderiza solo con perfil y sin badge vacío, con escape de HTML; built-ins 24/24 celdas exactos vs obs 313 y sobrescribibles; precedencia task.model>perfil>agente y perfil inexistente→warning sin abortar evidenciados por tests; agent.transform contrastado con agent.d.ts del SDK (AgentEditor.update soporta model) con dispose en cleanup; run_status (**Perfil:**) y plandocs (frontmatter modelProfile:) muestran el perfil. Sin desviaciones funcionales.
