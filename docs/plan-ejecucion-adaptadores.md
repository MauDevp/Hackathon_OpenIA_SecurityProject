# Plan de ejecución: escáneres y adaptadores (parte de Mauricio)

Derivado de `Plan_Mauricio.md` y del informe de investigación (§9.2, §12.2, §15.3).
Fecha: 2026-10-28. Rama de trabajo: `feat/adapters`, a partir de `main` (`a11e740`).

## 1. Estado verificado del entorno

| Elemento | Estado el 2026-10-28 |
| --- | --- |
| Sistema | Ubuntu 26.04.1 LTS, Linux x86_64 |
| Git | 2.53.0 |
| Node.js / npm | v24.21.0 / 11.19.0 (el scaffold pide `>=22`) |
| Docker | 29.8.0 |
| OSV-Scanner | **no instalado** |
| Gitleaks | **no instalado** |
| Go, Homebrew | no instalados (no hacen falta: se usan binarios de release) |
| `package-lock.json`, `node_modules` | no existen todavía |

## 2. Versiones a fijar y flags verificados en documentación oficial

### OSV-Scanner v2.7.0 (release 2026-10-12)

- Binario Linux: `osv-scanner_linux_amd64`; checksums: `osv-scanner_SHA256SUMS`; procedencia: `multiple.intoto.jsonl`.
- Escanear un lockfile: `osv-scanner scan -L <lockfile> --format json`.
- Modo sin red: `--offline` (no descarga, no envía nada). `--offline-vulnerabilities` solo aplica a la base de vulnerabilidades y otras funciones pueden usar red. **Usar `--offline`.**
- Descargar/actualizar base: `osv-scanner scan --offline --download-offline-databases -L <lockfile>` (requiere red, una sola vez). Alternativa HTTP: `https://osv-vulnerabilities.storage.googleapis.com/<ECOSYSTEM>/all.zip`.
- Ubicación de la base: variable `OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY`; layout observado en v2.7.0: `{dir}/osv-scalibr/{ecosystem}/all.zip` (la documentación dice `osv-scanner/`, el binario usa `osv-scalibr/`) (por ejemplo `npm/all.zip`, `PyPI/all.zip`).
- Códigos de salida documentados: `0` paquetes sin hallazgos; `1` hallazgos; `1-126` errores relacionados con resultados; `127` error general; `128` no se encontraron paquetes.
- JSON: `results[]` con `source.{path,type}` y `packages[]`, cada uno con `package.{name,version,ecosystem}`, `vulnerabilities[]` (registro OSV completo: `id`, `summary`, `aliases`, …) y `groups[].ids`.
- Lockfiles soportados relevantes: `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`, `requirements.txt` (con reserva), `poetry.lock`, `Pipfile.lock`, `uv.lock`.
- Limitación: el escaneo a nivel de commit no está soportado en modo offline. La resolución transitiva de Maven usa red y queda desactivada en offline; no aplica al fixture npm.

### Gitleaks v8.30.1 (release 2026-03-21)

- Binario Linux: `gitleaks_8.30.1_linux_x64.tar.gz`; checksums: `gitleaks_8.30.1_checksums.txt`.
- Escanear un directorio sin historial Git: `gitleaks dir <ruta>` (`detect` y `protect` están deprecados desde 8.19.0).
- Reporte JSON: `--report-format json --report-path <archivo>`. Escribir el archivo **fuera** del snapshot, en un directorio temporal propio.
- Redacción: `--redact` (100 % por defecto). Añadir `--no-banner --no-color`.
- Códigos de salida: `0` sin leaks; `1` leaks **o** error (la documentación no los distingue); `126` flag desconocido. `--exit-code <n>` cambia solo el código de leaks. **Decisión:** ejecutar con `--exit-code 0` para que `1` signifique únicamente error; los hallazgos se leen del JSON.
- Configuración: precedencia `--config` > `GITLEAKS_CONFIG` > `GITLEAKS_CONFIG_TOML` > `.gitleaks.toml` **dentro del directorio analizado**. Un repo no confiable podría desactivar reglas. **Decisión:** pasar siempre `--config` con una configuración del equipo versionada en `rules/gitleaks/guardia.toml`, y registrar en `omitted` si el snapshot contenía un `.gitleaks.toml` propio (ignorado).
- Aviso del proyecto: Gitleaks se declara "feature complete"; solo recibirá parches de seguridad. Suficiente para el prototipo; registrar como riesgo.
- Pendiente de verificar en R-M01 con el binario real: nombres exactos de los campos del JSON (`RuleID`, `File`, `StartLine`, `Description`, `Secret`, `Match`, `Line`, `Fingerprint`). Solo `RuleID`, `File`, `StartLine` y `Description` pasan al contrato.

