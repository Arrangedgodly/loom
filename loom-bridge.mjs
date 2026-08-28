#!/usr/bin/env node
/* loom-bridge.mjs — LOOM's optional MCP-mode companion bridge (V2-MCP).
 * Zero deps (Node core only). Serves index.html over http on a localhost port,
 * implements POST /mcp as DUAL-ERA MCP Streamable HTTP (modern stateless
 * 2026-07-28 + the legacy initialize handshake — the spec blesses serving both
 * eras on one endpoint), and proxies tools/call to the LIVE page over SSE+POST.
 * The page holds every tool and all state; this bridge is a generic translator
 * with no LOOM knowledge beyond serving the file (RQ2 Option A —
 * docs/ultron/research/rq2-webmcp-protocol.md).
 *   node loom-bridge.mjs → http://127.0.0.1:7331/  (PORT env override)
 *   GET /               the LOOM page (open it — the page IS the backend)
 *   POST /mcp           MCP endpoint; reference client: npx
 *                       @modelcontextprotocol/inspector --cli <url> --transport http
 *   GET /bridge         SSE: tool invocations bridge → page (CORS * — a hosted
 *                       page may attach to a local bridge)
 *   POST /bridge/result page → bridge: {type:'hello',tools} on SSE open, then
 *                       {id, result|error} per call
 * Security (spec + research record): binds 127.0.0.1 only; validates Host
 * (DNS-rebinding defense); rejects a non-loopback Origin on /mcp with 403
 * (absent Origin allowed — non-browser clients); a trivial rate limit; no auth
 * (a localhost music toy — documented). */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT) || 7331;
const PAGE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.html");
const SUPPORTED = ["2026-07-28", "2025-11-25", "2025-06-18"];
const SERVER_INFO = { name: "loom-bridge", version: "1.0.0" };
const INSTRUCTIONS = "Drives the LIVE LOOM piece: the eight tools mirror the " +
  "page's own controls one-to-one. Keep the page open in a browser tab — with " +
  "no attached page the tools answer a 'page not attached' error.";
const CALL_TIMEOUT_MS = 5000;
let page = null;                  // the attached page { sse, tools } — ONE
let callSeq = 0;                  // driver at a time: a new SSE attach
const pendingCalls = new Map();   // replaces the previous (last write wins)
const rateHits = [];              // trivial rate limit (request timestamps)
const loopback = (h) => h === "127.0.0.1" || h === "localhost" || h === "::1";
const notAttachedMsg = () => "LOOM page not attached; open http://127.0.0.1:" +
  PORT + "/ in a browser and keep the tab open";
const toolErr = (msg) => ({ resultType: "complete", isError: true,
  content: [{ type: "text", text: msg }] });
function text(res, status, body, type, extra) {
  res.writeHead(status, Object.assign(
    { "Content-Type": type, "Cache-Control": "no-store" }, extra || {}));
  res.end(body);
}
const json = (res, s, o, e) => text(res, s, JSON.stringify(o), "application/json", e);
const rpcResult = (res, s, id, result) => json(res, s, { jsonrpc: "2.0", id, result });
const rpcError = (res, s, id, code, message, data) => json(res, s,
  { jsonrpc: "2.0", id, error: { code, message, data } });

