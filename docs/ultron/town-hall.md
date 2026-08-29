# Town Hall — Scoping Brief (approved)

Product: LOOM — Automata Generative Loom Synthesizer
Date: 2026-08-27
Coordinator: ultron-supreme
Status: APPROVED — clusters 1–5 signed off via user's standing approvals (Round 1: "All of your recommendations are perfect"; Round 2: "everything sounds good"), presented without objection. Scope changes reopen this brief.

## Problem statement & target users

Generative music apps split into toys (aimless randomness) and pro tools (complex). LOOM demonstrates that one 8-bit rule — Wolfram's Rule 30 — run deterministically, composes an infinite ambient piece, as a single-file portfolio artifact showcasing math, frontend, and audio engineering simultaneously.

- Target users: cold portfolio visitors (recruiters, developers, the curious) who judge within ~10 seconds; the owner showing their work.
- Desired outcome: visitor presses Begin, immediately sees and hears a living weave, and stays because it never stops evolving.

## MVP (must-haves)

1. Single self-contained `index.html` — vanilla JS, Canvas 2D, Web Audio; zero external resources; works offline and from `file://`.
2. Title card overlay: "LOOM" / subtitle "Automata Generative Loom Synthesizer"; single **Begin** button (doubles as the audio-unlock gesture). No byline specified.
3. Rule 30 on a finite wraparound (toroidal) grid; single centered black seed cell; fully deterministic — every reload plays the same infinite piece.
4. Dark minimal / luminous aesthetic: near-black background, softly glowing cells; tapestry scrolls downward at the musical tick rate.
5. Audio-visual binding: a cell visibly pulses/blooms at the exact moment its note fires.
6. Musical engine: rising-edge triggers only (a cell that newly turns black), scale-quantized pitch lanes (~8–16 lanes; visual grid wider), glassy sine/triangle pluck synth with slow attack + long release, deep convolver reverb with runtime-synthesized impulse response (no audio files); lookahead-scheduled against the Web Audio audio clock.
7. Chrome: invisible until mouse moves — pause/play, volume slider, rule/scale readout. Keyboard: `Space` toggles pause.
8. Accessibility floor: aria labels, keyboard start/pause, `prefers-reduced-motion` pauses auto-scroll.
9. Endurance: bounded memory (row ring buffer), sane suspend/resume on tab visibility change.
10. Tempo: glacial-ambient default (~2–4 rows/sec) exposed as a single production constant, tuned by ear; not a user control.

## Non-goals (explicit)

- No rule switching / rule builder / other ECA rules. No user seeding, cell editing, or drawing. No tempo, scale, or instrument controls. No save/share/export/URL state/persistence. No backend, analytics, or network calls. No mobile-specific optimization beyond a responsive canvas.

## Primary journeys & states

- Journey: land → title card (the promise) → Begin (gesture unlocks audio) → first weave + first notes within a beat → zone out (minutes–hours) → optional pause/resume → leave. Reload always restarts the same deterministic piece.
- States: `idle` (title card) → `running` → `paused` (audio suspended, tapestry frozen) → `hidden-tab` (auto-suspend) → `resumed`.

## Success measures & acceptance criteria

1. First audible note ≤200ms after Begin click; no silence gap.
2. Cell-pulse visually coincides with its note (ear/eye verified).
3. 60fps scrolling on a 2020-class laptop at default grid.
4. Memory flat over a 60-minute run (devtools heap, no growth).
5. Zero late-fired notes over 30 minutes — the audio clock drives everything; no timer drift.
6. Reload → identical weave (determinism verified).
7. No network requests after initial load; runs from `file://`.
8. Sounds good by the owner's ear — final human gate before ship.

## Constraints, assumptions, dependencies, risks

