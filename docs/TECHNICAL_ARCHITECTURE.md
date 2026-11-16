# Sonora - Technical Architecture

> **Document purpose:** describe how Sonora should be implemented, including technical choices, system boundaries, data flow, and engineering conventions.
>
> This is an initial architecture baseline, not a claim that every technology or implementation detail has already been validated.
>
> **Status convention:** `DECIDED` means an approved product/architectural direction or constraint; `RECOMMENDED` means a preferred implementation approach that is not mandatory and may be replaced when an implementation agent identifies a concrete problem or improvement; `PROPOSED` means a candidate requiring discussion/approval; `OPEN` means unresolved.
>
> **Agent flexibility rule:** `RECOMMENDED` approaches are not hard requirements. An agent may adapt or replace them based on technical evidence, compatibility, performance, maintainability, or better design. It must explain the reason, preserve all `DECIDED` requirements, and update the relevant documentation/decision record when the change is material. Do not silently promote a recommendation to a mandatory constraint.

## 1. Architectural goals

The architecture must support the product requirements in `PRODUCT_SPEC.md`, especially:

- Deterministic generation and arbitrary-time reconstruction.
- Separation between generic music analysis and scenario-specific visual interpretation.
- Efficient procedural generation and rendering.
- Extensible visual scenarios.
- A replaceable audio-source integration.
- Manageable memory and CPU/GPU use.
- A simple MVP implementation that prioritizes user experience and avoids unnecessary infrastructure.

**DECIDED** — Audio analysis, music intelligence, procedural world generation, and 3D rendering execute on the user's device. A narrowly scoped Sonora-owned auxiliary backend is approved for source acquisition and delivery only: it may acquire the YouTube media, convert it, temporarily store it, and deliver the resulting file. It must not perform the client-side workloads listed above.

**DECIDED — Acquisition direction (experimental MVP)** — Use a backend-assisted, asynchronous acquisition flow based on non-official YouTube media extraction for this personal, unpublished, non-commercial prototype. This does not establish platform approval, legal clearance, or long-term reliability. The extractor is yt-dlp (Section 5.1, ADR 0008); its operational viability remains open and must be validated by a spike. Keep the acquisition adapter replaceable and the architecture agnostic of hosting provider.

**DECIDED** — The initial MVP includes three distinct visual scenarios based on the approved concept-art directions. They must share generic infrastructure for audio analysis, world identity, procedural generation, camera/experience orchestration, and rendering, while retaining scenario-specific composition and musical interpretation.

**DECIDED** — The MVP must not introduce a music catalog, playback history, or a persistent identity cache. Music processing and its derived data are temporary and limited to the current execution. The only persisted music data is the client-side audio file cache (ADR 0010).

Prefer clear module boundaries and deterministic data flow over premature abstraction.

## 2. High-level architecture

**RECOMMENDED** — Organize the application around the following logical systems. These are responsibility boundaries, not mandatory one-to-one classes, packages, processes, or services; revise the decomposition if implementation evidence supports a better structure:

1. **Audio Source Adapter** — obtains audio from a source and exposes a normalized input to the audio pipeline.
2. **Audio Processing Engine** — decodes and analyzes audio, producing signal-level features and the canonical PCM representation.
3. **Music Intelligence Engine** — derives rhythmic and interpretive musical information and builds a track timeline.
4. **World Identity / Generation Context** — creates the deterministic identity and seeds used by generation.
5. **World Generation Engine** — creates procedural world segments and resolves their deterministic parameters.
6. **Scenario System** — supplies scenario-specific interpretation rules, assets, and visual composition.
7. **Visual Systems / Renderer** — renders geometry, lighting, particles, atmosphere, and effects.
8. **Experience Controller** — coordinates playback time, camera input, world streaming, and rendering.

These are logical responsibilities. They do not yet prescribe a one-class-per-module implementation or a final directory structure.

## 3. Data flow

**RECOMMENDED** — The primary data flow is:

```text
User Input (YouTube URL + Scenario Selection)
    |
    v
Audio Source Adapter
    |
    v
Auxiliary Acquisition Backend
    |
    v
Temporary Audio File Delivery
    |
    v
Delivered audio file (bytes)
    |
    +----> Audio Identity (SHA-256 of the file bytes)
    |
    v
Client-side Audio Processing Engine (decode -> canonical PCM)
    |
    v
Music Intelligence Engine
    |
    +----> Musical Timeline
    |
    v
World Identity + Scenario Configuration
    |
    v
World Generation Engine
    |
    v
World State(t)
    |
    v
Visual Systems / Renderer
    ^
    |
Experience Controller (playback time, camera, segment streaming)
```

The central conceptual separation is:

```text
Audio Identity + Scenario Configuration + Generation Version
                              |
                              v
                       World Seed
                              |
                              v
        Musical Timeline + Scenario Rules + World Seed
                              |
                              v
                         World State(t)
                              |
                              v
                           Rendering
```

The renderer should consume a resolved state and render it. It should not independently reinterpret the raw music or make nondeterministic world-generation decisions.

The URL is a source locator used to acquire audio. It is not the musical identity and must not be used as the world-generation seed.

## 4. Technology choices

### 4.1 Rendering foundation

**DECIDED** — The selected rendering stack is Three.js + WebGL 2 + GLSL ES 3.00, integrated directly and independently from React. The authoritative technology decisions and rationale are recorded in `TECH_STACK.md` (ADR 0005).

**OPEN**
- Exact Three.js version and dependency policy.
- Whether a specific post-processing library is justified.
- Whether WebGPU should be evaluated in a future iteration; it is not part of the initial baseline.

### 4.2 Performance techniques

**RECOMMENDED**
- Reuse geometry and material resources where possible.
- Use instanced rendering for repeated objects.
- Reuse or update geometry buffers instead of frequently allocating new ones.
- Keep post-processing limited and optional.
- Prefer simple shader operations and avoid expensive effects as baseline requirements.
- Avoid ray tracing and complex global illumination.

**DECIDED** — Performance target: 60 FPS at 1080p, on desktop and mobile devices (see `PRODUCT_SPEC.md` Section 8.2).

**PROPOSED** — Automatic dynamic resolution scaling (lowering and restoring the renderer pixel ratio based on measured frame time, with a lower bound) as the primary quality adaptation, with no user-facing quality controls; an internal diagnostics overlay (frame time, draw calls, triangles, GPU memory) from the first prototype. Not yet approved.

Performance decisions must be validated by profiling on representative target devices, including at least one mobile device and a deliberately weaker desktop profile, since the development machine is high-end.

## 5. Audio pipeline

### 5.1 Audio Source Adapter

**DECIDED** — The rest of the application must not depend directly on the YouTube URL or a specific source-acquisition implementation.

**PROPOSED** — Define a source abstraction that can provide the audio data or decoded stream required by the processing engine, plus source metadata and lifecycle/error information.

**DECIDED — Acquisition and delivery direction**
- A Sonora-owned backend service performs source acquisition and delivery only.
- The backend uses an asynchronous job model with a `job_id`.
- The frontend checks job status until completion or failure, then downloads the complete audio file.
- The backend delivers the original m4a/AAC audio stream without re-encoding (replaces the earlier MP3 192 kbps target). It always requests the same format to keep identity differences minimal. Conversion (for example to MP3 via ffmpeg) is only a fallback when no m4a stream exists. Opus/WebM is avoided as the default because of inconsistent Safari support.
- Initial maximum source duration: 10 minutes.
- The resulting file is stored temporarily and is not intended to become a permanent user music library.
- Hosting: Cloud Run for the backend and GitHub Pages for the frontend (ADR 0011). The code must stay hosting-agnostic: provider specifics live only in the Dockerfile, the workflows, and environment variables.