## 3. Decisiones de diseño

1. **Sin shell.** `child_process.execFile` / `spawn` con ejecutable y lista de argumentos. Entorno mínimo: `PATH`, `HOME`, `OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY`, `GITLEAKS_CONFIG` no se pasa (se usa `--config`).
2. **Ubicación de binarios.** Variables `GUARDIA_OSV_SCANNER_BIN` y `GUARDIA_GITLEAKS_BIN`; si no existen, búsqueda en `PATH`. Las versiones esperadas viven en `src/adapters/tools.ts`; el adaptador ejecuta `osv-scanner --version` y `gitleaks version`, guarda el valor en `version` y, si difiere de la fijada, lo anota en `omitted` sin abortar.
3. **Base OSV.** Directorio por defecto `.guardia/osv-db/` (ignorado por Git). El adaptador calcula `sha256` del `all.zip` usado en cada ejecución; `downloadedAt` se lee de un sidecar `guardia-db-meta.json` escrito en el paso manual de descarga; `sourceDate` es `null` porque la fuente no lo proporciona. Base ausente → `status: "missing"`, nunca `ok` con cero hallazgos.
4. **Pruebas deterministas sin red.** Las pruebas unitarias crean ejecutables falsos (`fake-osv-scanner`, `fake-gitleaks`: scripts que imprimen un JSON controlado y salen con un código dado) en un directorio temporal y los inyectan vía `GUARDIA_*_BIN`. Están etiquetados como simulación en el nombre del test. Las pruebas de integración con binarios y base reales se activan solo con `GUARDIA_INTEGRATION=1`.
5. **Runner de pruebas.** Node 24 ejecuta `.ts` directamente (type stripping), por lo que `node --test tests/**/*.test.ts` funciona sin `tsx`. Restricción: no usar `enum`, `namespace` ni parameter properties. Proponer al compañero cambiar el script `test` de `package.json` y quitar `tsx` de `devDependencies`.
6. **Contrato.** Mientras `src/contracts.ts` no exista en `main`, usar `src/adapters/contracts.ts` como copia idéntica. Al integrar, ese archivo se reemplaza por `export * from "../contracts.js";` y nada más cambia.
7. **Fixtures.** `fixtures/adapters/npm-vulnerable/package-lock.json` con `lodash@4.17.20` (GHSA-35jh-r3h4-6jhm, [S50] del informe) y `fixtures/adapters/npm-clean/package-lock.json` con `ms@2.1.3` (lodash 4.17.21 ya tiene avisos de 2025/2026); `fixtures/adapters/secrets/config.py` con una clave sintética que coincida con una regla real de Gitleaks 8.30.1 (confirmar la regla en R-M01; candidata: un token con prefijo reconocido pero valor inventado). Nunca ejecutar el contenido de los fixtures.

## 4. Mapa de archivos

```
src/adapters/
  contracts.ts        copia temporal del contrato (ver decisión 6)
  tools.ts            versiones fijadas, nombres de binarios, variables de entorno
  runner.ts           ejecutor sin shell: timeout, tope de salida, env mínimo, errores tipados
  paths.ts            validación del snapshot y de rutas (sin seguir symlinks)
  shared.ts           utilidades comunes: sonda de versión, mensajes fijos de fallo
  osv.ts              adaptador OSV-Scanner → ScannerResult
  gitleaks.ts         adaptador Gitleaks → ScannerResult (redacción)
  index.ts            scanAll: ScanAll
rules/gitleaks/
  guardia.toml        configuración confiable del equipo (extiende la default)
fixtures/adapters/
  npm-vulnerable/package-lock.json
  npm-clean/package-lock.json
  secrets/config.py
tests/adapters/
  helpers/fake-tool.ts      crea ejecutables falsos en un tmpdir
  runner.test.ts
  osv.test.ts
  gitleaks.test.ts
  scan-all.test.ts
  adversarial.test.ts
  integration.test.ts       solo con GUARDIA_INTEGRATION=1
docs/
  scanners.md               versiones, comandos ejecutados, hashes, bloqueos, dudas
```

