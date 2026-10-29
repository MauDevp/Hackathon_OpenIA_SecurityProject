import type { AnalysisStatus } from "../contracts.js";

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
