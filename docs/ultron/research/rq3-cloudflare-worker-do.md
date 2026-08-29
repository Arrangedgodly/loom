# RQ3 — Cloudflare architecture for the public MCP endpoint (Worker + Durable Object)

## Question and affected task IDs

**RQ3:** What is the committed Cloudflare architecture for LOOM's public MCP endpoint —
replacing the localhost Node bridge (whose verified semantics are in
`docs/ultron/research/rq2-webmcp-protocol.md`) with a hosted Worker + Durable Object
(DO) that remote AI clients reach over the internet while an opted-in browser tab on
loom.arrangedgodly.com attaches as the tool backend?

- **Affected tasks:** V3-WORKER (decisive — pattern gates all Worker/DO code),
  V3-DEPLOY (runbook shape: wrangler vs Pages-git split, login scopes, verification),
  V3-PAGE (attach-channel transport the page must implement), V3-VERIFY (criterion ⑯
  free-tier cost numbers).
- Sub-questions: (a) DO availability/limits on the Workers Free plan incl. SSE
  viability; (b) SSE vs WebSocket page-attach channel; (c) official MCP-on-Workers
  patterns vs hand-rolled JSON-RPC; (d) Worker routes on the zone vs Pages Functions +
  DO binding; (e) CORS/Origin handling on both faces; (f) wrangler.toml shape, local
  dev recipe, login permissions.

---

## Constraints and evaluation criteria

From the project brief and v3 plan (docs/ultron/plan.md):

1. Page is a static single `index.html` on Cloudflare Pages (Pages-git deploy); it must
   stay the sole source of truth for synth state; MCP-active only on `http(s)`,
   dormant on `file://`.
2. V3-WORKER acceptance requires **"zero-dependency (Worker runtime APIs only)"** —
   no npm packages in the Worker.
3. Consent model: default-off toggle; un-opted pages never connect; one-driver slot
   (most-recently-attached opted-in tab).
4. Wire semantics = the RQ2-verified dual-era Streamable HTTP bridge behavior
   (modern 2026-07-28 stateless + legacy `initialize`; spec Origin checks; 403 on
   invalid Origin; absent Origin allowed).
5. Deploy split: page via Pages-git (git push → auto-deploy); infra via wrangler
   (`npx wrangler login` + `npx wrangler deploy`, owner-gated/halt-listed).
6. Criterion ⑯ needs documented free-tier numbers — the design must be demonstrably
   free-tier-viable at portfolio-traffic scale.
7. `?bridge=` local override must keep working (V3-PAGE regression criterion ⑮).

---

## Options considered

### (a) Durable Objects on the Workers Free plan — viability matrix

- **SQLite-backed DOs on Free: VIABLE.** Official pricing page (updated 2026-08-25):
  "Durable Objects are available both on Workers Free and Workers Paid plans"; on Free
  "Only Durable Objects with SQLite storage backend are available" (exactly what a new
  build must use anyway — `new_sqlite_classes`).
- **SSE from a DO: supported technically, NOT free-tier-viable as a long-lived page
  channel.** Streaming responses from DOs are fully supported (ReadableStream +
  `text/event-stream`; Agents docs: "Cloudflare Workers have no effective limit on SSE
  response duration"). But billing kills it: duration is billed wall-clock "while the
  Durable Object is actively running" — an in-flight streaming response keeps it
  active. A DO is billed at the full 128 MB allocation. One tab attached 24 h/day via
  SSE = 0.128 GB × 86,400 s ≈ **11,059 GB-s/day = 85.8% of the entire free 13,000
  GB-s/day budget**; two such tabs exceed it. On Free, exceeding a daily limit makes
  "further operations of that type fail with an error" until 00:00 UTC reset — the
  whole MCP endpoint would hard-fail.
- **WebSocket with the Hibernation API: viable and effectively free at idle.**
  "Billable Duration (GB-s) charges do not accrue during hibernation"; idle
  hibernation-eligible objects are not billed; incoming WS messages billed at a 20:1
  ratio ("100 messages ≈ 5 requests").

### (b) Page-attach channel — SSE+POST vs WebSocket

- **SSE + POST (RQ2 bridge shape, ported verbatim):** keeps page code identical to
  V2, but the DO accrues duration the whole time any tab is attached (math above) —
  rejected on free-tier evidence.
- **WebSocket (hibernating) — COMMITTED:** idle = zero duration billing; native in
  Workers/DO (canonical pattern: Worker/Pages Function proxies the upgrade to the DO,
  DO returns `status: 101` with the client socket, accepts with
  `state.acceptWebSocket(server)`); bidirectional — tool results return over the same
  socket, eliminating the POST-result face and its CORS surface entirely. Runtime
  answers protocol ping/pong automatically without waking the DO. Cost: page loses
  EventSource's built-in auto-reconnect (hand-roll a backoff loop — needed anyway
  because "Code updates disconnect all WebSockets" on every deploy).
