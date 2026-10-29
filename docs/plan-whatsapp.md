# Plan de implementación: alertas y programación por WhatsApp

## Objetivo

Añadir notificaciones salientes y opcionales por WhatsApp a DMsecurity para
dos flujos:

1. Escanear un repositorio en un intervalo configurado y avisar cuando el
   resultado sea `FINDINGS` o `INCOMPLETE`.
2. Revisar los cambios que están en el área de *staging* antes de crear un
   commit, y permitir, advertir o bloquear el commit según una política local.

La alerta debe incluir el alias del repositorio, SHA o referencia revisada,
estado, cantidad de hallazgos y acción sugerida. Nunca incluirá el valor de un
secreto, contenido de código ni el reporte JSON completo.

`PASS` sólo significa que los escáneres requeridos terminaron sin hallazgos y
con cobertura suficiente; no significa que el commit sea seguro.

## Límites y decisiones de producto

- WhatsApp rompe deliberadamente el modo totalmente local: un resumen de la
  alerta viaja a WhatsApp Web mediante una sesión local enlazada por QR. Será
  *opt-in*, estará apagado por defecto e incompatible con `--strict-offline`.
- La primera versión será sólo de salida. No aceptará comandos entrantes por
  WhatsApp ni expondrá un webhook público.
- La programación se realizará con el script existente y un timer de usuario
  (systemd) o cron; no será necesario un servidor permanente.
- Un error de WhatsApp no altera el resultado de seguridad. El escaneo termina
  con su estado real y la entrega se reintenta desde una cola local.
- El transporte se encapsula tras una interfaz y usa Baileys, sin Cloud API de
  Meta, token ni cuenta de desarrollador. Cada instalación vincula una cuenta
  de WhatsApp una vez mediante QR y conserva su sesión sólo en el equipo local.
- La instalación interactiva pregunta una vez el repositorio, destinatario,
  intervalo y política del hook; guarda la preferencia local y activa sólo los
  componentes que la persona confirme.
- Al finalizar, confirma por WhatsApp que la configuración se completó y
  ejecuta la primera verificación; comunica también ese resultado aunque sea
  `PASS`.

## Estado actual que se reutiliza

DMsecurity ya dispone de:

- `guardia scan`, que genera un reporte JSON redactado con `PASS`, `FINDINGS`
  o `INCOMPLETE` y el SHA analizado.
- `scripts/scheduled-scan.sh`, que guarda reportes e historial y muestra una
  notificación de escritorio para resultados distintos de `PASS`.
- `scripts/setup.sh`, una base OSV local y adaptadores que no entregan valores
  secretos en los hallazgos.

La solución debe extender estos componentes; no debe duplicar el escaneo ni
volver a interpretar la salida cruda de los escáneres.

## Arquitectura propuesta

```text
timer / hook pre-commit
          |
          v
   guardia scan / check-staged
          |
          +--> reporte JSON privado + historial local
          |
          v
   NotificationEvent redactado
          |
          v
     outbox local (0600) ---> WhatsAppTransport ---> Baileys / WhatsApp Web
                                  |
                                  +--> id de entrega o error sanitizado
```

### Nuevos módulos

| Ruta propuesta | Responsabilidad |
| --- | --- |
| `src/notifications/contracts.ts` | Tipos de evento, política de entrega y transporte. |
| `src/notifications/formatter.ts` | Construye mensajes cortos y redactados desde el reporte. |
| `src/notifications/whatsapp.ts` | Sesión Baileys, QR, persistencia privada de credenciales y envío redactado. |
| `src/notifications/settings.ts` | Destinatario persistente local, sin token ni variable de terminal requerida. |
| `src/notifications/outbox.ts` | Cola persistente, deduplicación y reintentos con *backoff*. |
| `src/core/index-snapshot.ts` | Materializa en temporal el contenido del índice Git para el pre-commit. |
| `src/cli/schedule.ts` | Comandos para crear, listar y quitar programaciones de usuario. |
| `scripts/pre-commit.sh` | Hook instalable explícitamente que llama a `check-staged`. |

Interfaz central:

```ts
type NotificationStatus = "queued" | "sent" | "failed" | "skipped";

interface NotificationEvent {
  id: string;
  occurredAt: string;
  repository: string; // alias local, no ruta absoluta por defecto
  ref: string;
  commit: string | null;
  status: "PASS" | "FINDINGS" | "INCOMPLETE";
  findingCount: number;
  scannerStates: Array<{ scanner: "osv" | "gitleaks"; status: string }>;
  trigger: "scheduled" | "pre_commit";
}

interface NotificationTransport {
  send(event: NotificationEvent): Promise<{ providerMessageId: string }>;
}
```

