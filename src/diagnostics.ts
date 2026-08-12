/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  code: string;
  detail?: string;
  file?: string;
  pluginId?: string;
  severity: DiagnosticSeverity;
  stage?: 'load' | 'registration' | 'invocation' | 'storage';
}

export interface DiagnosticReporter {
  report(diagnostic: Diagnostic): void;
}

function keyFor(diagnostic: Diagnostic): string {
  return [
    diagnostic.severity,
    diagnostic.code,
    diagnostic.pluginId ?? '',
    diagnostic.file ?? '',
    diagnostic.stage ?? '',
    diagnostic.detail ?? '',
  ].join('\u0000');
}

/** Collects unique, non-message diagnostics for extension logs and status. */
export class DiagnosticCollector implements DiagnosticReporter {
  private readonly diagnostics: Diagnostic[] = [];

  private readonly seen = new Set<string>();

  public report(diagnostic: Diagnostic): void {
    const key = keyFor(diagnostic);
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.diagnostics.push(diagnostic);
  }

  public all(): readonly Diagnostic[] {
    return this.diagnostics;
  }

  public count(severity: DiagnosticSeverity): number {
    return this.diagnostics.filter((item) => item.severity === severity).length;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Logs details only to the host console. Received messages are never logged. */
export function logDiagnostic(diagnostic: Diagnostic): void {
  const location = [
    diagnostic.stage === undefined ? '' : `stage=${diagnostic.stage}`,
    diagnostic.pluginId === undefined ? '' : `plugin=${diagnostic.pluginId}`,
    diagnostic.file === undefined ? '' : `file=${diagnostic.file}`,
  ]
    .filter((part) => part !== '')
    .join(' ');
  const line = `[DiceLuaCompat][${diagnostic.severity}][${diagnostic.code}]${
    location === '' ? '' : ` ${location}`
  }${diagnostic.detail === undefined ? '' : `: ${diagnostic.detail}`}`;
  if (diagnostic.severity === 'error') console.error(line);
  else if (diagnostic.severity === 'warning') console.warn(line);
  else console.info(line);
}

export function reportException(
  reporter: DiagnosticReporter,
  diagnostic: Omit<Diagnostic, 'detail'>,
  error: unknown,
): void {
  reporter.report({ ...diagnostic, detail: describe(error) });
}
