
# Sonora - Product Specification

> **Document purpose:** define what Sonora is, the experience it should provide, and the product-level rules its implementation must satisfy.
>
> **Status convention:** `DECIDED` means approved; `PROPOSED` means a candidate approach not yet approved; `OPEN` means unresolved.

## 1. Project overview

### 1.1 Concept

**DECIDED** — Sonora is a web application that takes a music source, analyzes its audio, and generates a procedural 3D visual world synchronized with the music.

The experience must go beyond a conventional audio visualizer or equalizer. Music should influence the world itself: its geometry, architecture, lighting, particles, atmosphere, deformations, and motion.

### 1.2 Project goals

- Create an immersive, music-synchronized 3D experience.
- Offer multiple visually distinct worlds that the user can choose from.
- Make the music meaningfully shape the environment, rather than merely driving bars or waveforms.
- Keep the experience visually compelling while using efficient techniques that avoid unnecessarily demanding hardware.
- Make the generated experience reproducible for the same audio content and scenario, within the defined determinism constraints.

### 1.3 Project context

**DECIDED** — Sonora is a personal portfolio project. The initial goal is to build a compelling and technically sound experience, not a commercial product.

## 2. User experience

### 2.1 Main flow

**DECIDED** — The MVP user flow is:

1. The user opens the application.
2. On the initial screen, the user provides a public YouTube video URL and chooses a visual scenario on that same screen.
3. The user presses the start button.
4. The application transitions to a loading screen.
5. During loading, Sonora obtains and processes the audio, analyzes the music, and prepares the deterministic world.
6. When preparation is complete, music playback and the visual experience start automatically.
7. The experience and world progression end when the music ends.

The exact visual design of the initial and loading screens remains an implementation/design detail to be established.

### 2.2 Playback behavior and controls

**DECIDED** — The MVP does not provide user-facing playback controls.

There will be no:
- Pause or resume.
- Seek.
- Rewind or fast-forward.
- Playback-speed adjustment.
- User-facing playback interruption controls.

The music starts automatically once loading and preparation are complete. The world advances during playback and the experience ends when the music ends.

This restriction applies to the user interface and MVP interaction model. It does **not** remove the underlying deterministic requirement to calculate or reconstruct world state at an arbitrary timestamp.

### 2.3 Camera and user perspective

**DECIDED**
- The camera represents the user and is the protagonist/perspective of the experience.
- The camera continuously advances forward in a straight line.
- The camera's forward movement is independent of its viewing direction.
- The user can look horizontally to either side, within a maximum range of 65 degrees from the forward direction (changed from 45 to 55 degrees on 2026-11-15 and to 65 degrees on 2026-11-16, user-authorized).
- The user can also look vertically, within independent limits of 55 degrees upward and 30 degrees downward (changed from 45/45, user-authorized 2026-11-15).
- The angular limits are independent on each axis. They do not define a combined viewing cone.
- The permitted viewing limits are:
  - Left: -65 degrees.
  - Right: +65 degrees.
  - Up: +55 degrees.
  - Down: -30 degrees.
- Looking around must not change the direction or route of forward movement.
- The camera is not free-look. Whenever the user stops moving the mouse (desktop) or lifts the finger (mobile), the view returns slowly and automatically to the forward-facing center.
- Look input: mouse movement on desktop and finger drag on mobile. Gyroscope input is not part of the MVP.
- The experience should be automatic; the user should not need to manually tune frequency mappings, musical sensitivity, lighting, or procedural-generation parameters.
- Vehicles, characters, creatures, and other entities may appear in the environment, provided they are secondary elements with behavior independent of the camera. They must not become a player-controlled protagonist or determine the camera's route.

### 2.4 Loading, errors, and atypical audio

**DECIDED — Loading**
- The loading screen shows the stages in sequence: obtaining the audio, preparing, analyzing, generating the world.
- A progress indicator with percentage is shown only where real progress data exists; audio acquisition on the backend shows state only.
- Each stage has a timeout; on expiry it becomes an error with the option to try again.

**DECIDED — Errors**
- Failures of acquisition (backend unavailable; video invalid, private, too long, live, or blocked), decoding, or the Worker are fatal to the experience.
- Uncertain analysis is not a failure: when tempo, beats, or structure are unreliable, scenarios degrade gracefully and rely on energy and transients.
- Error messages are one clear, non-technical sentence stating what happened and what the user can do. Every error returns the user to the initial screen with the URL preserved.
- No hidden automatic retry in the MVP, except a simple retry on transient network failures while polling job status. The user decides whether to try again.

