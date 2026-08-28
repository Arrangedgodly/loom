# LOOM

**Automata Generative Loom Synthesizer** — a one-page generative music sequencer built on Wolfram's Rule 30.

A cellular automaton weaves rows of cells down the screen like a digital tapestry. Each row's newly-active cells trigger scale-quantified synth notes, locked to the Web Audio clock — an infinite, deterministic ambient piece that never repeats. The whole app is a single self-contained `index.html` (vanilla JS + Canvas + Web Audio, zero dependencies, works offline).

## Play

Open `index.html` in any modern browser and press **Begin**.

- **Lean back** — the canonical Rule 30 piece, identical on every visit
- **Tinker** — move the mouse, open the mixer panel: rule (0–255, presets 30/90/110/184), tempo, scale, reseed, reset
- **Share** — every configuration encodes into the URL hash; *Copy link* gives a reproducible piece

## Prompt mode (MCP)

`loom-bridge.mjs` is a zero-dependency Node companion that serves the page and exposes it as an [MCP](https://modelcontextprotocol.io) server, so AI clients can drive the loom live:

```bash
node loom-bridge.mjs          # → http://127.0.0.1:7331
```

Point any MCP client (Claude, Inspector, an agent) at `http://127.0.0.1:7331/mcp` — eight tools (`get_state`, `set_rule`, `set_tempo`, `set_scale`, `reseed`, `set_volume`, `pause`, `resume`) mirror the on-screen controls one-to-one. Try: *"make it slower and darker, try rule 110."*

The bridge is localhost-only by design; the hosted page is fully functional without it.

## Development notes

- `?selftest` runs the built-in test suites (35 checks); `?fps` overlays a performance readout
- `docs/ultron/` holds the full build audit trail: scoping brief, plan, research records, and per-task verification evidence

## Verify a config

`#r=<rule>&t=<rowsPerSecond>&s=<scaleId>&d=<seedId>&v=<volume>` in the URL reproduces that exact piece — same seed, same weave, same music, every time.
