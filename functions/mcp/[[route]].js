/* functions/mcp/[[route]].js — Pages Function forwarder (V3-WORKER, RQ3).
 * Forwards /mcp (and anything under /mcp/*) verbatim to the LoomChannel
 * Durable Object via the Pages project's LOOM_CHANNEL DO binding — the
 * documented same-domain routing path (NO zone Workers routes ever exist on
 * loom.arrangedgodly.com; see the RQ3 record's routing evidence).
 * The DO (mcp-worker.js) owns every semantic: era-correct 405 on GET,
 * dual-era JSON-RPC on POST, Origin validation, -32000/-32002/-32601/…
 * error envelopes. This file is deliberately glue: it adds nothing.
 *
 * KNOWN-CHECK for V3-DEPLOY (flagged in RQ3 + plan.md): the Pages project's
 * DO binding must reference the ALREADY-DEPLOYED Worker (script_name is
 * mandatory for Pages configs; deploy order = wrangler deploy BEFORE git
 * push). The binding's exact TOML shape is verified at first deploy. */
export const onRequest = async ({ request, env }) =>
  env.LOOM_CHANNEL.get(env.LOOM_CHANNEL.idFromName("loom")).fetch(request);