**DECIDED — Atypical audio**
- Silent or near-silent audio: the timeline is flat and the world stays calm and stable; not an error.
- Very short tracks: accepted, with no minimum duration in the MVP.
- Abrupt endings or trailing silence: the music is considered to end at its last non-silent moment (the audio itself is never trimmed). The experience then runs the end-of-experience epilogue below, so trailing silence longer than the epilogue is not played to the end (changed 2026-11-15, user-authorized; previously the world continued until the audio ended).
- Unstable tempo or no clear pulse: low beat confidence; scenarios rely on energy and transients.
- Tracks over 10 minutes: rejected at backend validation with a specific message.

**DECIDED — End of experience** — When the music ends, a 5-second epilogue follows: the camera keeps moving slowly (50 km/h in scenarios with a music-driven path) while the screen fades to black, and then the experience ends and a simple final screen offers a way back to the start. Its content is a design detail. (Changed 2026-11-15, user-authorized; previously the experience ended exactly when the audio ended.)

**DECIDED — Voxel Dreamscape pace (2026-11-15, user-requested)** — In Voxel Dreamscape the camera stays low over a flat river; its speed follows the music's intensity on the same scale as Synthwave Dimension (100..600 km/h, cruise 280 km/h) and its field of view widens with the speed. The road stays flat (no climbs or descents) and no speed graph is shown. The epilogue speed is the same 50 km/h. The camera height is an initial choice and may change after the first visual review.

**DECIDED — Calm ending (Synthwave Dimension, 2026-11-15, user-requested)** — When the last 10 seconds of music are calm or fade out, the road becomes straight and flat for them, so the final shot shows the city and the sunset together. An intense ending keeps following the music.

## 3. Visual experience and scenarios

### 3.1 Visual direction

**DECIDED**
- Worlds may be abstract, surreal, stylized, or inspired by recognizable environments.
- Photorealism is not a requirement.
- Stylization is preferred when it helps avoid uncanny-valley results.
- Different scenarios should have clearly distinct visual identities.
- The MVP includes three initial scenarios based on the three concept-art references supplied for the project.

### 3.2 Initial scenarios

**DECIDED** — The MVP will include these three visual directions:

1. **Voxel Dreamscape** — a surreal voxel-like world with cubic structures, floating blocks/platforms, vegetation or fantastic environmental elements, and a colorful, atmospheric presentation.
2. **Synthwave Dimension** — a retro-futuristic geometric environment with stylized mountains, luminous grid-like surfaces or lines, and a synthwave horizon.
3. **Cybernetic Corridor** — a dark futuristic industrial environment with dense metallic/mechanical architecture and directional technological lighting.

These names are provisional identifiers for discussion, not final product names. The supplied concept arts are visual references, not a requirement to reproduce every pixel or detail literally.

### 3.3 Scenario behavior

**DECIDED**
- The user chooses one of the available scenarios on the initial screen.
- The rest of the visual interpretation is automatic.
- Each scenario defines its own visual language and its own rules for interpreting musical information.
- Scenarios use shared music-analysis capabilities, but do not need to map musical features to visuals in the same way.
- The three initial scenarios share the same underlying application infrastructure; they are not three independent applications or pipelines.

Example mappings are illustrative, not approved final implementations:
- Low frequencies may influence building illumination in one scenario and terrain deformation in another.
- A musical climax may reorganize floating structures in one world, intensify a synthwave landscape in another, or activate mechanical architecture in a third.

### 3.4 Extensibility

**DECIDED** — The project should support adding new scenarios without redesigning the entire music-analysis or rendering system.

**DECIDED** — Scenarios are authored as code modules with typed configuration (see `TECHNICAL_ARCHITECTURE.md` Section 9).

## 4. How music influences the world

### 4.1 Multiple levels of musical information

The experience combines three levels of musical interpretation.

**DECIDED — Reactive**
- Amplitude and volume.
- RMS / signal energy.
- Spectrum and spectral characteristics.
- Frequency bands.
- Transients.

**DECIDED — Rhythmic**
- BPM estimation.
- Beat positions / beat tracking.
- Measures and subdivisions, where they can be inferred reliably.
- Rhythmic patterns and impacts.