/* -- page channel ----------------------------------------------------------- */
function pageAttach(res) {
  if (page) { try { page.sse.destroy(); } catch (e) { /* gone */ } }
  page = { sse: res, tools: null };
  res.writeHead(200, { "Content-Type": "text/event-stream", "Connection": "keep-alive",
    "Cache-Control": "no-cache, no-transform", "Access-Control-Allow-Origin": "*" });
  res.write(": connected\n\n");
  const beat = setInterval(() => { try { res.write(": ping\n\n"); } catch (e) {} }, 15000);
  res.on("close", () => {
    clearInterval(beat);
    if (page && page.sse === res) {
      page = null;                // the tools die with the page
      for (const [id, p] of pendingCalls) {
        clearTimeout(p.timer); pendingCalls.delete(id);
        p.resolve({ result: toolErr("LOOM page detached — tool call failed") });
      }
      console.log("[bridge] page detached");
    }
  });
  console.log("[bridge] page attached (SSE)");
}
function pageCall(name, args) {
  return new Promise((resolve) => {
    if (!page) { resolve({ error: { code: -32000, message: notAttachedMsg() } }); return; }
    const id = ++callSeq;
    const timer = setTimeout(() => {
      pendingCalls.delete(id);
      resolve({ result: toolErr("Tool call timed out after " + CALL_TIMEOUT_MS + " ms (the page did not answer)") });
    }, CALL_TIMEOUT_MS);
    pendingCalls.set(id, { resolve, timer });
    page.sse.write("event: call\ndata: " + JSON.stringify(
      { type: "call", id, name, arguments: args || {} }) + "\n\n");
  });
}
function pageResult(msg) {
  if (msg && msg.type === "hello" && Array.isArray(msg.tools)) {
    if (page) page.tools = msg.tools;   // the manifest the page pushed
    console.log("[bridge] hello: " + msg.tools.length + " tools");
    return true;
  }
  if (msg && Number.isInteger(msg.id) && pendingCalls.has(msg.id)) {
    const p = pendingCalls.get(msg.id);
    clearTimeout(p.timer); pendingCalls.delete(msg.id);
    p.resolve(msg.error !== undefined ? { error: msg.error } : { result: msg.result });
    return true;
  }
  return false;
}

/* -- POST /mcp — dual-era Streamable HTTP ------------------------------------ */
async function handleMcp(req, res, body) {
  const origin = req.headers.origin;      // spec: DNS-rebinding defense;
  if (origin !== undefined) {             // absent = non-browser client
    let host = null;
    try { host = new URL(origin).hostname; } catch (e) { host = null; }
    if (!loopback(host)) return json(res, 403, { error: "Forbidden Origin" });
  }
  const now = Date.now();                 // trivial rate limit
  while (rateHits.length && now - rateHits[0] > 10000) rateHits.shift();
  if (rateHits.push(now) > 300) return rpcError(res, 429, null, -32000, "Rate limit exceeded");
  let msg = null;
  try { msg = JSON.parse(body); } catch (e) { msg = null; }
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcError(res, 400, msg && msg.id !== undefined ? msg.id : null, -32600, "Invalid Request");
  }
  const id = msg.id, params = msg.params || {};
  const metaVersion = (params._meta || {})["io.modelcontextprotocol/protocolVersion"] || null;
  const headerVersion = req.headers["mcp-protocol-version"] || null;
  if (headerVersion && metaVersion && headerVersion !== metaVersion) {   // 2026-07-28:
    return rpcError(res, 400, id, -32020, "HeaderMismatch",              // header and
      { header: "MCP-Protocol-Version", headerValue: headerVersion, metaValue: metaVersion }); }  // body must agree
  const headerMethod = req.headers["mcp-method"];
  if (headerMethod && headerMethod !== msg.method) {
    return rpcError(res, 400, id, -32020, "HeaderMismatch",
      { header: "Mcp-Method", headerValue: headerMethod, metaValue: msg.method });
  }
  const version = metaVersion || headerVersion;
  if (version && !SUPPORTED.includes(version)) {
    return rpcError(res, 400, id, -32022, "UnsupportedProtocolVersionError", { supported: SUPPORTED });
  }
  const modern = version === "2026-07-28";
  if (id === undefined) {                 // notifications → 202 Accepted
    res.writeHead(202, { "Cache-Control": "no-store" }); res.end(); return;
  }
  switch (msg.method) {
    case "initialize":                    // LEGACY era handshake (no sessions)
      return rpcResult(res, 200, id, {
        protocolVersion: SUPPORTED.includes(params.protocolVersion)
          ? params.protocolVersion : SUPPORTED[1],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
    case "server/discover":               // MODERN era (MUST implement)
      return rpcResult(res, 200, id, { resultType: "complete", supportedVersions: SUPPORTED,
        capabilities: { tools: { listChanged: false } }, instructions: INSTRUCTIONS,
        ttlMs: 0, cacheScope: "public",
        _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO } });
    case "ping":
      return rpcResult(res, 200, id, {});
    case "tools/list":
      if (!page || !page.tools) return rpcError(res, 200, id, -32000, notAttachedMsg());
      return rpcResult(res, 200, id, Object.assign({ tools: page.tools },
        modern ? { resultType: "complete", ttlMs: 0, cacheScope: "public" } : null));
    case "tools/call": {
      if (!page || !page.tools) return rpcError(res, 200, id, -32000, notAttachedMsg());
      if (!page.tools.some((t) => t && t.name === params.name)) {
        return rpcError(res, 200, id, -32602, "Unknown tool: " + params.name);
      }
      const outcome = await pageCall(params.name, params.arguments);
      console.log("[mcp] tools/call " + params.name + " → " + (outcome.error
        ? "error " + outcome.error.code : outcome.result && outcome.result.isError ? "isError" : "ok"));
      if (outcome.error) {
        return rpcError(res, 200, id, outcome.error.code || -32000,
          outcome.error.message || "Tool call failed");
      }
      return rpcResult(res, 200, id, outcome.result);
    }
    default:
      return rpcError(res, modern ? 404 : 200, id, -32601, "Method not found: " + msg.method);
  }
}

