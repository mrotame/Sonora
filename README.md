# Sonora

Sonora is a web application that analyzes a piece of music and generates a procedural 3D world synchronized with it in real time.

The idea goes beyond an audio visualizer or equalizer. The music shapes the world itself: its geometry, architecture, lighting, particles, atmosphere, and camera motion.

> A personal portfolio project, under development. Not a commercial product.

## How it works

1. You paste the URL of a public YouTube video and choose a scenario.
2. A small backend obtains the audio and delivers it to the browser.
3. On your device, the audio is decoded and analyzed (energy, frequency bands, transients, BPM, beats, and structural changes).
4. The world is generated deterministically and the music starts playing automatically.
5. The camera moves forward in a straight line through the world until the music ends. You can look around with the mouse or by dragging a finger, and the view slowly returns to the center on its own.

There is no pause, seek, or other playback control in the current version.

## Scenarios

| Scenario | Description |
|---|---|
| **Voxel Dreamscape** | A surreal voxel world with cubic structures, floating blocks, and a colorful atmosphere. |
| **Synthwave Dimension** | A retro-futuristic environment with stylized mountains, luminous grids, and a synthwave horizon. The camera speed and the road's elevation follow the pace of the music. |
| **Cybernetic Corridor** | A dark, dense industrial corridor with metallic architecture and directional lighting. |

The names are provisional. The concept art references are in [docs/](docs/).

## Determinism

The same audio file (identical bytes) and the same scenario generate the same world. The audio identity is the SHA-256 of the received file, and the world seed combines that identity with the scenario and the generation versions. The visual state can be reconstructed at any point in the track.

Numeric differences in decoding between browsers or devices may slightly change the analysis. This limitation is documented and accepted.

## Tech stack

- TypeScript
- React 19
- Vite
- Three.js (WebGL 2, GLSL ES 3.00)
- Web Audio API for decoding
- In-house audio analysis written in TypeScript, running in a Web Worker
- Node.js + TypeScript backend that uses [yt-dlp](https://github.com/yt-dlp/yt-dlp) only to obtain and deliver the audio

All analysis, procedural generation, and rendering happen on the user's device. The backend does not analyze music or store music data.

## Running locally

Requirements: Node.js 24 or later and, for the backend, `yt-dlp` installed and available on your PATH.

```bash
npm install

# frontend (Vite dev server)
npm run dev

# audio acquisition backend (in another terminal)
npm run server
```

Other scripts:

```bash
npm run typecheck   # type checking (frontend and server)
npm test            # tests
npm run build       # typecheck + production build
```

## Documentation

The documentation in [docs/](docs/) is the project's source of truth:

- [PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md): product goals, experience, and requirements.
- [TECHNICAL_ARCHITECTURE.md](docs/TECHNICAL_ARCHITECTURE.md): modules, data flow, and conventions.
- [TECH_STACK.md](docs/TECH_STACK.md): technology decisions (ADRs).

## Audio acquisition notice

Audio is obtained using unofficial YouTube media-extraction techniques. This is a deliberate choice for a personal, unpublished, non-commercial prototype. It comes with no platform approval, no guarantee of long-term reliability, and no legal clearance. The project does not offer music downloads to users.
