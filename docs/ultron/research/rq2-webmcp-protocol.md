# RQ2 — WebMCP protocol / transport / discovery for LOOM

## Question and affected task IDs

**RQ2:** Which WebMCP protocol/spec/transport/discovery should the single-page LOOM app
implement so external MCP clients (Claude, ChatGPT, agent harnesses) can attach and
reconfigure it live?

- **Affected tasks:** V2-MCP (implementation), V2-VERIFY (end-to-end acceptance test)
- Sub-questions: (a) current standard/dominant proposal for web-page-exposed MCP;
  (b) JSON-RPC framing + capability negotiation per MCP transports; (c) can a static
  single HTML file implement it client-side, and if not, the minimal viable serving
  arrangement; (d) concrete reference-client method for V2-VERIFY; (e) security model.

---

## Constraints and evaluation criteria

Constraints (from the project brief):

1. Page is a single self-contained `index.html` — vanilla JS/Canvas/Web Audio, no build,
   no external deps.
2. Tool surface: `get_state`, `set_rule`, `set_tempo`, `set_scale`, `reseed`,
   `set_volume`, `pause`, `resume` — all read/write an in-page config object.
3. Page must stay dormant-but-functional on `file://` and MCP-active on `http(s)`.

Evaluation criteria:

- **Client reach:** can real external MCP clients (Claude Desktop/Code, ChatGPT,
  CLI harnesses, Inspector) attach today, not just in-browser agents?
- **Spec conformance:** implements a published MCP transport (not an invented wire
  format), so reference clients work unmodified.
- **Single-file integrity:** how much of LOOM stays in `index.html`? Page must remain
  the sole source of truth for synth state.
- **Two-mode behavior:** clean `file://` dormancy vs `http(s)` activation.
- **Verification path:** scriptable, deterministic end-to-end test for V2-VERIFY.
- **Complexity / lock-in:** size of companion code, dependence on third-party
  extensions or non-standard transports.

---

## Options considered

### Option 1 — Pure in-page MCP: WebMCP (`navigator.modelContext`)

