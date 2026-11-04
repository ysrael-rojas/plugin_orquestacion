# Triage labels

Las skills hablan en términos de cinco roles canónicos de triage. En este repo el
tracker es markdown local, así que la "etiqueta" es el valor de la línea `Status:`
de cada ticket en `.scratch/<feature>/issues/`.

| Rol canónico | Valor de `Status:` | Significado |
|---|---|---|
| `needs-triage` | `needs-triage` | El mantenedor tiene que evaluarlo |
| `needs-info` | `needs-info` | Esperando información del reportante |
| `ready-for-agent` | `ready-for-agent` | Completamente especificado, listo para un agente |
| `ready-for-human` | `ready-for-human` | Requiere implementación humana |
| `wontfix` | `wontfix` | No se va a atender |

Se mantiene el vocabulario por defecto (mismo string rol y valor). Cuando una skill
diga «aplica la etiqueta X», escribe `Status: X` en el ticket.

Además de los cinco roles de estado, `triage` usa dos roles de **categoría**
(`bug`, `enhancement`), que en el tracker local van en una línea `Category:`.
