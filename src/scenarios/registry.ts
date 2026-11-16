// Main-thread registry of scenarios (logic + Three.js scene). Adding a scenario
// means adding its module here and its pure logic to `logics.ts` for the Worker.
import type { ScenarioDefinition } from './types.ts';
import { synthwaveLogic } from './synthwave/logic.ts';
import { SynthwaveScene } from './synthwave/scene.ts';

export const scenarios: ScenarioDefinition[] = [
  {
    logic: synthwaveLogic as ScenarioDefinition['logic'],
    label: 'Synthwave Dimension',
    createScene: () => new SynthwaveScene(),
  },
];