The page calls the proposed browser-native API to register tools; an in-browser agent
(Chrome's built-in agent, or an extension) discovers and invokes them.

- **Fit:** The official future direction for "website as tool" — W3C incubation, backed
  by Microsoft and Google. Zero companion code; the page alone suffices.
- **Breaks on:** reach, not files. WebMCP is **not JSON-RPC MCP** — the W3C AIKR CG
  technical notes state explicitly (Technical Note 3, "WebMCP Is Not an MCP Server"):
  "MCP uses JSON-RPC 2.0 over stdio/HTTP/SSE; WebMCP is browser-native, and tool
  definitions are not interchangeable with MCP server tools." External CLI/AI clients
  cannot attach; only an agent inside the user's browser can. Requires Chrome 149+
  origin trial (or a flag in Canary) and a visible tab — "no headless support."
- **Verification:** impossible for V2-VERIFY as specified (no external reference
  client); would need the Chrome "Model Context Tool Inspector" extension with
  Gemini preview models.
- **When preferable:** when the consumer is a browser-native agent and Chrome-only
  reach is acceptable. Not LOOM's V2 requirement.

### Option 2 — Static page + minimal local bridge implementing Streamable HTTP (RECOMMENDED)

A tiny zero-dependency Node script (`loom-bridge.mjs`, ~120 lines) that (a) serves
`index.html`, (b) implements the MCP **Streamable HTTP** endpoint at `POST /mcp`
(dual-era: modern 2026-07-28 stateless + legacy `initialize`), and (c) forwards
`tools/call` to the live page over an outbound page→bridge channel (SSE + fetch POST;
EventSource keeps it dependency-free). The page keeps ALL tool logic and state; the
bridge is a stateless proxy.

- **Fit:** full spec conformance — Claude Desktop/claude.ai connectors, Claude Code,
  the MCP Inspector, and any MCP client that accepts a URL can attach.
- **Single-file:** the PAGE stays single-file and fully functional standalone. The
  bridge is a companion dev/ops artifact, the same way a test runner is. **This is a
  constraint expansion that must be flagged:** V2-MCP cannot be delivered as
  "index.html only" if external clients must attach.
- **file://:** page gates MCP on `location.protocol` — dormant on `file://`, tries to
  attach on `http(s)`; graceful "inactive (no bridge)" if the bridge is absent.
- **Verification:** MCP Inspector CLI against `http://127.0.0.1:7331/mcp` (exact
  recipe below).

### Option 3 — postMessage/iframe/extension bridge (MCP-B pattern)

A Chrome extension acts as MCP client for pages; a native server bridges desktop MCP
clients to the extension over Streamable HTTP; the page talks MCP (official TS SDK) to
the extension via a `TabServerTransport` over postMessage.

- **Fit:** proven in production by MCP-B (Alex Nahas): pages embed
  `@modelcontextprotocol/sdk` + `@mcp-b/transports`, connect
  `TabServerTransport({ allowedOrigins })`; Claude Desktop connects to
  `@mcp-b/native-server` at `http://127.0.0.1:12306/mcp` (streamable HTTP).
- **Breaks on:** the upstream repo is **archived and the extension is now
  closed-source** ("The MCP-B extension is no longer open source"). Depends on every
  user installing a specific third-party extension; heavyweight for a music toy;
  npm SDK deps violate the no-deps page constraint unless inlined.
- **When preferable:** if we wanted many tabs/sites exposing tools through one
  installed extension and accepted the dependency. The *architecture* (bridge +
  outbound channel from the page) is sound and Option 2 reuses it without the
  extension.

### Rejected variants

- **Serverless function (Vercel/CF Worker) hosting `/mcp`:** can speak MCP publicly,
  but a browser page cannot accept inbound connections — the function could never
  reach the live page unless we also run a hosted WebSocket relay (scope expansion,
  hosting cost, privacy surface). Cloud AI clients (ChatGPT connectors) can't reach a
  user's localhost anyway without a tunnel. Future option only.
- **Service Worker on a static host answering `/mcp`:** a SW only intercepts requests
  from contexts it controls (its own origin's pages); native MCP clients' HTTP POSTs
  never pass through it. Not a server. Rejected.
- **WebSocket transport:** not standardized by MCP ("custom transports" are allowed,
  but mainstream clients don't ship client-side WS support — LangChain4j notes its WS
  support "is not standardized"). Used internally (page↔bridge) only if desired; SSE
  chosen instead because Node core has no WS server.

---

## Recommendation and rationale

**Commit: a static page cannot be an MCP transport server. Browsers cannot listen on
sockets; both standard MCP transports (stdio, Streamable HTTP) require a process that
accepts inbound connections. The minimal viable pattern is a ~120-line, zero-dependency
local bridge script shipped alongside the page** (`node loom-bridge.mjs`), implementing
MCP Streamable HTTP at `/mcp` and proxying tool calls to the page over an SSE+POST
channel. The page — the single-file artifact — implements the tool registry, JSON-RPC
dispatch, and activation logic; the bridge is a dumb, generic translator with no LOOM
knowledge beyond serving the file.

What stays single-file: the entire app and MCP tool layer (`index.html`). What is
added: one companion script + (dev-time only) `npx @modelcontextprotocol/inspector`.
**Flagged for coordinator:** this expands "no build, no external deps" from
"one file in the repo" to "one file + one small script"; it does NOT change the
two-mode requirement (page remains dormant-functional on `file://`, MCP-active on
`http(s)` served by the bridge).

Rationale:

1. Only Option 2 satisfies "external MCP clients attach" with a *published* transport.
   WebMCP (Option 1) is the standards-track future but serves in-browser agents, not
   CLI/AI clients, and is flag/origin-trial gated as of 2026-08.
2. The current spec revision (2026-07-28) is **stateless** — no `initialize`
   handshake, no sessions, POST-only — which makes the bridge trivially small.
3. Dual-era support (also answering legacy `initialize`) keeps deployed clients
   (which may still speak 2025-06-18/2025-11-25 wire shapes) working; the spec
   explicitly blesses this: "A dual-era server MAY serve both eras concurrently on
   the same endpoint."
4. Cheap forward hedge: feature-detect and register WebMCP tools
   (`if (navigator.modelContext)`) as an optional bonus — zero cost, no lock-in.

---

## Evidence (primary sources, fetched 2026-08-28)

### MCP specification — modelcontextprotocol.io

- **Version timeline** (from `https://modelcontextprotocol.io/llms.txt`): revisions
  2024-11-05, 2025-03-26, 2025-06-18, 2025-11-25, **2026-07-28 (latest/current)**, plus
  a draft. No WebMCP/browser pages in the spec.
- **Streamable HTTP, 2026-07-28**
  (`https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http`):
  - "The server **MUST** provide a single HTTP endpoint path … that supports POST."
  - Revision removed the GET stream endpoint, protocol-level sessions
    (`Mcp-Session-Id`), `DELETE`, and `Last-Event-ID` resumability.
  - Security: "Servers **MUST** validate the `Origin` header on all incoming
    connections to prevent DNS rebinding attacks … If the `Origin` header is present
    and invalid, servers **MUST** respond with HTTP 403 Forbidden." / "servers
    **SHOULD** bind only to localhost (127.0.0.1)" / "**SHOULD** implement proper
    authentication."
  - Required headers on every POST: `MCP-Protocol-Version` (must match
    `_meta.io.modelcontextprotocol/protocolVersion` else `400` +
    `HeaderMismatch` `-32020`), `Mcp-Method`, `Mcp-Name` ("REQUIRED for compliance").
  - Responses: single JSON object (`application/json`) or request-scoped SSE stream;
    client `Accept` must list both. Notifications → `202 Accepted`. Unknown method →
    `404` + JSON-RPC `-32601`.
- **Changelog 2026-07-28**
  (`https://modelcontextprotocol.io/specification/2026-07-28/changelog`):
  - "Remove protocol-level sessions and the `Mcp-Session-Id` header."
  - "Make MCP stateless: remove the `initialize`/`notifications/initialized`
    handshake. Every request now carries its protocol version and client capabilities
    in `_meta`."
  - "Add `server/discover`: servers **MUST** implement this RPC."
  - "Require standard MCP request headers (`Mcp-Method`, `Mcp-Name`)…"
  - "Require `ttlMs` and `cacheScope` fields on results returned by `tools/list`…"
  - "Servers **SHOULD** return tools from `tools/list` in a deterministic order."
- **Versioning & compatibility**
  (`https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning`):
  - "There is no negotiation handshake. Every request carries its protocol version."
  - Unsupported version → error `-32022` `UnsupportedProtocolVersionError` with
    `data.supported` list.
  - Era model: "Modern" (2026-07-28+, per-request `_meta`) vs "Legacy"
    (2025-11-25 and earlier, `initialize` handshake); "A dual-era server MAY serve
    both eras concurrently on the same endpoint."
- **server/discover** (`https://modelcontextprotocol.io/specification/2026-07-28/server/discover`):
  request = no params beyond `_meta`; result =
  `{ resultType: "complete", supportedVersions: [...], capabilities: { tools: {} },
  _meta: { "io.modelcontextprotocol/serverInfo": { name, version } }, instructions,
  ttlMs, cacheScope }`. Servers MUST implement it; clients MAY call it.
- **Tools** (`https://modelcontextprotocol.io/specification/2026-07-28/server/tools`):
  Tool = `{ name, title?, description?, icons?, inputSchema (JSON Schema, defaults
  2020-12), outputSchema?, annotations? }`; tool names SHOULD be 1–128 chars of
  `[A-Za-z0-9_.-]`; `tools/call` → `{ name, arguments }`; result →
  `{ resultType: "complete", content: [{type:"text",…}], structuredContent?, isError }`;
  unknown tool → JSON-RPC `-32602`; tool execution errors → `isError: true` content.
  Security: "there **SHOULD** always be a human in the loop"; servers MUST "Validate
  all tool inputs … Rate limit tool invocations"; annotations are untrusted.
- **Legacy-era minimal server (2025-06-18)**
  (`https://modelcontextprotocol.io/specification/2025-06-18/basic/transports`):
  sessions are optional ("a server … **MAY** assign a session ID"); a server that
  offers no SSE stream "**MUST** … return HTTP 405 Method Not Allowed" to GET; DELETE
  may 405. So a POST-only JSON server with an `initialize` handshake is
  spec-legal for legacy clients.

### WebMCP (browser-native proposal)

- **W3C AIKR CG technical notes**
  (`https://w3c-cg.github.io/aikr/webMCP/webMcp-technical-notes.html`): WebMCP spec is
  a "Draft Community Group Report" dated **2026-02-12**, editors Brandon Walderman
  (Microsoft), Khushal Sagar and Dominic Farolino (Google); incubating in the W3C Web
  Machine Learning CG; Chrome Early Preview Program launched **2026-02-10**
  (Chrome 146 Canary, `WebMCP for testing` flag).
  - API: `navigator.modelContext` with `provideContext()`, `clearContext()`,
    `registerTool(tool)`, `unregisterTool(name)`; declarative forms API; tools have
    `name/description/inputSchema/execute/annotations`; `requestUserInteraction()` on
    the `ModelContextClient` for human-in-the-loop.
  - TN3: "WebMCP Is Not an MCP Server" — postMessage-based, browser-native; not
    JSON-RPC; not interchangeable with MCP wire tools.
  - Security: origin isolation + SecureContext required; consent gap ("Tools are
    silently registered and discoverable"); prompt injection called "the most acute
    risk" with no spec defense beyond same-origin.
- **Chrome for Developers** (`https://developer.chrome.com/docs/ai/webmcp`,
  published 2026-05-18, updated 2026-06-09): origin trial from **Chrome 149**; local
  dev via `chrome://flags/#enable-webmcp-testing`; requires a visible browser tab
  (no headless); Permission-Policy `tools` (default `self`, iframes need
  `allow="tools"`); gated on origin isolation (disabled if `document.domain` is used).

### MCP-B (postMessage/extension bridge precedent)

- `https://github.com/MiguelsPizza/WebMCP` (archived, AGPL-3.0): page uses
  `@modelcontextprotocol/sdk` `McpServer` + `TabServerTransport` (postMessage);
  `@mcp-b/native-server` "starts a server on port 12306 by default"; Claude
  Desktop/Cursor config `{"type":"streamable-http","url":"http://127.0.0.1:12306/mcp"}`.
  README: "The MCP-B extension is no longer open source." Proves the
  bridge+outbound-channel architecture; don't build on the closed extension.

### Reference client (V2-VERIFY)

- **MCP Inspector** (`https://modelcontextprotocol.io/docs/2026-07-28/tools/inspector`):
  package `@modelcontextprotocol/inspector`, requires Node ≥ 22.19.0. CLI mode:
  `npx @modelcontextprotocol/inspector --cli https://api.example.com/mcp --transport http
  --method tools/call --tool-name get_weather --tool-arg city=Boston --format json | jq .result`
  and `--method tools/list`. "All three [web/CLI/TUI] are built on the same shared
  core … the same protocol-era negotiation (legacy vs. modern 2026-07-28)."

### Client attach support (secondary sources)

- Claude Platform MCP connector docs
  (`https://platform.claude.com/docs/en/agents-and-tool/mcp-connector`): remote MCP
  servers via Streamable HTTP from Messages API; claude.ai/Desktop "Settings →
  Connectors" accepts a server URL; Claude Code: `claude mcp add --transport http`.
- ChatGPT connectors: remote **HTTPS + OAuth only** — cannot reach a user's localhost
  bridge (community/vendor docs). Cloud clients are inherently out of reach for a
  local bridge without a public tunnel; fine for V2 (local clients + Inspector).

### Discovery

- Classic MCP has **no page manifest discovery**: clients are configured with an
  explicit URL/command. `.well-known/mcp.json` is only a proposal under discussion
  (GitHub discussion #1147); the MCP Registry + `.well-known/mcp-registry-auth` is for
  publishing public servers; IETF `draft-serra-mcp-discovery-uri-02` is pending.
  WebMCP's registration IS a discovery mechanism, but only for in-browser agents.
  → LOOM needs no discovery work; document the URL.

---

## Tradeoffs, risks, confidence

- **Tradeoff accepted:** one companion script vs zero external reach. Without it, only
  Chrome-canary in-browser agents could ever drive the page (Option 1).
- **Risks:**
  - Deployed clients may still be legacy-era as of 2026-08 → mitigated by dual-era
    bridge (`initialize` path is ~40 extra lines; spec explicitly supports it).
  - Cloud AI clients (ChatGPT) can never reach a localhost bridge → accepted; V2
    targets local clients (Claude Desktop/Code, Inspector, harnesses).
  - Page must be open for tools to work → by design (live reconfig is the point);
    bridge returns a clear JSON-RPC error when the page isn't attached.
  - WebMCP is fast-moving (CG draft + origin trial) → we only feature-detect; nothing
    breaks if it changes.
  - EventSource reconnect storms → native retry with browser backoff; bridge treats
    each attach as idempotent.
- **Confidence: HIGH** on protocol facts (all fetched from primary spec pages on
  2026-08-28). **MEDIUM** on deployed-client era behavior (Claude/ChatGPT wire era as
  of 2026-08) — mitigated by dual-era implementation. **HIGH** that a static page
  cannot serve a standard MCP transport (architectural, not version-sensitive).

---

## Implementation consequences and plan updates

### V2-MCP — concrete guidance

**Companion bridge** (`loom-bridge.mjs`, zero deps, Node core only; default port 7331,
`PORT` env override; binds 127.0.0.1):

- `GET /` → serve `index.html` from disk.
- `POST /mcp` → MCP Streamable HTTP endpoint (below).
- `GET /bridge` → SSE stream to the page (server→page tool invocations). CORS:
  `Access-Control-Allow-Origin: *` on `/bridge` endpoints only (loopback, no secrets;
  enables a hosted page to attach to a local bridge — loopback is exempt from
  mixed-content blocking in modern browsers).
- `POST /bridge/result` → page→bridge tool results, body `{id, result|error}`.
- Security: bind 127.0.0.1; validate `Host` is `127.0.0.1:<port>` (DNS-rebinding
  defense); on `/mcp`, reject invalid `Origin` with 403 (absent Origin allowed for
  non-browser clients); no CORS on `/mcp`; trivial rate limit; no auth (localhost
  music toy — document it).

**`/mcp` wire behavior (dual-era):**

- Modern (2026-07-28): per-request `_meta`
  (`io.modelcontextprotocol/protocolVersion`, `clientInfo`, `clientCapabilities`);
  validate `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` headers against body
  (`400` + `-32020` on mismatch); implement `server/discover`
  (`supportedVersions: ["2026-07-28","2025-11-25","2025-06-18"]`,
  `capabilities: { tools: {} }`, `serverInfo: {name:"loom",…}`); reply
  `application/json` single objects; include `resultType: "complete"`,
  result `_meta` `serverInfo`, and `ttlMs`/`cacheScope` on list results; unknown
  method → `404` + `-32601`; unsupported version → `400` + `-32022` with `supported`.
- Legacy: answer `initialize` (echo capabilities `{tools:{listChanged:false}}`,
  `serverInfo`, negotiated `protocolVersion`); no `Mcp-Session-Id`; `GET`/`DELETE`
  → `405` (spec-legal).
- `tools/list`: serve the manifest the page pushed on attach; if no page attached →
  JSON-RPC error `-32000` "LOOM page not attached; open http://127.0.0.1:7331/".
- `tools/call`: forward `{id, name, arguments}` to the page over `/bridge` SSE; await
  matching `/bridge/result` (5 s timeout) → JSON-RPC result; timeout/detached →
  `isError: true` tool-execution error.

**In-page MCP layer (inside `index.html`):**

- Activation: `const mcpEnabled = ['http:','https:'].includes(location.protocol);`
  — on `file://` skip entirely (dormant, synth fully functional). On `http(s)`,
  open `new EventSource(BRIDGE + '/bridge')` where `BRIDGE` defaults to same-origin,
  overridable via `?bridge=` query param or localStorage. Status surfaced in the UI:
  `MCP: dormant (file://)` / `MCP: active` / `MCP: inactive (no bridge)` with
  auto-reconnect (EventSource native).
- On SSE open, page sends `{type:'hello', tools:[…manifest…]}` via
  `POST /bridge/result`; on `{type:'call', id, name, arguments}` events, dispatch to
  the in-page tool registry, then POST `{id, result}`.
- Tool manifest (deterministic order; JSON Schema 2020-12; annotations honest):
  - `get_state` — `{type:"object",additionalProperties:false}`, `readOnlyHint: true`,
    `outputSchema` = config object; returns `structuredContent` + text.
  - `set_rule` — `{rule: string(enum), value: …}` per rule table; `idempotentHint: true`.
  - `set_tempo` — `{bpm: integer 20–300}`; `set_scale` — `{root: enum, mode: enum}`;
    `reseed` — `{seed: integer?}`; `set_volume` — `{volume: number 0–1}`;
    `pause`/`resume` — empty schema `{type:"object",additionalProperties:false}`.
  - Every setter returns `{applied: true, state: <new value>}`; validation failures →
    `isError: true` with actionable text (models self-correct).
- Optional bonus (best-effort, no lock-in): `if (navigator.modelContext)
  navigator.modelContext.registerTool(...)` mirroring the same handlers for future
  in-browser agents.

### V2-VERIFY — reference client recipe

1. `node loom-bridge.mjs` → serving `http://127.0.0.1:7331/`.
2. Open `http://127.0.0.1:7331/` in a browser (audio needs the page live; the page is
   the MCP backend).
3. Inspector CLI (Node ≥ 22.19):
   - `npx -y @modelcontextprotocol/inspector --cli http://127.0.0.1:7331/mcp --transport http --method tools/list --format json`
     → assert all 8 tools present.
   - `… --method tools/call --tool-name set_tempo --tool-arg bpm=140 --format json`
     → assert `applied: true`; then `--tool-name get_state` → assert `bpm === 140`
     (round-trip through the live page).
   - Repeat per tool (`pause` → `get_state.paused === true`, etc.). Negative test:
     `set_tempo bpm=9999` → `isError: true`. Detach test: close tab → `tools/list`
     returns the explicit "page not attached" error.
4. Raw curl smoke (modern era): `curl -X POST http://127.0.0.1:7331/mcp -H
   'Content-Type: application/json' -H 'MCP-Protocol-Version: 2026-07-28' -H
   'Mcp-Method: tools/list' -H 'Accept: application/json, text/event-stream' -d
   '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"curl","version":"0"},"io.modelcontextprotocol/clientCapabilities":{}}}}'`.
5. Optional real-client check: `claude mcp add --transport http loom
   http://127.0.0.1:7331/mcp`, then drive tools from Claude Code.

### Plan updates / flags for coordinator

- V2-MCP scope now includes `loom-bridge.mjs` (~120 lines, zero deps) — constraint
  expansion explicitly flagged and justified; `index.html` remains single-file,
  standalone, and fully functional without the bridge.
- No discovery work needed (explicit URL configuration is the MCP mechanism today).
- WebMCP `navigator.modelContext` registration is an optional stretch item, not a
  dependency.

---

## Decision priority and status

- **Priority:** P0 blocker for V2-MCP design (transport choice gates all MCP code).
- **Status:** DECIDED — Option 2 (local bridge + Streamable HTTP dual-era + SSE proxy
  to the page), with optional WebMCP feature-detect bonus. Awaiting coordinator
  acknowledgment of the single-file constraint expansion.

---

## Delegation record

- Track: RQ2 (WebMCP protocol/transport/discovery) — research subagent for
  **deep-research-supreme** (ultron-supreme line).
- Run date: 2026-08-28. Method: primary-source fetches of modelcontextprotocol.io
  (spec revisions 2025-06-18 and 2026-07-28: transports, changelog, versioning,
  discover, tools; Inspector docs; llms.txt index), W3C AIKR CG WebMCP technical
  notes, Chrome for Developers WebMCP page, MCP-B repo, plus targeted searches for
  client attach support and discovery proposals.
