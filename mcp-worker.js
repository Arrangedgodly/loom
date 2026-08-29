/* mcp-worker.js — LOOM's public MCP endpoint (V3-WORKER).
 * One wrangler-deployed Worker exporting a single SQLite-backed Durable Object
 * class `LoomChannel` that holds ALL server logic (RQ3-committed pattern —
 * docs/ultron/research/rq3-cloudflare-worker-do.md). ZERO dependencies:
 * Cloudflare Worker runtime APIs only, no npm packages.
 *
 * Faces (the Worker's own fetch routes these into the DO singleton
 * `env.LOOM_CHANNEL.idFromName("loom")` — exactly what `wrangler dev`
 * exercises; on the zone, thin Pages Functions forward to the same DO):
 *
 *   POST /mcp     DUAL-ERA MCP Streamable HTTP — a 1:1 port of the verified
 *                 RQ2 `loom-bridge.mjs` semantics (docs/ultron/research/
 *                 rq2-webmcp-protocol.md): modern stateless 2026-07-28
 *                 (per-request _meta, MCP-Protocol-Version/Mcp-Method header
 *                 checks → -32020, unsupported version → -32022,
 *                 server/discover, ttlMs/cacheScope on lists, unknown method
 *                 → 404 + -32601 in the modern era) + the LEGACY
 *                 `initialize` handshake (no sessions; GET/DELETE → 405,
 *                 spec-legal for a POST-only legacy server).
 *                 Origin rule (spec): absent Origin allowed (non-browser MCP
 *                 clients); a present-but-unallowlisted Origin → 403.
 *   GET  /attach  HIBERNATING WebSocket page channel (Hibernation API —
 *                 idle attach accrues no billable DO duration). `Upgrade:
 *                 websocket` required (else 426); handshake Origin validated
 *                 when present (browsers always send it — the hijack
 *                 defense; WebSockets have no CORS).
 *   (anything)    404.
 *
 * ATTACH WIRE PROTOCOL (for V3-PAGE — recognizable next to the bridge's):
 *   page → DO, immediately on socket open (CONSENT HANDSHAKE — nothing is
 *     registered before it; sockets that never hello are closed by a short
 *     storage alarm):
 *       {"type":"hello","tools":[<the 8-tool manifest, schemas from the live
 *                                  Loom contract — same shape the page pushed
 *                                  to the bridge>],"optIn":true}
 *     `optIn` MUST be exactly true (the consent gate; the bridge's hello had
 *     no optIn — that is the one deliberate wire delta). `tools` may be
 *     omitted; the DO then serves its embedded static copy of the same
 *     manifest. Legacy bridge-shaped results without a "type" field are also
 *     accepted (see below).
 *   page → DO, per call (either shape works; the first is canonical):
 *       {"type":"result","id":<int>,"result":{…}}  or  {"type":"result",
 *        "id":<int>,"error":{"code":…,"message":…}}
 *       {"id":<int>,"result":{…}} / {"id":<int>,"error":{…}}   (bridge shape)
 *   page → DO keepalive (optional): the exact text "loom-ping" — the runtime
 *     auto-answers "loom-pong" WITHOUT waking the DO (setWebSocketAuto-
 *     Response), so proxies keep the socket alive for free.
 *   DO → page, tool invocation (same shape the bridge pushed over SSE):
 *       {"type":"call","id":<int>,"name":<tool>,"arguments":{…}}
 *   DO → page, one-driver takeover notice (a new hello closes the previous
 *     driver — last write wins, like the bridge's SSE replacement):
 *       {"type":"detached","reason":"replaced"}
 *
 * HIBERNATION SAFETY (RQ3): no state that matters may live only in `this.*`.
 *   - The driver slot + its hello manifest live in DO STORAGE (`driver`
 *     {epoch, tools}) — SQLite-backed, survives hibernation and restarts.
 *   - The socket side is re-derivable: every accepted socket carries a
 *     serializeAttachment() tag ({at} on accept, {driverEpoch} on hello);
 *     the current driver is found by matching tags against the stored epoch
 *     via ctx.getWebSockets() (connected sockets survive hibernation).
 *   - Pending calls live ONLY during in-flight /mcp requests, which keep the
 *     DO active by themselves (per RQ3); call ids are seeded from Date.now()
 *     so they stay unique across hibernation boundaries.
 *   - The trivial rate-limit window is in-memory and resets on hibernation
 *     (an abuse backstop, not a correctness surface — documented).
 * Security: spec Origin checks on both faces (403 invalid, absent allowed);
 * body cap 256 KB; trivial rate limit (300 req / 10 s, DO-local); no CORS
 * headers anywhere (the browser page only ever opens /attach); no auth (a
 * public music toy with an explicit opt-in consent gate — documented). */