## Configuración y privacidad

La sesión enlazada se guarda en
`$XDG_STATE_HOME/dmsecurity/whatsapp-auth` (o bajo `DMSECURITY_STATE_DIR`) con
directorio `0700` y archivos `0600`. Los reportes e historial permanecen bajo
`$XDG_STATE_HOME/dmsecurity`.

El asistente `guardia onboard`, iniciado por `bash scripts/install.sh`, solicita
el destinatario en formato E.164 con `+` y código de país, lo guarda con permisos `0600` en
`$XDG_CONFIG_HOME/dmsecurity/whatsapp.json` y muestra el QR. El usuario lo
escanea desde **Dispositivos vinculados** de WhatsApp y no escribe token alguno.
`DMSECURITY_WHATSAPP_RECIPIENT` sólo es un override opcional por proceso. Las
claves de sesión nunca se escriben en el reporte, historial, outbox, consola ni
configuración versionada; tampoco se pasan a OSV-Scanner ni Gitleaks.

### Contenido permitido

```text
DMsecurity · FINDINGS
Repo: mi-api · commit: abcd123
Hallazgos: 2 · OSV: ok · Gitleaks: ok
Acción: revisa el reporte local antes de continuar.
```

```text
DMsecurity · INCOMPLETE
Repo: mi-api · commit: abcd123
No se pudo completar toda la cobertura. Revisa la instalación local.
```

Por defecto no se envían rutas de archivos, IDs detallados de vulnerabilidad,
nombres de dependencias ni valores secretos. Un nivel de detalle mayor sólo
podrá habilitarse con una opción local explícita y documentada.

## Escaneo programado

### Comportamiento

1. Extender `scripts/scheduled-scan.sh` con `GUARDIA_NOTIFY=whatsapp`.
2. El script genera el reporte como hoy, construye un `NotificationEvent` y lo
   agrega a la outbox.
3. La outbox entrega sólo para los estados configurados. El predeterminado es
   `FINDINGS,INCOMPLETE`; `PASS` no genera spam.
4. Deduplicar por `repositorio + commit + estado + huella de hallazgos`. Si no
   cambia el commit ni los hallazgos, no reenviar. Reenviar al cambiar el SHA,
   la huella de hallazgos o al recuperarse de `INCOMPLETE`.
5. Ante un fallo temporal, reintentar con espera exponencial y límite de
   intentos. Registrar sólo un código de error sanitizado, nunca claves de
   sesión ni detalles de la conexión.

### Experiencia de programación

```bash
guardia schedule add \
  --repo /ruta/a/mi-api \
  --ref main \
  --every 6h \
  --notify whatsapp \
  --on findings,incomplete

guardia schedule list
guardia schedule remove --id <id-mostrado-por-list>
```

En Linux, `schedule add` genera un servicio y timer de usuario de systemd.
Cuando systemd de usuario no esté disponible, muestra una línea de cron lista
para copiar, sin editar el crontab automáticamente. Debe usar rutas absolutas,
conservar los reportes y respetar `GUARDIA_STATE_DIR`.

## Validación antes de un commit

### Problema técnico

`guardia scan --ref HEAD` revisa el último commit, no los cambios que todavía
no existen en un commit. Por ello no sirve como validación pre-commit por sí
solo.

### Solución: snapshot del índice

Agregar `guardia check-staged --repo <ruta> --out <reporte>`:

1. Leer el índice con `git ls-files --cached --stage -z` y resolver blobs con
   `git cat-file`, sin hacer checkout ni escribir en el repositorio analizado.
2. Copiar sólo blobs regulares a un directorio temporal privado. Excluir y
   registrar symlinks, gitlinks, rutas inseguras y errores igual que el
   snapshot de commit.
3. Detectar lockfiles y llamar al orquestador existente con ese snapshot.
4. Marcar el objetivo como `INDEX` y el commit como `null`, o publicar un
   formato de reporte `1.1` con `target: { kind: "index", baseCommit }`. No
   cambiar el contrato `1.0` sin publicar su esquema nuevo.
5. Escribir el reporte fuera del repositorio y eliminar el snapshot al acabar.

Instalación del hook sólo bajo orden explícita:

```bash
guardia hook install --repo /ruta/a/mi-api --mode block
```

El instalador nunca sobrescribe un hook existente. Si encuentra uno, crea un
wrapper sólo con confirmación o muestra instrucciones para integrarlo a mano.

### Política del hook

| Resultado | Modo `warn` | Modo `block` recomendado |
| --- | --- | --- |
| `PASS` | Permite el commit. | Permite el commit. |
| `FINDINGS` | Advierte y permite. | Bloquea el commit. |
| `INCOMPLETE` | Advierte y permite. | Bloquea por cobertura insuficiente. |

El hook encola la alerta sin esperar la respuesta de WhatsApp. Una caída de la
sesión o de red no debe bloquear ni permitir un commit: decide sólo el
resultado local del escaneo. Una alerta de `PASS` para pre-commit será opcional
y estará apagada por defecto.

## Estados y errores

- Con `--strict-offline`, rechazar `--notify whatsapp` antes de iniciar: enviar
  una alerta requiere red y no puede declararse aislado.
- `INCOMPLETE` se notifica por defecto, porque puede indicar base OSV faltante,
  escáner ausente o cobertura no verificable.
- Si falla WhatsApp, el reporte conserva su estado de seguridad y la entrega
  queda `failed` o `queued` en la outbox.
- Los logs incluyen alias, SHA corto, estado, intentos y hora; nunca claves de
  sesión, contenido sensible ni detalles íntegros de la conexión.

## Fases de entrega

### Fase 1 — Contrato y notificación manual

- Definir `NotificationEvent`, formatter y pruebas de redacción.
- Implementar transporte Baileys, comando `guardia whatsapp login`, QR en
  terminal y persistencia de sesión privada.
- Añadir `guardia notify --report <archivo>` para probar un reporte existente.
- Documentar el número destinatario, vínculo por QR y revocación desde
  Dispositivos vinculados.

**Cierre:** un reporte `FINDINGS` sintético produce un mensaje seguro con mock;
ni secretos sintéticos ni claves de sesión aparecen en payload ni logs.

### Fase 2 — Outbox y escaneo programado

- Crear outbox con permisos `0600`, deduplicación y reintentos.
- Extender `scheduled-scan.sh` y añadir `schedule add/list/remove`.
- Mantener la notificación de escritorio como alternativa local.

**Cierre:** un timer simulado entrega una sola alerta por el mismo SHA y vuelve
a alertar si cambia el commit o la huella de hallazgos.

### Fase 3 — Check del índice y hook

- Implementar `createIndexSnapshot` y `check-staged`.
- Instalar hook opt-in y soportar `warn`/`block`.
- Definir schema `1.1` si se agrega la representación formal de `INDEX`.

**Cierre:** un secreto o lockfile vulnerable staged hace que `block` rechace el
commit; `PASS` lo permite; `INCOMPLETE` falla cerrado en `block`.

### Fase 4 — Operación y endurecimiento

- Métricas locales de entrega, rotación de outbox e instrucciones de soporte.
- Límite de frecuencia y prueba opt-in con una cuenta real de WhatsApp en un
  entorno de pruebas.
- Revisión de privacidad, retención y consentimiento del destinatario.

## Pruebas de aceptación

- El formatter no filtra valores `DEMO_`, claves de sesión ni secretos de
  Gitleaks.
- Con `PASS` no se envía mensaje programado por defecto; con `FINDINGS` e
  `INCOMPLETE` sí se encola uno.
- El mismo SHA y huella no duplica alertas; un SHA nuevo sí.
- QR vencido, sesión invalidada y caída de red no cambian el veredicto ni
  revelan claves ni detalles sensibles.
- `--strict-offline` junto con WhatsApp se rechaza de forma explícita.
- `check-staged` no modifica el repositorio, cubre archivos nuevos o
  modificados del índice y rechaza symlinks que salgan del temporal.
- Hooks existentes no se sobrescriben y `warn`/`block` respetan la política.
- `npm run build`, `npm test` y una prueba opt-in de QR/envío contra una cuenta
  de pruebas pasan antes de liberar la integración.

## Fuera de alcance inicial

- Leer, interpretar o ejecutar comandos recibidos por WhatsApp.
- Enviar código, valores secretos, el reporte completo o rutas sensibles.
- Afirmar que un `PASS` garantiza seguridad.
- Instalar hooks, timers o cron sin una confirmación explícita dentro del
  asistente de instalación.
