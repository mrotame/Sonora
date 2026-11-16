// Registry of the pure scenario logic, safe to import from the Worker.
import type { ScenarioLogic } from './types.ts';
import { synthwaveLogic } from './synthwave/logic.ts';

export const scenarioLogics: Record<string, ScenarioLogic<unknown, unknown>> = {
  [synthwaveLogic.id]: synthwaveLogic as ScenarioLogic<unknown, unknown>,
};