import { DurableObject } from "cloudflare:workers";

/* -- constants (bridge parity unless noted) --------------------------------- */
const SUPPORTED = ["2026-07-28", "2025-11-25", "2025-06-18"];
const SERVER_INFO = { name: "loom-channel", version: "1.0.0" };
const INSTRUCTIONS = "Drives the LIVE LOOM piece: the eight tools mirror " +
  "the page's own controls one-to-one. Keep the page open in a browser tab " +
  "with remote control enabled — with no attached page the tools answer a " +
  "'page not attached' error.";
const CALL_TIMEOUT_MS = 5000;       // tools/call page round-trip budget
const HELLO_GRACE_MS = 30000;       // un-hello'd sockets closed after this
const BODY_CAP = 262144;            // 256 KB request cap (bridge parity)
const RATE_MAX = 300, RATE_WINDOW_MS = 10000;
const PING_TEXT = "loom-ping", PONG_TEXT = "loom-pong";

const publicOrigin = (env) =>
  (env && typeof env.PUBLIC_ORIGIN === "string" && env.PUBLIC_ORIGIN) ||
  "https://loom.arrangedgodly.com";
const notAttachedMsg = (env) => "LOOM page not attached; open " +
  publicOrigin(env) + "/ in a browser, opt in (Allow remote control), and " +
  "keep the tab open";
const toolErr = (msg) => ({ resultType: "complete", isError: true,
  content: [{ type: "text", text: msg }] });

/* Origin allowlist: the prod page origin + loopback for dev (any port,
 * either scheme — checked by hostname, like the bridge's loopback rule).
 * Env `ALLOWED_ORIGINS` (comma/space separated) adds hostnames for
 * V3-DEPLOY preview testing. Absent Origin is allowed EVERYWHERE (the spec
 * rule for non-browser MCP clients); a present but malformed/unallowlisted
 * Origin is rejected. */
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

/* -- responses (bridge parity shapes) ---------------------------------------- */
const jsonRes = (status, obj, extra) => new Response(JSON.stringify(obj),
  { status, headers: Object.assign({ "Content-Type": "application/json",
      "Cache-Control": "no-store" }, extra || {}) });
const textRes = (status, body, extra) => new Response(body,
  { status, headers: Object.assign({ "Content-Type": "text/plain",
      "Cache-Control": "no-store" }, extra || {}) });
/* Early responses on requests that may still carry a body must DRAIN the
 * unread stream first (bounded) — cancelling (or ignoring) an in-flight
 * body trips workerd's "Can't read from request stream after response has
 * been sent" and, in local dev, kills the Miniflare proxy connection
 * ("Network connection lost" — found the hard way). Bounded at 1 MiB so a
 * hostile stream still gets cut. */
const DRAIN_MAX = 1048576;
const earlyRes = async (request, response) => {
  const body = request && request.body;
  if (!body) return response;
  try {
    const reader = body.getReader();
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > DRAIN_MAX) {
        try { await reader.cancel(); } catch (e) {}
        break;
      }
    }
  } catch (e) { /* body already gone — nothing to drain */ }
  return response;
};
const rpcResult = (id, result) => jsonRes(200, { jsonrpc: "2.0", id, result });
const rpcError = (status, id, code, message, data) => jsonRes(status,
  { jsonrpc: "2.0", id, error: { code, message, data } });

/* -- the embedded static 8-tool manifest -------------------------------------
 * A verbatim copy of the page's manifest() (index.html section [9]) with the
 * Loom contract's limits baked in (limits: rows/s 0.5–8, seedId 0–
 * 4294967295, volume 0–1; the 8 scale registry ids). The page is the source
 * of truth: tools/list serves the manifest the driver PUSHED in its hello
 * (bridge parity — the page generates schemas from the live registries);
 * this static copy is the fallback when a hello carries no tools array, and
 * the reference this file documents for the page contract. */