- **SSE terminated by a Worker (DO feeding it):** the Worker's subrequest to the DO
  stays in-flight to deliver events → keeps the DO active/billed anyway. Rejected.

### (c) Official MCP-on-Workers pattern vs hand-rolled JSON-RPC

- **Official: Cloudflare Agents SDK** (`agents` package). Current docs (updated
  2026-06-03) recommend `createMcpHandler()` from `agents/mcp/server` with
  `@modelcontextprotocol/server` **v2.0.0** — "stateless with legacy compatibility by
  default" — for new servers; the DO-based `McpAgent` is **deprecated** ("Do not use
  that path for a new server"; the quick-deploy templates "still use the deprecated
  McpAgent path"). Reference example: `cloudflare/agents` `examples/mcp-worker`
  ("no Durable Objects, no persistent state"); templates `cloudflare/ai/demos/
  remote-mcp-authless` / `-github-oauth`. The handler ships built-in dual-era support,
  `route` (default `/mcp`), `corsOptions`, `allowedHostnames`, and
  `allowedOriginHostnames` (403 on malformed/opaque Origins, Origin-less clients
  allowed — i.e., exactly the spec-mandated behavior).
- **Hand-rolled JSON-RPC port of `loom-bridge.mjs` — COMMITTED.** All server logic in
  the DO; the RQ2 bridge already implements and verified the exact dual-era wire
  semantics (headers `MCP-Protocol-Version`/`Mcp-Method`/`Mcp-Name`, `-32020`/
  `-32022` errors, `server/discover`, `ttlMs`/`cacheScope`, legacy `initialize`),
  so a 1:1 port preserves verified behavior and endpoint parity with the local
  bridge. Decisive constraints: V3-WORKER mandates zero npm dependencies; the SDK
  requires `npm i agents @modelcontextprotocol/server@2.0.0 zod`; and the SDK line is
  churning (McpAgent frozen, SDK v1→v2 migration guide live) — churn risk for a
  stable portfolio endpoint. Also, the SDK assumes tools execute in the Worker; our
  proxy-to-page part is custom work either way, so the SDK saves little.
- The hand-rolled Worker should still **mirror the blessed `mcp-worker` example's
  shape** (fetch-handler entry, exact-path `/mcp` route, tool registry object) so the
  design stays idiomatic and swappable. The Agents SDK is the documented fallback if
  conformance gaps appear in V3-VERIFY.

### (d) Same-domain routing — Worker routes on the zone vs Pages Functions + DO binding