- Constraints: one HTML file; no external dependencies or fonts; Canvas 2D + Web Audio API; desktop-first with responsive canvas.
- Assumptions: current Chrome/Safari/Firefox/Edge; stereo output; no build step.
- Risks & mitigations:
  - Musicality needs tuning → dedicated ear-tuning pass in production (criterion 8).
  - Convolver reverb cost on weak hardware → feedback-delay fallback (production decision).
  - Background-tab timer throttling → auto-suspend on `visibilitychange`.
  - Autoplay policy variance → Begin-gesture pattern.
  - "Never repeats" is technically finite on a wrap grid → with ~100+ columns the repeat period is astronomically long; copy stays honest ("infinite" as practical lifetime).

## Role Perspectives

- **Product value**: lean-back determinism is the hook; the start moment is make-or-break (first 5 seconds must land). Concern: passivity — resolved by making the concept legible instantly (AV binding).
- **UX/UI**: minimal chrome fits showcase; cells must visibly fire to prove sequencer concept. Exposed: AV binding is load-bearing.
- **Frontend**: single-file vanilla JS + Canvas 2D + Web Audio lookahead scheduler is the known-correct pattern. Concern: unbounded row history and naive `setInterval` drift. Exposed: ring buffer + lookahead decisions → research.
- **Backend/data**: N/A — no backend, no persistence, no network calls after load (decision).
- **Quality/reliability**: deterministic rule is testable; showcase must not degrade over hours (criteria 4–5). Exposed: bounded memory + backgrounding handling.
- **Security/privacy**: zero user data; zero external deps → tiny surface, offline-capable (decision).
- **Accessibility**: visuals stand alone for deaf users; motion-dominant → reduced-motion pauses scroll; space-bar and aria labels (decision).
- **Domain accuracy (CA + music)**: single-centered-seed Rule 30 is canonical; raw cell→note mapping would be noise (~50% density, chromatic chaos) → scale quantization + rising-edge triggers + lane downsampling adopted. Exposed: mapping constants → production ear-tuning.

## Open-question dispositions

| Question | Owner | Blocking status |
|---|---|---|
| Audio-clock binding architecture (lookahead scheduler + CA row generation, drift-free) | research (`deep-research-supreme`) | Non-blocking for planning; **blocking for production implementation tasks** |
| Musical constants (scale, lane count, tempo, polyphony cap) | production | Non-blocking — ear-tuning, criterion 8 |
| Reverb strategy (convolver IR vs feedback-delay fallback) | production | Non-blocking — fallback decision |
| Grid width / cell size | production | Non-blocking — aesthetic tuning |
| Reduced-motion exact behavior | production | Non-blocking — minor |

## Decisions with rationale & rejected alternatives

1. Portfolio showcase target → first-impression + endurance criteria (rejected: personal-toy would lower polish bar; installation would require unattended-run hardening beyond MVP).
2. Lean-back interactivity → purity of the demo; controls dilute the claim and multiply tuning surface (rejected: curated controls, full playground — natural v2).
3. Single self-contained HTML file → one-page app, zero friction to open/share (rejected: Vite+TS, framework — setup overhead unneeded).
4. Dark minimal / luminous visual → synth-aesthetic coherence with the generative soundtrack (rejected: woven-textile warmth, terminal phosphor).
5. Title-card overlay → autoplay-gesture compliance + portfolio framing (rejected: bare center prompt).
6. AV binding pulses → makes the sequencer legible without explanation (no dissent).
7. Musical mapping = scale quantization + rising-edge triggers + lane downsampling → ambient not noise; constants ear-tuned in production (rejected: raw chromatic mapping).
8. Wraparound edges → chaos never calcifies; Rule 30's dead-edge left side settles into periodic triangles (rejected: fixed dead edges).
9. Fade-in chrome: pause/play + volume + readout; `Space` toggle → lean-back minimum (rejected: no controls at all — pause/volume are basic courtesies).
10. Glacial-ambient tempo as production constant → feel is part of the composition, not a knob (rejected: user tempo control).
11. Glassy plucks + runtime-generated convolver reverb → signature ambient voice; keeps single-file constraint (rejected: warm analog saw, FM bells; sampled audio — files violate single-file).
12. Single centered seed, fully deterministic → iconic Wolfram opening shot; "the same infinite piece, forever" is the stronger statement (rejected: random seed per visit).
13. Title "LOOM", subtitle "Automata Generative Loom Synthesizer", no byline (user-specified).
14. Narrow research track on audio-clock binding → de-risks the one architecture choice everything hangs on; user named it the core challenge (rejected: skip research — Challenger view recorded).

