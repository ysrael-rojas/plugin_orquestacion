# Docs de dominio

Cómo deben consumir las skills de ingeniería la documentación de dominio de este
repo cuando exploran el código.

Layout de este repo: **single-context** (un `GLOSSARY.md` y `docs/adr/` en la raíz).

## Antes de explorar, lee

- **`GLOSSARY.md`** en la raíz del repo.
- **`docs/adr/`**: los ADRs que toquen el área en la que vas a trabajar.

Si esos archivos no existen, **continúa en silencio**: no señales su ausencia ni
propongas crearlos por adelantado. `domain-modeling` (se llega vía `grill-with-docs`)
los crea de forma perezosa cuando de verdad se resuelven términos o decisiones.

## Estructura

```
/
├── GLOSSARY.md
├── docs/adr/
│   ├── 0001-ejemplo-decision.md
│   └── 0002-otra-decision.md
└── src/
```

## Usa el vocabulario del glosario

Cuando tu salida nombre un concepto de dominio (título de ticket, propuesta de
refactor, hipótesis, nombre de test), usa el término tal como lo define
`GLOSSARY.md`. No derives a sinónimos que el glosario evita explícitamente.

Si el concepto que necesitas no está en el glosario, es una señal: o estás
inventando lenguaje que el proyecto no usa (reconsidéralo) o hay un hueco real
(anótalo para `domain-modeling`).

## Marca conflictos con ADRs

Si tu salida contradice un ADR existente, dilo explícitamente en vez de
sobrescribirlo en silencio:

> _Contradice ADR-0007 (…), pero merece reabrirse porque…_
