# Decisiones técnicas

## 2026-10-29 — Adaptador separado antes de OpenQodex

**Decisión:** la primera versión usa un núcleo propio pequeño y adaptadores
independientes para OSV-Scanner y Gitleaks. No integra OpenQodex todavía.

**Motivo:** esta entrega necesita demostrar snapshot inmutable, ejecución
offline explícita, redacción y estados de cobertura. Esos límites son
comprobables con un contrato pequeño y sin acoplarse a formatos o ciclos de
release externos.

**Consecuencia:** `src/contracts.ts` es la frontera canónica. Una integración
futura puede implementar `ScanAll` sobre OpenQodex sin cambiar la CLI, el
snapshot ni el formato de reporte. Antes de integrar se debe evaluar la versión
de OpenQodex, compatibilidad de licencia, cobertura de snapshot/aislamiento y
si una contribución upstream elimina este adaptador.