**DECIDED — Interpretive**
- Structural sections and changes.
- Introductions, where detectable.
- Transitions and pauses.
- Climax or significant increases in musical intensity.
- Tension and calm.
- Unexpected changes or contrasts.

The system should combine these forms of information instead of relying on a single audio metric.

### 4.2 MVP analysis scope

**DECIDED** — The MVP targets the reactive and rhythmic capabilities above, plus practical structural/interpretive estimates that help shape the experience:
- Detecting meaningful transitions and structural changes.
- Estimating sections or phases of different musical behavior.
- Estimating climactic changes, tension, and calm.
- Representing uncertainty when an interpretation is not reliable.

The MVP does not require semantic certainty that a section is specifically a verse or chorus. A system may identify a significant increase in energy or a structural transition without assigning a conventional song-section label.

**Not required for the MVP**
- Advanced semantic recognition of verses and choruses.
- Instrument identification.
- Stem separation (for example, isolated vocals, drums, or bass).
- Music-genre recognition.
- Advanced harmonic analysis or chord progression recognition.

These may be considered future enhancements.

### 4.3 Scenario-specific interpretation

**DECIDED** — Shared analysis produces musical information that scenarios can interpret according to their own rules.

The music-analysis layer should not need to know the visual meaning of every feature. For example, a strong bass event may illuminate structures in one scenario and deform terrain in another.

## 5. Music analysis and playback synchronization

### 5.1 Pre-analysis and real-time analysis

**DECIDED** — The intended approach combines whole-track pre-analysis with real-time analysis during playback.

Pre-analysis should:
- Analyze the track as a whole.
- Identify musical structure and important events.
- Produce information that can be used to plan visual changes in advance.
- Help keep major world-generation decisions stable and reproducible.

Real-time analysis should:
- Complement pre-analysis with playback-time amplitude and spectral details.
- Detect or refine transients and immediate impacts.
- Support responsive visual details.

**DECIDED** — Real-time audio analysis must not be the sole source for major procedural geometry decisions. Small playback or analysis variations should not cause the core world layout to change unpredictably.

Real-time analysis may influence smaller visual variations and reactive details, but major structural decisions must rely on the deterministic information established during pre-analysis and world generation.

### 5.2 Audio source

**DECIDED** — The MVP starts with a user-provided public YouTube video URL.

The source integration should remain isolated from the rest of the application so that the audio pipeline is not permanently coupled to YouTube.

**DECIDED** — The intended processing experience is temporary in-memory audio processing; the application is not intended to provide a music-download feature to users.

**DECIDED — Acquisition direction (experimental MVP)** — The current direction is to use a Sonora-owned auxiliary backend service to acquire the audio from the public YouTube URL and deliver the resulting audio file to the frontend. The acquisition mechanism is expected to rely on non-official YouTube media-extraction techniques for this personal, unpublished, non-commercial prototype. This is a project-context decision, not a claim of platform approval, long-term reliability, or legal clearance. The extractor is yt-dlp (see `TECHNICAL_ARCHITECTURE.md` Section 5.1 and ADR 0008); its operational feasibility remains **OPEN** and must be validated by a spike.

**DECIDED** — The backend's responsibility is limited to audio acquisition, conversion (fallback only), temporary handling (memory or temporary disk), and delivery. It must not perform music analysis, musical intelligence, procedural generation, or 3D rendering. Those workloads remain on the user's device.

**DECIDED — Initial delivery direction** — Acquisition is asynchronous. The backend returns a job identifier; the frontend checks job status and, when processing is complete, downloads the complete audio file. The initial target is the original m4a/AAC audio stream delivered without re-encoding (revised from the earlier MP3 192 kbps target; MP3 conversion is only a fallback when no m4a stream exists), for public videos up to 10 minutes. These are initial operating parameters and may be revised after technical tests and hosting constraints are understood.

Temporary processing data may exist only for the duration required to complete the current request. It must not become persistent application data.

The user-facing input remains the YouTube video URL. The source integration must remain isolated so the acquisition mechanism can be replaced later.

## 6. Deterministic world generation and audio identity

### 6.1 Core requirement

**DECIDED** — The same acquired audio file (identical bytes) and the same scenario must generate the same world, provided the scenario version, generation version, and processing behavior remain the same.

