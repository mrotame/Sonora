// Presentation of each scenario on the initial screen: icon and backdrop screenshot(s).
// Kept here, keyed by scenario id, so the generic scenario registry stays free of UI assets.
// A scenario without an entry still works: it gets a generic icon and no backdrop.
import type { ReactNode } from 'react';
import synthwaveUrl from './img/synthwave.webp';
import overworldUrl from './img/overworld.webp';
import netherUrl from './img/nether.webp';

export interface ScenarioArt {
  icon: ReactNode;
  /** One image, or two shown split by a diagonal (left | right). */
  backdrops: string[];
}

const FALLBACK: ScenarioArt = {
  icon: <svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="14" /></svg>,
  backdrops: [],
};

const ART: Record<string, ScenarioArt> = {
  synthwave: {
    icon: (
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <circle cx="24" cy="17" r="8" />
        <path d="M17 15h14M16.5 19h15" />
        <path d="M4 32l10-9 7 6 6-6 9 9" />
        <path d="M4 32h40M4 38h40M12 32l-6 12M24 32v12M36 32l6 12" />
      </svg>
    ),
    backdrops: [synthwaveUrl],
  },
  'voxel-dreamscape': {
    icon: (
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <path d="M24 5l16 9v20l-16 9-16-9V14z" />
        <path d="M8 14l16 9 16-9M24 23v20" />
      </svg>
    ),
    // Overworld | Nether
    backdrops: [overworldUrl, netherUrl],
  },
};

export function artFor(scenarioId: string): ScenarioArt {
  return ART[scenarioId] ?? FALLBACK;
}
