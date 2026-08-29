/* loom-site.js — LOOM's merged site Worker entry (V3-DEPLOY restructure,
 * 2026-08-28). ONE Worker (`loom`) serves everything on
 * loom.arrangedgodly.com: the static site AND the public MCP endpoint.
 * The hostname is a WORKER CUSTOM DOMAIN on this exact Worker name
 * (verified live before this restructure: workers/domains lists
 * loom.arrangedgodly.com -> service `loom`; there is no Pages project
 * named loom — the earlier Pages-Functions plan was dead and this single
 * worker replaces it, strictly simpler, outcome-preserving).
 *
 * Routing (this entry's fetch):
 *   /mcp, /attach  → delegated VERBATIM to mcp-worker.js's default fetch —
 *                    the proven gates (405/426/403/body-cap) + the DO
 *                    singleton routing env.LOOM_CHANNEL.idFromName("loom").
 *   anything else  → env.ASSETS — the static site. The assets directory is
 *                    the repo root pruned by .assetsignore to EXACTLY
 *                    index.html (the whole public site is that one file).
 *
 * The Durable Object class is imported and re-exported, never duplicated:
 * wrangler resolves DO classes from the entry script, and ALL server logic
 * still lives in mcp-worker.js's `LoomChannel` (V3-WORKER, verified there).
 * Static-asset requests never reach this script at all (asset matching runs
 * first by default); the ASSETS fallback covers every non-matched path,
 * including the asset layer's own 404 for paths like /README.md.
 *
 * Local dev (the full same-origin stack on ONE origin):
 *   npx wrangler dev   → http://localhost:8787 — index.html at /, POST /mcp,
 *                        WS /attach, all same-origin. */
import channelWorker, { LoomChannel } from "./mcp-worker.js";

export { LoomChannel };

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/mcp" || path === "/attach") {
      return channelWorker.fetch(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