**DECIDED — Backend implementation**
- Extractor: yt-dlp, behind the replaceable source adapter. Runtime: Node.js + TypeScript, invoking yt-dlp (and ffmpeg only for the fallback) as subprocesses; HTTP contract types may be shared with the frontend.
- Job state is held in memory only (no database). A service restart loses jobs, which is acceptable for the MVP.
- Temporary files are deleted after the first completed download, with a safety TTL after job completion and cleanup of orphaned files at startup. Initial values (for example a 10-minute TTL, 2 to 3 concurrent jobs, a maximum file size, and a per-job timeout) are starting points, not decisions.
- Input is validated: only recognized public YouTube video URLs are accepted (no playlists or live streams), duration is checked from metadata before download, and a simple per-IP rate limit applies.
- Hosting requirements (not a provider choice): long-running processes, yt-dlp installable, temporary disk.
- **Feasibility spike required before building the backend:** (1) yt-dlp downloads the m4a on the target host without being blocked; (2) `decodeAudioData` decodes the file in Chrome, Firefox, and Safari; (3) decoding time for a 10-minute track is acceptable.

**Spike status (partial, 2026-11-15; Windows development machine, residential IP):**
- yt-dlp 2026.10.26 downloaded format 140 (m4a AAC-LC, about 130 kbps, 44.1 kHz stereo) from 3 public videos (3:26, 4:16, 7:08) without blocking, in about 10 s each. The file bytes were identical across repeated downloads. yt-dlp applies a container fixup (`FixupM4a`). One repeated download failed once without a diagnosed cause; the backend must handle transient failures.
- `decodeAudioData` was validated only in Chromium-based browsers (Edge 157 and Brave, headless, desktop). Firefox and Safari were not tested; the supported-browser set remains **OPEN**.
- Decoding a 10-minute synthetic track (three tracks concatenated) took about 0.75 to 1.3 s. Its canonical PCM is 202 MiB. In Brave the process memory grew by about 560 to 600 MiB for a single decode. Mobile has not been measured yet.
- Brave's decoded samples differ between sessions (about 76 dB below signal level); Edge's are bit-identical. This motivated ADR 0009.
- **Not yet validated:** a datacenter or hosting IP (the main blocking risk), rejection of live, private, or over-10-minute videos (no test URLs), a video without an m4a stream, and any mobile device.

These are approved initial direction/operating parameters, subject to validation in the prototype. Realistic execution time, storage, transfer, and provider limits remain open.

**DECIDED — No persistent music data, except the local audio cache**
- The application must not persistently store source URLs, audio identities, fingerprints, analysis results, or music-related history. Audio files are persisted only in the client audio cache below.
- This restriction applies to both the client and the auxiliary backend; the backend persists nothing.
- **Local audio cache (ADR 0010):** `src/audio/sources/audioCache.ts` stores the delivered audio bytes in IndexedDB keyed by YouTube video id (extracted by `shared/youtubeUrl.ts`), limit 500 MB with least-recently-used eviction. `acquireAudio` in `backendSource.ts` checks it before calling the backend and stores the result after a download. Cache errors are treated as a miss. Nothing else (identity, PCM, analysis) is cached.
- The backend may temporarily hold the acquired audio file only as required to complete the current acquisition and delivery job.
- Temporary data must be discarded after its operational purpose is fulfilled.
- The frontend may hold audio, PCM, analysis data, and generation context in memory for the current experience.
- World identity must be recalculated for every new execution.
- No persistent cache, catalog, history, or URL-to-identity mapping should be implemented to force identity continuity between executions.

**DECIDED — HTTP contract (initial, implemented in `shared/contract.ts`)**
- `POST /api/jobs` with `{url}` returns `202 {jobId}`; errors return `{errorCode}` (`INVALID_URL` 400, `RATE_LIMITED` 429, `BUSY` 503).
- `GET /api/jobs/:id` returns `{jobId, status, errorCode?}` with `status` in `queued | fetching_metadata | downloading | ready | failed`.
- `GET /api/jobs/:id/audio` returns the m4a (`audio/mp4`) once ready; the file and the job are deleted after the first complete download (later requests return 404).
- Error codes: `INVALID_URL, UNAVAILABLE, LIVE, TOO_LONG, TOO_LARGE, BLOCKED, TIMEOUT, DOWNLOAD_FAILED, BUSY, RATE_LIMITED, NOT_FOUND`. The frontend maps them to one non-technical sentence each. The backend keeps no URL after the job runs and logs no media data (extractor diagnostics only with `SONORA_DEBUG=1`).
- The frontend polls every 700 ms, retries only network failures (3 times), and gives up after 150 s (initial values).
- The backend retries a job's metadata and download steps up to 2 extra times (1.5 s, then 3 s) only for the generic failure `DOWNLOAD_FAILED`, inside the job timeout. Unavailable, live, too long, too large, blocked and timeout are definitive and never retried (`server/retry.ts`). Added after a single unexplained failure in the first manual test.
- Operating values (concurrency 2, queue 10, job timeout 120 s, ready TTL 10 min, max file 30 MiB, 10 requests per minute per IP) are configurable starting points, not decisions. Rate limiting uses the last `X-Forwarded-For` entry when `TRUST_PROXY=1` (set in the Docker image); its behavior behind the Cloud Run proxy is not yet verified.

**OPEN** — The calibrated operational limit values, and whether Cloud Run's CPU throttling and in-memory `/tmp` are acceptable for background jobs and the egress counter.

**Implementation status (2026-11-15):** the backend (`server/`) and the frontend adapter (`src/audio/sources/backendSource.ts`) and decoding module (`src/audio/processing/decode.ts`) are implemented and verified locally end to end with the 3 test videos in Edge and Brave (identity equals the SHA-256 of the file in all cases). Failure paths verified locally: invalid URL, playlist URL, unavailable video, duration above the limit (with a lowered limit), and backend not running. Not verified: live and private videos, a video above 10 minutes, any datacenter host.

**Implementation status of the first scenario (2026-11-15):** the vertical slice runs end to end with Synthwave Dimension (code only, not yet a scenario selection UI beyond one entry): acquisition, hashing, decoding, Worker analysis (energy, bass, mid, high and spectral flux at 100 Hz, each normalized by its own 98th percentile), seeds by named path, constant-speed camera (`distance = speed * t` from the audio clock), look limited to +-45 degrees with recentering, segment window (L = 80, 5 ahead, 1 behind, starting values) and a diagnostics overlay in development builds only. Verified in headless Edge and Brave (software rendering, so frame rates are not representative) with screenshots and without GL or console errors. Not done: beats, sections and events (ADR 0007 spike), the other two scenarios, mobile, real-GPU profiling, dynamic resolution (still PROPOSED).

**Synthwave Dimension v2 (2026-11-15, `visual_complexity = medium`, PROPOSED visual direction approved by the user for this iteration):** the scenario version went from 1 to 2 because the terrain amplitude curve changed (mountain height now spans 0.4x to 1.5x of the base peak from the smoothed track energy, about +-2 s, baked into the segments; plus a live `mountainPulse` of up to +25% from bass applied in the terrain vertex shader). Added: three star populations (about 40% bass, 45% mid, 15% high) selected by a per-cell hash in the sky shader; a distant skyline layer (towers and ridge silhouette, in the sky shader, no streaming; later replaced by the horizon ring, Section 8.1); horizon haze and a sun halo ring; and 500 drifting embers drawn as one `Points` object whose positions are a pure function of the camera distance (no per-frame state), with density driven by energy and glow by mid and flux. Band-to-visual mappings are scenario-specific and not universal. Verified by typecheck and unit tests only; the shaders were not run on a GPU or in a browser, so visual quality, shader compilation and frame rate are unverified.

