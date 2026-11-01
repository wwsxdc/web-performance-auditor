import type { JsonReport } from '../types/report';
import type { MetricName } from '../types/metrics';

export interface ReportValidation {
  valid: boolean;
  errors: string[];
}

const METRIC_NAMES: readonly MetricName[] = ['LCP', 'CLS', 'INP', 'FCP', 'TTFB'];
const METRIC_UNITS = ['ms', 'score'];
const METRIC_SOURCES = ['web-vitals', 'performance-api', 'derived'];
const EXPERIMENT_STATUSES = ['running', 'completed', 'incomplete', 'failed', 'cancelled'];
const CLEANUP_STATUSES = ['pending', 'completed', 'failed'];
const COMPLETENESS_LEVELS = ['full', 'partial', 'limited'];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function findNonSerializable(
  value: unknown,
  path: string,
  seen = new WeakSet<object>(),
): string | null {
  if (typeof value === 'function' || typeof value === 'symbol') {
    return `${path} содержит несериализуемое значение`;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return `${path} содержит циклическую ссылку`;
    seen.add(value);
    for (let index = 0; index < value.length; index++) {
      const found = findNonSerializable(value[index], `${path}[${index}]`, seen);
      if (found) return found;
    }
    seen.delete(value);
    return null;
  }
  if (isObject(value)) {
    if (seen.has(value)) return `${path} содержит циклическую ссылку`;
    seen.add(value);
    for (const [key, nested] of Object.entries(value)) {
      const found = findNonSerializable(nested, `${path}.${key}`, seen);
      if (found) return found;
    }
    seen.delete(value);
  }
  return null;
}

function isOneOf(value: unknown, allowed: readonly string[]): boolean {
  return typeof value === 'string' && allowed.includes(value);
}

/**
 * Runtime validation of the exported JSON document (FR-24 / 7.8).
 * The exported report must stay a plain, versioned, serializable object.
 */