- **Worker route `loom.arrangedgodly.com/mcp*`: REJECTED (undocumented/unsupported on
  a Pages-claimed hostname).** The Workers Routes doc covers routes "in front of your
  application server" on proxied DNS but contains no Pages-coexistence claim;
  Pages Known Issues documents the conflict in one direction ("Custom domains cannot
  be added to a domain that has a Worker already routed on that domain" — routes and
  Pages occupy the same routing namespace); community threads (312550 "Configure
  workers to run on path(s) currently served by CF Pages", 621315, 640862) converge
  on: you cannot reliably route a zone Worker in front of a Pages custom domain —
  use a service binding / Pages Function instead. Some mixed community reports say
  zone routes sometimes fire on Pages hostnames; undocumented behavior is exactly
  what a halt-listed one-shot deploy must not depend on.
- **Pages Functions + DO binding — COMMITTED.** Fully documented path: a
  `functions/mcp/[[route]].js` + `functions/attach.js` forwarder in the Pages project
  (ships via the EXISTING Pages-git flow), binding to a separately deployed DO
  Worker ("You cannot create and deploy a Durable Object within a Pages project. You
  must create a Durable Object Worker and bind it to your Pages project"). Matches
  our deploy split perfectly: page + forwarder via git push; DO Worker via
  `wrangler deploy`. No route conflicts possible; static asset requests stay
  free/unlimited; only `/mcp*` and `/attach` invoke Functions (Pages CI
  auto-generates `_routes.json`; ≤100 rules). WebSocket upgrades forward cleanly
  (the canonical DO proxy pattern works from Pages Functions: detect
  `Upgrade: websocket`, `return stub.fetch(request)` with the DO's 101).
- **Migrate the whole site to a Worker with static assets (Cloudflare's recommended
  end-state for NEW projects — "If you are starting a new project, use Workers
  instead of Pages"):** rejected for v3 — it would move the page off the established
  Pages-git flow and expand scope; recorded as the future migration path
  (`workers/static-assets/migration-guides/migrate-from-pages`).

### (e) CORS/Origin on both faces

- **MCP POST face:** identical to the RQ2 bridge/spec rule — validate `Origin` when
  present (403 on mismatch), allow absent Origin (non-browser MCP clients), no CORS
  headers. Allowlist = `https://loom.arrangedgodly.com` (plus `http://localhost:*`
  in dev). (The Agents SDK's `allowedOriginHostnames` implements the same rule if
  the fallback is ever adopted.)
- **Page-channel face (`/attach` WebSocket):** same-origin by construction
  (`wss://loom.arrangedgodly.com/attach` from `https://loom.arrangedgodly.com`).
  WebSockets are not governed by CORS (no preflight; the browser does not enforce
  same-origin on WS) — the server MUST validate the handshake `Origin` itself as the
  hijacking defense; allowlist exactly the page origin (+ localhost in dev). No
  credentials/cookies needed. Because results return over the socket (bidirectional
  WS), there is **no POST face and no CORS surface at all** in production — simpler
  than the bridge's SSE+POST+CORS arrangement, which existed only because Node core
  has no WS server. The RQ2 idea of `Access-Control-Allow-Origin: *` on the channel
  is dropped; the `?bridge=` override remains for the local Node bridge (its own
  SSE+POST protocol, unchanged, criterion ⑮).

### (f) Wrangler specifics — covered in Implementation consequences below

---

## Recommendation and rationale

**COMMIT — "DO-housed server + Pages-Function forwarder + hibernating WebSocket":**

1. One wrangler-deployed Worker (`mcp-worker.js`) exports a single SQLite-backed
   Durable Object class `LoomChannel`. ALL server logic lives in the DO: the dual-era
   JSON-RPC `POST /mcp` face (ported 1:1 from `loom-bridge.mjs`), the `GET /attach`
   WebSocket face (hibernation API), the one-driver slot, and the pending-call proxy.
2. The DO Worker's own `fetch()` routes `/mcp` and `/attach` into the DO singleton —
   this is what `wrangler dev` tests directly, so V3-WORKER's local proof exercises
   the real server, not glue.
3. On the zone, the existing Pages project gains two thin Functions that forward
   verbatim to the DO via binding: `POST https://loom.arrangedgodly.com/mcp` and
   `wss://loom.arrangedgodly.com/attach`. Page stays static + Pages-git; infra stays
   wrangler; no zone routes are ever created.
4. Free tier throughout: DO requests 100k/day, duration 13,000 GB-s/day with
   hibernation making idle attach cost ~zero; WS messages at 20:1; portfolio traffic
   uses ≈1% of quotas (math under Implementation consequences).

Rationale: every leg is load-bearing evidence — SSE long-lived streaming from a DO
would burn ~86% of the free daily duration budget per always-on tab (pricing doc);
hibernating WebSockets cost zero duration while idle (exact quote); zone routes on a
Pages hostname are undocumented while Functions+DO-binding is explicitly documented;
the zero-dep acceptance rule rules out the Agents SDK; and the RQ2 bridge already
contains verified wire semantics to port rather than reimplement via a churning SDK.

---

## Evidence (primary sources, fetched 2026-08-28)

### Durable Objects — pricing, limits, billing

- **Durable Objects pricing** (`https://developers.cloudflare.com/durable-objects/platform/pricing/`,
  page dated 2026-08-25):
  - "Durable Objects are available both on Workers Free and Workers Paid plans."
  - Free plan: "Only Durable Objects with SQLite storage backend are available."
  - Free daily limits: requests "100,000 / day"; compute duration "13,000 GB-s / day";
    SQLite rows read "5 million / day"; rows written "100,000 / day"; stored "5 GB
    (total)". Limits reset daily 00:00 UTC; exceeding any one → "further operations
    of that type will fail with an error".
  - Duration is billed "for the 128 MB of memory your Durable Object is allocated,
    regardless of actual usage"; wall-clock "while the Durable Object is actively
    running … or is idle in memory but unable to hibernate."
  - "Requests to a Durable Object keep it active or create the object if it was
    inactive." Concurrent requests share one duration stream.
  - Without hibernation, `accept()` "will incur duration charges for the entire time
    the WebSocket is connected"; with the Hibernation API the docs recommend it "to
    avoid incurring duration charges once all event handlers finish running."
  - Idle, hibernation-eligible objects "are not billed for duration, even before the
    runtime has hibernated them"; "Inactive objects receiving no requests do not
    incur any duration charges."
  - "Incoming WebSocket messages are billed at a 20:1 ratio (100 messages ≈ 5
    requests)."
  - `setWebSocketAutoResponse()` pings "will not incur additional wall-clock time".
- **Workers platform limits** (`https://developers.cloudflare.com/workers/platform/limits/`):
  - Free: 100,000 requests/day; 10 ms CPU/request; 50 subrequests/request; 6
    simultaneous open connections awaiting headers (both plans); memory 128 MB.
  - Duration (HTTP): "No limit while the client stays connected"; DO invocations
    "No hard limit while the caller stays connected to the Durable Object."
  - Free daily cap breach → Error 1027.
- **DO WebSocket API** (`https://developers.cloudflare.com/durable-objects/api/websockets/`):
  - Hibernation: `this.ctx.acceptWebSocket(server)` "allows the Durable Object to be
    hibernated"; **"Billable Duration (GB-s) charges do not accrue during
    hibernation."**
  - "Ping/pong handling does not interrupt hibernation"; handler methods
    `webSocketMessage(ws, msg)` / `webSocketClose(...)`; attachments via
    `serializeAttachment` capped at "Maximum serialized size is 16,384 bytes".
  - "Outgoing WebSockets do not hibernate" (an active outbound socket keeps the DO
    alive up to 15 min) — our design uses only server-side sockets.
  - "Code updates disconnect all WebSockets."
  - Compat date ≥ 2026-04-07: runtime auto-replies to Close frames.
  - Local dev: prior to wrangler 3.13.2 / Miniflare v3.20231016.0 sockets never
    hibernated locally (events still delivered) — i.e., current wrangler hibernates
    locally.
- **DO WebSockets best practices**
  (`https://developers.cloudflare.com/durable-objects/best-practices/websockets/`):
  the canonical proxy pattern — Worker validates `Upgrade: websocket` (426 if
  absent), `env.WEBSOCKET_SERVER.getByName("foo")`, `return stub.fetch(request)`;
  DO creates `new WebSocketPair()`, accepts the server end, returns
  `new Response(null, { status: 101, webSocket: client })`. "Both Workers and
  Durable Objects are billed based on the number of requests" → validate in the
  proxy to avoid DO charges. DOs "connect thousands of clients per instance."
- **SSE support (technical)** (`https://developers.cloudflare.com/agents/runtime/communication/http-sse/`):
  Agents/DOs serve SSE via `ReadableStream`; "Cloudflare Workers have no effective
  limit on SSE response duration"; SSE is server→client only. (Support confirmed;
  free-tier viability denied by the pricing math above.)

### Official MCP-on-Workers patterns

- **MCP overview** (`https://developers.cloudflare.com/agents/model-context-protocol/`,
  updated 2026-06-03): remote MCP servers use Streamable HTTP; quickstart guide at
  `guides/remote-mcp-server/`.
- **Remote MCP server guide** (same tree): comparison of four approaches —
  `createMcpHandler()` ("stateless with legacy compatibility", best for "New
  stateless tools"), `createLegacyMcpHandler()`, `McpAgent` (stateful, DO-based,
  marked "Deprecated Durable Object and RPC servers"), raw SDK transport. "Use
  `createMcpHandler` for a new stateless server." Callout: "The quick-deploy
  templates in this section still use the deprecated `McpAgent` path. Do not use
  that path for a new server." Templates: `npm create cloudflare@latest --
  remote-mcp-server-authless --template=cloudflare/ai/demos/remote-mcp-authless`
  (and a GitHub-OAuth variant using `workers-oauth-provider` with `apiRoute:
  "/mcp"`).
- **Handler API reference**
  (`https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/`):
  `createMcpHandler` from `agents/mcp/server` uses `@modelcontextprotocol/server`
  **v2.0.0** (`npm i agents @modelcontextprotocol/server@2.0.0 zod`); per-request
  server factory; `era: "modern" | "legacy"` exposed to the factory; `legacy:
  "stateless" | "reject"`; `route` default `"/mcp"`; `corsOptions`;
  `allowedHostnames`; `allowedOriginHostnames` (malformed/opaque Origins → 403,
  Origin-less allowed); `responseMode: "auto" | "json"`. `createLegacyMcpHandler`
  from `agents/mcp` pins `@modelcontextprotocol/sdk` v1.30.0.
- **`cloudflare/agents` example `mcp-worker`**
  (`https://github.com/cloudflare/agents/tree/main/examples/mcp-worker`):
  `import { McpServer } from "@modelcontextprotocol/server"; import {
  createMcpHandler } from "agents/mcp/server";` — factory registers tools via
  `server.registerTool(name, {description, inputSchema: zod}, async handler)`,
  Worker `fetch` = `createMcpHandler(createServer)(request, env, ctx)`. "No Durable
  Objects, no persistent state, each request is independent." Sibling examples:
  `mcp` (stateful McpAgent), `mcp-worker-authenticated`, `mcp-client`.

### Routing — routes vs Pages Functions

- **Workers Routes** (`https://developers.cloudflare.com/workers/configuration/routing/routes/`):
  routes run "in front of your application server" on proxied DNS records; zone
  attached via `zone_id`/`zone_name`; precedence among routes = most specific
  pattern wins; "Routes can `fetch()` Custom Domains and take precedence if
  configured on the same hostname." **No Pages-coexistence behavior is documented
  anywhere on the page.**
- **Workers Custom Domains**
  (`https://developers.cloudflare.com/workers/configuration/routing/custom-domains/`):
  a Custom Domain "point[s] all paths of a domain or subdomain to your Worker";
  "you cannot create a Custom Domain on a hostname with an existing CNAME DNS
  record" — which is exactly what a Pages custom domain creates. (So Workers
  Custom Domains are also out for this hostname.)
- **Pages Known Issues** (`https://developers.cloudflare.com/pages/platform/known-issues/`):
  "Custom domains cannot be added to a domain that has a Worker already routed on
  that domain" — official acknowledgment that Workers routes and Pages domains
  conflict in the routing namespace (documented in the Pages-claims-second
  direction; the reverse direction is simply undocumented).
- **Pages Functions bindings**
  (`https://developers.cloudflare.com/pages/functions/bindings/`): "You cannot
  create and deploy a Durable Object within a Pages project … You must create a
  Durable Object Worker and bind it to your Pages project" (dashboard:
  Settings → Bindings → Add → Durable Object; or the Pages Wrangler config). Local
  dev recipe: `wrangler dev` in the DO Worker directory; separately
  `npx wrangler pages dev <OUTPUT_DIR> --do <BINDING_NAME>=<CLASS_NAME>@<SCRIPT_NAME>`
  (CLI flags take precedence over the config file).
