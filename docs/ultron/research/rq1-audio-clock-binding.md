# RQ1 — Lookahead-scheduler architecture binding deterministic CA rows to the Web Audio clock

- **Research question (RQ1):** What lookahead-scheduler architecture binds deterministic cellular-automata row generation to the Web Audio clock drift-free? Sub-questions: (a) lookahead window sizing and tick cadence at ~2–4 rows/sec glacial ambient; (b) deriving row tick times from `AudioContext.currentTime` vs alternatives; (c) the timer that drives the lookahead loop under background-tab throttling; (d) correlating scheduled future audio events with rAF-driven visual pulses; (e) suspend/resume across `visibilitychange` without note pile-up or drift; (f) measuring/avoiding late notes.
- **Affected task IDs:** **T-SCHED** (blocking dependency — this document dispositions it), **T-AVBIND** (visual correlation guidance in §Implementation), minor input to T-SHELL (visibilitychange suspend wiring) and T-ENDUR (bounded-memory argument).
- **Track owner / delegation record:** Research track run by subagent for **deep-research-supreme**, 2026-08-27. Primary sources consulted: Web Audio API spec (Editor's Draft 1.1, 21 July 2026), MDN (Window.setTimeout, BaseAudioContext.currentTime, BaseAudioContext.state, AudioContext, Document.visibilitychange, requestAnimationFrame, WorkerGlobalScope.setTimeout, Web Audio API/Advanced techniques), Chris Wilson "A Tale of Two Clocks" (web.dev migration of the HTML5Rocks Jan 2013 article), Chrome for Developers blog (Timer throttling in Chrome 88, 2021-01-18), Chromium Issue 40494643, Nolan Lawson (2025-08-31). All fetched 2026-08-27.

---

## 1. Recommendation (one paragraph)

Use the **classic Wilson lookahead scheduler**: a coarse main-thread timer (`setInterval`, 100 ms — self-chaining `setTimeout` equally valid) whose callback runs a catch-up loop that schedules CA rows against `AudioContext.currentTime + SCHEDULE_AHEAD` with **SCHEDULE_AHEAD = 2.0 s**. Row tick times are *never* derived from the wall clock or from `currentTime` directly; they are **accumulated** (`nextRowTime += rowInterval`) so the sequence is drift-free by construction and deterministic. Visual pulses correlate through Wilson's `notesInQueue` pattern: the scheduler pushes `{row, audioTime}` and the rAF render loop consumes entries whose `time < ctx.currentTime`, blooming the cell exactly when the audio clock crosses the note time. On `visibilitychange → hidden`, stop the timer and `ctx.suspend()`; on visible, `await ctx.resume()`, rebase `nextRowTime = ctx.currentTime + 0.15`, flush stale visual-queue entries, restart the timer. **Do not** use rAF as the scheduling driver, and **do not** add a Worker timer — the Worker exemption under throttling is not documented and is contradicted by Chromium tracker evidence, while the visible-tab path needs no exemption at all.

## 2. Constraints and evaluation criteria

Constraints (from project plan, T-SCHED/T-ARCH): single-file vanilla JS (`index.html`), zero external dependencies, must run from `file://` and offline; hours-long runtime with bounded memory; deterministic CA rows generated just-in-time ahead of the audio clock; ~100–200 grid columns, 8–16 audible lanes per row; shell already specifies hidden-tab auto-suspend and a Begin gesture that unlocks `AudioContext`.

Evaluation criteria: (1) drift-free row timing over hours; (2) determinism of the CA row sequence (row N always derived identically); (3) robustness to main-thread jitter and background-tab timer throttling; (4) visual-audio correlation within perception threshold; (5) clean suspend/resume with no pile-up; (6) implementation complexity acceptable in one script section of a single file; (7) bounded memory; (8) measurable lateness.

## 3. Options considered

### Option A — Classic setInterval/timeout lookahead (Wilson 2013) — **RECOMMENDED**
Timer callback (25 ms in Wilson's metronome; we relax to 100 ms for 2–4 rows/sec) fills a horizon: `while (nextRowTime < ctx.currentTime + scheduleAheadTime) { scheduleRow(...); nextRowTime += rowInterval; }`. Audio events are sample-timed on the rendering thread; the timer only needs to fire "often enough."

- Drift behavior: none — times accumulate independently of when the timer fires; timer jitter only affects how early events are scheduled, never when they play. Wilson's article explicitly attributes this to audio events firing "at exactly their scheduled times even if the main thread is blocked."
- Under throttling: while visible, timers are essentially unclamped. Chrome's "minimal throttling" tier covers pages that are visible *or* "made sound in the last 30 seconds"; MDN additionally documents that inactive-tab throttling "may also be waived if a page is playing sound using a Web Audio API AudioContext" and "Firefox does not throttle inactive tabs if the tab contains an AudioContext." Our shell suspends on hidden anyway, so the hidden-tab regimes (1 s checks; Chrome 88 intensive 1/min) never apply in production. A 2.0 s horizon additionally tolerates the 1 s regime as defense-in-depth.
- Single-file fit: trivial (~30 lines), no Worker, no messaging.
- Risk: main thread can stall (GC, heavy canvas frame) — absorbed by the horizon; horizon sizing is the only tuning knob.

### Option B — rAF-driven lookahead — **strongest alternative, rejected as primary**
Wilson's article itself notes rAF can replace the setTimeout scheduler. Pros: one loop, naturally synchronized with rendering cadence while visible; scheduling piggybacks on frames we already draw. Cons (decisive): **MDN: "requestAnimationFrame() calls are paused in most browsers when running in background tabs or hidden iframes"** — the scheduler would starve exactly when the page is hidden, and unlike Option A there is no fallback tick; rAF cadence is display-dependent (drops under load, changes with refresh rate), coupling audio-horizon health to render performance; a long canvas frame directly delays refilling the horizon. Acceptable only as a *supplement* (see visual-correlation section); if used as the sole driver, hidden-tab suspend must already have happened or audio stops.

### Option C — Worker + setTimeout timer driving the loop — **rejected**
A dedicated Worker created from a Blob URL sends "tick" postMessages to the main thread, which still owns `AudioContext` and does all scheduling (audio nodes cannot be constructed off-thread). Purported benefit: worker timers allegedly escape background-tab throttling. **Documentation does not settle this:** MDN's `WorkerGlobalScope.setTimeout` page carries no exemption statement, and Chromium Issue 40494643 ("Web Workers get throttled if window loses focus") records workers *being* throttled, with the tracker noting the audible-tab exemption as the relief valve. Costs: Blob-Worker construction adds single-file complexity and a `file://` origin risk (opaque origins have historically restricted Worker/Blob combinations in some browsers), cross-thread message latency is another jitter source, and the benefit only exists in a state (hidden, not suspended) that LOOM's shell deliberately avoids. Verdict: complexity buys an undocumented guarantee we do not need. **If** a future owner wants continuous background audio without suspend, run the disposable spike in §7 first rather than guessing.

## 4. Evidence (links, versions/dates, exact claims)

All sources fetched 2026-08-27.

1. **Chris Wilson, "A Tale of Two Clocks"** — HTML5Rocks, January 2013; canonical current home: <https://web.dev/articles/audio-scheduling> (HTML5Rocks retired; redirects here). Exact claims: metronome uses a 25 ms timer with 100 ms lookahead ("A good starting point is probably 100ms of 'lookahead' time, with intervals of 25ms"); the loop `while (nextNoteTime < audioContext.currentTime + scheduleAheadTime) { scheduleNote(current16thNote, nextNoteTime); nextNote(); }`; note time computed as `nextNoteTime += 0.25 * secondsPerBeat` (accumulate from last note, never from `currentTime`); the audio clock is a float of seconds "precise to the individual sample level with ~15 decimal digits of precision even after running for days," whereas `Date.now()` gives integer milliseconds and `performance.now()` still rides a main thread whose timer callbacks "can easily be skewed by tens of milliseconds" by layout/GC/XHR; scheduled audio events run on a separate thread and "fire at exactly their scheduled times even if the main thread is blocked"; lookahead must exceed worst-case main-thread delay plus OS audio buffer ("low single-digit milliseconds to about 50 ms"); drawing uses a *third* timing system — rAF reads `notesInQueue` entries with `time < audioContext.currentTime` — and rAF may replace the timer, but Web Audio precision is still required for the notes.
2. **Web Audio API spec, Editor's Draft 1.1, 21 July 2026** — <https://webaudio.github.io/web-audio-api/> (previous published: W3C REC 17 June 2021). Exact claims: `currentTime` is "the time in seconds of the sample frame immediately following the last sample-frame in the block of audio most recently processed"; "When the BaseAudioContext is in the 'running' state, the value of this attribute is monotonically increasing and is updated by the rendering thread in uniform increments, corresponding to one render quantum" (128 frames); "All scheduled times in the Web Audio API are relative to the value of currentTime"; elapsed context time "may not be synchronized with other clocks in the system"; `AudioScheduledSourceNode.start(when)`: "If 0 is passed in for this value or if the value is less than currentTime, then the sound will start playing immediately" (late notes sound late, not dropped); `AudioContextState` "suspended": "context time is not proceeding, audio hardware may be powered down/released"; `suspend()`: "Suspends the progression of AudioContext's currentTime, allows any current context processing blocks that are already processed to be played to the destination"; `resume()`: "Resumes the progression of the AudioContext's currentTime when it has been suspended"; "A newly-created AudioContext will always begin in the suspended state," and a user agent may allow the initial running transition "only when the AudioContext's relevant global object has sticky activation" (autoplay policy; non-activated `resume()` promises are held pending, not rejected); lifetime: "Once created, an AudioContext will continue to play sound until it has no more sound to play, or the page goes away" (no visibility-based auto-suspend in spec); `getOutputTimestamp()` provided for contextTime↔performanceTime mapping "when accurate synchronization is required"; source nodes created per note are automatically released by the implementation (bounded memory for fire-and-forget voices).
3. **MDN, Window.setTimeout — "Timeouts in inactive tabs"** (current as of 2026-08-27) — <https://developer.mozilla.org/en-US/docs/Web/API/Window/setTimeout>. Exact claims: "To reduce the load (and associated battery usage) from background tabs, browsers will enforce a minimum timeout delay in inactive tabs. It may also be waived if a page is playing sound using a Web Audio API AudioContext." / "Firefox Desktop has a minimum timeout of 1 second for inactive tabs." / "Firefox does not throttle inactive tabs if the tab contains an AudioContext." / Chrome tiers: "Minimal throttling: Applies to timers when the page is visible, has made sound recently, or is otherwise considered active"; "Throttling: ... Timers in this state are checked once per second"; "Intensive throttling: Introduced in Chrome 88 (January 2021) ... Nesting count is 5 or higher. Page has been invisible for more than 5 minutes. Page has been silent for more than 30 seconds. WebRTC is inactive. ... Timers in this state are checked once per minute"; nested timers force a 4 ms minimum after 5 levels.
4. **MDN, Web Audio API — Advanced techniques** (last modified 2025-09-18) — <https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Advanced_techniques>. Self-described "much stripped down version of Chris Wilson's A Tale Of Two Clocks (2013)"; code uses `const lookahead = 25.0` (timer ms), `const scheduleAheadTime = 0.1` (s), `nextNoteTime += secondsPerBeat`, `setTimeout(scheduler, lookahead)` chaining, kickoff `nextNoteTime = audioCtx.currentTime`, and the `notesInQueue`/rAF draw loop `while (notesInQueue.length && notesInQueue[0].time < currentTime)`. Describes `currentTime` as "extremely accurate, returning a float value accurate to about 15 decimal places."
5. **MDN, BaseAudioContext.currentTime** — <https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/currentTime>. "Returns a double representing an ever-increasing hardware timestamp in seconds ... It starts at 0." Also: Firefox may round `currentTime` (2 ms default with `privacy.reduceTimerPrecision`; 100 ms with `privacy.resistFingerprinting`) — harmless at 250–500 ms row intervals, but caps scheduling precision claims.
6. **MDN, BaseAudioContext.state / AudioContext.suspend / AudioContext.resume** — <https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/state>. "The `suspended` state indicates that the audio context was paused in response to a user action inside the web app ... unpaused by running the `AudioContext.resume()` method"; `interrupted` is browser-initiated (e.g., laptop closed, exclusive audio access) with iOS-style `resume()` retry pattern shown. `suspend()`: "temporarily halting audio hardware access and reducing CPU/battery usage"; `resume()`: "Resumes the progression of time in an audio context that has previously been suspended/paused."
7. **MDN, Document: visibilitychange event** — <https://developer.mozilla.org/en-US/docs/Web/API/Document/visibilitychange_event>. "Fired at the document when its visibility status changes — for example, when the user switches browser tabs, navigates to a new page, minimizes or closes the browser"; "Transitioning to hidden is the last event that's reliably observable by the page"; "The transition to hidden is also a good point at which pages can stop making UI updates and stop any tasks"; the page's own example pauses audio on hidden and resumes on visible with a was-playing guard.
8. **MDN, Window.requestAnimationFrame** — <https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame>. "requestAnimationFrame() calls are paused in most browsers when running in background tabs or hidden iframes, in order to improve performance and battery life." (Decisive against Option B as sole driver.)
9. **Chrome for Developers blog, "Timer throttling in Chrome 88"**, Jake Archibald, 2021-01-18 — <https://developer.chrome.com/blog/timer-throttling-in-chrome-88>. Conditions for 1/min intensive throttling (hidden >5 min, chain count ≥5, silent); visible pages and pages that made real (non-silent) sound in the last 30 seconds get minimal throttling; WebRTC-active pages exempt. (Fetched copy served an auto-translation; English conditions corroborated verbatim by MDN item 3.)
10. **Chromium Issue 40494643, "Web Workers get throttled if window loses focus"** — <https://issues.chromium.org/40494643>. Tracker evidence that worker timers are *not* reliably exempt from throttling; the audible-tab exemption is what relieves it. **No MDN or spec text guarantees worker timers unthrottled** (checked `WorkerGlobalScope.setTimeout` — no statement either way).
11. **Nolan Lawson, "Why do browsers throttle JavaScript timers?", 2025-08-31** — <https://nolanlawson.com/2025/08/31/why-do-browsers-throttle-javascript-timers/>. Background: the 4 ms nesting clamp per HTML spec, "even more aggressive for background tabs (1 second in Chrome!)", Safari's heavy timer throttling (~26.7 ms median). Does *not* cover workers, rAF pause, or audio exemptions — i.e., corroborates the throttling landscape but leaves sub-question (c)'s worker variant to tracker evidence/spike.

## 5. Tradeoffs, risks, confidence

- **Tradeoff — horizon size vs control latency:** a 2.0 s horizon means lane/rule/tempo changes take up to ~2 s to reach the speakers. For glacial ambient this matches the aesthetic (Wilson's tradeoff note: lookahead length = how long control changes take to take effect); if the owner wants snappier response, 1.2 s still clears the 1 s background-throttle interval. Do not go below ~1.0 s.
- **Tradeoff — visible-only scheduling:** because we suspend when hidden, background throttling regimes become irrelevant; the cost is that audio stops when the tab is hidden (already the plan's acceptance criterion). If a future owner wants background playback, that is *probably* fine in Firefox (AudioContext exemption) and in Chrome while audibly sounding (30 s rule), but a silent ambient stretch in a hidden tab can trip intensive throttling — then a bigger horizon (≥60 s) or the §7 spike is needed.
- **Risk — autoplay/activation:** `resume()` before sticky activation holds its promise pending (spec); the Begin gesture handles this, but T-SCHED should not `await` an unconditional resume — subscribe to `statechange` and re-check.
- **Risk — visual-queue growth when hidden:** rAF is paused while hidden, so `notesInQueue`-style entries would accumulate if scheduling continued; our suspend-on-hidden prevents it, and the resume flush (below) hard-caps it. Enforce a cap (drop oldest beyond, e.g., 64 entries) as belt-and-braces for hour-long runs.
- **Risk — Firefox `currentTime` rounding (2 ms default; 100 ms with resistFingerprinting):** affects neither 250–500 ms row spacing nor the `time < currentTime` comparison materially; do not build sub-10 ms precision claims into T-AVBIND thresholds.
- **Risk — undocumented worker behavior** (Option C): flagged explicitly; not needed in production.
- **Confidence: HIGH** for the core pattern (timer choice, accumulation-based tick derivation, currentTime as sole scheduling reference, notesInQueue visual correlation, suspend/resume sequence) — every element is spec text or the canonical first-party pattern. **MEDIUM** only for the claim "setInterval keeps adequate cadence in every hidden-tab scenario," which we sidestep by design (suspend-on-hidden) rather than prove.

## 6. Implementation consequences and plan updates (concrete T-SCHED guidance)

**Constants** (scheduler section of the single script):
```js
const TIMER_INTERVAL_MS = 100;    // lookahead timer cadence (Wilson used 25 ms for 16th notes; 100 ms suffices at 2–4 rows/s)
const SCHEDULE_AHEAD_S  = 2.0;    // horizon: > worst-case timer gap; survives even the 1 s background-throttle tier
const START_DELAY_S     = 0.15;   // rebase margin on start/resume so first row is never in the past
const LATE_EPSILON_S    = 0.05;   // clamp margin for the late-note guard
```

**Tick derivation (sub-questions a, b)** — accumulate, never sample:
```js
// state: nextRowTime (audio-seconds), rowIndex (monotonic, drives deterministic CA)
function schedulerTick() {
  const now = ctx.currentTime;
  while (nextRowTime < now + SCHEDULE_AHEAD_S) {
    if (nextRowTime < now + 0.01) {            // late-note guard (f): spec says a past
      lateRows++;                               // start(when) "will start playing immediately"
      nextRowTime = now + LATE_EPSILON_S;       // clamp instead of firing a burst late
    }
    const row = ca.nextRow();                   // deterministic, just-in-time; rowIndex advances 1:1 with rows
    synth.scheduleRow(row, nextRowTime);        // all AudioNode start()/setValueAtTime use nextRowTime
    visualQueue.push({ rowIndex, row, time: nextRowTime });  // bounded: horizon/rowInterval + cap
    nextRowTime += rowIntervalSeconds;          // e.g. 0.25–0.5 s; THE drift-free step (double accumulation,
  }                                             // ~1e-16 s error/op — negligible for hours)
}
timerId = setInterval(schedulerTick, TIMER_INTERVAL_MS);   // self-chaining setTimeout(schedulerTick, TIMER_INTERVAL_MS) equally valid (MDN form)
```
`Date.now()`/`performance.now()` must not appear anywhere in the audio path; `currentTime` is the only scheduling reference (spec: all Web Audio scheduled times are relative to it; it is not synchronized with other clocks).

**Timer (c):** `setInterval` at 100 ms while playing; `clearInterval` on pause/suspend. Rationale: visible pages are minimally throttled; LOOM additionally suspends when hidden; the 2 s horizon would bridge even the 1 s inactive-tab tier.

**Visual correlation (d) — guidance for T-AVBIND:** render loop only; no scheduling here:
```js
function renderFrame() {                       // rAF loop (T-VIS owns it)
  const now = ctx.currentTime;                 // audio clock, NOT rAF timestamp
  while (visualQueue.length && visualQueue[0].time < now) {
    const e = visualQueue.shift();             // Wilson/MDN notesInQueue pattern verbatim
    pulses.bloom(e.rowIndex, e.row);           // cell blooms exactly as its note sounds
  }
  renderer.draw();
  requestAnimationFrame(renderFrame);
}
```
At 60 fps the bloom trails the audio clock by ≤1 frame (~16.7 ms) — far under ambient perception thresholds. If T-AVBIND later needs speaker-aligned (rather than render-aligned) blooms, use `ctx.getOutputTimestamp()` to offset by `outputLatency`; document any threshold as ≥20 ms given Firefox's rounding.

**Suspend/resume sequence (e):**
```js
document.addEventListener('visibilitychange', () => {
  if (document.hidden && playing) {
    clearInterval(timerId);                    // 1. stop scheduling first (no new events)
    visualQueue.length = 0;                    // 2. drop pending blooms (rAF is paused anyway; prevents pile-up)
    ctx.suspend();                             // 3. freeze the clock: "context time is not proceeding";
  }                                            //    already-scheduled future notes survive frozen and play on resume
  else if (!document.hidden && suspendedByHide) {
    ctx.resume().then(() => {                  //    (also fires statechange; prefer statechange-driven wiring)
      nextRowTime = Math.max(nextRowTime, ctx.currentTime + START_DELAY_S);  // rebase: audio time is continuous
      timerId = setInterval(schedulerTick, TIMER_INTERVAL_MS);               // CA rowIndex untouched -> determinism preserved
    });
  }
});
```
Why no drift/pile-up: `suspend()` halts `currentTime` progression, so scheduled-but-unplayed notes remain in the future and play normally after `resume()`; because the timer is stopped, nothing new is scheduled against a frozen clock; `nextRowTime` is rebase-clamped so the first post-resume row leads by 150 ms rather than firing "immediately." The same two-step (stop timer, suspend) applies to user pause (T-SHELL), where the `wasPlaying`-style guard from MDN's visibilitychange example is the pattern. Also handle browser-initiated `interrupted` state (iOS-style) by re-resuming on `statechange` per MDN's `BaseAudioContext.state` example.

**Late-note measurement (f):** the guard above counts `lateRows` (rows whose accumulated time had already passed `currentTime`); additionally log `lateness = ctx.currentTime - (t - rowIntervalSeconds)`-style metrics only if needed. Notes are never scheduled in the past (spec: past `when` → plays immediately → audible rush). Optional diagnostic in modern Chrome only: `AudioPlaybackStats` (spec 1.1 draft; SecureContext; gated to visible docs) exposes `underrunEvents`/`underrunDuration` — treat as opportunistic, not required. Note the distinction: underruns/late scheduling are *main-thread* failures the horizon absorbs; `baseLatency`/`outputLatency` are constant output delays, not drift.

**Bounded memory (T-ENDUR):** the scheduler holds ≤ `ceil(SCHEDULE_AHEAD_S / rowIntervalSeconds)` + 1 scheduled rows (≈ 4–9 rows; each 8–16 lane descriptors); `visualQueue` is drained every frame and hard-capped (e.g., 64 entries); fire-and-forget source nodes are released automatically by the implementation per the spec's node-lifetime rules. Nothing else grows with time.

**Plan updates to record:** T-SCHED is unblocked — implement Option A exactly as above; T-AVBIND should implement the `visualQueue` consumption contract (`time < ctx.currentTime`) inside T-VIS's rAF loop and target ≤1-frame audio-clock correlation; T-SHELL wires `visibilitychange` to the suspend/resume sequence; T-ENDUR inherits the bounded-memory argument; the deferred Worker-timer spike is recorded below and should only be scheduled if the owner changes the hidden-tab behavior to "keep playing."

## 7. Explicitly unsettled + recommended spike

**Sub-question (c)-worker:** whether `setInterval` inside a dedicated Worker (Blob-constructed, `file://` origin) escapes Chrome's hidden-tab timer throttling when the owning page is silent is **not settled by documentation** (MDN silent; spec silent; Chromium Issue 40494643 contradicts the folklore exemption). Recommendation: if background playback without suspend is ever desired, run a ~15-minute disposable spike before the production worker: Blob-worker posting timestamps every 250 ms, page hidden ≥5 min, silent AudioContext, log inter-tick gaps in Chrome stable + Firefox; only adopt the Worker timer if gaps stay <2 s. Until then, no Worker in LOOM.

## 8. Decision priority and status

- **Priority:** high — RQ1 blocks T-SCHED (milestone M2) and is the plan's designated "core technical risk of the project."
- **Status:** DECIDED. Recommendation: Option A (classic Wilson lookahead, `setInterval` 100 ms, `SCHEDULE_AHEAD = 2.0 s`, accumulated `nextRowTime`, `notesInQueue` visual correlation, visibilitychange suspend/resume with rebase). Alternative on record: Option B (rAF-driven) only as a supplement to rendering. Option C (Worker timer) rejected pending the §7 spike. Confidence: HIGH (core pattern), MEDIUM (hidden-tab timer cadence — sidestepped by suspend-on-hidden).