This includes, as applicable:
- Geometry and object placement.
- Colors and visual palettes.
- Lighting behavior.
- Particle placement and motion.
- Procedural transformations.
- Other generated visual properties.

Changing the audio content or scenario should produce a different world identity.

The identity is based on the exact bytes of the audio file actually acquired for the current execution, not on the source URL itself and not on the decoded samples (see `TECH_STACK.md` ADR 0009).

### 6.2 Reconstructing an instant

**DECIDED** — The visual state must be reconstructible at an arbitrary point in the track, independently of the history of frame updates.

Examples:
- The state calculated for 2:35 must match the state that would appear at 2:35 during uninterrupted playback.
- Particle and animation states should be calculable from time, seed, and relevant musical parameters rather than relying exclusively on accumulated per-frame simulation.

The MVP does not expose seeking to the user. Arbitrary-time reconstruction remains an internal product/technical requirement for determinism and reliable state evaluation.

### 6.3 World identity and seed

**DECIDED — Identity inputs**

The world identity incorporates:
- The SHA-256 hash of the acquired audio file's bytes, exactly as delivered by the backend (the original m4a/AAC from yt-dlp, or, in production, the m4a obtained through the third-party APIs of ADR 0012).
- Scenario identifier.
- Scenario version.
- World-generation version.

Conceptual formula:

```text
Audio Identity = SHA-256(audio_file_bytes)

World Seed = HASH(
    audio_identity +
    scenario_id +
    scenario_version +
    generation_version
)
```

The SHA-256 hash is calculated over the delivered file before decoding. Decoded PCM (Section 6.4) is not part of the identity.

This is an identity for the exact delivered file, including its container and metadata. It is not robust acoustic recognition. Different encodings, mixes, edits, or cuts of the same recording may produce different hashes.

### 6.4 Canonical PCM representation

**DECIDED** — The MVP uses the following canonical PCM representation as the input of analysis and playback. It is not hashed (Section 6.3):

| Parameter | Definition |
|---|---|
| Sample rate | 44,100 Hz |
| Channels | Stereo (2 channels) |
| Sample format | Float32 |
| Channel organization | Interleaved |
| Byte order | Little-endian |
| Volume normalization | None |

The interleaved channel order is:

```text
L0, R0, L1, R1, L2, R2, ...
```

Both channels are preserved. No automatic volume normalization is applied.

The canonical PCM representation must be used consistently as the deterministic pre-analysis input.

**DECIDED** — The decoded audio is kept as two separate Float32 channels in memory (not interleaved), which avoids a copy of about 202 MiB for a 10-minute track. The values and the sample format are the canonical ones above.

### 6.5 Silence and audio boundaries

**DECIDED** — The complete audio is preserved; the identity covers the whole delivered file.

- Leading silence is preserved.
- Trailing silence is preserved.
- No automatic silence detection or trimming is applied to the audio.
- No automatic cropping is applied to the beginning or end of the audio.

Consequently, two otherwise identical recordings with different amounts of leading or trailing silence may have different audio identities.

### 6.6 Identity consistency and source changes

**DECIDED**
- The same exact audio file bytes must produce the same audio identity.
- The same audio identity, scenario identifier, scenario version, and generation version must produce the same world seed.
- The same world seed and deterministic generation behavior must produce the same world.
- The same YouTube URL with unchanged audio content should produce the same world, assuming the acquisition process delivers the same file bytes.
- If the audio associated with a URL changes, the resulting world may also change.
- The URL is a source locator, not the identity of the music.
- The MVP does not need to recognize the same musical composition across different encodings, edits, mixes, or versions.
- Small changes in audio may result in a different audio hash. The system should nevertheless avoid allowing small reactive variations to arbitrarily reorganize the central world structure.

**DECIDED — Accepted limitation** — Small technical differences in acquisition (for example a different yt-dlp version or container fixup, or a re-encoded source stream) may occasionally produce different file bytes and therefore a different audio identity, even when the source URL has not changed. This possibility is accepted in the MVP in favor of implementation simplicity and development speed.

The MVP does not require advanced acoustic fingerprinting, cross-encoding matching, or other mechanisms to identify equivalent recordings.

