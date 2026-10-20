import { STORAGE_LIMITS } from '../constants/config';

export interface ExtensionSettings {
  retentionDays: number;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  retentionDays: STORAGE_LIMITS.sessionRetentionDays,
};

const SETTINGS_KEY = 'wpa_settings';

export function normalizeRetentionDays(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_SETTINGS.retentionDays;
  }
  return Math.min(365, Math.max(1, Math.round(value)));
}

export async function getSettings(): Promise<ExtensionSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const value = stored[SETTINGS_KEY] as Partial<ExtensionSettings> | undefined;
  return {
    retentionDays: normalizeRetentionDays(value?.retentionDays),
  };
}

export async function updateRetentionDays(value: number): Promise<ExtensionSettings> {
  const settings: ExtensionSettings = {
    retentionDays: normalizeRetentionDays(value),
  };
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  return settings;
}
