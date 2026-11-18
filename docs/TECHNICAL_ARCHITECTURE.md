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
- **Production acquisition (ADR 0012, 2026-11-16):** YouTube blocks yt-dlp on Cloud Run, so when `RAPIDAPI_KEY` is set the backend gets the file from third-party RapidAPI APIs tried in priority order with fallback (`server/sources.ts`): first `server/ytMp3M4a.ts` (m4a AAC 128 kbps via `GET /audio`), then `server/ytToMp3.ts` (YouTube's m4a stream through a relay, DASH container), then `server/rapidapi.ts` (m4a AAC 128 kbps, re-encoded by the provider). This replaces the "original stream without re-encoding" rule above in production; yt-dlp remains the fallback without a key.
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
- **Datacenter IP (2026-11-16):** on Cloud Run, yt-dlp jobs fail with `BLOCKED` (YouTube bot check). Resolved by ADR 0012.
- **Not yet validated:** rejection of live, private, or over-10-minute videos (no test URLs), a video without an m4a stream, and any mobile device.

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

**PROPOSED — Synthwave skyline v3 and mountain growth (2026-11-16, user-requested, awaiting visual approval on a GPU)** — Scene-only changes (`synthwave/scene.ts`; scenario version stays 17). City: 3 rows of 250 slots (750 slots, about 500 buildings drawn after the empty slots; was 1200), rows 280 m apart and staggered by half a slot, a softer pack toward the centre (`core` 0.3 -> 0.5); buildings about as wide as the slot spacing (centre 48..78 m, sides 70..150 m, depth 55..110 m) so they read as blocks, not sticks, and a height envelope steeper than the presence one (the tallest towers only in the centre, the sides kept low), so the centre reads as the densest part; each building has its own facade shade and back rows take more haze. Windows use larger cells (40 x 34 instead of 30 x 22), anti-aliased edges, and blend into their average glow once a cell drops under a few pixels, so they no longer shimmer. The city still stands on the ground ahead (unchanged), so it stays visible from high up; a fixed-height city anchored to the path's end height was tried and reverted at the user's request, because it sank out of view while the road was far above it. Mountains: the growth window moved from 25..175 m to 150..600 m ahead of the camera with the same eased curve (small start, increasingly fast rise), so at cruise speed the strong rise ends about 2 s ahead and is visible. Verified by typecheck, unit tests and headless SwiftShader screenshots of a synthetic path (ground level and 2.5 km above the end height, plus a 60° side view); GPU frame rate not measured.

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

### 9.1 Voxel Dreamscape (scenario version 6, 2026-11-17)

**PROPOSED — design and constants, approved by the user (2026-11-16); awaiting visual approval on a GPU.** Files in `src/scenarios/voxel/`: pure (Worker and Node tests) `noise.ts`, `blocks.ts`, `terrain.ts`, `road.ts`, `schedule.ts`, `chunk.ts`, `nether.ts`, `mesher.ts`, `path.ts`, `logic.ts`; Three.js only in `textures.ts` and `scene.ts`. The world is made of 1 m blocks; the camera rides a straight cobblestone road along x = 0 (3 blocks wide) at a fixed height above its surface.

- **Terrain (`terrain.ts`):** block columns from seeded Perlin noise: sea level y = 0, continents, hills and mountain ranges (fbm), meandering rivers (the camera-independent channel field `riverField`), lakes where the continent noise is low, and a 4-block-lattice trilinear density for overhangs on high ground. Layers: grass, 3 to 4 dirt, stone; sand on beaches, gravel on beds and patches, coal and iron ore. One biome. All of it is a pure function of the world seed and block coordinates.
- **Road (`road.ts`):** the per-row profile of the road, cached per 128-row chunk and the single source for both the camera and the segments. Land is cut or embanked next to the road; a river or lake on the road line becomes an arched bridge (oak planks deck, cobblestone beams and pillars, fence rails) with a sine-squared arch of 3 to 7 blocks, or a flat causeway when longer than 120 blocks; an arch rises at most 0.9 layer per row (`ROAD.maxArchRise`), so the deck never skips a step, and its bank margins stop at a cave mouth (scenario version 31, 2026-11-18, user-reported: a river against a mouth used to cut the arch short at the first cave row, dropping the deck and the camera 2-3 blocks in one row), so the arch comes down to the cave floor's level; the cave sections run through a cavern (see below; tunnels were removed in version 6). Light posts every 24 rows alternate sides at |x| = 3.
- **Path (`path.ts`):** `createPath(timeline, worldSeed?)` (an optional contract extension; Synthwave ignores the seed). Overworld pace is unchanged (see the decision below); `heightAt`/`slopeAt` follow `bridgeOffsetAt`. Inside a Nether interval the path uses a Synthwave-like descent implemented here (no import from the Synthwave scenario): a slope from -0.55 at the most intense moments to +0.06 at the calmest, followed with a 0.7 s time constant, and a speed bonus on steep drops (still capped at 600 km/h).
- **Schedule (`schedule.ts`, three levels since scenario version 6, 2026-11-17, user-requested; PROPOSED thresholds, to be tuned in review):** a section intensity (`intensityCurves().section`: the same raw intensity as the pace, two centered box passes of 1.5 s half-width, about 3 s; it was the 6 s islands curve, whose wide window opened the Nether many seconds before the climax and closed it many seconds after). Since scenario version 7 (2026-11-17, user-requested) it is scaled over the frames where music plays only (above `SILENCE_LEVEL`), between their 10th and 98th percentile (`SECTION_SCALE`), so 0 is the calmest part of the music and 1 its most intense; before, a near-silent intro pulled the scale down and medium passages already read as intense. It is read with hysteresis at two levels, matching the user-requested split (below 50% open road, 50..69% caves, 70..100% Nether): caves (enter above 0.52, leave below 0.48; gaps of open road under 5 s are merged, caves under 5 s dropped, none before 3 s) and Nether (enter above 0.72, leave below 0.68; at least 6 s inside, 8 s between visits, none in the first 6 s). Every Nether interval is widened by 3 s of cave on each side, so the order is always open -> caves -> Nether -> caves -> open. Caves close 2 s and the Nether 5 s before the music ends. The hour starts at 6.5; exit k of N is at 9 h to 21 h evenly (N = 1: 21 h); between visits the day drifts by 30% of the way to the next exit; with N = 0 it drifts to 12 h over the music. Segments bake the hour at their start and end, whether they start inside the Nether, and the distances of the portals they contain, so the scene derives the dimension and the hour from the camera distance alone (no per-frame state).
- **Meshing (`chunk.ts`, `mesher.ts`):** each segment (64 rows, 2 `behind`, 6 `ahead`) builds a block volume with one padding row and column on every side (so faces at the seams are culled exactly as inside a segment) plus a light margin of 15 rows on each side (`LIGHT_REACH`, read but never meshed), then a greedy mesh with per-vertex ambient occlusion and smooth lighting. Output per segment: opaque blocks, water surface, cutout plants/fences/rails (typed arrays, transferred to the main thread; the worker`s `transferablesOf` accepts any typed array). Vertex: position (3) + layer, u, v, packed (face, AO, 4 x sky light, 4 x block light, flags). Quads merge only where texture, AO and both light channels are equal at all four corners.
- **Light (`light.ts`, scenario version 4, 2026-11-16, user-requested; modelled on the block game's conventions, not its code):** two baked channels of 0..15 per cell, flood filled (BFS, -1 per block; opaque blocks stop light, leaves and water dim it by 1). Sky light: 15 straight down from the open sky, then spread sideways, so overhangs and tunnels darken gradually; the Nether has none. Block light: emitters (`LIGHT_EMIT` in `blocks.ts`: glowstone and lava 15, portal 11, crying obsidian 10, magma 3). Each face corner averages the light of the front cell and its 3 neighbours around the corner (opaque ones excluded). The shader turns the levels into colour with a lightmap like the game's (`level / (4 - 3 level)`, ambient + sky x day factor + warm block light, partial brightness lift) times the fixed face shade and AO. Light sources draw their texture at constant full brightness: no audio driver, no time-of-day change. Cost: about +40% per segment in the Worker (Node: ~330 ms vs ~230 ms build + mesh). Verified by unit tests (levels, walls, overhang fall-off, seam agreement); not seen on a GPU.
- **Islands (removed, scenario version 11, 2026-11-17, user-requested):** the floating islands (clusters lifted from the ground by a vertex shader, with ruined portals and amethyst clusters), their module `islands.ts`, the island pass of `chunk.ts`, the island shader and materials of `scene.ts`, and the slow "islands" intensity curve of `path.ts` are gone. The per-vertex `extra` attribute of the mesher is now unused.
- **Caves and the open road (`caveMask.ts`, `terrain.ts`, `road.ts`, `chunk.ts`, scenario version 6):** the cave sections become road-row ranges through the pace tables (`voxelTerrain(timeline, seed)` in `path.ts`: the pace never depends on the terrain, so it is computed once without it and memoized per timeline); `TerrainSalts.caves` carries them, and every per-world cache in `road.ts` is keyed by that terrain object. Near the road (`TERRAIN.centreClear`: fully within 30 blocks, fading out by 80) the mountain field is removed and the land is capped at layer 11, so no tunnel forms. **Mountains (`terrain.ts` `mountainShape`, scenario version 8, 2026-11-17, user-requested: natural and all different; PROPOSED values, to be tuned in review):** after the ideas of the block game's terrain shaping (read from its worldgen data: continentalness, erosion, folded ridges `1 - 3 | |r| - 2/3 |`, jaggedness only on high ridges of low erosion), reimplemented with this scenario's own noise, not its code: a massif mask (scale 220), domain warp (70 blocks) so ranges bend, erosion (scale 700) that sets how tall and rugged a massif is, folded ridge noise (scale 190) for ridgelines and valleys, a per-massif size (0.35..1.3, scale 520) and jagged peaks (scale 26, up to 28 layers) on high, uneroded ridges; base amplitude 100 layers, capped at layer 160. Surface rules: snow above layer 92 (+-10 with noise) unless the slope reaches 2.6 blocks per block, bare stone from a slope of 1.4 and just below the snow line, no trees from layer 74. The slope is measured per column from its neighbours in the detailed volume. The detailed volume grows with the segment's highest column (plus 10 layers of headroom). The road's cut widens and steepens with noise on each side and along the road (no straight symmetric staircase), and the open land near the road stays low (`centreClear` 36..120). New block `snow` (Faithful 32x texture). Cost (Node): detailed segments about 0.5..1.3 s (were 0.7..1.4 s at version 7, before the faster column fill). Over a cave range a ridge (the same mountain generator, fully grown, never under 34 layers) rises across the road (full width about 28 blocks each side, fading by 80). Since scenario version 7 (user-requested: a natural mountain with the mouth in it, not a straight wall) its footprint along the road is per column (`caveMountain`): within 6 blocks of the road the mountain's face is a cliff on the first (and last) cave row, 17..23 layers high, climbing to the crest over 30 rows behind it; farther out its edge reaches forward about 1.1 rows per block (with noise) and rises over a slope that lengthens with the distance, inside the 64-row approach (`caveWeight`), so the road enters a valley that closes into the cliff. The cavern is 60% of its height at the mouth and the exit, opening up over 14 rows. The road kind `Tunnel` is replaced by `Cave`, set from the ranges alone: `chunk.ts` carves a cavern around the road (half-width 5..12 and height 8..15 wandering along the road, rough with 3D noise), with lava pools on the floor beyond 5 blocks (no fluid flow, so lava only where it could not run: a floor at most 3 layers above the road with 3 free layers above it and no lower neighbour column on any of the 4 sides; never on walls or over a drop; `caveLavaAt` is pure in the row and its two neighbour rows, so seams agree), glowstone and ores on the rock faces and wall lamps every 10 rows; the road corridor stays clear. The far field keeps the cave mountains on the road (no cut there).
- **Mountain surfaces, cliffs and cave mouths (`terrain.ts`, `chunk.ts`, `far.ts`, scenario version 9, 2026-11-17, user-requested: mountains were almost all bare stone, and a cave cut a large flat wall into its mountain; PROPOSED values, to be tuned in review).** Causes found: (1) the surface rule turned every column with a slope of 1.4 or more into stone, and that slope was the largest step to a single neighbour (two-thirds of the mountain columns step 1..2 blocks to some neighbour, so a large share went bare); below the top block the far field drew one stone band from 4 layers down to its floor, so distant walls were about 90% one texture. (2) The road cut (`roadColumn`) was applied to `columnAt`, which already contained the cave mountain: on the approach rows the cut flattened a strip up to 17+ blocks wide at road level, and on the first cave row the cut stopped, so the mountain rose 11+ layers on a single row across that strip: a vertical plane wall. Changes: `columnAt` = `raiseCaveMountain(baseColumnAt(...))`; the road (detailed and far) cuts `baseColumnAt` and the cave mountain is raised afterwards. Outside the cave rows the cave mountain is capped by valley slopes rising from the road surface at 0.6..1.5 layers per block away from it (noise per side and along the road, plus rough noise); over the mouth and the exit its face starts at 18 layers and leans back 1.2..2.6 layers per row with rough noise, fading into the full mountain from 8 to 22 blocks off the road (`caveValley`, `caveBrow`, `caveBrowHalf`); the mouth lintel is 3..5 blocks either side of the road (`caveMouthHalf`). Surface rules: the slope is the gradient over two blocks each side, or 0.6 x the largest neighbour step if larger (`surfaceSlope`); the soil (grass over 3..4 dirt) thins with an effective slope (slope + broad and fine noise + 1.2 x altitude weight between layers 70 and 112) from 1.3 to bare rock at 2.2, so the grass/rock line is ragged and climbs with the terrain; thin soil shows gravel or coarse dirt scree; snow is unchanged. Rock is layered (`rockAt`): bands 6 layers thick, offset per column by warp noise (5 + 2 layers), each band stone, andesite or tuff by hash, with lenses along it; ores stay in the stone. The far field uses the same strata for its walls (one band per stratum) and draws no dirt under bare rock. Cliffs (`cliffWeight`, `fillCliff`): steep mountain columns (slope 1.5..2.6) more than 4..8 blocks from the road, or any around a cave section, are filled layer by layer from a nearby column shifted by clamped 3D noise (up to 3 blocks; 6 around caves), so faces get ledges, bays and overhangs; the corridor next to the road keeps its own column outside the cave rows, and the cave is carved after this. Trees and plants skip cliff columns. The surface grid holds `max(4, caveCliffWarp + 2)` rows beyond the volume so displaced reads and their slopes never come from the grid's edge (seams agree). New blocks `andesite`, `tuff` and `coarseDirt` (Faithful 32x textures). Cost (Node, one machine): detailed segments about 125..145 ms (were about 95 ms), far segments about 370..445 ms (were about 405 ms). Verified by unit tests (surface mix and grading on high ground, strata present, cave mouth face leans back and is irregular, mountain wraps around the mouth, seams of the cave mountain identical, seam lighting compared on the light field) and a CPU raycast preview only; not seen on a GPU.
- **Nether (`nether.ts`):** built only for segments inside an interval, relative to the rail height at each row: the classic Nether Wastes (scenario version 15, 2026-11-17, user-requested; DECIDED 2026-11-18: approved by the user after a manual test in the app): a cavern 208 blocks wide whose density follows the game's `final_density` (JAR 26.3, `noise_settings/nether.json`: 4 x 8 x 4 lattice interpolated trilinearly, floor forced solid under layer 24, roof toward 0.9375, lava sea at game layer 32 = 9 m under the rail; the noise is 3 octaves of Perlin in place of `old_blended_noise`, and the roof at 112 instead of 128 is an approximation), an open ellipse around the rail so the road never runs in a tunnel, side walls closing over the last 26 blocks, then magma (layers 27..36), gravel, a little soul sand, quartz ore, lava pools in basins, lava falls from the roof and hanging glowstone clusters (`NETHER.glowCell` cells, 12 blocks since version 25, jittered, as ellipsoids held by the roof). Light posts (scenario version 21, 2026-11-18, user-reported: the glowstone lanterns hung in mid-air over the corridor) stand on both sides of the bridge on the rows chosen from the beats (scenario version 22, see "Nether post rows and beats"; every 16 rows, `NETHER.postSpacing`, when built without a path; none within a row of a portal): a nether-brick bracket at |x| = 3 just outside the railing, a nether-brick fence column `ROAD.postHeight` tall, a one-block arm and an always-lit redstone lamp under it, the overworld post's shape. Only the Nether Wastes biome (no Crimson/Warped forests, Soul Sand Valley or Basalt Deltas). All pure functions of the seed (`hash01`/`perlin3`), so segments are reproducible and seamless (light margin `LIGHT_REACH`). Unchanged: the nether-brick bridge with rails (powered rails every 7 rows) and fences (scenario version 19, 2026-11-18, user-requested: where the deck changes level the rail is the block game's ascending rail, the flat rail tilted 45 degrees and stretched so it rises one block across its cell (`mesher.ts`, after `template_rail_raised_*.json`), so the rails of two levels join; a single-row pit in the deck is raised to its lower neighbour by `railDeckLayer`, since a rail ramps toward only one side; tests check that every joint of a whole visit meets), the portals, the path and the minecart. Past every exit portal the Nether volume goes on for `NETHER.exitTail` = 96 rows (scenario version 20, 2026-11-18, user-reported: generation stopped at the exit portal), level at the rail height of the exit and cut short before the next visit, so the cavern reaches past the Nether fog end (about 61 m, 72 m at the widest detailed volume); it is only seen from inside the Nether. The scene shows only the camera`s dimension. Portals (5 x 7 obsidian frames with the animated portal pane) stand across the road at both ends of every interval, in both dimensions (fixed 2026-11-17: the Nether descent tables now hold their last value after a leg, so the exit portal is placed at the rail height and not above the cave, where it was never visible); around each one a purple flash covers about 0.5 s at cruise speed, which hides the jump of the camera height. In the Nether the camera has a minecart (entity texture) fixed around it.
- **Sky, light and post-processing (2026-11-16, user-requested; PROPOSED, awaiting visual approval on a GPU):** in the style of the shader packs players install for block games (techniques written from scratch; no code from any pack, whose licence forbids reuse). `atmosphere.ts` (pure) gives, from the baked hour, the linear sky colours, sun direction, the light that falls on the world (sun by day, moon by night, faded to 0 at the swap) and the sky ambient; `skyGlsl.ts` turns them into one sky function shared by the dome, the fog (fogged blocks take the colour of the sky behind them), water reflections and the clouds. Blocks are lit in linear HDR: hemisphere sky ambient x baked sky light, direct sun/moon light where sky light is near 15 (stands in for shadows), warm block light; light sources above white. Water: sky reflection with small waves, Fresnel, sun highlight. Plants sway with a wind on track time. `post.ts` (`VoxelPost`): the scene renders into a half-float MSAA target, every material writing its visibility through the fog to alpha; then volumetric clouds (half resolution, 40-step ray march between 250 and 430 m through a 64^3 tileable Perlin-Worley texture built at load by `cloudNoise.ts` in about 0.5 s, 5-step light march, two-lobe phase, coverage from the baked mood 0.42..0.62, brightness from the smoothed mids), composite by alpha, light shafts (quarter resolution radial blur toward the sun), 6-level bloom, ACES-fitted tone map, saturation, vignette, display encoding, and the portal flash. No history buffers: each frame is a pure function of its inputs. Contract: `ScenarioScene.render?(renderer, camera)` (optional; the controller falls back to `renderer.render`), Synthwave unchanged. The block clouds are removed. Verified by typecheck, unit tests (atmosphere continuity, noise determinism and tiling) and headless SwiftShader screenshots (noon, dawn, sunset, night, Nether); GPU frame rate not measured.
- **Green, wooded mountains (`terrain.ts`, `chunk.ts`, `far.ts`, scenario version 12, 2026-11-17, user-requested: the mountains were bare stone, near and far; PROPOSED values, to be tuned in review).** The soil rule keeps grass up the slopes: bare rock only from an effective slope of 2.6 (full at 3.8; was 1.3..2.2), the altitude weight is 0.9 over layers 96..140 (was 1.2 over 70..112), snow from layer 100 (was 92), cliffs (`fillCliff`) from slope 2.3 (was 1.5). On slopes over 1.2 the grass also covers up to 4 blocks under the top one (`grassCover`, 70% of those blocks by hash), so the faces of the steps are green; the far field draws the same cover in its wall bands. Trees: `treeLine` 98 (was 74); on mountain columns (`mountain` over 0.15, slope up to `TERRAIN.treeSlope` 3) the density is at least 0.07 in forest and 0.04 elsewhere (`TERRAIN.mountainTrees`, was 0.045 / 0.012 / 0.002) and a step of 3 blocks to a neighbour is accepted (was 2); the far field applies the same rule to its tree cells and grows the leaf canopy of its 8-block cells also on mountains outside dense forest. Tests use a fixed seed version (`TEST_WORLD_VERSION` 11), so a version bump does not change the worlds they were written on. Verified by unit tests (grass share of the mountain surface by altitude, grass under the top block of a steep slope, trees high on the mountains in the detailed and in the far terrain) and typecheck; not seen on a GPU.
- **Spruce forest only on the extremely distant mountains (`far.ts`, `chunk.ts`, `blocks.ts`, scenario version 13, 2026-11-17, user-requested; PROPOSED values; supersedes the mountain tree density of version 12 and the near/middle spruce of the first version 13).** The user rejected a spruce forest that buried the near and middle terrain while the far mountains stayed bare. Now the detailed terrain (`chunk.ts`) has the ordinary forest everywhere (oak, birch, big oak, the original densities), no spruce, bushes only in dense forests, ferns only in dense forests; `TERRAIN.mountainTrees` is removed. The far field draws spruce only in cells of 8 blocks at |x| of at least `FAR.spruceFrom` (576) on mountain columns of slope up to `treeSlope`: one spruce per cell with chance `FAR.spruceChance` (0.85), standing in the middle of the cell, `FAR.spruceTall` (2) blocks taller than `spruceHeight`; the 2- and 4-block cells have only the ordinary trees and the oak canopy of dense forests. Measured on seed 12345 (share of mountain columns whose top is a leaf, 40..98 layers): near 9% at 40..576 blocks (was 61..78%), 35% at 576..1280 (was 46%: seen from above the cones leave gaps between them, so this share is lower than the old flat canopy, even though from the side each cell now holds a tall tree; the density of the far forest is to be judged by eye). Blocks: new blocks `spruceLog`, `spruceLeaves` (gray texture, fixed spruce tint through `FLAG.spruce`) and `fern` (cross plant, grass tint), with Faithful 32x textures (same pack and licence as the others, branch 26.2 of Faithful-32x-Java). The spruce is a trunk of 7..11 blocks (`spruceHeight`) with a three-tier cone box, drawn only by the far field. Experiment (not a decision): `VITE_VOXEL_NEAR_HALF` (96..512) widens the detailed volume; unset it is 96 (see `terrain.ts`). Verified by unit tests and typecheck; not seen on a GPU.
- **Wider detailed volume (`terrain.ts`, `logic.ts`, scenario version 14, 2026-11-17, user-requested: the loss of detail at 6 chunks was too close to the screen; PROPOSED values, to be tuned by frame rate and generation time).** The detailed 1-block volume is now 512 blocks (32 Minecraft chunks of 16) to each side of the road (`TERRAIN.halfWidth`, was 96 = 6 chunks) and 12 segments of 64 blocks ahead (768 blocks = 48 chunks, was 6 = 24 chunks); 2 segments behind (unchanged). The far field starts where the detailed volume ends (`FAR_EDGES` follow `TERRAIN.halfWidth`), so its 2-block band (up to 256 blocks) now lies inside the detailed volume and its first cells outside are 4 blocks wide; its extent (`FAR.halfWidth` 1280, 6 segments ahead) is unchanged. `VITE_VOXEL_NEAR_HALF` (96..512) still overrides the width (it was an experiment; now it only lowers the default, e.g. 256 on a slower machine). Rejected after measuring: 128 chunks (2048 blocks) to each side and ahead, about 18 s and 3.2M vertices per segment in Node, and most of it past the end of the fog. Cost with 512 (Node, one thread, one segment, synthetic timeline): about 5.3 s and 0.8M vertices for segment 5, 6.1 s and 1.0M for segment 6 (it was not measured at 96). The camera crosses one segment in about 3.8 s at 17 m/s, so generation per segment is slower than the pace unless the Worker keeps ahead; the first window of 14 segments is not measured in the browser. Not measured on a GPU or in the browser (frame rate, memory and loading time are unknown). Verified by unit tests and typecheck.
- **Reduced detailed volume and fog (`terrain.ts`, `logic.ts`, `far.ts`, `scene.ts`, scenario version 17, 2026-11-17, user-requested: loading was slow and, at about 100 km/h, the scenery sometimes did not load in time; PROPOSED values, to be tuned by frame rate and generation time).** The detailed 1-block volume is now 384 blocks (24 Minecraft chunks) to each side of the road (`TERRAIN.halfWidth`, was 512 = 32) and 8 segments of 64 blocks ahead (512 blocks = 32 chunks, was 12 = 48); 2 behind (unchanged). The fog follows the detailed volume: `FOG_RANGE` is derived in `scene.ts` from `TERRAIN.halfWidth` and the segments ahead (complete at the nearest edge of the detailed terrain, `min(halfWidth, (segmentsAhead - 1) * segmentLength)` = 384 m, starting at 45% = 173 m; was a fixed 650..1250), so changing the chunks changes the fog and the far field is almost hidden (it now lies beyond the fog; it could be shrunk further). ( the Nether haze keeps its 16% share), the far field shrinks to 4 segments of 256 ahead (1024 m) and `FAR.halfWidth` 896 (was 6 and 1280), so it still ends past the fog, and the camera far plane is 1500 m (was 2600). The far field still starts where the detailed volume ends. `VITE_VOXEL_NEAR_HALF` (96..512) still overrides the width. Not measured in the browser or on a GPU (loading time and frame rate unknown). Verified by typecheck and unit tests (see the task report).
- **Mountains without towers (`terrain.ts`, `chunk.ts`, scenario version 18, 2026-11-18, user-reported: the distant mountains looked like towers and "planets" with no logic; DECIDED 2026-11-18: approved by the user after a manual test in the app, overworld and Nether generation kept as they are).** Not caused by the far field: the detailed volume never reads it (both are pure functions of `terrain.ts`), and the far field lies beyond the fog. Causes measured on seed 12345: (1) the jagged peaks of `mountainShape` (scale 26 blocks, up to about 36 layers, added only where the massif is already high) were blades with a median width of about 6 blocks and near-vertical walls on top of a smooth massif (scale 190); they reach full height only beyond `centreClear` (|x| > 120), which is why the mountains near the road looked fine. (2) Some of them reached `topY` and were cut flat. (3) `fillCliff` shifted each layer by rounded 3D noise of up to 3 blocks (6 on every row near a cave), changing by about 0.8 (1.4) blocks per layer; on a slope s a shift moves the face by shift x s layers, so the steepest faces switched between rock and air from layer to layer: 30% of the cliff columns (50% near a cave) had air inside their rock, rock fragments floated, and grass or snow copied from a neighbour's top showed inside the face. Changes: peaks at scale 90 with up to 22 layers (`jagAmp`, `jagScale`, ridged noise / 0.3), as broad as they are tall; heights above `topKnee` (128) are eased toward `topY` (`softTop`, same value and slope at the knee) instead of cut, so no column reaches the ceiling; `fillCliff` bounds the shift by `cliffRise` / slope blocks (6 layers of movement whatever the slope), uses slower noise (`cliffScale` 12 x 12, not rounded) and a bilinear height between grid columns, and fills the column run by run, top down, with `groundBlock` (the soil and surface rules of `naturalBlock` for a given top) so soil and snow lie only on exposed blocks; the density cut (`densityTop`) applies to it as before. The wide cave-mouth shift (`caveCliffWarp`) now fades to `cliffWarp` over `caveBrowHalf` away from the road instead of applying to every cliff of the approach rows. Measured after the change (same sample): cliff columns with air in their rock 1% (was 30%; 1% near a cave, was 50%), floating fragments 11 (was 158; the remaining ones also exist without cliffs), grass or snow inside a face 0% (was 12%), mountain columns at the ceiling 0 (were 20 of 173k), highest column 149. Test: `voxel mountains: no towers on the massifs, no summit cut flat at the ceiling, no holes in the cliffs` (fails on the version 17 code on all five checks); the "high ground shows rock and snow" check of the grass test now counts from `snowLine`, since the peak slopes below it keep their grass. Verified by unit tests, typecheck, and CPU renders (side elevations, cross-sections and a raycast from the road), then by the user in the app (manual test, approved); frame rate not measured.
- **View distance and far field (`far.ts`, scenario version 5, 2026-11-17, user-requested; PROPOSED, awaiting visual approval on a GPU):** the fog now starts at 500 m and is complete at 1250 m (it was 70..150 m, which hid everything past mid distance); the Nether haze keeps a short range (16% of that, about 80..200 m, colour #330808 of the biome). Past the detailed segments (+-96 blocks across, 6 x 64 m ahead), Voxel opts in to the shared far-field layer (`ScenarioLogic.farField`, see 8): segments of 256 rows, 6 ahead (1.5 km) and 5 behind, +-1280 blocks wide, made of 8 x 8-block cells sampled at their centre from the same `columnAt` / `naturalBlock` (the road cut is applied within `ROAD.flatHalf` of the road), drawn as blocky boxes with the block textures (top face, walls toward lower neighbours, grass/dirt/stone bands), forests as a 6-block leaf canopy, flat water below the sea level. The far meshes use the detailed shaders with a `FAR_LAYER` define that discards fragments inside the area of the contiguous run of loaded detailed segments (`uNearClip`, a pure function of the loaded set and the camera); cell edges are aligned with that area's borders (`FAR_EDGES`), and walls on those borders reach down to layer -16, so the edge of the detailed area is closed. Hidden in the Nether. Camera far plane 2600 m. Cost (Node): about 80..140 ms and about 75k triangles per far segment, 12 loaded (about 0.9M triangles). Verified by unit tests (reproducibility, cell alignment, coverage of the fog range) and typecheck only; not seen on a GPU, frame rate not measured. Since scenario version 8 (2026-11-17, user-requested: the sides looked unrendered, because 8-block cells sampled at one point flattened every mountain within a few hundred metres of the road) the cells grow with |x|: 2 x 2 blocks up to 256 blocks from the road, 4 x 4 up to 576, 8 x 8 beyond (`FAR.bands`, `cellSizeAt`); each column of cells has rows of its own size, and walls between bands are split at the finer rows. The cell slope (for snow and bare stone) comes from the neighbour cells. 2 far segments behind instead of 5. Cost (Node): about 350 ms and about 114k quads per far segment, 8 loaded (about 1.8M triangles); not measured on a GPU. Since scenario version 10 (2026-11-17, user-requested: the distant land looked bare and flat, without textures or trees; PROPOSED values, to be tuned in review): (1) the cells of 2 and 4 blocks may hold a tree of their own (`Cell.tree`, `addTree`): a trunk box and two leaf boxes (5 x 5 and 3 x 3) of oak or birch, at the detailed terrain's own density (`FAR.treeDensity`, one tree per cell at most, a pure function of the cell's first column and row and the world seed; not on slopes of 1.2 or more); the 8-block cells of a forest keep the leaf canopy but its height varies by cell (5 to 7 blocks, `FAR.canopy`, `FAR.canopyExtra`); (2) the far quads carry ambient occlusion: the foot of a wall is darker (taller wall, darker; fading over the first 4 blocks), trunks and the underside of crowns too; (3) the far fragment shader (`FAR_LAYER`) multiplies the colour by a tone per 3-block patch and per 48-block area (`farTone`) and samples the atlas with gradients scaled by 0.55, so the mip chain keeps one more level of detail instead of averaging each texture to one flat colour; (4) the fog starts at 650 m instead of 500 m and closes with a steeper curve (smoothstep to the power 1.35), so mid-distance terrain keeps its contrast. Cost: more vertices per far segment (trees are 5 quads per box); not measured on a GPU. Verified by unit tests (trees only in the fine cells, darkened wall feet, reproducibility) and typecheck; not seen on a GPU.
- **Nether post rows and beats (`netherPosts.ts`, `beats.ts`, scenario version 22, 2026-11-18, user-requested, supersedes version 21's beat-switched lamps; PROPOSED, not yet seen on a GPU):** only in the Nether (the overworld posts keep their glowstone and spacing). The post lamp is the block `redstoneLamp`, now an ordinary always-lit light source (texture `redstone_lamp_on`, emissive, `LIGHT_EMIT` 15); the separate lamp light channel, the `uLamp` uniform and the segment `beats` fields of version 21 are removed. The posts' rows are chosen so the camera passes each post on a beat: for every beat of a visit, the row whose post leaves the screen closest to 115 ms after the beat is kept if that is within 80..150 ms (`POSTS.leadS`, `POSTS.windowS`). Then, from the entry portal, the candidate nearest to 16 rows past the last post is taken, at least 10 rows past it (`POSTS.spacing`, `minGap`). Where the next usable candidate is more than 32 rows away (`maxGap`), evenly spaced posts fill in, and the tail past the exit portal is evenly spaced. "Leaves the screen" is computed from the path, using the camera the controller builds: distance, height over the deck, pitch (0.8 x the slope angle), vertical FOV `fovAt`, a 16:9 aspect and the 0.5 m near plane. The post's boxes (bracket, fence column, arm, lamp) are tested against the view frustum, and the last moment any of them is in view is found to 1 mm. The world cannot depend on the window, so the aspect is fixed. The lamp leaves last, through the top of the screen, which the aspect does not change. The viewer's look offset is not included. The rows are a pure function of the timeline and the path, memoized per path; they are passed to `buildNetherVolume` as `postAt`. Beats are a scenario-local estimate until the timeline has beat events (ADR 0007): an onset envelope (flux plus 1.5 x the bass rise, minus its 0.4 s mean, scaled to unit deviation), one tempo from its autocorrelation with a log-normal prior around 120 BPM (60..180), and dynamic-programming beat tracking (Ellis 2007, tightness 100), with leading and trailing beats weaker than half the RMS beat onset trimmed and beats in silence dropped; memoized per timeline. One tempo per song: tempo changes and music without a pulse are not handled (posts then fall back to even spacing). Verified by unit tests: synthetic kick tracks at 96, 128 and 150 BPM give one beat per kick within 30 ms, and none in a silent intro. On a 128 BPM kick track with a Nether visit, every post leaves the screen 80..150 ms after a beat (measured 97..131 ms), with gaps of 10..32 rows (measured 12..14), and the placement is deterministic. A track without a pulse falls back to even spacing. The overworld posts keep glowstone, and the lamp is emissive with block light 15. Typecheck passes. Not seen in the app.
- **Drivers:** clouds (mids), water glints (highs), floating cubes: spin kick and edge flash (flux, same logic as before but kept at least 30 m to the side and 28 m above the camera), portals (energy), caves, Nether and hour (section intensity with hysteresis, baked).
- **Cave and Nether music-driven blocks (scenario version 24):** `blocks.ts` `BAND.cave` (1, in the low two flag bits of blocks with `FLAG.energy`; the portal keeps 0, steady) marks the cave blocks `redstoneOre` (stone texture with red specks painted in `textures.ts`; the shader makes only the red pixels emissive; their baked block light is tinted red and dimmed in sky-less caves in `lighting()`) and `caveLamp` (glowstone texture), placed only by `carveCave` (`chunk.ts`), so the open road never has them. **Cave pulse (`cavePulse.ts`, 2026-11-18, user-reported: erratic blinking; PROPOSED values, not yet seen on a GPU):** the Worker bakes `caveBeats` into each segment descriptor: the `bassBeatTimes` within 2 s of its time span, each with a peak (0.55 + 0.45 x bass, x 1.3 on every 4th beat of the song) and a decay constant (0.35 x the interval to the next beat, 70..300 ms). The scene passes the last three beats of the segment under the camera to `uCaveBeats` (time relative to now, peak, decay), and the shader evaluates the envelope (25 ms linear attack, exponential decay; `PULSE_GLSL`, the twin of `beatEnvelope`) per fragment, delayed by its distance from the camera / 60 m/s (at most 150 ms), so the beat spreads as a wave. Only the redstone specks pulse (`0.3 + 1.2 x pulse`). Where no beat lies within 1.5 s, `uCaveOnset` fades in over 0.5 s: flux squared with an instant rise and a 0.18 s decay. The cave block light in `lighting()` and the wall lamps follow only `uCaveBreath` (energy smoothed over 0.6 s), so no large surface pulses fast. The drifting cubes keep `cubeGlow`, unchanged; `uCaveGlow` is removed. Deterministic from the timeline, except that the smoothing (breath, onset fallback) depends on the frame steps, like the other smoothed drivers. Nether: `NETHER.lavaFallDensity`, `glowCell`, `glowKeep` set the density of lava falls and glowstone clusters (coverage measured in `tests/voxel.test.ts`); the light posts use `bassBeatTimes` (`beats.ts`: the same beat tracker over the rise of the bass only) with `POSTS.minGap` as the least spacing, so fast beats give a post every 2nd or 3rd beat. The beats are still the scenario's own estimate until the timeline provides them (ADR 0007).
- **Pulsed light blocks (scenario version 25, 2026-11-18, user-requested; PROPOSED values, not yet seen on a GPU):** `BAND` becomes `{ none 0, bass 1, mid 2 }`. Bass: `redstoneOre` (specks only) and `netherGlowstone`; mids: `caveLamp`, `caveGlowstone` (the cave ceiling glowstone, light 15) and `lavaFall` (the Nether lava-fall columns: the same texture, light and fluid faces as `lava`, `isLava` in `blocks.ts`; the sea and the pools stay `lava`, steady). Overworld glowstone and the post lamps keep plain emissive blocks. `NETHER.glowCell` 18 -> 12 (about 2.2x the clusters). The mids channel (`cavePulse.ts` `midHitTimes` / `caveMids`, memoized per timeline) takes local peaks of the rise of the mids track minus its 0.4 s mean, over 1.5 standard deviations, at least 0.15 s apart, dropping any within 60 ms of a bass beat and any in silence; each hit has a peak 0.6 + 0.4 x mids and a decay 0.25 x the interval to the next hit (60..200 ms). The segment descriptor carries `caveMids` next to `caveBeats`; the scene fills `uCaveMids[3]` the same way. In `shade()` a pulsed block draws its lit texture (whole light blocks dimmed to 0.35, the ore at full) plus `rgb x 3.6 x 1.95 x pulse` on its emissive pixels, so it is dark between pulses and about 30% above the previous peak on them; the bass channel keeps the wave delay and the onset fallback, the mids channel the wave only. The orange tint and the breathing of the wall lamps are removed; the cave block light in `lighting()` still breathes. Verified by unit tests (a synthetic kick-and-snare track: mids hits on the snare, never within 60 ms of a bass beat, spaced, deterministic, none in silence; the block bands); typecheck passes. **Version 26** (tried and reverted: a glow following the live band level, `uBandLevel`; it lit the blocks by default). **Version 27 (2026-11-18, user-requested; PROPOSED values, not yet seen on a GPU):** `CAVE_PULSE.attackS` 70 ms; the glowing pixels of every pulsed block keep 0.15 of the scene light between pulses (`PULSE_DARK`, now applied to the ore specks too), and the envelope peak is `rgb x 3.6 x 2.4`. New kind `BAND.bassGate` (3) for `redstoneOre`: binary. `caveBeats` also bakes `holds` per beat (`holdOf`: from the beat, while the bass track stays above 0.5 of its peak in the first 50 ms, clamped to 80..300 ms and to the interval minus 40 ms; 0 in silence); the scene sets `uRedstone` = `redstoneAt(beats, now)` (0 or 1) and the shader draws `rgb x 3.6 x 2.6 x uRedstone` on the specks, with no wave and no onset fallback. The mids channel carries `holds` of 0. **Version 28 (2026-11-18, user-reported: some repeated kicks did not light; user-requested to follow the band level like the Synthwave mountains and sun; PROPOSED values, not yet seen on a GPU):** the pulsed blocks no longer use beat detection (`caveBeats`, `caveMids`, `midHitTimes`, the envelope, the wave from the camera and the onset fallback are removed; `bassBeatTimes` stays for the Nether posts). `cavePulse.ts` computes, once per timeline (memoized), for the bass and mids tracks: `(level - local mean over 0.5 s) / max(0.15, local max over 1 s - that mean)`, clamped to 0..1, 0 in silence; and a binary redstone track on the bass pulse (on at 0.5, off below 0.3, at most 0.3 s per run, then off until the pulse falls below 0.3). Each segment descriptor carries the slice around its time span (`cavePulse`: `t0`, `rate`, `bass`, `mid`, `redstone`); every frame the scene reads it at the track time (`pulseAt`, linear like `Timeline.evaluate`) into `uPulseBass`, `uPulseMid` and `uRedstone`. Peaks (2.4, redstone 2.6) and `PULSE_DARK` (0.15) are unchanged. Verified by unit tests (a kick, a second kick 150 ms later and a snare per 0.5 s: each kick flashes above 0.8 and lights the redstone, dark before the next kick, the snare lights the mids; a held bass note keeps the redstone lit at most 0.3 s; silence gives 0; deterministic); typecheck passes. Version 29 (2026-11-18, user-requested, PROPOSED, not yet seen on a GPU): cave block-light gain `CAVE_LIGHT` 0.5 -> 0.7 (before the breathing); glowstone peak `PULSE_PEAK` 2.4 -> 1.9 and redstone `REDSTONE_PEAK` 2.6 -> 2.0, the pulsed lava falls keep 2.4 (`LAVA_PEAK`, picked in the shader by the animated flag); Nether `lavaFallDensity` 1/75 -> 1/150, and `lavaFallLit` (40%) of the falls use `B.lavaFallLit` (47: same lava texture, light and fluid faces, emissive and animated, no energy flag, so steady). One kind per fall (hash per column). Unit test: both kinds appear in a Nether visit, one kind per column; `lavaFallLit` is lava and never pulsed. Version 30 (2026-11-18, user-requested, PROPOSED, not yet seen on a GPU): the cave redstone ore is removed (block, atlas layer, painted texture, `uRedstone`, the binary track in `cavePulse.ts` and `BAND.bassGate`); `B.caveGlowstone` (ceiling) and every `B.lavaFall` are steady emissive blocks without `FLAG.energy` (`B.lavaFallLit` and `lavaFallLit` from version 29 are gone, the fall density stays 1/150); only `B.caveLamp` (wall lamps, mids) and `B.netherGlowstone` (bass) still pulse, at `PULSE_PEAK` 1.9; `CAVE_LIGHT` 0.7 -> 0.9. Unit tests: the kind of each light block, and no redstone ore in the generated caves.
- **Textures:** unmodified Faithful 32x textures (README credits) in one `DataArrayTexture` atlas with one layer per texture or animation frame (water 32, lava 20, magma 3, portal 32); the minecart entity texture is loaded separately.
- Seeds: named path `terrain`; hashes with fixed salts; no `Math.random`. Verified by `tests/voxel.test.ts` (reproducibility, seams, clear corridor, bridges, schedule, Nether path, drivers) and by headless screenshots (SwiftShader); frame rate on a GPU is not measured yet.

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
- Horizontal look to the left: maximum -65° (changed from -45° to -55° on 2026-11-15 and to -65° on 2026-11-16, user-authorized).
- Horizontal look to the right: maximum +65°.
- Vertical look upward: maximum +55° (changed from +45°, user-authorized 2026-11-15).
- Vertical look downward: maximum -30° (changed from -45°, user-authorized 2026-11-15).
- Horizontal and vertical limits are independent.
- The limits do not form a combined cone restriction.
- Forward movement remains straight and independent of camera orientation.

**DECIDED — Camera speed** — Forward speed is constant (baseline), so camera position is a pure function of track time, `z(t) = v · t`. Musical influence comes from how the world reacts, not from camera speed. Modulating speed over time remains possible later because position is defined as a function of time; any such change must stay deterministic and time-addressable.

**DECIDED — Per-scenario camera path (2026-11-15, user-authorized exception for Synthwave Dimension only)** — A scenario may opt in to a music-driven path through the optional `ScenarioLogic.createPath(timeline)` returning a `TrackPath` (`distanceAt`, `timeAt`, `heightAt`, `slopeAt`, all pure functions of track time). Scenarios without `createPath` keep the constant speed `z(t) = v · t` and a flat road, so the other scenarios are unaffected. The Experience controller uses the path for the camera distance and height, and the Worker passes the same path to `generateSegment` (`SegmentInput.path`) so the terrain spacing and the road elevation (`roadY`, one value per row) agree with the camera. Synthwave (`synthwave/path.ts`, scenario version 10; continuous model approved by the user on 2026-11-15, replacing the earlier 5-level section model) follows the music second by second. Intensity = log loudness (energy in dB above -30 dB) mixed with spectral flux, smoothed with a centered (zero-lag) filter of about 1.5 s and scaled between the song's 2nd and 98th percentile, so a change shows up when it happens in the music and subtle changes still bend the road a little. The target slope comes from the intensity against the song's median plus its contrast with the surrounding ~20 s: calmer climbs, more intense descends, proportionally to the difference, up to 0.75 (about 37 degrees). The ratios follow Audiosurf 2's modding defaults (community docs, github.com/DeathByNukes/as2-doc: `playerminspeed` 0.1 / `playermaxspeed` 2.9, `uphilltiltscaler` 0.8 / `downhilltiltscaler` 1.55, `uphilltiltsmoother` 0.03 / `downhilltiltsmoother` 0.06): descents are about twice as steep as climbs for the same difference and the slope tips downward twice as fast (time constants 0.4 s down, 0.8 s up). Speed is set in log space: about 280 km/h on flat road at median intensity (minimum 100 km/h on the steepest climbs, maximum 600 km/h), faster when more intense, and the slope adds a physics-like term (a steep climb brakes more than a gentle one, a steep descent speeds up more than a gentle one), clamped to 100..600 km/h while the music plays (the km/h scale is our choice, Audiosurf's is not public). The road height is the integral of the slope with no height limit, so a song drifts downhill overall like Audiosurf's tracks. The camera pitch follows 80% of the slope angle, and the whole cross-section (road and mountains) rides the elevation in the terrain vertex shader. Tempo and beat data do not exist yet (ADR 0007), so loudness and flux are the pace proxy. Verified by unit tests (reaction within about 1 s, subtle vs. big changes, steeper climbs slower, descents steeper than climbs, monotonic distance, `timeAt` inverse, seams, determinism) and by the track preview tool on the user's reference song compared with an Audiosurf 2 screenshot; not yet seen on a GPU in the app, so the constants (`PATH` in `path.ts`) are a first tuning.

**DECIDED — Voxel Dreamscape path and field of view (2026-11-15, user-requested; heights updated 2026-11-16)** — Voxel Dreamscape also defines `createPath(timeline, worldSeed?)` (`voxel/path.ts`); in the overworld the road height follows only the bridges (`heightAt`/`slopeAt` from `road.ts`, see 9.1) and the Nether rail profile replaces it inside a Nether interval (2026-11-17, user-requested: a roller coaster with the music in the manner of Synthwave's road, local to the Nether and independent of that scenario: drive = intensity against the visit's 40% quantile + 0.8 x against the surrounding ~8 s; more intense than expected descends up to slope -0.6 and calmer climbs up to +0.28 (a climb needs twice the difference), time constants 0.35 s down and 0.8 s up; the speed gains up to +0.45 ln on the steepest descents and loses up to 0.5 ln on the steepest climbs, within 40..100 km/h; constants in `NETHER_PATH`; PROPOSED tuning, not yet seen on a GPU), and the speed follows the music (intensity = log loudness + flux, centered ~1.5 s smoothing, rank-scaled; ln speed = ln 63 km/h + 1.6 x (intensity - median), clamped to 40..100 km/h, followed with a 1.2 s time constant; eased to 25 km/h over 2.5 s after the music ends). Two small shared-contract extensions, both optional and without effect on Synthwave: `TrackPath.fovAt(t)` (the controller sets the camera's vertical FOV from it every frame, default 70 degrees; Voxel: 84 to 117.6 degrees, linear in log speed (2026-11-17, user-requested: 40% wider than the earlier 60 to 84); inside a Nether interval it is 12% wider again, capped at 130 degrees, eased in over 1.2 s after the entry portal and back out over 1.2 s after the exit) `ScenarioConfig.pathTilt` (share of the slope angle the camera pitch follows, default 0.8 as in Synthwave; Voxel sets 0 since scenario version 31, 2026-11-18, user-requested: like the block game the view stays level on steps, bridges and Nether ramps while the camera rides them up and down; `netherPosts.ts` uses the same value for its screen-exit computation) and `ScenarioConfig.speedGraph` (`false` hides the speed-graph HUD for a scenario with a path; every shipped scenario with a path shows it, Voxel included). Verified by unit tests (faster and wider FOV in intense passages, flat road, end speed, `timeAt` inverse, purity).

**DECIDED — End of music and epilogue (2026-11-15, user-requested)** — `Timeline.musicEndS` is the time of the last frame whose normalized energy exceeds `SILENCE_LEVEL` (0.01, about -40 dB below the track's 98th percentile); a fully silent track counts as music to its end. This only locates the end; the audio is never trimmed (Section 5.2). The Experience controller ends the run at `musicEndS + EPILOGUE_S` (5 s) from the audio clock, which keeps running after the source stops, instead of at the source's `onended`. During the epilogue it sets the opacity of a black overlay element (`ExperienceOptions.fadeOverlay`, owned by `App.tsx`, above the scene and the speed graph) to an eased ramp, a pure function of track time (`fadeOut`). Synthwave's path (`path.ts`, scenario version 16): (a) `endingCalmness` scores the 10 s before the music ends, leaving out the last ~1.5 s that the centered smoothing already pulls toward the following silence: calm when its mean intensity is 0.05 above to 0.15 below the song's pivot, or fading when its first 2.5 s are 0.1 to 0.3 more intense than its last 2.5 s (0..1, the larger of the two); (b) the target slope is multiplied by `1 - flatten`, where flatten ramps by that score over the 3 s before the window, so the window itself rides flat, and is 1 after the music ends; (c) after the music ends the speed (and its floor) eases in log space to `endKmh` (50 km/h) over 2.5 s. The path tables run 3.5 s past the audio so this completes even on an abrupt ending; beyond them the path extrapolates at its last state. Verified by typecheck and unit tests (music end detection, calm and fade-out endings flatten, an intense ending does not, no slope jumps, flat road and end speed after the music, abrupt ending); not seen on a GPU in the app, and the thresholds are untuned on real songs.

**DECIDED — Speed graph HUD (2026-11-15)** — `src/experience/hud/speedGraph.ts` draws the speed graph on a separate 2D canvas (a fixed-position element in `App.tsx`, top-right, `pointer-events: none`), owned by the Experience controller and drawn every frame after the WebGL render. It exists only when the scenario defines `createPath`. It plots `TrackPath.heightAt` over the whole track duration (20 Hz table, computed once); the speed readout comes from a 20 Hz table from `TrackPath.distanceAt` (local difference over 0.25 s), so the graph is a pure function of the path and track time and adds no per-frame state. The line is drawn in short pieces colored from `TrackPath.slopeAt` (white flat, green uphill, red downhill, interpolated up to `STEEP_SLOPE = 0.75`, equal to Synthwave's `PATH.maxSlope`). Colors are untuned constants. Verified by typecheck and unit tests only (no unit test for the drawing); not seen in a browser.

**DECIDED — Track preview dev tool (2026-11-15, user-requested)** — `tools/track-preview.ts` (`npm run preview:track -- <audio-file | youtube-url> [--ref image.png]`) runs the same `analyzeTrack` and Synthwave `createTrackPath` as the app in Node and writes a static HTML report to `.preview/` (gitignored): the whole-song road profile (height over distance at true proportions, and over time), the speed and the raw intensity, colored by slope, with an optional reference image (for example an Audiosurf screenshot of the same song) for side-by-side comparison. It is a development aid for tuning `PATH`, not part of the shipped app; it needs `ffmpeg` on PATH for decoding (different from the browser's `decodeAudioData`, so results may differ very slightly) and `yt-dlp` for URLs. No new dependency.

**DECIDED — Look input and recentering**
- Desktop: mouse movement; mobile: finger drag. Gyroscope is out of the MVP.
- Input changes a look offset (yaw and pitch) relative to the forward direction, clamped independently per axis (±65° horizontal, +55° up, -30° down).
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

**Current structure (2026-11-15):** `src/` (frontend: `App.tsx` as the flow input, preparing, running, ended or failed; `home/` with the initial/loading screen (`HomeScreen.tsx`, `home.css`; `progress.ts` is the pure, unit-tested mapping from preparation step to the loading-bar percentage: fixed ranges per step, real fraction from the Worker's analysis progress, time-based asymptotic creep for steps that report none; the ranges are a first guess, untuned) and the per-scenario icon and backdrop screenshots keyed by scenario id (`scenarioArt.tsx`, `img/*.webp`, bundled by Vite; a scenario without an entry gets a generic icon and no backdrop); `audio/sources`, `audio/processing/decode.ts`, `audio/analysis` (FFT and track analysis), `audio/intelligence/timeline.ts`, `world/identity/seed.ts`, `world/segments/manager.ts`, `world/generation` (dedicated Worker, protocol and client), `scenarios` (`types.ts`, `registry.ts`, `logics.ts`, `synthwave/` and `voxel/`, each with pure `logic.ts` and `path.ts` and Three.js `scene.ts`), `experience/controller` and `experience/camera`), `tests/` (`npm test`, Node's built-in runner, no extra dependency; the modules they import are DOM-free and use `.ts` import extensions), `server/` (acquisition backend, Node + TypeScript, run with `npm run server`; Node strips the types natively, so no extra runtime dependency), `shared/` (HTTP contract types imported by both), `spike/` (disposable measurement scripts from the acquisition spike, to be deleted). `npm run typecheck` checks the frontend and the server with separate tsconfigs. The tree below is the original proposal and remains guidance.

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
