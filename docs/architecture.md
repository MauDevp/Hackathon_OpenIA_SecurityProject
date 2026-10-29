# Arquitectura de Guardia v1

Guardia analiza un commit de Git local y nunca hace checkout ni escribe dentro
del repositorio objetivo.

```text
CLI -> resolver ref -> snapshot temporal -> OSV-Scanner + Gitleaks -> política -> JSON + resumen
                         |                         |
                         +-- blobs regulares        +-- resultados normalizados
                             solamente                  y redactados
```

1. La CLI exige `scan`, `--repo`, `--ref` y `--out`. Rechaza una salida que
   esté dentro del repositorio, incluso mediante un padre que sea un enlace
   simbólico.
2. El núcleo resuelve la referencia a un hash completo y materializa sólo los
   blobs regulares del árbol Git en un directorio temporal privado. No copia
   archivos no rastreados. Symlinks, gitlinks, traversal y errores de copia se
   registran; un snapshot así queda incompleto.
3. Los adaptadores reciben exclusivamente la ruta del snapshot y lockfiles
   relativos. Ejecutan argv fijos, sin shell. Siempre devuelven una respuesta
   para `osv` y otra para `gitleaks`.
4. La política da prioridad a `INCOMPLETE`: snapshot incompleto, escáner
   ausente/error/no soportado o aislamiento estricto sin verificar. Si todo
   terminó, hallazgos dan `FINDINGS`; cero hallazgos dan `PASS`.
5. El reporte guarda cobertura, omisiones, metadatos de base y hallazgos sin
   valores secretos. El directorio temporal se borra al terminar.

## Límites de confianza

- `PASS` sólo significa que las etapas requeridas terminaron sin hallazgos;
  nunca significa que el repositorio sea seguro.
- OSV se invoca con `--offline`, pero Guardia no aplica ni audita aislamiento
  de red a nivel de kernel. Por ello `--strict-offline` hoy termina como
  `INCOMPLETE` con aislamiento `unverified`.
- Gitleaks informa hallazgos, no una lista fiable de cada archivo que revisó;
  el reporte lo declara en `omitted` en vez de inventar cobertura por archivo.
- No se ejecutan paquetes ni se instalan dependencias de los fixtures.