const SCALE_IDS = ["a-minor-pentatonic", "c-major-pentatonic",
  "a-natural-minor", "c-major", "d-dorian", "a-hirajoshi", "a-whole-tone",
  "a-blues"];
const NONE_SCHEMA = { type: "object", properties: {},
  additionalProperties: false };
const STATE_OUT = {
  type: "object",
  properties: {
    rule: { type: "integer" }, rowsPerSecond: { type: "number" },
    scaleId: { type: "string" }, scaleName: { type: "string" },
    seedId: { type: "integer" }, volume: { type: "number" },
    state: { type: "string" }, paused: { type: "boolean" },
    playing: { type: "boolean" },
  },
  required: ["rule", "rowsPerSecond", "scaleId", "scaleName", "seedId",
    "volume", "state", "paused", "playing"],
  additionalProperties: false,
};
const STATIC_TOOLS = [
  { name: "get_state", title: "Read loom state",
    description: "Reads the live state of the LOOM piece: rule (0-255), " +
      "tempo in rows/second, scale id + name, seed id, volume, and the " +
      "playback state (idle/running/paused).",
    inputSchema: NONE_SCHEMA, outputSchema: STATE_OUT,
    annotations: { readOnlyHint: true } },
  { name: "set_rule", title: "Set rule",
    description: "Sets the cellular-automaton rule (Wolfram 0-255; presets " +
      "30, 90, 110, 184). Effective on the next scheduled row - live, " +
      "mid-flight.",
    inputSchema: { type: "object",
      properties: { rule: { type: "integer", minimum: 0, maximum: 255,
        description: "Wolfram rule number (presets 30, 90, 110, 184)" } },
      required: ["rule"], additionalProperties: false },
    annotations: { idempotentHint: true } },
  { name: "set_tempo", title: "Set tempo",
    description: "Sets the tempo in rows per second (0.5-8). Queued rows " +
      "keep their audio times; the new grid starts after the last queued " +
      "row - no burst, no drift.",
    inputSchema: { type: "object",
      properties: { rowsPerSecond: { type: "number", minimum: 0.5,
        maximum: 8, description: "Rows (beats) per second" } },
      required: ["rowsPerSecond"], additionalProperties: false },
    annotations: { idempotentHint: true } },
  { name: "set_scale", title: "Set scale",
    description: "Switches the scale quantization of the lanes to a " +
      "registry id.",
    inputSchema: { type: "object",
      properties: { scaleId: { type: "string", enum: SCALE_IDS,
        description: "Registry scale id" } },
      required: ["scaleId"], additionalProperties: false },
    annotations: { idempotentHint: true } },
  { name: "reseed", title: "Reseed",
    description: "Plants a deterministic seed. seedId 0 (or omitted) is " +
      "the canonical single centered cell; any other uint32 id derives a " +
      "deterministic seed row (mid-flight the next scheduled row becomes " +
      "it).",
    inputSchema: { type: "object",
      properties: { seedId: { type: "integer", minimum: 0,
        maximum: 4294967295,
        description: "Optional seed id (omitted = canonical)" } },
      additionalProperties: false } },
  { name: "set_volume", title: "Set volume",
    description: "Sets the master volume (0-1).",
    inputSchema: { type: "object",
      properties: { volume: { type: "number", minimum: 0, maximum: 1,
        description: "Master volume 0-1" } },
      required: ["volume"], additionalProperties: false },
    annotations: { idempotentHint: true } },
  { name: "pause", title: "Pause",
    description: "Pauses the piece - suspends audio and freezes the weave " +
      "(the same transition as the page's pause control). A no-op when not " +
      "playing.",
    inputSchema: NONE_SCHEMA, annotations: { readOnlyHint: false } },
  { name: "resume", title: "Resume",
    description: "Resumes the paused piece (audio-clock rebase, no burst). " +
      "A no-op when not paused.",
    inputSchema: NONE_SCHEMA },
];

