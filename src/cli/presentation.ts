import type { AnalysisResult, AnalysisStatus, Finding } from "../contracts.js";
import { redactSecrets } from "../core/report.js";

const supportsColor = (): boolean => Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined;

function paint(code: number, value: string): string {
  return supportsColor() ? `\u001B[${code}m${value}\u001B[0m` : value;
}

const bold = (value: string): string => paint(1, value);
const cyan = (value: string): string => paint(36, value);
const green = (value: string): string => paint(32, value);
const yellow = (value: string): string => paint(33, value);
const red = (value: string): string => paint(31, value);
const dim = (value: string): string => paint(2, value);

export function setupBanner(): string {
  return [
    cyan("╭──────────────────────────────────────────────────────────╮"),
    cyan("│") + ` ${bold("DMsecurity · configuración guiada")}                      ` + cyan("│"),
    cyan("│") + ` ${dim("Protege tu repositorio antes de cada cambio.")}             ` + cyan("│"),
    cyan("╰──────────────────────────────────────────────────────────╯"),
  ].join("\n") + "\n";
}

export function setupStep(number: number, title: string, description: string): string {
  return `\n${cyan(`━━ ${number}/4`)} ${bold(title)}\n${dim(description)}\n`;
}

export function setupSuccess(message: string): string {
  return `${green("✓")} ${message}\n`;
}

export function setupWarning(message: string): string {
  return `${yellow("!")} ${message}\n`;
}

export function setupError(message: string): string {
  return `${red("✕")} ${message}\n`;
}

export function setupResult(status: AnalysisStatus, findings: number): string {
  if (status === "PASS") return setupSuccess("Primera verificación terminada: no se detectaron hallazgos.");
  if (status === "FINDINGS") return setupWarning(`Primera verificación terminada: ${findings} hallazgo(s) requieren revisión.`);
  return setupWarning("Primera verificación incompleta: revisa la cobertura antes de confiar en el resultado.");
}

function menuItem(number: number, command: string, description: string): string {
  return `  ${cyan(`${number}.`)} ${bold(command.padEnd(30))}${dim(`(${description})`)}`;
}

/** Main menu shown only in an interactive terminal. */
export function actionMenu(): string {
  const width = 68;
  const line = (value: string, emphasis = false): string => {
    const content = emphasis ? bold(value) : dim(value);
    return `${cyan("│")} ${content}${" ".repeat(Math.max(0, width - value.length))} ${cyan("│")}`;
  };
  return [
    "",
    cyan(`╭${"─".repeat(width + 2)}╮`),
    line("DMsecurity 🛡️ · centro de seguridad", true),
    line("Elige una acción. Las revisiones se ejecutan sólo en tu equipo."),
    cyan(`╰${"─".repeat(width + 2)}╯`),
    menuItem(1, "login", "iniciar sesión con WhatsApp Web"),
    menuItem(2, "logout", "cerrar sesión local de WhatsApp Web"),
    menuItem(3, "dmsecurity onboard", "configurar repositorio, alertas y protecciones"),
    menuItem(4, "comandos", "ver y ejecutar comandos disponibles"),
    menuItem(5, "chequeo detallado", "listar problemas, ubicación y correcciones locales"),
    menuItem(6, "chat administrador", "activar el control seguro por WhatsApp"),
    `  ${cyan("0.")} ${bold("Salir".padEnd(30))}${dim("(cerrar el menú)")}`,
  ].join("\n") + "\n";
}

interface CommandReferenceRow {
  command: string;
  description: string;
}

function tableCell(value: string, width: number): string {
  return ` ${value.padEnd(width)} `;
}