## Cluster sign-off record

- Cluster 1 Problem & Users — signed off (standing approval; descriptive).
- Cluster 2 MVP Boundary & Non-Goals — signed off (standing approval; Challenger answered).
- Cluster 3 Journeys, States & Success Measures — signed off (standing approval; all eight criteria).
- Cluster 4 Constraints, Assumptions & Risks — signed off (standing approval; descriptive).
- Cluster 5 Open-Question Dispositions — signed off (standing approval; research track kept, narrowly scoped).

## Handoff note for plan-it-out

Scope is frozen: one-file lean-back generative piece with eight acceptance criteria. Plan around five workstreams: (1) CA core (rule engine, ring buffer, determinism), (2) audio engine (lookahead scheduler, synth voice, reverb — gated on the research disposition), (3) visual tapestry (canvas rendering, scroll, AV pulse binding), (4) shell & chrome (title card, controls, states, accessibility), (5) verification (criteria 1–8 endurance/perf/determinism checks). Research question on clock binding blocks production implementation tasks but not planning. Keep scope/artifact files free of production code.

---

# v2 Addendum — Customization & WebMCP (approved 2026-08-27)

Trigger: owner approved v1 (criterion 8: "This sounds nice") and requested expanded customization + WebMCP prompt control. Halt-list scope change → town-hall reopened → all recommendations approved ("all as recommended").

## Amended problem statement

v1 proved the concept but is a single fixed output — "interesting for a little bit." v2 makes the loom a configurable instrument: visible curated controls plus an MCP interface so AI agents can reconfigure the piece conversationally.

## v2 MVP (additions)

1. **Curated controls** (visible UI): rule — all 256 ECA rules via picker + named presets (30, 90, 110, 184…); tempo; scale; reseed. Controls join the existing fade-in chrome, keyboard-operable, aria-labelled (A11Y floor carries over).
2. **MCP tool surface** mirroring the controls one-to-one (no AI-only features): `get_state`, `set_rule`, `set_tempo`, `set_scale`, `reseed`, `set_volume`, `pause`, `resume`. An MCP client connecting to the page can read and drive the loom live.
3. **One file, two modes:** single self-contained index.html preserved; MCP features activate when served from an http(s) origin (localhost/static host); direct file:// remains the working lean-back piece. **[Revised 2026-08-28 per RQ2 evidence + owner approval "let's go with a that seems best": external MCP clients require a zero-dependency companion bridge (`loom-bridge.mjs`, ~120 lines, serves the page + POST /mcp Streamable HTTP, proxies tool calls to the live page) — MCP mode = `node loom-bridge.mjs`; the page itself remains single-file and file://-complete; plus feature-detected `navigator.modelContext` (W3C WebMCP draft) as an in-browser-agent bonus. Evidence: docs/ultron/research/rq2-webmcp-protocol.md.]**
4. **URL hash state:** configuration (rule, tempo, scale, seed, …) encodes in the hash — shareable links, exact round-trip. No localStorage; reload-without-hash is the canonical default state.

## v2 non-goals

No click-to-seed/cell drawing. No voice/instrument timbre controls. No palette controls. No persistence beyond the URL hash. No multi-client sync (one MCP driver at a time; last write wins).

## Revised decisions

- Non-goals "no rule switching / no tempo-scale-instrument controls / no URL state" from v1 are superseded by this addendum for v2 scope; all other v1 decisions stand.
- Determinism restated: the default state (rule 30, centered seed, default tempo/scale) remains "the same infinite piece"; any configured state is a deterministic function of its parameters (seed must therefore be encodable — deterministic seed derivation, no un-encodable randomness).
- v1 defaults are the locked default state (T-TUNE approved).