## 5. Unidades de trabajo, en orden

Cada unidad cierra con un commit propio en `feat/adapters` (Conventional Commits, sin atribución), con sus pruebas y docs. RED antes de implementar cuando el caso sea ejecutable.

| # | Unidad | Tareas de `Plan_Mauricio.md` | Entregable y criterio de cierre | Depende de |
| --- | --- | --- | --- | --- |
| U0 | Rama y contrato temporal | C-M01 | `feat/adapters` creada; `src/adapters/contracts.ts` idéntico al contrato; `tests/adapters/helpers/fake-tool.ts`; `node --test tests/adapters/` corre en verde con un test trivial. | — |
| U1 | Runner sin shell | C-M02 | `runner.ts` con `execFile`, timeout, tope de bytes, env allowlist, lista cerrada de herramientas. Tests: herramienta ausente → `missing`; timeout → `error` ("interrupted"); salida mayor al tope → `error`; stdout crudo nunca en el mensaje de error; intento de ejecutar algo fuera de la lista → rechazo. | U0 |
| U2 | Instalación y base OSV (manual, ver §7) | I-M01, I-M02 | Binarios en `~/.local/bin` o `.guardia/tools/`, checksums verificados; `.guardia/osv-db/osv-scalibr/npm/all.zip` con `guardia-db-meta.json`; primera versión de `docs/scanners.md` con comandos reales, hashes y resultado de las dos pruebas (offline con base y sin base). | — |
| U3 | Investigación de I/O reales | R-M01, R-M02 | Ejecutar ambos binarios contra los fixtures y guardar en `docs/scanners.md`: comando exacto, código de salida observado, campos del JSON confirmados, si Gitleaks leyó `.gitleaks.toml` del objetivo. Sin esto no se cierran U4 ni U5. | U2 |
| U4 | Adaptador OSV | C-M03 | `osv.ts`: construye `-L <lockfile> --format json --offline`, mapea `vulnerabilities[].id` y `summary`, llena `database`, trata `0/1/127/128`. Tests con fake: hallazgo, sin hallazgos, 128 → `unsupported` con el lockfile en `omitted`, 127 → `error`, JSON inválido → `error`, base ausente → `missing`. Test de integración opt-in con el fixture real. | U1, U3 |
| U5 | Adaptador Gitleaks | C-M04 | `gitleaks.ts`: `dir <snapshot> --config rules/gitleaks/guardia.toml --report-format json --report-path <tmp> --redact --no-banner --no-color --exit-code 0`. Mapea solo `RuleID`, `File`, `StartLine`, `Description`. Tests: hallazgo redactado (el valor sintético no aparece en `JSON.stringify(result)` ni en logs capturados), exit 1 → `error`, JSON inválido → `error`, `.gitleaks.toml` en el snapshot → anotado en `omitted`. | U1, U3 |
| U6 | `scanAll` e integración | C-M05 | `index.ts` ejecuta ambos en paralelo con `Promise.allSettled`, devuelve siempre dos `ScannerResult`; una excepción inesperada se convierte en `status: "error"` sanitizado. Nota de integración para el compañero en `docs/scanners.md` (import, variables, estados). | U4, U5 |
| U7 | Pruebas adversarias y cierre | C-M06 | Rutas con espacios; symlink que apunta fuera del snapshot (declarar si Gitleaks lo sigue y cómo se reporta); lockfile fuera del snapshot → rechazado antes de ejecutar; `.gitleaks.toml` hostil ignorado. `docs/scanners.md` con sección "aislamiento de red: no verificado" para que el modo estricto reporte `INCOMPLETE`. Resumen final de comandos, resultados y bloqueos. | U6 |

Horas de referencia del informe (§6.1): OSV 12–32 h, Gitleaks 8–16 h. Es una banda de planeación, no compromiso.