/* -- server ------------------------------------------------------------------- */
function readBody(req, next) {
  let body = "", len = 0;
  req.on("data", (c) => { len += c.length; if (len > 262144) { req.destroy(); return; } body += c; });
  req.on("end", () => next(body));
  req.on("error", () => {});
}
const server = http.createServer((req, res) => {
  const hostName = String(req.headers.host || "")   // rebinding defense
    .replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  if (!loopback(hostName)) return text(res, 403, "Forbidden Host", "text/plain");
  const url = (req.url || "/").split("?")[0];
  const corsBridge = { "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type" };
  if (url === "/bridge") {
    if (req.method === "OPTIONS") { res.writeHead(204, corsBridge); return res.end(); }
    if (req.method === "GET") return pageAttach(res);
    return text(res, 405, "Method Not Allowed", "text/plain", corsBridge);
  }
  if (url === "/bridge/result") {
    if (req.method === "OPTIONS") { res.writeHead(204, corsBridge); return res.end(); }
    if (req.method !== "POST") return text(res, 405, "Method Not Allowed", "text/plain", corsBridge);
    return readBody(req, (b) => {
      let msg = null;
      try { msg = JSON.parse(b); } catch (e) { msg = null; }
      text(res, pageResult(msg) ? 202 : 400, "", "application/json", corsBridge);
    });
  }
  if (url === "/mcp") {
    if (req.method === "POST") return readBody(req, (b) => handleMcp(req, res, b));
    return text(res, 405, "Method Not Allowed", "text/plain", { Allow: "POST" });
  }
  if (req.method === "GET") {
    if (url === "/" || url === "/index.html") {
      try {
        return text(res, 200, fs.readFileSync(PAGE_PATH), "text/html; charset=utf-8");
      } catch (e) {
        return text(res, 500, "index.html not found next to loom-bridge.mjs", "text/plain");
      }
    }
    if (url === "/favicon.ico") { res.writeHead(204); return res.end(); }
  }
  return text(res, 404, "Not Found", "text/plain");
});
function shutdown() {
  console.log("[bridge] shutting down");
  for (const [, p] of pendingCalls) { clearTimeout(p.timer); p.resolve({ result: toolErr("Bridge shutting down — tool call failed") }); }
  if (page) { try { page.sse.end(); } catch (e) { /* closed */ } }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
server.listen(PORT, "127.0.0.1", () => {
  console.log("[bridge] LOOM page:  http://127.0.0.1:" + PORT + "/");
  console.log("[bridge] MCP client: POST http://127.0.0.1:" + PORT + "/mcp");
  console.log("[bridge] open the page in a browser — the page is the backend");
});