**DECIDED — Cross-browser determinism is not required** — The audio identity and world seed depend only on the delivered file bytes, so they are the same in every browser. The decoded samples and the musical timeline derived from them are expected to be reproducible within the same execution environment (same browser, version, and device class), but different browsers or devices may decode, resample, or analyze audio with minor numeric differences, producing a slightly different timeline and therefore a different world for the same URL. Some browsers also deliberately perturb Web Audio output between sessions as a privacy measure (measured in Brave: decoded samples differed between sessions by about 76 dB below the signal level, while Edge was bit-identical). The effect of such differences on the analysis output has not yet been measured. This is accepted in the MVP in favor of practicality. Reproducibility of identity and seed, and arbitrary-time reconstruction (Section 6.2) given the same timeline, remain required.

### 6.7 Persistence and recalculation

**DECIDED** — The MVP must not persist music-related data, with one exception: the local audio cache described below.

**DECIDED — Local audio cache (revised by the project owner)** — The client keeps the acquired audio file of each processed YouTube video in browser storage (IndexedDB), keyed by video id, so that entering the same video again does not require a new download. The cache is limited to 500 MB; the least recently used entries are evicted first. The cache is local to the browser, holds only the delivered audio bytes, and never leaves the device. If the cache is unavailable or fails, the app behaves as a cache miss. The server stays stateless.

Everything else below remains non-persistent:
- Source URLs.
- Acquired audio files (except in the local audio cache above).
- Canonical PCM data.
- Audio hashes or fingerprints.
- Music-analysis results.
- Generated world identities or seeds.
- Persistent history or catalogs of previously processed tracks.

The application must not maintain a persistent cache or catalog to associate URLs with previous audio identities or generated worlds. The audio cache stores only file bytes; identity is still computed from those bytes on every execution.

Audio acquisition, decoding, analysis, and identity calculation are performed for each execution. The audio identity is recalculated from the audio acquired and decoded during that execution.

Temporary in-memory data may be used while processing the current experience, but it must not be retained as persistent application data on the server or client.

The MVP does not guarantee that a previously generated world can be retrieved from a past execution. Reproducibility is based on receiving the same canonical audio data and using the same scenario and generation versions.

## 7. Procedural world structure

### 7.1 Segmented world

**DECIDED**
- The world is generated as a sequence of procedural segments.
- Each segment has a deterministic position and seed.
- Segments ahead of the camera should be generated in advance.
- Segments sufficiently far behind the camera should be discarded to control memory use.
- The experience should appear continuous without retaining the entire world in memory.

**DECIDED** — Segments have a fixed spatial length per scenario. They do not align with musical events; music shapes their content and the transitions between musical sections are smooth parameter changes. Camera forward speed is constant, except in Synthwave Dimension and Voxel Dreamscape (whose speed follows the music's intensity on a flat river, see Section 2.4), where the camera speed and the road elevation follow the pace of the music (Audiosurf-style, continuously and second by second: calmer moments go uphill and slower, more intense moments go downhill and faster, in proportion to how much the music changes, so a gentle climb brakes a little and a steep one brakes a lot, and the cruise speed depends on the music's intensity rather than jumping to the maximum on any descent; see `TECHNICAL_ARCHITECTURE.md` Section 11). Seams are avoided through continuous world-space fields and an origin-point ownership rule for discrete objects (details in `TECHNICAL_ARCHITECTURE.md` Section 8.1).

**DECIDED — Speed graph (2026-11-15, user-requested, Synthwave Dimension only)** — Scenarios whose camera speed follows the music show a small non-interactive graph in the top-right corner (Audiosurf-style): the road height profile over the whole track (climbs rise, descents fall; already-played part dimmed), a dot at the current instant and a speed readout (km/h). The line is colored by the road slope: white when flat, shifting to green on climbs and to red on descents, fully saturated at the steepest slope. Scenarios with constant speed do not show it.

**OPEN**
- Concrete segment length per scenario and the exact retention window (to be calibrated by profiling).

## 8. Execution and performance constraints

### 8.1 Client-side processing

**DECIDED** — All product processing other than source acquisition/delivery must run on the user's device. A Sonora-owned auxiliary backend is permitted solely for acquiring, converting (fallback only), temporarily handling (memory or temporary disk), and delivering the source audio. The backend must not perform audio analysis, music intelligence, procedural generation, or 3D rendering.

The user's device is the practical limit on processing capacity. The product will not impose artificial usage quotas or a fixed limit on the number of tracks a user may experience.