## 6. Coordinación con el compañero

Puntos que hay que acordar **antes** de que cada uno avance mucho, porque el scaffold actual y `Plan_Mauricio.md` no coinciden en todo:

1. **Ruta de la CLI.** El scaffold tiene `src/cli/index.ts` y `package.json` apunta `bin` a `dist/cli/index.js`; el plan del compañero dice `src/cli.ts`. Decidir una y ajustar `bin`. Propuesta: conservar `src/cli/index.ts` para no mover el `bin`.
2. **Runner de pruebas.** `package.json` hoy usa `tsx`, que no está instalado ni hay lockfile. Propuesta: `"test": "node --test tests/**/*.test.ts"` sin `tsx`. El compañero decide, porque `package.json` es suyo.
3. **`src/contracts.ts`.** El compañero lo crea con el texto exacto de la sección "Contrato compartido" y lo lleva a `main` lo antes posible. Es el primer merge; después `feat/adapters` se rebasa y reemplaza su copia temporal por un re-export.
4. **Snapshot.** Confirmar que `snapshotDir` llega como ruta absoluta, ya materializada, sin symlinks que salgan de ella, y que `lockfiles` son relativas. El adaptador valida ambas cosas de todos modos y rechaza lo que no cumpla.
5. **Variables de entorno y directorio `.guardia/`.** Acordar que la CLI pasa (o deja heredar) `OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY` y `GUARDIA_*_BIN`, y que `.guardia/` queda en `.gitignore` (ya lo está).
6. **Regla de merge.** Cada uno revisa el PR del otro; nadie edita `src/core/`, `src/cli*`, `package.json` (compañero) ni `src/adapters/`, `tests/adapters/`, `docs/scanners.md` (Mauricio) sin avisar. `rules/gitleaks/` y `fixtures/adapters/` son de Mauricio.
7. **Orden de merges.** (1) contrato del compañero → `main`; (2) `feat/adapters` con U0–U7; (3) núcleo y CLI del compañero consumiendo `scanAll`.

## 7. Pasos manuales (no los hace el código)

1. Crear la rama: `git switch -c feat/adapters`.
2. Descargar `osv-scanner_linux_amd64` y `osv-scanner_SHA256SUMS` de la release v2.7.0, verificar con `sha256sum -c`, dar permisos de ejecución y colocar en `~/.local/bin/osv-scanner` (o `.guardia/tools/`).
3. Descargar `gitleaks_8.30.1_linux_x64.tar.gz` y `gitleaks_8.30.1_checksums.txt`, verificar, extraer y colocar `gitleaks` en `~/.local/bin/`.
4. Con red, descargar la base npm: `OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY=$PWD/.guardia/osv-db osv-scanner scan --offline --download-offline-databases -L fixtures/adapters/npm-vulnerable/package-lock.json`. Anotar fecha y `sha256sum` del `all.zip` en `.guardia/osv-db/guardia-db-meta.json` y en `docs/scanners.md`.
5. Repetir el escaneo sin `--download-offline-databases` (debe funcionar sin red) y luego con un `OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY` vacío (debe fallar de forma visible). Registrar códigos de salida.
6. Acordar con el compañero los siete puntos de §6, en especial la ruta de la CLI y el runner de pruebas, antes de U4.
7. Decidir si `Plan_Mauricio.md` se versiona. Si es un archivo personal para pegar en Codex, añadirlo a `.git/info/exclude`; si es documentación del equipo, moverlo a `docs/`.

## 8. Riesgos y qué hacer si fallan

- **Descarga bloqueada (red o permisos):** documentar el bloqueo en `docs/scanners.md`, seguir con U1 y los tests con herramientas falsas; `scanAll` devuelve `missing`, nunca `ok` simulado.
- **Campos del JSON de Gitleaks distintos a lo supuesto:** se corrigen en U5 con la evidencia de U3; por eso U3 bloquea U4 y U5.
- **Gitleaks sigue symlinks fuera del snapshot:** declararlo en `omitted` y proponer al compañero que el snapshot no contenga symlinks.
- **Aislamiento de red no verificado:** es el estado esperado del prototipo; el informe lo exige como `INCOMPLETE` en modo estricto. No prometer más.