**Synthwave glow rebalance (2026-11-15, user-requested visual tuning):** grid colours are unchanged (cyan ground, magenta toward the peaks). The beat pulse (`gridGlow`) and the flux flash now apply only to the mountain peaks, weighted by height above the road; the flat ground, the plain and the road edges keep a steady glow (`GROUND_GLOW`). Embers went from 500 to 900 with six hashed colours and a brighter hot core (same point size as before); they now fall slowly (0.6 to 1.5 units/s each) and sway on track time instead of camera distance, in a box that rides with the camera, so camera speed and climbs no longer change their on-screen motion, and they fade in at the top of the box and out near the ground; and `emberGlow` / `emberDensity` were raised. No scenario version bump: only live parameters and shaders changed, not generated segments. Verified by typecheck and unit tests only; not checked in a browser.

**Synthwave ember fix (2026-11-15, user-reported bug):** embers were placed relative to the camera every frame (a box locked to the camera), so they had no forward parallax and looked like a flat overlay, while the additive, no-depth-write points still depth-tested against near mountains; their point size was a fixed pixel formula (not perspective-correct, independent of resolution, DPR and FOV), and density switched them on and off with a hard step from energy (0.45 to 1.0), so the count jumped. Now each ember has a fixed world position that wraps inside a box kept mostly ahead of the camera (10 units behind, 190 ahead), so the camera flies through them; the point size is perspective-correct for a 0.2-unit ember from the drawing-buffer height and the projection; the density threshold is soft and its range is narrower (0.65 to 1.0); and embers fade near the box's far end, its sides, very close to the camera, and when sub-pixel. Same determinism (pure function of seed, track time and camera position). Verified by typecheck and unit tests only; not checked in a browser.