/** Readable command reference for people who want to work beyond the main menu. */
export function commandReference(): string {
  const rows: CommandReferenceRow[] = [
    { command: "dmsecurity --login", description: "Vincula WhatsApp Web mediante un QR." },
    { command: "dmsecurity --logout", description: "Borra la sesión local de WhatsApp Web." },
    { command: "dmsecurity onboard", description: "Configura repositorio, alertas, timer y hook." },
    { command: "dmsecurity detailed-check", description: "Lista problemas, ubicación y cómo corregirlos." },
    { command: "dmsecurity admin-chat", description: "Inicia el chat seguro en la terminal actual." },
    { command: "dmsecurity admin-chat install", description: "Activa el chat seguro del administrador por WhatsApp." },
    { command: "dmsecurity admin-chat stop", description: "Detiene y elimina el servicio de chat local." },
    { command: "dmsecurity scan …", description: "Escanea una rama y guarda un reporte." },
    { command: "dmsecurity check-staged …", description: "Revisa lo preparado para el próximo commit." },
    { command: "dmsecurity schedule …", description: "Administra revisiones programadas." },
    { command: "dmsecurity hook install …", description: "Instala la protección antes de cada commit." },
  ];
  const commandWidth = 34;
  const descriptionWidth = 58;
  const border = `├${"─".repeat(commandWidth + 2)}┼${"─".repeat(descriptionWidth + 2)}┤`;
  const row = (command: string, description: string): string => `│${tableCell(command, commandWidth)}│${tableCell(description, descriptionWidth)}│`;
  return [
    "",
    bold("Comandos de DMsecurity"),
    `┌${"─".repeat(commandWidth + 2)}┬${"─".repeat(descriptionWidth + 2)}┐`,
    row("Comando", "Qué hace"),
    border,
    ...rows.map((item) => row(item.command, item.description)),
    `└${"─".repeat(commandWidth + 2)}┴${"─".repeat(descriptionWidth + 2)}┘`,
    dim("Ingresa un comando de la tabla o presiona 0 para regresar."),
  ].join("\n") + "\n";
}

/** Context shown before one of the interactive security checks begins. */
export function securityCheckHeader(kind: "rápida" | "detallada", repository: string, ref: string): string {
  return [
    "",
    cyan(`━━ Verificación ${kind}`),
    `${dim("Repositorio:")} ${redactSecrets(repository)}`,
    `${dim("Referencia:")} ${redactSecrets(ref)}`,
  ].join("\n") + "\n";
}

function findingLabel(finding: Finding): string {
  return finding.type === "dependency" ? "Vulnerabilidad de dependencia" : "Posible secreto expuesto";
}

function findingLocation(finding: Finding): string {
  return `${finding.path}${finding.line === undefined ? "" : `:${finding.line}`}`;
}

/** A local-only view; it intentionally keeps only redacted report content. */
export function detailedSecurityReport(result: AnalysisResult): string {
  const lines: string[] = ["", bold("Problemas encontrados")];
  if (result.findings.length === 0) {
    lines.push(green("✓ No se detectaron vulnerabilidades ni secretos expuestos."));
  } else {
    for (const [index, finding] of result.findings.entries()) {
      lines.push(`${cyan(`${index + 1}.`)} ${bold(findingLabel(finding))} · ${finding.scanner.toUpperCase()}`);
      lines.push(`   ${dim("ID/regla:")} ${finding.id}`);
      lines.push(`   ${dim("Ubicación:")} ${findingLocation(finding)}`);
      lines.push(`   ${dim("Detalle:")} ${finding.summary}`);
    }
  }

  const incomplete = result.scanners.filter((scanner) => scanner.status !== "ok");
  if (incomplete.length > 0) {
    lines.push("", yellow("Cobertura pendiente"));
    for (const scanner of incomplete) {
      lines.push(`  ${scanner.scanner}: ${scanner.error ?? "no se pudo completar la revisión"}`);
    }
  }

  if (result.findings.length > 0 || incomplete.length > 0) {
    const dependencyCount = result.findings.filter((finding) => finding.type === "dependency").length;
    const secretCount = result.findings.filter((finding) => finding.type === "secret").length;
    lines.push("", bold("Cómo corregirlo"));
    if (dependencyCount > 0) {
      lines.push(`  • Dependencias (${dependencyCount}): actualiza la dependencia afectada a una versión corregida, actualiza el lockfile y vuelve a ejecutar la revisión.`);
    }
    if (secretCount > 0) {
      lines.push(`  • Secretos (${secretCount}): revoca y rota la credencial de inmediato, elimínala del código e historial y usa una variable de entorno o gestor de secretos.`);
    }
    if (incomplete.length > 0) {
      lines.push("  • Cobertura: corrige o reinstala los escáneres y su base local antes de confiar en un resultado limpio.");
    }
  }
  return `${lines.map(redactSecrets).join("\n")}\n`;
}
