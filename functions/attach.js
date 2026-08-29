/* functions/attach.js — Pages Function forwarder (V3-WORKER, RQ3).
 * Forwards GET /attach (the hibernating-WebSocket page channel) to the
 * LoomChannel Durable Object via the Pages project's LOOM_CHANNEL DO
 * binding. Per the canonical DO proxy pattern, the cheap gate checks run
 * HERE (before the DO is invoked — "validate in the proxy to avoid DO
 * charges"): upgrade required (426), method (405), Origin allowlist when
 * the header is present (403 — the WebSocket hijacking defense; WebSockets
 * have no CORS, and absent Origin means a non-browser client, allowed).
 * The DO re-validates all of this (defense in depth).
 * The allowlist duplicates mcp-worker.js's tiny rule rather than importing
 * it — importing the Worker would bundle the Durable Object class into the
 * Pages Functions build. */
const NO_STORE = { "Cache-Control": "no-store" };
const json = (status, obj) => new Response(JSON.stringify(obj), { status,
  headers: Object.assign({ "Content-Type": "application/json" }, NO_STORE) });
const text = (status, body, extra) => new Response(body, { status,
  headers: Object.assign({ "Content-Type": "text/plain" }, NO_STORE, extra) });

function originAllowed(origin, env) {
  if (origin === undefined || origin === null || origin === "") return true;
  let host;
  try { host = new URL(origin).hostname; } catch (e) { return false; }
  if (host === "loom.arrangedgodly.com") return true;
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" ||
      host === "::1") return true;
  const extra = env && typeof env.ALLOWED_ORIGINS === "string"
    ? env.ALLOWED_ORIGINS.split(/[\s,]+/).filter(Boolean)
        .map((h) => h.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
          .replace(/\/+$/, "").replace(/:\d+$/, ""))
    : [];
  return extra.includes(host);
}

export const onRequest = async ({ request, env }) => {
  const early = async (response) => {   // drain unread bodies on early
    const body = request.body;          // returns (cancelling an in-flight
    if (!body) return response;         // body trips the runtime; bounded)
    try {
      const reader = body.getReader();
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > 1048576) {
          try { await reader.cancel(); } catch (e) {}
          break;
        }
      }
    } catch (e) { /* body already gone */ }
    return response;
  };
  if (request.method !== "GET") {
    return early(text(405, "Method Not Allowed", { Allow: "GET" }));
  }
  if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
    return early(text(426, "Upgrade Required", { Upgrade: "websocket" }));
  }
  if (!originAllowed(request.headers.get("Origin"), env)) {
    return early(json(403, { error: "Forbidden Origin" }));
  }
  return env.LOOM_CHANNEL.get(env.LOOM_CHANNEL.idFromName("loom"))
    .fetch(request);
};
