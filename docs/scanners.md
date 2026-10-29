# Escáneres externos

Guardia no descarga binarios ni bases de datos. El operador prepara herramientas
locales y Guardia informa `missing` o `error` si no puede ejecutarlas.

## OSV-Scanner

Debe estar disponible como `osv-scanner` en `PATH`. Cada lockfile compatible se
invoca por separado con argumentos equivalentes a:

```bash
osv-scanner scan --offline --format json -L /snapshot/package-lock.json
```

El directorio local se toma de
`OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY`; si no existe, se usa
`.guardia/osv-db` bajo el directorio actual. La fecha, fecha de fuente y SHA-256
se toman opcionalmente de `.guardia/osv-db/guardia-db-meta.json`; si no se
conocen se reportan como `null`. No se inventan esos metadatos.

OSV se ejecuta con `--offline`, pero esto no demuestra por sí solo que el
proceso no abrió sockets. La versión de binario se detecta durante cada
ejecución y aparece en el reporte.

## Gitleaks

Debe estar disponible como `gitleaks` en `PATH`. Guardia ejecuta un análisis de
directorio contra el snapshot, usando `rules/gitleaks/guardia.toml`, redactando
el informe de la herramienta y descartando campos como `Secret`, `Match` y
`Line` antes de crear el contrato. El informe transitorio se genera fuera del
snapshot y se elimina al terminar.

El config del equipo extiende las reglas por defecto. Se ignoran comentarios
`gitleaks:allow`; si el snapshot contiene un `.gitleaksignore` en su raíz, el
adaptador conserva los hallazgos disponibles pero marca su cobertura como
`error`, porque Gitleaks puede honrar esa supresión. No se afirma aislamiento
de red.

## Estado real de esta entrega

Los adaptadores están implementados, pero esta copia de trabajo no incluye
binarios ni una base OSV descargada. Las pruebas unitarias inyectan `ScanAll`
falso y no presentan resultados simulados como análisis reales.