This does not imply unlimited performance. The implementation should be designed to work on devices with reasonable processing and 3D graphics capabilities.

### 8.2 Visual quality and efficiency

**DECIDED**
- The goal is to create visually attractive and expressive worlds without unnecessarily heavy techniques.
- Prefer efficient geometry, reusable resources, and restrained shader complexity where they preserve the intended visual quality.
- Avoid making expensive visual effects mandatory when a lighter alternative can deliver a comparable result.
- Performance and memory use are important design constraints, not reasons to reduce the experience to a basic audio visualizer.

**DECIDED — Performance target** — The target is 60 FPS at 1080p. Desktop and mobile devices are both in scope for the MVP.

Exact minimum hardware, minimum acceptable frame rate, and quality adaptation remain **OPEN** and should be established through profiling on representative devices, including mobile.

## 9. MVP scope summary

**DECIDED — MVP includes**
- A public YouTube video URL as the initial music input.
- Scenario selection on the same initial screen as URL entry.
- A loading/preparation screen after the user starts the experience.
- Backend-assisted audio acquisition and delivery, with decoding, analysis, music intelligence, procedural generation, and rendering on the client.
- Temporary in-memory processing without persistent storage of music-related data.
- Whole-track pre-analysis combined with real-time audio analysis.
- Reactive, rhythmic, and practical structural/interpretive analysis as described in Section 4.2.
- Three initial scenarios based on the supplied concept arts.
- Automatic playback and world progression once preparation is complete.
- No user-facing pause, resume, seek, rewind, fast-forward, or speed controls.
- A continuously forward-moving first-person camera with horizontal look limited to ±65° and vertical look to +55° up and -30° down, independently.
- Secondary environmental entities are allowed, provided they do not become the protagonist or control the camera route.
- Deterministic world identity based on SHA-256 of the delivered audio file bytes, scenario identifier, scenario version, and generation version.
- Canonical PCM representation (44,100 Hz, stereo, Float32, little-endian, no volume normalization) as the input of analysis; it is not hashed.
- Preservation of leading and trailing silence (no trimming).
- Recalculation of audio identity on every execution, without catalog, history, or identity cache. Only the audio file itself is cached locally (Section 6.7).
- Acceptance of occasional identity differences caused by technical acquisition variations, and of minor analysis differences between browsers, devices, and sessions caused by decoding numerics.
- Mouse (desktop) and touch-drag (mobile) look input with automatic slow recentering.
- A 60 FPS at 1080p target on desktop and mobile.
- Defined loading, error, and atypical-audio behavior (Section 2.4).
- Deterministic arbitrary-time state reconstruction.
- Procedural world generation using managed segments.
- Music analysis, music intelligence, procedural generation, and rendering on the client; a narrowly scoped acquisition/delivery backend is allowed.

**OPEN**
- Minimum acceptable performance floor and the exact supported browsers/devices (the 60 FPS at 1080p target and mobile inclusion are decided in Section 8.2).
- Whether scenario previews are shown on the initial screen.
- Exact scenario names and visual details beyond the approved concept-art direction.

## 10. Out of scope or not yet committed

The following are not approved requirements unless explicitly added later:
- Photorealistic rendering.
- User-facing controls for detailed musical mappings.
- Manual editing of procedural-generation parameters.
- User-facing playback controls in the MVP.
- Advanced acoustic fingerprinting or recognition of equivalent recordings across different encodings.
- Cataloging, history, or persistent storage of generated identities and analysis results (the local audio file cache of Section 6.7 is the only exception).
- Instrument identification, stem separation, or advanced semantic music understanding.
- Technology choices beyond those approved in `TECH_STACK.md` (for example a specific audio-analysis library, which is not adopted).

## 11. Open product questions

1. What is the minimum acceptable frame rate floor and hardware capability (the 60 FPS at 1080p target is decided)?
2. Should scenario previews be shown on the initial screen?

## 12. Change policy

This document is the product-level reference for Sonora. Technical implementation approaches marked `RECOMMENDED` in the architecture documents are guidance, not product requirements; an implementation agent may propose a better approach when it identifies concrete problems or improvements, while preserving the approved product behavior. Changes to approved behavior should be intentional and reflected here. When a proposed technical solution changes the user-visible experience or a product requirement, update this document as well as the technical architecture.