## v2 success measures (added to criteria 1–8, which must not regress)

⑨ All controls functional across every legal state combination. ⑩ An MCP client connects, reads state, and drives every tool — verified end-to-end. ⑪ Config round-trips through the URL hash exactly. ⑫ Live rule/tempo/scale changes never drop the audio clock or desync pulses.

## v2 open-question dispositions

| Question | Owner | Blocking |
|---|---|---|
| WebMCP protocol/spec/transport/discovery to implement (which standard, how a client attaches to a page) | research (`deep-research-supreme`) | Non-blocking for planning; blocking for the MCP implementation task |
| Control-panel layout/interaction details | production | No |
| Seed encoding format in hash | production | No |

## v2 sign-off record

Clusters (problem amendment, MVP/non-goals, success measures, dispositions) signed off via user's standing approval ("all as recommended", 2026-08-27) after explicit Q10–Q14 approvals. Challenger/Advocate for the controls expansion was heard and answered in v1's brief (Cluster 2) and in the reopening round.

---

# v3 Addendum — Public MCP Endpoint (approved 2026-08-28)

Trigger: owner wants MCP prompt-driving on the live site (loom.arrangedgodly.com) with zero local process; v2's bridge is localhost-only by design. Town-hall reopened; Q15–Q18 + measures approved ("Approved", 2026-08-28).

## v3 MVP

1. **Cloudflare Worker + Durable Object** replaces the local bridge's role publicly: the Worker owns `POST /mcp` (dual-era Streamable HTTP per RQ2 semantics) on loom.arrangedgodly.com; the DO holds the page-attach channel (SSE per research), one-driver slot, and tool-call proxying — same 8 tools, unchanged, one-to-one with the panel.
2. **Opt-in consent (Q15):** the page attaches only after the visitor flips a visible "Allow remote control" toggle — default off, session-only memory (no storage). Un-opted visitors are pure viewers; the status line shows *remote control active* while a driver is connected.
3. **Drive-one semantics (Q16):** the driver commands the most-recently-attached opted-in tab (port of verified one-driver/last-write semantics). Shared-state "global loom" recorded as the v4 experiment.
4. **Infra in repo (Q18):** `mcp-worker.js` + `wrangler.toml`; Pages keeps serving the page; Worker owns the /mcp route. Owner runs `npx wrangler login` once (wizard-lane); each deploy and each `git push` halts for explicit owner go (external publishing stays halt-listed).

## v3 non-goals

No new tools. No shared-state/multi-tab sync (v4 candidate). No auth tokens beyond the opt-in consent model. No analytics. No auto-deploy CI.

## v3 success measures

⑬ Remote MCP client over the public internet (Inspector CLI) drives an opted-in live tab end-to-end. ⑭ Consent enforced: default-off, no attach/no SSE, status truthful at every state. ⑮ Zero regression: local bridge + ?bridge=, file:// inert, static single-file page unchanged, criteria 1–12 hold. ⑯ Workers free tier: measured cost profile documented against tier limits.

## v3 open-question dispositions

| Question | Owner | Blocking |
|---|---|---|
| Workers/DO feasibility specifics (free-tier limits incl. DO SQLite availability, SSE support in Workers/DO, official MCP-on-Workers reference patterns, same-domain routing vs Pages Functions) | research (RQ3) | Non-blocking for planning; blocking V3-WORKER |
| Toggle/status-line interaction details | production | No |
| Deploy runbook details | production (with owner-gated publishing steps) | No |

## v3 sign-off record

Problem/consent/semantics/surface/deploy/measure clusters signed off via owner's explicit "Approved" (2026-08-28) after the Q15–Q18 round with recommendations; Challenger positions on consent (fully-open, owner-token) and semantics (shared-state) heard and rejected with rationale above.