export function validateJsonReport(value: unknown): ReportValidation {
  const errors: string[] = [];

  if (!isObject(value)) {
    return { valid: false, errors: ['Отчёт должен быть объектом'] };
  }

  if (!isFiniteNumber(value.reportVersion) || value.reportVersion < 1) {
    errors.push('reportVersion должен быть положительным числом');
  }
  if (!isFiniteNumber(value.schemaVersion)) {
    errors.push('schemaVersion должен быть числом');
  }
  if (typeof value.generatedAt !== 'string' || Number.isNaN(Date.parse(value.generatedAt))) {
    errors.push('generatedAt должен быть ISO-датой');
  }

  if (!isObject(value.tool) || typeof value.tool.name !== 'string' || typeof value.tool.version !== 'string') {
    errors.push('tool.name и tool.version обязательны');
  }

  if (!isObject(value.session)) {
    errors.push('session обязателен');
  } else {
    const session = value.session;
    if (typeof session.id !== 'string') errors.push('session.id обязателен');
    if (typeof session.url !== 'string') errors.push('session.url обязателен');
    if (!isFiniteNumber(session.startedAt)) errors.push('session.startedAt обязателен');
    if (typeof session.status !== 'string') errors.push('session.status обязателен');
    if (!isObject(session.browser) || typeof session.browser.name !== 'string') {
      errors.push('session.browser.name обязателен');
    }
    if (!Array.isArray(session.navigations)) {
      errors.push('session.navigations должен быть массивом');
    } else {
      session.navigations.forEach((navigation, index) => {
        if (!isObject(navigation)) {
          errors.push(`session.navigations[${index}] должен быть объектом`);
          return;
        }
        if (typeof navigation.id !== 'string') {
          errors.push(`session.navigations[${index}].id обязателен`);
        }
        if (typeof navigation.url !== 'string') {
          errors.push(`session.navigations[${index}].url обязателен`);
        }
        if (navigation.kind !== 'document' && navigation.kind !== 'spa') {
          errors.push(`session.navigations[${index}].kind некорректен`);
        }
        if (!isFiniteNumber(navigation.startedAt)) {
          errors.push(`session.navigations[${index}].startedAt обязателен`);
        }
      });
    }
  }

  if (!Array.isArray(value.metrics)) {
    errors.push('metrics должен быть массивом');
  } else {
    value.metrics.forEach((metric, index) => {
      if (!isObject(metric)) {
        errors.push(`metrics[${index}] должен быть объектом`);
        return;
      }
      if (typeof metric.id !== 'string') errors.push(`metrics[${index}].id обязателен`);
      if (typeof metric.name !== 'string' || !(METRIC_NAMES as readonly string[]).includes(metric.name)) {
        errors.push(`metrics[${index}].name некорректен`);
      }
      if (metric.value !== null && !isFiniteNumber(metric.value)) {
        errors.push(`metrics[${index}].value должен быть числом или null`);
      }
      if (typeof metric.status !== 'string') errors.push(`metrics[${index}].status обязателен`);
      if (!isFiniteNumber(metric.observedAt)) {
        errors.push(`metrics[${index}].observedAt обязателен`);
      }
      if (!isOneOf(metric.unit, METRIC_UNITS)) {
        errors.push(`metrics[${index}].unit некорректен`);
      }
      if (!isOneOf(metric.source, METRIC_SOURCES)) {
        errors.push(`metrics[${index}].source некорректен`);
      }
      if (typeof metric.rating !== 'string') {
        errors.push(`metrics[${index}].rating обязателен`);
      }
    });
  }

  if (!Array.isArray(value.attribution)) {
    errors.push('attribution должен быть массивом');
  } else {
    value.attribution.forEach((entry, index) => {
      if (!isObject(entry)) {
        errors.push(`attribution[${index}] должен быть объектом`);
        return;
      }
      if (typeof entry.metricId !== 'string') {
        errors.push(`attribution[${index}].metricId обязателен`);
      }
      if (typeof entry.metricName !== 'string' || !(METRIC_NAMES as readonly string[]).includes(entry.metricName)) {
        errors.push(`attribution[${index}].metricName некорректен`);
      }
      if (!isFiniteNumber(entry.observedAt)) {
        errors.push(`attribution[${index}].observedAt обязателен`);
      }
      if (!isObject(entry.attribution)) {
        errors.push(`attribution[${index}].attribution обязателен`);
      }
    });
  }

  if (!Array.isArray(value.events)) {
    errors.push('events должен быть массивом');
  } else {
    value.events.forEach((event, index) => {
      if (!isObject(event) || typeof event.id !== 'string' || typeof event.type !== 'string' || !isFiniteNumber(event.timestamp)) {
        errors.push(`events[${index}] должен содержать id, type и timestamp`);
      }
    });
  }

  if (!Array.isArray(value.experiments)) {
    errors.push('experiments должен быть массивом');
  } else {
    value.experiments.forEach((experiment, index) => {
      if (!isObject(experiment)) {
        errors.push(`experiments[${index}] должен быть объектом`);
        return;
      }
      if (typeof experiment.id !== 'string') {
        errors.push(`experiments[${index}].id обязателен`);
      }
      if (typeof experiment.baselineSessionId !== 'string') {
        errors.push(`experiments[${index}].baselineSessionId обязателен`);
      }
      if (!isFiniteNumber(experiment.tabId)) {
        errors.push(`experiments[${index}].tabId обязателен`);
      }
      if (typeof experiment.url !== 'string') {
        errors.push(`experiments[${index}].url обязателен`);
      }
      if (!isOneOf(experiment.status, EXPERIMENT_STATUSES)) {
        errors.push(`experiments[${index}].status некорректен`);
      }
      if (!isOneOf(experiment.cleanupStatus, CLEANUP_STATUSES)) {
        errors.push(`experiments[${index}].cleanupStatus некорректен`);
      }
      if (!Array.isArray(experiment.domains) || experiment.domains.some((domain) => typeof domain !== 'string')) {
        errors.push(`experiments[${index}].domains должен быть массивом строк`);
      }
    });
  }
  if (!Array.isArray(value.limitations) || value.limitations.some((item) => typeof item !== 'string')) {
    errors.push('limitations должен быть массивом строк');
  }

  if (!isObject(value.completeness)) {
    errors.push('completeness обязателен');
  } else {
    const completeness = value.completeness;
    if (!isOneOf(completeness.level, COMPLETENESS_LEVELS)) {
      errors.push('completeness.level некорректен');
    }
    if (
      !Array.isArray(completeness.reasons) ||
      completeness.reasons.some((item) => typeof item !== 'string')
    ) {
      errors.push('completeness.reasons должен быть массивом строк');
    }
    if (!isFiniteNumber(completeness.observedSince)) {
      errors.push('completeness.observedSince обязателен');
    }
  }

  const nonSerializable = findNonSerializable(value, 'report');
  if (nonSerializable) errors.push(nonSerializable);

  return { valid: errors.length === 0, errors };
}

export function assertValidJsonReport(report: JsonReport): void {
  const validation = validateJsonReport(report);
  if (!validation.valid) {
    throw new Error(`Отчёт не прошёл проверку схемы: ${validation.errors.join('; ')}`);
  }
}