/* -- the Worker: routes /mcp and /attach into the DO singleton -------------- */
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/mcp") {
      if (request.method !== "POST") {           // era-correct: no GET stream
        return earlyRes(request,
          textRes(405, "Method Not Allowed", { Allow: "POST" }));
      }
      const declared = Number(request.headers.get("Content-Length")) || 0;
      if (declared > BODY_CAP) {                 // reject at the OUTER hop —
        return earlyRes(request,                 // cancelling a body owned by
          textRes(413, "Payload Too Large"));    // a FORWARDED request (the
      }                                          // DO's copy) trips workerd's
      if (!originAllowed(request.headers.get("Origin"), env)) {  // "can't
        return earlyRes(request, jsonRes(403, { error: "Forbidden Origin" }));  // read
      }                                          // after response" — so the
      return env.LOOM_CHANNEL                   // cap check lives here (the
        .get(env.LOOM_CHANNEL.idFromName("loom")).fetch(request);  // DO keeps
    }                                            // the after-read check)
    if (path === "/attach") {
      if (request.method !== "GET") {
        return earlyRes(request,
          textRes(405, "Method Not Allowed", { Allow: "GET" }));
      }
      if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
        return earlyRes(request, textRes(426, "Upgrade Required",
          { Upgrade: "websocket" }));
      }
      if (!originAllowed(request.headers.get("Origin"), env)) {
        return earlyRes(request, jsonRes(403, { error: "Forbidden Origin" }));
      }
      return env.LOOM_CHANNEL                                   // → the DO
        .get(env.LOOM_CHANNEL.idFromName("loom")).fetch(request);
    }
    return earlyRes(request, textRes(404, "Not Found"));
  },
};

