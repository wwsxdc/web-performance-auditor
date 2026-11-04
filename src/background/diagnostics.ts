import { generateId } from '../utils/id';
import type { DiagnosticLogEntry } from '../types/diagnostics';

const KEY = 'wpa_diagnostics';
const MAX_ENTRIES = 30;

function toMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function logDiagnostic(scope: string, error: unknown): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(KEY);
    const current = Array.isArray(stored[KEY])
      ? (stored[KEY] as DiagnosticLogEntry[])
      : [];
    const entry: DiagnosticLogEntry = {
      id: generateId(),
      timestamp: Date.now(),
      scope,
      message: toMessage(error).slice(0, 500),
    };
    await chrome.storage.local.set({
      [KEY]: [entry, ...current].slice(0, MAX_ENTRIES),
    });
  } catch {
    // The diagnostic journal must never break the operation it reports.
  }
}

export async function getDiagnostics(): Promise<DiagnosticLogEntry[]> {
  try {
    const stored = await chrome.storage.local.get(KEY);
    return Array.isArray(stored[KEY]) ? (stored[KEY] as DiagnosticLogEntry[]) : [];
  } catch {
    return [];
  }
}

export async function clearDiagnostics(): Promise<void> {
  try {
    await chrome.storage.local.remove(KEY);
  } catch {
    // Nothing to clear.
  }
}
