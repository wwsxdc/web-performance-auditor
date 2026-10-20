import type { ExperimentPreset } from '../types/experiment';

export const ANALYTICS_DOMAINS = [
  'google-analytics.com',
  'googletagmanager.com',
  'doubleclick.net',
  'facebook.net',
  'hotjar.com',
  'clarity.ms',
  'segment.com',
  'mixpanel.com',
  'amplitude.com',
  'sentry.io',
] as const;

export interface ExperimentPresetConfig {
  label: string;
  description: string;
  domains: string[];
  requiresDomains: boolean;
}

export const EXPERIMENT_PRESETS: Record<ExperimentPreset, ExperimentPresetConfig> = {
  analytics: {
    label: 'Блокировка аналитики',
    description: 'Блокирует распространённые аналитические и трекинговые домены.',
    domains: [...ANALYTICS_DOMAINS],
    requiresDomains: false,
  },
  'third-party-domain': {
    label: 'Блокировка стороннего домена',
    description: 'Блокирует один указанный сторонний домен и его поддомены.',
    domains: [],
    requiresDomains: true,
  },
  custom: {
    label: 'Пользовательский список',
    description: 'Блокирует перечисленные вручную домены.',
    domains: [],
    requiresDomains: true,
  },
};

export const EXPERIMENT_WARNING =
  'Блокировка JavaScript может нарушить работу страницы. Эксперимент влияет только на текущую вкладку и требует перезагрузки.';

export const EXPERIMENT_POINTER_KEY = 'wpa-active-experiment';