/* -- the Durable Object: all server logic ------------------------------------ */
export class LoomChannel extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx; this.env = env;
    this.pending = new Map();     // call id → {resolve, timer, ws} — ONLY
    this.rateHits = [];           // during in-flight /mcp requests (RQ3)
    this.callSeq = 0;             // seeded from Date.now() — hibernation-safe
    try {                         // runtime answers "loom-ping" → "loom-pong"
      this.ctx.setWebSocketAutoResponse(   // WITHOUT waking the DO (RQ3);
        new WebSocketRequestResponsePair(PING_TEXT, PONG_TEXT));
    } catch (e) { /* older runtimes: webSocketMessage answers it instead */ }
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/mcp") {
      if (request.method !== "POST") {
        return earlyRes(request,
          textRes(405, "Method Not Allowed", { Allow: "POST" }));
      }
      if (!originAllowed(request.headers.get("Origin"), this.env)) {
        return earlyRes(request, jsonRes(403, { error: "Forbidden Origin" }));
      }
      return this.handleMcp(request);
    }
    if (path === "/attach") {
      if (request.method !== "GET") {
        return earlyRes(request,
          textRes(405, "Method Not Allowed", { Allow: "GET" }));
      }
      if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
        return earlyRes(request, textRes(426, "Upgrade Required",
          { Upgrade: "websocket" }));
      }
      if (!originAllowed(request.headers.get("Origin"), this.env)) {
        return earlyRes(request, jsonRes(403, { error: "Forbidden Origin" }));
      }
      return this.attach();
    }
    return earlyRes(request, textRes(404, "Not Found"));
  }

  /* -- POST /mcp — the RQ2 dual-era handler, ported 1:1 -------------------- */
  async handleMcp(request) {
    const now = Date.now();                 // trivial rate limit (in-memory;
    while (this.rateHits.length &&          // resets on hibernation — an
        now - this.rateHits[0] > RATE_WINDOW_MS) this.rateHits.shift();
    if (this.rateHits.push(now) > RATE_MAX) {   // abuse backstop, documented)
      return rpcError(429, null, -32000, "Rate limit exceeded");
    }
    const declared = Number(request.headers.get("Content-Length")) || 0;
    if (declared > BODY_CAP) {
      return earlyRes(request, textRes(413, "Payload Too Large"));
    }                                             // (bridge cut the socket;
    const body = await request.text();            //  Workers cancel + 413)
    if (body.length > BODY_CAP) return textRes(413, "Payload Too Large");
    let msg = null;
    try { msg = JSON.parse(body); } catch (e) { msg = null; }
    if (!msg || typeof msg !== "object" || Array.isArray(msg) ||
        msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      return rpcError(400, msg && !Array.isArray(msg) &&
        msg.id !== undefined ? msg.id : null, -32600, "Invalid Request");
    }
    const id = msg.id, params = msg.params || {};
    const metaVersion = (params._meta || {})["io.modelcontextprotocol/protocolVersion"] || null;
    const headerVersion = request.headers.get("MCP-Protocol-Version") || null;
    if (headerVersion && metaVersion && headerVersion !== metaVersion) {
      return rpcError(400, id, -32020, "HeaderMismatch",
        { header: "MCP-Protocol-Version", headerValue: headerVersion,
          metaValue: metaVersion });
    }
    const headerMethod = request.headers.get("Mcp-Method");
    if (headerMethod && headerMethod !== msg.method) {
      return rpcError(400, id, -32020, "HeaderMismatch",
        { header: "Mcp-Method", headerValue: headerMethod,
          metaValue: msg.method });
    }
    const version = metaVersion || headerVersion;
    if (version && !SUPPORTED.includes(version)) {
      return rpcError(400, id, -32022, "UnsupportedProtocolVersionError",
        { supported: SUPPORTED });
    }
    const modern = version === "2026-07-28";
    if (id === undefined) {                 // notifications → 202 Accepted
      return new Response(null,
        { status: 202, headers: { "Cache-Control": "no-store" } });
    }
    switch (msg.method) {
      case "initialize":                    // LEGACY era handshake (no sessions)
        return rpcResult(id, {
          protocolVersion: SUPPORTED.includes(params.protocolVersion)
            ? params.protocolVersion : SUPPORTED[1],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
      case "server/discover":               // MODERN era (MUST implement)
        return rpcResult(id, { resultType: "complete", supportedVersions: SUPPORTED,
          capabilities: { tools: { listChanged: false } },
          instructions: INSTRUCTIONS, ttlMs: 0, cacheScope: "public",
          _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO } });
      case "ping":
        return rpcResult(id, {});
      case "tools/list": {
        const driver = await this.getDriver();
        if (!driver) return rpcError(200, id, -32000, notAttachedMsg(this.env));
        return rpcResult(id, Object.assign({ tools: this.activeManifest(driver) },
          modern ? { resultType: "complete", ttlMs: 0, cacheScope: "public" }
                 : null));
      }
      case "tools/call": {
        const driver = await this.getDriver();
        if (!driver) return rpcError(200, id, -32000, notAttachedMsg(this.env));
        if (!this.activeManifest(driver)
            .some((t) => t && t.name === params.name)) {
          return rpcError(200, id, -32602, "Unknown tool: " + params.name);
        }
        const outcome = await this.pageCall(driver, params.name, params.arguments);
        if (outcome.error) {
          return rpcError(200, id, outcome.error.code || -32000,
            outcome.error.message || "Tool call failed");
        }
        return rpcResult(id, outcome.result);
      }
      default:
        return rpcError(modern ? 404 : 200, id, -32601,
          "Method not found: " + msg.method);
    }
  }

  /* -- GET /attach — hibernating WebSocket, consent-gated ------------------ */
  attach() {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);       // hibernation-eligible accept —
    try { server.serializeAttachment({ at: Date.now() }); } catch (e) {}
    return this.armHelloAlarm().then(() =>   // arm BEFORE returning 101 (the
      new Response(null, { status: 101, webSocket: client }));  // consent
  }                                          // hello gates everything

  /* Hibernation-safe driver lookup: storage holds the slot; the socket is
   * re-derived by matching serializeAttachment tags against the stored
   * epoch (connected sockets survive hibernation — getWebSockets). */
  attachmentOf(ws) {
    try { return ws.deserializeAttachment() || null; } catch (e) { return null; }
  }
  async getDriver() {
    const info = await this.ctx.storage.get("driver");
    if (!info) return null;
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.attachmentOf(ws);
      if (att && att.driverEpoch === info.epoch) return { ws, info };
    }
    await this.ctx.storage.delete("driver");  // stale slot (socket gone)
    return null;
  }
  activeManifest(driver) {                  // the pushed manifest wins (the
    return Array.isArray(driver.info.tools) &&   // page is the source of
      driver.info.tools.length ? driver.info.tools : STATIC_TOOLS;  // truth)
  }

  /* -- page channel: hello / call / result ---------------------------------- */
  async handleHello(ws, msg) {
    if (msg.optIn !== true) return;         // CONSENT GATE: nothing registers
    const prev = (await this.ctx.storage.get("driver")) || {};
    const epoch = (prev.epoch || 0) + 1;    // storage-derived → monotonic
    await this.ctx.storage.put("driver", { epoch: epoch,
      tools: Array.isArray(msg.tools) ? msg.tools : null, at: Date.now() });
    try { ws.serializeAttachment({ driverEpoch: epoch, at: Date.now() }); }
    catch (e) { /* attachment writes are best-effort tagged */ }
    for (const other of this.ctx.getWebSockets()) {   // ONE driver: replace
      if (other === ws) continue;                     // the previous, last
      const att = this.attachmentOf(other);           // write wins
      if (att && Number.isInteger(att.driverEpoch)) {
        this.failPendings(other, "LOOM page detached — replaced by a newer page");
        try { other.send(JSON.stringify({ type: "detached",
                                          reason: "replaced" })); } catch (e) {}
        try { other.close(4000, "replaced by a newer page"); } catch (e) {}
      }
    }
  }

  pageCall(driver, name, args) {
    return new Promise((resolve) => {
      this.callSeq = Math.max(this.callSeq, Date.now()) + 1;
      const id = this.callSeq;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ result: toolErr("Tool call timed out after " +
          CALL_TIMEOUT_MS + " ms (the page did not answer)") });
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve, timer: timer, ws: driver.ws });
      try {
        driver.ws.send(JSON.stringify(
          { type: "call", id: id, name: name, arguments: args || {} }));
      } catch (e) {
        clearTimeout(timer); this.pending.delete(id);
        resolve({ result: toolErr("LOOM page detached — tool call failed") });
      }
    });
  }

  failPendings(ws, why) {                   // detach/replacement fails only
    for (const [id, p] of this.pending) {   // THAT socket's in-flight calls
      if (p.ws !== ws) continue;
      clearTimeout(p.timer); this.pending.delete(id);
      p.resolve({ result: toolErr(why) });
    }
  }

  /* -- hibernation event handlers ------------------------------------------ */
  async webSocketMessage(ws, message) {
    if (typeof message !== "string") {
      try { ws.close(4003, "text frames only"); } catch (e) {}
      return;
    }
    if (message === PING_TEXT) {            // fallback when the runtime's
      try { ws.send(PONG_TEXT); } catch (e) {}   // auto-response is absent
      return;
    }
    let msg = null;
    try { msg = JSON.parse(message); } catch (e) { return; }
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "hello") return this.handleHello(ws, msg);
    if (msg.type === "result" || Number.isInteger(msg.id)) {
      const driver = await this.getDriver();  // only the CURRENT driver's
      if (driver && driver.ws === ws &&        // results route (stale sockets
          Number.isInteger(msg.id) &&          // cannot answer for the new
          this.pending.has(msg.id)) {          // driver)
        const p = this.pending.get(msg.id);
        clearTimeout(p.timer); this.pending.delete(msg.id);
        p.resolve(msg.error !== undefined ? { error: msg.error }
                                          : { result: msg.result });
      }
      return;
    }
  }

  async webSocketClose(ws, code, reason, wasClean) {
    const info = await this.ctx.storage.get("driver");
    const att = this.attachmentOf(ws);
    if (info && att && att.driverEpoch === info.epoch) {
      await this.ctx.storage.delete("driver");  // the tools die with the page
    }
    this.failPendings(ws, "LOOM page detached — tool call failed");
  }

  /* Un-hello'd sockets are closed after a grace period (consent gate
   * cleanup). Alarm state is storage-backed → hibernation-safe. */
  async armHelloAlarm() {
    const grace = Number(this.env && this.env.HELLO_GRACE_MS) || HELLO_GRACE_MS;
    const when = Date.now() + grace;
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || cur > when) await this.ctx.storage.setAlarm(when);
  }
  async alarm() {
    const grace = Number(this.env && this.env.HELLO_GRACE_MS) || HELLO_GRACE_MS;
    const info = await this.ctx.storage.get("driver");
    const now = Date.now();
    let next = null;
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.attachmentOf(ws);
      if (info && att && att.driverEpoch === info.epoch) continue;  // driver
      const age = att && att.at ? now - att.at : Infinity;
      if (age < grace) next = next === null ? att.at + grace
        : Math.min(next, att.at + grace);      // not yet stale — re-arm
      else try { ws.close(4001, "no consent hello"); } catch (e) {}
    }
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }
}