- **Pages Wrangler configuration**
  (`https://developers.cloudflare.com/pages/functions/wrangler-configuration/`):
  DO bindings in a Pages config are configured like Workers' **but "`script_name`
  [is] mandatory"** for Pages; `pages_build_output_dir` required; requires Wrangler
  ≥ 3.45.0 + V2 build system; once a Wrangler file is used it becomes the "source of
  truth" (dashboard bindings become read-only). `durable_objects` is a
  non-inheritable key (re-specify fully under any `[env.*]` override).
- **Pages Functions pricing**
  (`https://developers.cloudflare.com/pages/functions/pricing/`): Functions requests
  are billed as Workers requests and share the free-plan daily quota ("50,000
  Functions requests and 50,000 Workers requests to use your full 100,000 daily
  request usage"); "A request is considered static when it does not invoke
  Functions" — static asset requests are free/unlimited on all plans.
- **Pages Functions routing**
  (`https://developers.cloudflare.com/pages/functions/routing/`): file-based routes;
  `[[catchall]]` for any-depth; unmatched paths fall back to static assets;
  auto-generated `_routes.json` (≤100 rules, exclude beats include).
- **Community (secondary, flagged):** threads 312550 (Workers on paths served by
  Pages — practical answer: service bindings, not routes), 621315, 640862 (routes
  cannot be defined on `*.pages.dev`), plus multiple reports of zone routes being
  shadowed on custom-domain hostnames. Consistent with: routes-on-Pages-hostname is
  not a supported path.
- **Future direction** (`https://developers.cloudflare.com/workers/best-practices/workers-best-practices/`):
  "If you are starting a new project, use Workers instead of Pages. Pages continues
  to work, but new features and optimizations are focused on Workers." (Context for
  the recorded migration option; not acted on in v3.)