**Synthwave embers on slopes (2026-11-15, user-reported bug):** the ember box's floor followed the road elevation under the camera, so on a climb the embers ahead (where the road is already higher) were inside the slope and appeared to rise out of the ground as the camera caught up. Each ember's floor now follows the road elevation at its own z: the scene samples the road from the loaded far segments every 10 units along the box (`uRoad`, same source as the horizon ring's ground samples) and the shader interpolates it. Verified by typecheck and unit tests only; not checked in a browser.

**DECIDED** — Audio decoding for analysis (after delivery), signal processing, music analysis, and music intelligence run client-side. The source adapter isolates the rest of the application from YouTube-specific acquisition details. The backend is not an analysis service.

### 5.2 Audio Processing Engine

Responsibilities:
- Decode source audio into a representation suitable for analysis.
- Convert decoded audio into the canonical PCM representation defined in Section 7.2 (analysis input).
- Extract signal-level features such as amplitude, energy, spectrum, frequency bands, and transients.
- Provide analysis data with timestamps that can be associated with playback time.
- Make the canonical PCM data available to analysis and playback. The audio identity is not derived from it (Section 7.2).

**DECIDED — Canonical PCM representation for the MVP**

The canonical PCM representation must use the following configuration:

| Parameter | Definition |
|---|---|
| Sample rate | 44,100 Hz |
| Channels | Stereo (2 channels) |
| Sample format | Float32 |
| Channel organization | Interleaved |
| Byte order | Little-endian |
| Volume normalization | None |

Interleaved channel order:

```text
L0, R0, L1, R1, L2, R2, ...
```

The canonical PCM is the input of analysis and playback. It is not hashed; the audio identity is the SHA-256 of the delivered file bytes (Section 7.2, ADR 0009).

**DECIDED** — The decoded audio is kept as two separate Float32 channels (not interleaved), avoiding a copy of about 202 MiB for a 10-minute track. A mono source is represented by the same channel twice. Interleaving, if ever needed, is a consumer-side conversion.

No volume normalization should be applied as part of canonicalization. The original amplitude dynamics must be preserved.

**DECIDED — Silence handling**
- Preserve the complete decoded audio.
- Do not automatically remove leading silence.
- Do not automatically remove trailing silence.
- Do not apply automatic silence trimming to the audio.
- Silence is part of the audio data and of the delivered file, and therefore contributes to the file hash.

**RECOMMENDED** — Keep whole-track analysis and playback-time analysis as distinct processing paths that produce compatible feature representations.

**DECIDED — Decoding path** (see ADR 0006) — Hash the delivered file bytes with `crypto.subtle` (before decoding, because `decodeAudioData` detaches its input buffer), then decode with the Web Audio API (`decodeAudioData` on a 44,100 Hz `OfflineAudioContext`) and build the canonical PCM as two separate Float32 channels. Decoding runs on the main thread; the PCM is then transferred to the Worker (ADR 0006, amended by ADR 0009). Cross-browser identical output is not required. Mono sources are duplicated to stereo (assumption to confirm).

**OPEN**
- Exact feature extraction data structures.

The canonical PCM format defines the target representation, but it does not guarantee that every browser decoder or resampling implementation will produce identical samples from every source; some browsers perturb the output between sessions (measured in Brave). Because the identity is taken from the file bytes, these differences no longer affect the identity or seed, but may slightly affect the analysis. The effect on analysis output remains to be measured once the analysis exists.

### 5.3 Music Intelligence Engine

Responsibilities:
- Estimate or derive BPM and beat positions.
- Identify beats, measures, and subdivisions where reliable.
- Detect sections, transitions, pauses, tension, calm, and climactic events.
- Combine low-level signal features with higher-level musical interpretation.
- Produce a timestamped musical timeline that scenarios can consume.

**DECIDED** — The MVP analysis scope includes reactive signal features (amplitude/RMS or energy, spectrum/frequency bands, and transients), rhythmic features (BPM/beat positions, measures and subdivisions where reliable), and structural/interpretive estimates (sections, transitions, pauses, tension/calm, and climactic changes where technically feasible). Semantic certainty is not required for labels such as verse or chorus; uncertain inferences must not be treated as guaranteed facts.

**DECIDED — Analysis implementation** (see ADR 0007) — The analysis pipeline is implemented in-house in TypeScript, with a validation spike on varied tracks for beat tracking and structure. Cross-browser determinism of analysis output is not required; same-environment reproducibility is.

**OPEN**
- Exact confidence computation per detection (the representation is decided in Section 6; graceful degradation behavior is decided in `PRODUCT_SPEC.md` Section 2.4).

## 6. Musical timeline and deterministic evaluation

**DECIDED** — Pre-analysis should provide stable information for major visual decisions. Real-time analysis complements it but must not be the only driver of major geometry.

**DECIDED** — Real-time analysis may influence smaller reactive visual variations, such as intensity, brightness, particle behavior, and other local effects. It must not arbitrarily change the structural identity or major geometry of the world.

**DECIDED — Timeline model (hybrid)** — The musical timeline combines:
- **Continuous feature tracks** sampled at a fixed rate (initial value 100 Hz, adjustable after profiling/spike): energy/RMS, frequency bands, spectral flux, and derived tension/intensity curves.
- **Discrete typed events** ordered by time and queried by binary search: beats (with bar and position in bar when reliable), sections, transitions, climaxes, pauses.
- **Confidence** values (0 to 1) on events and derived curves, plus global confidence indicators (for example tempo and beat-grid confidence), so scenarios can degrade gracefully.

The timeline is produced once by the pre-analysis, is immutable afterwards, and is evaluated statelessly by time. Playback-time analysis (for example via an `AnalyserNode`) is separate and may only drive small reactive details, never structure.

The system should support evaluation such as:

```text
musical_features = timeline.evaluate(time)
scenario_parameters = scenario.interpret(musical_features, world_seed)
world_state = world.evaluate(time, scenario_parameters)
```

This is illustrative pseudocode, not a prescribed API.

**OPEN**
- Interpolation strategy for feature tracks and the exact event/field schemas.
- How live features are reconciled with precomputed features without compromising reproducibility.
- Whether any live-only visual details are permitted, and how they remain deterministic during seeking/replay.

## 7. World identity and deterministic generation

### 7.1 Identity inputs

**DECIDED** — World identity incorporates:
- Audio identity: SHA-256 of the delivered audio file's bytes.
- Scenario ID.
- Scenario version.
- Generation version.

Conceptual formula:

```text
audio_identity = SHA256(audio_file_bytes)

world_seed = HASH(
    audio_identity +
    scenario_id +
    scenario_version +
    generation_version
)
```

The URL is not an identity input. It is only the locator used to acquire the audio.

The identity is recalculated on every execution. It must not be retrieved from persistent storage or a URL-based identity cache; only the audio bytes may come from the local audio cache, and the identity is hashed from them.

**DECIDED** — The same exact audio file bytes, combined with the same scenario ID, scenario version, and generation version, must produce the same world identity and deterministic world generation.

**DECIDED** — Different audio data may produce a different world, even if it originates from the same YouTube URL. If the audio associated with a URL changes, the resulting world may also change.

The MVP does not need to recognize that two different audio files are alternate encodings, edits, or versions of the same musical composition.

### 7.2 Audio identity and canonical PCM

**DECIDED** — Use SHA-256 over the bytes of the delivered audio file as the MVP audio identity mechanism (ADR 0009, which amends the earlier PCM-based definition). Do not implement advanced acoustic fingerprinting.

The canonical PCM representation (the input of analysis and playback, not hashed) is:

- Sample rate: 44,100 Hz.
- Channel layout: stereo.
- Channel order: left followed by right.
- Sample format: Float32.
- Organization: interleaved.
- Byte order: little-endian.
- Volume normalization: none.
- Leading and trailing silence: preserved.

The interleaved sample order is:

```text
L0, R0, L1, R1, L2, R2, ...
```

The hash is calculated over the delivered file's bytes, not over PCM.

This approach identifies the exact delivered file, including its container and metadata. It is not intended to identify equivalent musical content across alternate encodings, mixes, edits, sample-rate conversions, or cuts.

**DECIDED** — The MVP accepts that small technical differences in acquisition (for example a different yt-dlp version or container fixup) may occasionally produce a different file hash, even when the source URL is unchanged.

**DECIDED** — Do not implement identity storage to compensate for those differences. (The local audio cache incidentally keeps the same bytes for a repeated video on the same browser, but it is not meant to guarantee continuity.) Simplicity and implementation speed take priority over guaranteeing identity continuity across separate executions.

**DECIDED** — Do not trim leading or trailing silence. The whole delivered file contributes to identity.

**DECIDED** — Incomplete or failed acquisition/decoding is a fatal error handled as described in `PRODUCT_SPEC.md` Section 2.4; no partial-audio experience is attempted.

### 7.3 Deterministic random generation

**DECIDED** — Random-looking procedural output must be reproducible from stable inputs.

**DECIDED — Seeding model**
- Ambient randomness (`Math.random()`) is not used in generation; all randomness comes from seeded sources.
- Sub-seeds are derived by hashing the world seed with explicit, named, versioned paths and indices (for example world seed + `"segment"` + index + `"terrain"`), never from global counters, so adding a subsystem does not alter existing ones.
- Each scope builds its own small seeded PRNG from its sub-seed when a sequence is needed.
- Index-addressed values (for example particle N or instance N) use a stateless hash `rand(seed, n)` instead of an advancing generator, so any element can be evaluated directly at any time.
- Derivation uses a synchronous 32-bit integer hash and a small PRNG; the specific algorithms (for example cyrb53/murmur3 and sfc32) are implementation choices, not decisions.
- Changes to generation rules that alter output require incrementing the generation version.
- Generated results must not depend on iteration order, frame rate, or prior frame state.

### 7.4 Arbitrary-time world state

**DECIDED** — World state at time `t` must be reconstructible without replaying every preceding frame.

**PROPOSED**
- Evaluate animation and particle transforms from absolute track time, stable seed, and timeline parameters.
- Use closed-form or time-addressable functions where practical.
- For complex simulation that cannot be evaluated directly, investigate deterministic checkpoints or reproducible simulation windows.
- Ensure seeking backward and forward produces the same result for the same timestamp and inputs.

**OPEN** — Identify any visual systems that genuinely require stateful simulation and define a deterministic reconstruction strategy for each.

## 8. Procedural world generation

### 8.1 Segment manager

**DECIDED**
- Divide the world into sequential segments.
- Assign each segment a stable position and deterministic seed.
- Generate segments ahead of the camera.
- Dispose of segments that are sufficiently far behind the camera.

**DECIDED — Segment model**
- Segments have a fixed spatial length `L` per scenario (defined in the scenario configuration; concrete value set by prototyping). Segment `i` occupies `[i·L, (i+1)·L)` along the travel axis, and `i = floor(z / L)`.
- Segment boundaries do not follow musical events. Musical alignment happens through content: each segment's parameters are influenced by the timeline range its time interval covers (Section 8.2). Analysis failures degrade content, not structure.
- Continuity uses continuous world-space fields where possible (for example terrain and deformation as `f(x, z, seed)`, not per-segment), so there are no seams by construction. Discrete objects are placed with a margin and belong to the segment containing their origin point, avoiding duplicates and gaps.
- Transitions between musical sections are smooth interpolations of scenario parameters over time (via `interpret`), not segment swaps.
- A segment manager maintains a bounded window of `N_ahead` segments ahead and `N_behind` behind (counted in segments). Initial values 4 and 1 are starting points to be calibrated by profiling, not decisions; real look-ahead must cover each scenario's view distance (fog/far plane).
- Generation is asynchronous, prioritizes the nearest segments, and is cancelled if the segment leaves the window before completing.

**PROPOSED — Optional far-field layer (2026-11-15, implemented for Synthwave Dimension, awaiting visual approval on a GPU)** — A scenario may opt in to a second, coarse terrain layer through `ScenarioLogic.farField` (`config`: its own segment length and window; `generateSegment`: pure, sampling the same continuous world fields on a coarser and wider grid). The Experience controller runs a second `SegmentManager` for it; Worker requests carry `layer: 'near' | 'far'`, and far segments use the separate seed path `'far-segment'`, so near-segment seeds are unchanged. The scene hands over between the two layers with a complementary screen-space dither inside the area where near segments are always loaded (no seam, no z-fighting), and fades the terrain into the sky's atmosphere (gradient, haze and sun glow, without the sun disc, stars or skyline) before the end of the far window. `ScenarioConfig.viewDistance` sets the camera far plane (default 1500); the near plane is 0.5. Synthwave: far segments of 500 m with a 25 m grid and +-4 km width, 10 ahead (5 km), fog from 750 m to 4.75 km, scenario version 15. Verified by typecheck, unit tests and headless software-rendered screenshots; frame rate on a real GPU is not measured.

**PROPOSED — Synthwave horizon ring (2026-11-15, approved by the user for implementation, awaiting visual approval on a GPU)** — Replaces the skyline painted in the sky shader. That skyline was a silhouette at infinity, so it floated above the end of the terrain when the camera was high up on descents. The change is scene-only (`synthwave/scene.ts`): no generation, streaming or contract change, so the scenario version stays 15. The ring is a camera-centred backdrop made of three meshes: a flat polar plain (0.8 to 6.8 km), three rows of instanced buildings (about 5 to 5.5 km, 510 slots; each slot's place and size are hashed from the slot and the world salt, and lit windows come from the shader) and a low ridge strip at 6.2 km. Its height is anchored to the ground ahead. Each frame the scene samples the road elevation (`roadY`) of the loaded far segments every 125 m, from 0.5 km behind to 5 km ahead, into a uniform array, holding the last known value over gaps; the vertex shaders interpolate it by distance ahead. This is a pure function of the loaded descriptors and the camera, with no state carried between frames. The far terrain flattens to the road level between 3.3 and 3.9 km from the camera, so it ends on the plain. The plain sinks below the ground (80 m under the terrain, 20 m at its edge), so it never pokes through. Terrain and plain fog is capped at 0.85 so the far ground still reads as ground; building bases dissolve into that haze and their upper parts keep a fog of 0.3. The neon grid gains a 400 m scale, shared by terrain and plain. Cost: 3 extra draw calls and about 40k triangles. Verified by typecheck, unit tests and headless SwiftShader screenshots of a synthetic steep descent: the shaders compile and the city stands on the ground when viewed from about 900 m above it. Frame rate on a real GPU is not measured and the constants are untuned.

**PROPOSED — Synthwave skyline v2 (2026-11-15, user-requested, awaiting visual approval on a GPU)** — Scene-only change to the horizon ring city (scenario version stays 15). Four rows of 300 slots (1200 buildings, 4.7 to 5.4 km) whose angles are warped toward straight ahead, so the skyline is dense and tall under the sun and thins out and lowers toward the sides (height envelope: a central Gaussian of about 0.45 rad plus a wide low one; empty slots grow toward the sides). Each instance is four unit boxes shaped in the vertex shader: body, optional setback tier, roof (flat, pyramid spire, slanted wedge or tapered crown) and optional antenna with a beacon; unused parts collapse to zero size. Lights are static (2026-11-16, user-requested): a fixed, hash-chosen share of windows (per world salt) is lit at constant brightness, and neon rims and antenna beacons are steady; no time or music input, so there are no `SynthwaveParams` for the city. Lights cut through the haze more than facades. Cost: same 1 draw call, about 58k triangles for the city (was about 6k). Verified by typecheck, unit tests and headless SwiftShader screenshots; GPU frame rate not measured.

**OPEN**
- Concrete `L` per scenario and coordinate conventions.
- Final window values after profiling.

### 8.2 Segment generation

Each segment should be derivable from stable inputs, such as:
- World seed.
- Segment index.
- Scenario ID/version.
- Relevant musical timeline range.
- Generation version.

A segment should not receive a new random identity merely because it was unloaded and generated again.

## 9. Scenario system

**DECIDED** — Scenarios have distinct visual identities and their own musical interpretation rules while consuming shared music-analysis capabilities.

**DECIDED — Scenario format and contract** — Scenarios are code modules (TypeScript) with typed configuration objects for tunable values (palettes, densities, thresholds). They are not fully data-driven.

A scenario provides:
- Stable `id` and `version` (both feed the world seed).
- `interpret(features, seed)`: pure, deterministic mapping from timeline features at time `t` to scenario visual parameters.
- `generateSegment(descriptor)`: pure function that, given the segment index, its sub-seed, and the relevant timeline range, produces the segment descriptor (geometry, instances, parameters).
- Its own resources (shaders, materials, assets) with creation and disposal routines.
- A typed configuration.

The shared infrastructure provides and owns: audio analysis, timeline, identity and seed derivation, segment lifecycle (window, disposal, asynchronous calls), playback clock, camera, base renderer, and resource budgeting/disposal.

Boundary rules:
- Scenarios do not decode or analyze audio, and do not own the playback clock or camera.
- Shared infrastructure has no knowledge of any scenario's geometry or visual meaning.
- Functionality is promoted from a scenario to shared infrastructure only when a second real use exists; no speculative abstraction.

**OPEN**
- How scenario assets are loaded, cached, and disposed in detail (so far: Voxel Dreamscape's textures are bundled by Vite, loaded by the scene and awaited through the optional `ScenarioScene.ready()`; see 9.1).
- How scenario versions affect reproducibility beyond feeding the seed.

### 9.1 Voxel Dreamscape (scenario version 2, 2026-11-16)

**PROPOSED — visual direction and constants, approved by the user for this first implementation; awaiting visual approval on a GPU.** Files: `src/scenarios/voxel/` (`logic.ts` pure, `path.ts` pure, `scene.ts` Three.js). The camera glides 3 m above a straight river through a valley of terraced voxel banks (5 m columns, 2.5 m terraces, 230 m to each side; the river is 9 to 21 m wide and always clear under the camera).

- **Signature (baked):** pieces of the banks break off as floating archipelagos. Clusters of a 64 m world-space grid decide, from the slow intensity (~6 s smoothing) at the time the camera reaches them, whether they break off (10% to 75% of clusters) and how high they float (45 to 140 m, x0.8..1.3 per island). Each island takes the top of its columns (thicker in the centre) and drifts toward the river while rising. The rise is a pure function of the distance to the camera (still in the bank from 760 m ahead, fully lifted 200 m ahead), so the motion itself reads as the world coming apart. Portals (30% to 70% of islands, more when intense) and crystals stand on the islands and rise with them.
- **Groups and drivers:** banks (bass: voxel-seam glow), archipelagos (slow intensity, baked), portals and crystals (energy: brightness), river mirror (highs: glints), aurora and sky (mids: brightness and reach), drifting cubes (flux: spin kick and edge flash), horizon ring of voxel peaks in a lake (about 20 s intensity, baked per segment: warms the horizon and fog colour). Music-independent life on track time: island bob, canopy sway, aurora flow, star twinkle, water waves, portal swirl, cube orbit.
- **Rendering:** each segment is three instanced box meshes (ground, islands, glow) of one unit box, attributes interleaved in one buffer; the water is one plane around the camera; sky, ring (1100 instanced columns) and cubes (650) are fixed, camera-centred meshes. Fog uses the sky's haze colour. About 57 draw calls and 0.36 to 0.38 M triangles in headless SwiftShader screenshots; frame rate on a real GPU is not measured. No far-field layer: the valley walls and the fog (180 m to about 1 km) hide the end of the 1.12 km window, and the horizon ring sits beyond it.
- Seeds: named paths `terrain`, `islands`, `props`, `trees`; no `Math.random`.
- **Block trees (2026-11-16, user-requested, scenario version 2):** trees are no longer one log box and one leaf cube. `tree()` in `logic.ts` builds them from 1.25 m leaf and log blocks in three archetypes picked per tree: a small classic oak (two 5x5 layers with random missing corners, a 3x3 layer that may lean one block, a plus on top), a big round oak (a lumpy main blob and 1 to 3 smaller blobs on branches, roots at the base, trunk 1x1 or 2x2) and a wide flat crown of jagged disc layers on a 2x2 trunk. Trees near the river are always small oaks, so leaves stay 8 m clear of the camera path. Each leaf layer is merged into greedy rectangles of whole blocks. Cherry leaves are their own box kind (`cherryCanopy`, 15% of trees). The shader tiles one texture per block, adds a per-block brightness jitter and a per-tree hue shift, and sways a whole crown as one piece. Placement is unchanged (same columns and chances). Cost: tree boxes are about a third of the loaded boxes; a 17-segment window holds about 37k boxes (about 0.45 M triangles, was about 0.37 M). Verified by typecheck, unit tests and headless SwiftShader screenshots (shaders compile, no errors). Not seen on a real GPU yet.
- **Block textures (2026-11-16, user-requested):** voxel surfaces use 14 unmodified 32x32 textures from the Faithful 32x resource pack (credits in `README.md`, license copy in `voxel/textures/LICENSE.txt`). `voxel/textures.ts` loads them (Vite asset URLs) into one `DataArrayTexture` (one layer per texture, plus 32 layers for the nether portal animation), with nearest magnification and mipmaps. The scene exposes the optional `ScenarioScene.ready()`, which `Experience.prepare()` awaits before the first frame. Mapping: one tile per 2.5 m terrace. Bank tops are grass (tinted, as the gray source is tinted in game), then a grass-edged layer, dirt (2 layers), stone (6 layers) and deepslate deeper down and under islands. Trees are oak log, with oak or cherry leaves (holes filled with a dark foliage colour, because the boxes are opaque). Crystals are amethyst or prismarine. Portal frames are crying obsidian (its tears glow with the energy), and portal cores show the animated nether portal texture (20 frames/s of track time). Drifting cubes are amethyst, purpur or glowstone. The music-driven glows (seams, levitation, cube edges) are unchanged. Scene-only: no generation change, so the scenario version stays 1. Verified by typecheck, unit tests and headless SwiftShader screenshots, with shaders compiling without errors. Not seen on a real GPU yet.

## 10. Rendering and visual systems

Potential responsibilities:
- Geometry and material management.
- Lighting and color behavior.
- Particle systems.
- Atmospheric effects.
- Shader-driven deformation.
- Scenario-specific visual composition.

**DECIDED** — The renderer must support the visual world without becoming the source of musical interpretation or nondeterministic generation.

Instancing, resource reuse, and optional post-processing are covered by the `RECOMMENDED` guidance in Section 4.2.

**PROPOSED**
- Prefer deterministic, time-addressable particle behavior where possible.
- Establish quality settings only after profiling.

**OPEN** — Exact division between CPU-generated geometry, GPU shader deformation, and instanced objects.

## 11. Experience controller and camera

Responsibilities:
- Coordinate the application flow from user submission (YouTube URL and scenario selection) through loading/preparation and automatic experience start.
- Coordinate playback time with world evaluation.
- Apply camera look input.
- Maintain forward movement independently of look direction.
- Request and retire world segments as the camera advances.
- Coordinate rendering and terminate the experience when the track ends.

**DECIDED** — The MVP playback experience has no user-facing pause, resume, seek, rewind, fast-forward, speed, previous, or next controls. The experience starts automatically once audio preparation and world initialization are complete, and ends when the music ends.

**DECIDED** — Forward travel remains on a straight path. Horizontal and vertical looking do not change the travel direction.

**DECIDED — Camera look limits**
- Horizontal look to the left: maximum -55° (changed from -45°, user-authorized 2026-11-15).
- Horizontal look to the right: maximum +55°.
- Vertical look upward: maximum +55° (changed from +45°, user-authorized 2026-11-15).
- Vertical look downward: maximum -30° (changed from -45°, user-authorized 2026-11-15).
- Horizontal and vertical limits are independent.
- The limits do not form a combined cone restriction.
- Forward movement remains straight and independent of camera orientation.

**DECIDED — Camera speed** — Forward speed is constant (baseline), so camera position is a pure function of track time, `z(t) = v · t`. Musical influence comes from how the world reacts, not from camera speed. Modulating speed over time remains possible later because position is defined as a function of time; any such change must stay deterministic and time-addressable.

**DECIDED — Per-scenario camera path (2026-11-15, user-authorized exception for Synthwave Dimension only)** — A scenario may opt in to a music-driven path through the optional `ScenarioLogic.createPath(timeline)` returning a `TrackPath` (`distanceAt`, `timeAt`, `heightAt`, `slopeAt`, all pure functions of track time). Scenarios without `createPath` keep the constant speed `z(t) = v · t` and a flat road, so the other scenarios are unaffected. The Experience controller uses the path for the camera distance and height, and the Worker passes the same path to `generateSegment` (`SegmentInput.path`) so the terrain spacing and the road elevation (`roadY`, one value per row) agree with the camera. Synthwave (`synthwave/path.ts`, scenario version 10; continuous model approved by the user on 2026-11-15, replacing the earlier 5-level section model) follows the music second by second. Intensity = log loudness (energy in dB above -30 dB) mixed with spectral flux, smoothed with a centered (zero-lag) filter of about 1.5 s and scaled between the song's 2nd and 98th percentile, so a change shows up when it happens in the music and subtle changes still bend the road a little. The target slope comes from the intensity against the song's median plus its contrast with the surrounding ~20 s: calmer climbs, more intense descends, proportionally to the difference, up to 0.75 (about 37 degrees). The ratios follow Audiosurf 2's modding defaults (community docs, github.com/DeathByNukes/as2-doc: `playerminspeed` 0.1 / `playermaxspeed` 2.9, `uphilltiltscaler` 0.8 / `downhilltiltscaler` 1.55, `uphilltiltsmoother` 0.03 / `downhilltiltsmoother` 0.06): descents are about twice as steep as climbs for the same difference and the slope tips downward twice as fast (time constants 0.4 s down, 0.8 s up). Speed is set in log space: about 280 km/h on flat road at median intensity (minimum 100 km/h on the steepest climbs, maximum 600 km/h), faster when more intense, and the slope adds a physics-like term (a steep climb brakes more than a gentle one, a steep descent speeds up more than a gentle one), clamped to 100..600 km/h while the music plays (the km/h scale is our choice, Audiosurf's is not public). The road height is the integral of the slope with no height limit, so a song drifts downhill overall like Audiosurf's tracks. The camera pitch follows 80% of the slope angle, and the whole cross-section (road and mountains) rides the elevation in the terrain vertex shader. Tempo and beat data do not exist yet (ADR 0007), so loudness and flux are the pace proxy. Verified by unit tests (reaction within about 1 s, subtle vs. big changes, steeper climbs slower, descents steeper than climbs, monotonic distance, `timeAt` inverse, seams, determinism) and by the track preview tool on the user's reference song compared with an Audiosurf 2 screenshot; not yet seen on a GPU in the app, so the constants (`PATH` in `path.ts`) are a first tuning.

**DECIDED — Voxel Dreamscape path and field of view (2026-11-15, user-requested)** — Voxel Dreamscape also defines `createPath` (`voxel/path.ts`), with flat `heightAt`/`slopeAt`: only the speed follows the music (intensity = log loudness + flux, centered ~1.5 s smoothing, rank-scaled; ln speed = ln 280 km/h + 1.3 x (intensity - median), clamped to 100..600 km/h, followed with a 1.2 s time constant; eased to 50 km/h over 2.5 s after the music ends). Two small shared-contract extensions, both optional and without effect on Synthwave: `TrackPath.fovAt(t)` (the controller sets the camera's vertical FOV from it every frame, default 70 degrees; Voxel: 60 to 84 degrees, linear in log speed) and `ScenarioConfig.speedGraph` (`false` hides the speed-graph HUD for a scenario with a path; Voxel sets it). Verified by unit tests (faster and wider FOV in intense passages, flat road, end speed, `timeAt` inverse, purity).

**DECIDED — End of music and epilogue (2026-11-15, user-requested)** — `Timeline.musicEndS` is the time of the last frame whose normalized energy exceeds `SILENCE_LEVEL` (0.01, about -40 dB below the track's 98th percentile); a fully silent track counts as music to its end. This only locates the end; the audio is never trimmed (Section 5.2). The Experience controller ends the run at `musicEndS + EPILOGUE_S` (5 s) from the audio clock, which keeps running after the source stops, instead of at the source's `onended`. During the epilogue it sets the opacity of a black overlay element (`ExperienceOptions.fadeOverlay`, owned by `App.tsx`, above the scene and the speed graph) to an eased ramp, a pure function of track time (`fadeOut`). Synthwave's path (`path.ts`, scenario version 16): (a) `endingCalmness` scores the 10 s before the music ends, leaving out the last ~1.5 s that the centered smoothing already pulls toward the following silence: calm when its mean intensity is 0.05 above to 0.15 below the song's pivot, or fading when its first 2.5 s are 0.1 to 0.3 more intense than its last 2.5 s (0..1, the larger of the two); (b) the target slope is multiplied by `1 - flatten`, where flatten ramps by that score over the 3 s before the window, so the window itself rides flat, and is 1 after the music ends; (c) after the music ends the speed (and its floor) eases in log space to `endKmh` (50 km/h) over 2.5 s. The path tables run 3.5 s past the audio so this completes even on an abrupt ending; beyond them the path extrapolates at its last state. Verified by typecheck and unit tests (music end detection, calm and fade-out endings flatten, an intense ending does not, no slope jumps, flat road and end speed after the music, abrupt ending); not seen on a GPU in the app, and the thresholds are untuned on real songs.

**DECIDED — Speed graph HUD (2026-11-15)** — `src/experience/hud/speedGraph.ts` draws the speed graph on a separate 2D canvas (a fixed-position element in `App.tsx`, top-right, `pointer-events: none`), owned by the Experience controller and drawn every frame after the WebGL render. It exists only when the scenario defines `createPath`. It plots `TrackPath.heightAt` over the whole track duration (20 Hz table, computed once); the speed readout comes from a 20 Hz table from `TrackPath.distanceAt` (local difference over 0.25 s), so the graph is a pure function of the path and track time and adds no per-frame state. The line is drawn in short pieces colored from `TrackPath.slopeAt` (white flat, green uphill, red downhill, interpolated up to `STEEP_SLOPE = 0.75`, equal to Synthwave's `PATH.maxSlope`). Colors are untuned constants. Verified by typecheck and unit tests only (no unit test for the drawing); not seen in a browser.

**DECIDED — Track preview dev tool (2026-11-15, user-requested)** — `tools/track-preview.ts` (`npm run preview:track -- <audio-file | youtube-url> [--ref image.png]`) runs the same `analyzeTrack` and Synthwave `createTrackPath` as the app in Node and writes a static HTML report to `.preview/` (gitignored): the whole-song road profile (height over distance at true proportions, and over time), the speed and the raw intensity, colored by slope, with an optional reference image (for example an Audiosurf screenshot of the same song) for side-by-side comparison. It is a development aid for tuning `PATH`, not part of the shipped app; it needs `ffmpeg` on PATH for decoding (different from the browser's `decodeAudioData`, so results may differ very slightly) and `yt-dlp` for URLs. No new dependency.

**DECIDED — Look input and recentering**
- Desktop: mouse movement; mobile: finger drag. Gyroscope is out of the MVP.
- Input changes a look offset (yaw and pitch) relative to the forward direction, clamped independently per axis (±55° horizontal, +55° up, -30° down).
- When input stops (mouse idle, or finger released), the offset returns slowly and automatically to zero (forward-facing center). The camera is never free-look.
- Because the offset is accumulated from movement and decays toward zero, absolute cursor-position mapping is not used.

**OPEN**
- Recentering tuning (idle delay before return, return speed/easing) and input sensitivity; to be set in the prototype. Mouse/touch sensitivity was lowered by 25% (0.0022 → 0.00165 rad per pixel, 2026-11-15, user request).
- Whether desktop uses Pointer Lock. Assumption: not used in the MVP, since the offset decays to center and the cursor hitting a window edge is acceptable; confirm in the prototype.
- Audio start under browser autoplay policies: the `AudioContext` should be created or resumed inside the start-button click handler, since playback begins only after loading and mobile browsers require a user gesture; confirm in the prototype.

## 12. Execution architecture and concurrency

**DECIDED — Responsibility boundary** — The frontend owns the application UI, experience lifecycle, audio playback coordination, world state coordination, and Three.js rendering. The acquisition backend is a separate auxiliary service with the restricted responsibility described in Section 5.1.

**DECIDED — Execution model (baseline)**
- **Main Thread:** React UI, experience controller, camera and look input, audio decoding and playback coordination, real-time analysis, timeline queries during the experience, and the Three.js scene/render loop (including creation of Three.js objects from segment descriptors).
- **One dedicated Web Worker:** whole-track audio analysis, music-intelligence calculations, and `generateSegment` (producing segment descriptors only). Internal responsibilities stay modular; additional Workers only if profiling justifies them.
- **Data flow:** the main thread hashes the delivered file bytes (SHA-256, a few MiB, before decoding because `decodeAudioData` detaches its input), decodes it into two Float32 channels at 44,100 Hz, then transfers the channel buffers to the Worker (Transferable, no copy). The Worker returns the immutable timeline once (feature tracks as transferable buffers, events as plain objects); the main thread queries it during the experience, while the Worker keeps its own copy for segment generation.
- **Messaging:** typed messages for progress, results, and errors, with request identifiers to support cancelling segment generation. The Worker never touches the Three.js scene.
- **Real-time analysis:** `AnalyserNode` read from the main thread. No AudioWorklet in the baseline; reconsider only if the prototype shows it is insufficient.
- **Not used in the baseline:** `SharedArrayBuffer`/cross-origin isolation, `OffscreenCanvas`, multiple Workers.
- **Worker failure:** treated as a fatal error that ends the experience with a user-facing message. No automatic recovery in the MVP.

Material deviations from this model must be justified by evidence (limitations, compatibility, or measured bottlenecks) and recorded here.

**DECIDED** — Music-related information is temporary and scoped to the current execution. The application must not persist PCM data, audio identities, analysis results, or music history in client-side storage. The delivered audio file may be kept in the IndexedDB audio cache (ADR 0010).

**OPEN**
- Exact message schemas.
- Scheduling, backpressure, and progress-reporting details.
- Whether real-time analysis needs an AudioWorklet after an end-to-end prototype is profiled.

## 13. Project structure

**RECOMMENDED** — Organize code by responsibility rather than placing all logic in a single application layer.

An initial conceptual structure could be:

**Current structure (2026-11-15):** `src/` (frontend: `App.tsx` as the minimal flow input, preparing, running, ended or failed; `audio/sources`, `audio/processing/decode.ts`, `audio/analysis` (FFT and track analysis), `audio/intelligence/timeline.ts`, `world/identity/seed.ts`, `world/segments/manager.ts`, `world/generation` (dedicated Worker, protocol and client), `scenarios` (`types.ts`, `registry.ts`, `logics.ts`, `synthwave/` and `voxel/`, each with pure `logic.ts` and `path.ts` and Three.js `scene.ts`), `experience/controller` and `experience/camera`), `tests/` (`npm test`, Node's built-in runner, no extra dependency; the modules they import are DOM-free and use `.ts` import extensions), `server/` (acquisition backend, Node + TypeScript, run with `npm run server`; Node strips the types natively, so no extra runtime dependency), `shared/` (HTTP contract types imported by both), `spike/` (disposable measurement scripts from the acquisition spike, to be deleted). `npm run typecheck` checks the frontend and the server with separate tsconfigs. The tree below is the original proposal and remains guidance.

```text
src/
├── app/                 # Application bootstrap and top-level composition
├── audio/
│   ├── sources/         # Audio source adapters
│   ├── processing/      # Decoding, PCM canonicalization, and signal analysis
│   └── intelligence/    # Rhythm, structure, and musical timeline
├── world/
│   ├── identity/        # PCM identity, world seed, and generation identity
│   ├── generation/      # Procedural generation
│   ├── segments/        # Segment lifecycle and streaming
│   └── state/           # Time-addressable world state
├── scenarios/           # Scenario implementations and definitions
├── rendering/
│   ├── renderer/        # Three.js setup and render orchestration
│   ├── shaders/         # GLSL shaders
│   └── systems/         # Particles, lighting, atmosphere, etc.
├── experience/
│   ├── camera/           # Camera and look controls
│   ├── playback/         # Playback clock and synchronization
│   └── controller/       # Experience orchestration
└── shared/               # Shared types and utilities
```

This is a starting proposal, not a required final directory tree. Refine it after the framework, build tooling, and module interfaces are selected. The application layer will need to represent at least the input/selection, loading/preparation, active experience, and completed/failed lifecycle states. The UI framework is decided in `TECH_STACK.md`; detailed state-management choices remain open.

## 14. Engineering conventions

**RECOMMENDED**
- Use explicit interfaces between major systems.
- Keep source acquisition, audio analysis, musical interpretation, world generation, and rendering independently testable.
- Prefer typed data contracts for timeline events, features, scenario configuration, segment descriptors, and world state.
- Avoid hidden mutable global state.
- Make random seeds and time inputs explicit dependencies.
- Dispose GPU and audio resources deliberately.
- Keep scenario-specific behavior out of generic infrastructure unless it is genuinely shared.
- Keep temporary music data in memory where practical and avoid unnecessary persistence.
- Keep the file hashing and seed derivation deterministic; keep canonical PCM conversion reproducible within the supported execution environment (it is not hashed).

**OPEN**
- Lint and format conventions (language, framework, build tool, and package manager are decided in `TECH_STACK.md`).
- Unit, integration, and browser-test frameworks.
- Detailed Worker communication, scheduling, and concurrency refinements beyond the decided model in Section 12.
- Error-reporting and logging conventions.

## 15. Testing and validation strategy

**RECOMMENDED** — Tests should validate architectural properties, not only individual functions.

Important test categories:
- Same audio file bytes + same scenario/version + same generation version produces the same world identity.
- Same exact audio file bytes produce the same SHA-256 audio identity.
- Different audio file bytes may produce a different audio identity, even when acquired from the same URL.
- Leading and trailing silence are preserved and contribute to the audio identity (they are part of the file).
- The audio identity does not change when the decoded samples vary between sessions.
- Canonical PCM conversion uses the defined sample rate, stereo channel layout, Float32 sample format, and two separate (non-interleaved) channels.
- Same segment inputs produce the same segment output.
- Evaluating the same timestamp repeatedly produces equivalent world state.
- Seeking to a timestamp matches the state reached by uninterrupted playback at that timestamp.
- Unloading and regenerating a segment reproduces its original output.
- Scenario-specific interpretation does not alter shared audio-analysis results.
- Resource disposal prevents unbounded growth during long playback.
- Only the audio file cache (IndexedDB, size-limited) is written to persistent client-side storage; no PCM, identity, analysis, or history.
- The acquisition backend does not persist music-related data beyond the temporary operational lifecycle required for delivery.

Performance profiling should measure representative scenes on target hardware and guide quality/performance decisions.

## 16. Technical decisions still required

1. Select and validate exact dependency versions and implementation tooling, respecting `TECH_STACK.md`.
2. Run the acquisition feasibility spike (yt-dlp on the target host, m4a decoding in Chrome/Firefox/Safari, 10-minute decode time, and peak memory on mobile; 10 minutes of canonical PCM is about 212 MB (202 MiB, measured), and with the `AudioBuffer` and the interleaved copy the process memory grew by about 560 to 600 MiB in desktop Brave; partially done, see Section 5.1) and calibrate operational limits.
3. Run the beat-tracking/structure validation spike for the in-house analysis (ADR 0007).
4. Define the exact timeline schemas (the hybrid model itself is decided in Section 6).
5. Validate the SHA-256 of the delivered file and the canonical PCM conversion in the supported browser environment (Chromium-based browsers partially validated; see Section 5.1).
6. Define the exact scenario interface types (the responsibility split is decided in Section 9).
7. Define concrete segment length per scenario and calibrate the streaming window (model decided in Section 8.1).
8. Define the playback clock and synchronization between audio time and rendering (camera speed is decided in Section 11).
9. Define the performance floor, quality adaptation, and the reference device set (the 60 FPS at 1080p target is decided in Section 4.2).
10. Define test frameworks and resource lifecycle details.
11. Define logging conventions and exact timeout values (failure behavior is decided in `PRODUCT_SPEC.md` Section 2.4).

## 17. Implementation principles

- Do not implement every proposed subsystem before validating the smallest end-to-end vertical slice.
- Prefer proving the critical pipeline early: audio input → canonical PCM → SHA-256 identity → analysis → deterministic world generation → one procedural segment → rendered synchronized experience.
- Profile before adding optimization complexity.
- Keep product requirements separate from technical mechanisms.
- When a proposed choice is rejected, update this document so future work does not continue to rely on it.
- Record significant approved technology and architecture decisions as ADRs consolidated in `TECH_STACK.md`; do not create separate decision files.
- Treat every `RECOMMENDED` approach as replaceable guidance, not an implementation mandate. If a recommendation is changed, record the technical reason and update this document so later agents do not assume the earlier approach is still preferred.
- Do not introduce music history, catalogs, or identity caches, or persist anything beyond the audio file cache, unless a future product decision explicitly changes this constraint.
**Synthwave Dimension v4 (2026-11-15, user-requested):** the scenario version went from 3 to 4. Each mountain now has its own size: a smooth world-space size field (`mountainSize`, seeded from the world seed) scales the final height by 0.6x to 3.6x, skewed so giants are rare and many stay small. Far away, mountains start at a smaller random size (0.25x to 0.5x); a baked per-vertex `startRatio` (start/final) lets the terrain vertex shader grow them to full size as a pure function of the distance to the camera (full size 40 units ahead, start size from 320 units), so there is no per-frame state. The live bass `mountainPulse` still applies on top. Verified by typecheck and unit tests only (determinism, seams and size variation); the shader was not run on a GPU or in a browser, so the visual result, the growth range (`GROW_DONE`/`GROW_START`) and the size ranges (`TERRAIN.startRange`/`finalRange`) are untuned.
