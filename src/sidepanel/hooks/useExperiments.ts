import { useCallback, useEffect, useState } from 'react';
import type { Experiment, ExperimentInput } from '../../types/experiment';
import { generateId } from '../../utils/id';

interface StartResponse {
  experiment?: Experiment;
  error?: string;
}

export function useExperiments(sessionId: string | undefined) {
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      const response = (await chrome.runtime.sendMessage({
        type: 'EXPERIMENT_LIST',
        requestId: generateId(),
      })) as { experiments?: Experiment[] } | undefined;
      setExperiments(response?.experiments ?? []);
    } catch (err) {
      console.error('[WPA UI] Failed to load experiments:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, sessionId]);

  const start = useCallback(async (input: ExperimentInput) => {
    setError(undefined);
    const response = (await chrome.runtime.sendMessage({
      type: 'EXPERIMENT_START',
      requestId: generateId(),
      ...input,
    })) as StartResponse | undefined;

    if (response?.error) {
      setError(response.error);
      return undefined;
    }
    await refresh();
    return response?.experiment;
  }, [refresh]);

  const finish = useCallback(async (experimentId: string) => {
    setError(undefined);
    const response = (await chrome.runtime.sendMessage({
      type: 'EXPERIMENT_FINISH',
      requestId: generateId(),
      experimentId,
    })) as { experiment?: Experiment; error?: string } | undefined;
    if (response?.error) setError(response.error);
    await refresh();
    return response?.experiment;
  }, [refresh]);

  const cancel = useCallback(async (experimentId: string) => {
    setError(undefined);
    const response = (await chrome.runtime.sendMessage({
      type: 'EXPERIMENT_CANCEL',
      requestId: generateId(),
      experimentId,
    })) as { experiment?: Experiment; error?: string } | undefined;
    if (response?.error) setError(response.error);
    await refresh();
    return response?.experiment;
  }, [refresh]);

  const activeForSession = experiments.find(
    (experiment) =>
      experiment.status === 'running' &&
      (experiment.baselineSessionId === sessionId || experiment.experimentSessionId === sessionId),
  );
  const activeExperiment = activeForSession ?? experiments.find(
    (experiment) => experiment.status === 'running',
  );

  return {
    experiments,
    activeExperiment,
    isLoading,
    error,
    start,
    finish,
    cancel,
    refresh,
  };
}