### Wrangler auth

- **Wrangler general commands** (`https://developers.cloudflare.com/workers/wrangler/commands/general/`):
  `wrangler login` "uses all the available scopes by default"; `--scopes` accepts a
  whitespace-separated list; `--scopes-list` enumerates; device-flow login added
  2026-08-04 (changelog); optional-scope chooser added 2026-08-22 (changelog). For
  this architecture the owner needs workers + account scopes only — **no zone
  scopes, because no zone routes are created** (a concrete simplification vs the
  routes design).

---

## Tradeoffs, risks, confidence

- **Tradeoff accepted:** the page's public attach moves from EventSource+POST
  (V2 bridge) to WebSocket — new page code (reconnect loop, two transports behind a
  small channel abstraction so `?bridge=` keeps the SSE+POST path, criterion ⑮).
- **Tradeoff accepted:** hand-rolled JSON-RPC instead of the blessed SDK — we own
  protocol-conformance edge cases, but they are already implemented and
  Inspector-verified in the bridge (RQ2), and the zero-dep acceptance rule plus SDK
  churn (McpAgent deprecated; v1→v2 migration) justify it. SDK remains the
  documented fallback.
- **Risks:**
  - Deploys drop all WebSockets ("Code updates disconnect all WebSockets") → page
    reconnect loop mandatory (also covers laptop sleep/network churn).
  - Free-tier daily caps hard-fail (not bill) at quota → monitor in V3-VERIFY ⑯;
    math says ~1% usage at demo scale, ~10% at 10× scale.
  - DO binding in the Pages project must reference an already-deployed Worker →
    deploy ORDER matters (wrangler deploy before the git push that carries the
    functions/ dir) — captured in the runbook delta.
  - Adding any zone Worker route on loom.arrangedgodly.com later could break the
    Pages custom domain (documented conflict) — record a "no zone routes on this
    hostname" invariant in the runbook.
  - Hibernation wipes in-memory state on idle → keep the DO stateless-per-request
    (attached socket registry is runtime-managed; pending calls only live during an
    in-flight /mcp request, which keeps the DO active by itself). Use
    `serializeAttachment` only if a tiny per-tab label is needed (16 KB cap).
  - Unverified detail (flagged): the exact TOML shape of a DO binding inside a
    Pages wrangler config is inferred from the documented mandatory `script_name`
    rule (no verbatim example on the page) — verify at first deploy; dashboard
    binding is the fallback.
- **Confidence:** HIGH on (a) and (b) (primary pricing/limits/websockets docs with
  exact quotes and arithmetic). HIGH on (d) (Pages Functions path fully documented;
  routes-on-Pages documented only as conflicting/absent). MEDIUM-HIGH on (c)
  (judgment call anchored by the plan's zero-dep acceptance criterion). HIGH on (e)
  (same-origin WS + spec Origin rules). MEDIUM on (f) local-dev nuances beyond the
  documented `--do` recipe (e.g., cross-port Origin handling is by-construction, not
  doc-cited).

---

## Implementation consequences

### V3-WORKER — endpoint structure (single file `mcp-worker.js`, zero deps)

- Worker `fetch(request, env)`:
  - `POST /mcp` → forward to DO singleton: `env.LOOM_CHANNEL.get(
    env.LOOM_CHANNEL.idFromName("loom")).fetch(request)`; also serve `GET /mcp`
    with era-correct 405 so V3-DEPLOY's public GET probe matches.
  - `GET /attach` → validate `Upgrade: websocket` (else 426) + `Origin` allowlist
    (prod: `https://loom.arrangedgodly.com`; dev: `http://localhost:*`) → forward to
    DO → return its 101.
- `LoomChannel extends DurableObject`:
  - `fetch`: route `/mcp` → the ported dual-era JSON-RPC handler (RQ2 semantics
    verbatim: modern headers validation + `-32020`/`-32022`, `server/discover`,
    `tools/list` (static 8-tool manifest, deterministic order, `ttlMs`/`cacheScope`,
    or the "page not attached" `-32000` error), `tools/call` → send
    `{type:"call",id,name,arguments}` over the attached socket, await matching
    result message, 5 s timeout → `isError: true` tool error; legacy `initialize`
    path; Origin check on this face too (403 invalid, absent allowed).
  - `/attach` → `new WebSocketPair()`; `this.ctx.acceptWebSocket(server)`; return
    101. **Attach is consent-gated:** nothing is registered until the first message
    `{type:"hello", tools:[…], optIn:true}` arrives; sockets that never hello are
    closed on a short alarm. One-driver: a new hello closes the previous driver
    socket; `webSocketClose` clears the slot; `webSocketMessage` routes
    `{type:"result", id, result|error}` to the pending call and `{type:"hello"}`
    as above.
- Tool manifest/schemas: copy the 8-tool registry from the bridge/RQ2 (get_state,
  set_rule, set_tempo, set_scale, reseed, set_volume, pause, resume) — static in the
  Worker, mirroring the page's Loom contract.

### V3-WORKER — `wrangler.toml` skeleton

```toml
name = "loom-channel"
main = "mcp-worker.js"
compatibility_date = "2026-04-07"   # >= this enables WS auto close-reply; later is fine
workers_dev = false                 # true only if a workers.dev probe URL is wanted

[[durable_objects.bindings]]
name = "LOOM_CHANNEL"
class_name = "LoomChannel"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["LoomChannel"]   # SQLite backend — required on Free plan
```

### V3-PAGE — attach-channel design deltas

- Public attach (opt-in AND `https://loom.arrangedgodly.com` origin only):
  `new WebSocket("wss://" + location.host + "/attach")`; on open send the hello
  (tools manifest + optIn signal); on message dispatch calls to the existing
  in-page registry; send results as `{type:"result", id, result}` over the socket.
  Hand-rolled reconnect: exponential backoff + jitter, only while opted-in;
  toggle-off / tab close → `ws.close()` and zero further attempts (criterion ⑭:
  default-off = zero network attempts).
- Keep the V2 SSE+POST transport for `?bridge=` (local Node bridge) — one channel
  abstraction, two transports; `file://` untouched; status-line states map 1:1
  (inactive / opted-in / attached / driver-active; add "reattaching" during
  backoff).

### V3-PAGE/V3-WORKER — local dev-test recipe (M9/M10)

1. Terminal 1: `npx wrangler dev` in the Worker dir → `http://localhost:8787`
   (real local workerd DO via Miniflare; WS hibernation works locally on current
   wrangler).
2. Drive `POST http://localhost:8787/mcp` with the RQ2 curl recipe + Inspector CLI
   (`npx -y @modelcontextprotocol/inspector --cli http://localhost:8787/mcp
   --transport http --method tools/list --format json`, etc.).
3. Page attach against local DO: serve the page from any static server (e.g.
   `python3 -m http.server`) and use the dev attach override
   (`ws://localhost:8787/attach`) — cross-port is fine for WS (no CORS); the DO's
   dev allowlist accepts `http://localhost:*` Origins.
4. Full-stack through the real Functions path: terminal 2
   `npx wrangler pages dev . --do LOOM_CHANNEL=LoomChannel@loom-channel` →
   `http://localhost:8788` (same-origin attach + /mcp via the forwarder; flag
   syntax per Pages bindings doc; CLI flags override the config file).
5. Limitations to respect: zone routes don't exist locally (irrelevant — none in the
   design); local DO state is Miniflare-local; test the Origin matrix explicitly
   (good Origin 200/101, bad Origin 403, absent Origin allowed on /mcp).

### V3-DEPLOY — runbook deltas (vs the plan's current wording)

- The plan's step 3–4 wording ("wrangler deploy" makes the "Worker own /mcp …
  route split") changes meaning: there is **no zone route**. New sequence:
  1. `npx wrangler login` (owner) — default all-scopes grant; only workers+account
     scopes are actually exercised; **no zone permissions needed**.
  2. `npx wrangler deploy` (creates the DO namespace via the `new_sqlite_classes`
     migration) — MUST precede the git push.
  3. Git push to main ships `index.html` + `functions/mcp/[[route]].js` +
     `functions/attach.js` + the Pages wrangler config carrying the DO binding
     (`script_name = "loom-channel"` mandatory for Pages). Pages auto-deploys;
     `_routes.json` auto-covers `/mcp*` and `/attach`; all other paths stay static.
  4. Verification (V3-DEPLOY + V3-VERIFY): public `GET /mcp` → era-correct 405/404;
     `POST /mcp` → JSON-RPC; bad `Origin` → 403; `/attach` without upgrade → 426;
     page byte-identical on all non-function paths; Inspector CLI over the public
     internet (criterion ⑬).
- Invariant to record: never create a zone Workers route (or Workers Custom Domain)
  on `loom.arrangedgodly.com` — documented to conflict with the Pages custom domain.

### V3-VERIFY — criterion ⑯ free-tier numbers (documented baseline)

- Quotas (Free): Workers+Functions 100,000 req/day shared; DO 100,000 req/day;
  DO duration 13,000 GB-s/day (= 101,562 s of active DO time at the billed 128 MB);
  DO rows 5M read / 100k write per day; static asset requests unlimited/free;
  incoming WS messages 20 ≈ 1 DO request.
- Measured-cost model to validate: each MCP POST = 1 Function request + 1 DO
  request; each attach = 1 + 1; each tool call additionally ≈ 2 WS messages ≈ 0.1
  DO request-equivalents; DO active only during request bursts (≤ ~1 s per call; 5 s
  worst case). Demo scale (50 sessions × 20 calls/day): ≈ 2,100 Function requests
  (2.1%), ≈ 2,160 DO request-equivalents (2.2%), ≈ 128 GB-s duration (1.0%). Even
  the worst case is bounded: duration supports ≥ 20,300 five-second calls/day before
  the 13,000 GB-s budget is spent — far above portfolio traffic. **Conclusion: the
  design is free-tier-viable with ~2% headroom-cushioned usage; no paid upgrade
  required; failure mode at cap is hard-fail-until-midnight-UTC, not a bill.**
- The explicitly rejected SSE alternative, for the record: one 24 h-attached tab via
  SSE ≈ 11,059 GB-s/day = 85.8% of the free duration budget → two tabs would
  hard-fail the endpoint. This is the number that decided (b).

---

## Decision priority and status

- **Priority:** P0 blocker for V3-WORKER (M9); shapes V3-PAGE transport, V3-DEPLOY
  runbook order, and V3-VERIFY ⑯ baselines.
- **Status:** DECIDED — DO-housed dual-era MCP server (hand-rolled port of the RQ2
  bridge, zero deps) + hibernating-WebSocket page channel + Pages-Function
  forwarders with DO binding; Workers Free tier throughout; no zone routes. Two
  flagged items for the coordinator: (1) V3-DEPLOY's step order changes (wrangler
  deploy BEFORE git push) and its "route split" verification is now
  Functions-based; (2) the Pages-config DO-binding TOML shape is inferred from the
  mandatory-`script_name` rule — confirm at first deploy (dashboard binding is the
  fallback).

---

## Delegation record

- Track: RQ3 (Cloudflare Worker + Durable Object architecture) — research subagent
  for **deep-research-supreme** (ultron-supreme line).
- Run date: 2026-08-28. Method: primary-source fetches of Cloudflare docs (Durable
  Objects pricing; Workers platform limits; DO WebSocket API + best-practices;
  Agents/MCP overview, remote-mcp-server guide, handler-API reference; Workers
  routes + custom domains; Pages known-issues, bindings, wrangler-configuration,
  functions routing/pricing, local development; Agents HTTP-SSE; Wrangler general
  commands), the `cloudflare/agents` `mcp-worker` example, plus targeted web
  searches for routes-vs-Pages coexistence (community threads flagged as secondary)
  and the Workers-over-Pages guidance. All quotes fetched 2026-08-28; doc dates
  recorded where shown.
