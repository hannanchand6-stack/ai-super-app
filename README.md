# AI Super App

A production-quality foundation for a multi-model AI chat platform
(OpenAI, Anthropic Claude, Google Gemini, xAI Grok, and future
providers). **Phase 1** built the architecture/backend/DB foundation.
**Phase 2** (this pass) built a full design system and app shell —
Chat, Create, Files, Projects, Research, Memory, Agents, Settings —
with real wiring where a backend exists (Chat, model status) and
honest "not available yet" states everywhere else.

## Routes

| Route         | Status                                                        |
|---------------|-----------------------------------------------------------------|
| `/`           | Dashboard — real provider status, honest empty states elsewhere |
| `/chat`       | **Fully functional**: real SSE streaming, persisted conversations (list/switch/rename/delete), against the mock AI provider |
| `/create`     | Designed UI (image/video/audio/game tabs), generation disabled — no provider wired |
| `/files`      | Designed UI, functional drag-drop *detection* only — no storage backend |
| `/projects`   | Designed UI, no persistence yet |
| `/research`   | Designed UI, no search tool wired into the orchestrator yet |
| `/memory`     | Designed UI, `Memory` table exists but nothing writes to it |
| `/agents`     | Designed UI, no execution runtime |
| `/settings`   | Appearance (theme) is fully functional; provider status is live; everything else is a designed, disabled placeholder |

## Stack

| Layer      | Choice                          | Why                                                              |
|------------|----------------------------------|-------------------------------------------------------------------|
| Framework  | Next.js 14 (App Router) + TS    | Unified frontend + API routes, strong TS support, easy to deploy |
| Styling    | Tailwind CSS                    | Fast, consistent, CSS-variable-based theming (dark/light)        |
| Database   | PostgreSQL via Prisma ORM       | Type-safe queries, migrations, easy schema evolution             |
| Auth       | NextAuth.js (Auth.js)           | Pluggable providers, first-class Prisma adapter                  |
| Validation | Zod                              | One library for both env-var and request validation              |
| Logging    | Pino                             | Structured logs with built-in secret redaction                   |
| Testing    | Vitest                           | Fast, TypeScript-native test runner                               |

## Phase 3 — real chat + streaming

`/api/chat` now persists every turn and streams responses over SSE:

- **Request shape**: `POST /api/chat` with `{ conversationId?, message, provider?, model?, stream? }`. `conversationId` omitted → a new conversation is created (titled from the first message). History is loaded server-side from the database, not resent by the client.
- **Streaming**: `stream: true` returns `Content-Type: text/event-stream` with `start` → `delta`* → `done` (or `error`) events. The client (`src/lib/api/stream-chat.ts` + `src/lib/api/parse-sse.ts`) reads the response body directly via `fetch` + `ReadableStream` (not `EventSource`, since that doesn't support POST bodies).
- **Stop generation**: aborting the client's `AbortController` aborts the `fetch`, which Next.js surfaces as `req.signal.aborted` in the route handler; the mock provider's `generateStream` checks that flag between chunks and stops. Whatever was generated so far is still persisted as the assistant message (never discarded).
- **Conversations**: `GET/POST /api/conversations`, `GET/PATCH/DELETE /api/conversations/[id]` — backed by `src/lib/conversations.ts`, which wraps the Prisma `Conversation`/`Message` tables.
- **Temporary auth bridge**: no sign-in provider exists yet (Phase 2 note still applies), so `getOrCreateDevUser()` upserts one fixed local user and every conversation is scoped to it. This is isolated in one function specifically so it's a one-line swap once real auth lands — see the comment in `src/lib/conversations.ts`.
- **CORS**: `src/middleware.ts` now actually enforces `CORS_ALLOWED_ORIGINS` on `/api/*` (it existed in config since Phase 1 but was never applied until now).
- **Provider currently connected**: only `mock` — it now streams real, word-by-word chunks of its own (non-fabricated, clearly-labeled) response. OpenAI/Anthropic/Gemini/Grok remain typed skeletons; `generateStream` is optional on `AIProvider`, so a real vendor can add true token streaming later, or omit it and the orchestrator transparently falls back to one-shot generation delivered as a single chunk.

## Phase 4 — real multi-provider AI integration

Four real providers are implemented against their actual vendor APIs via
plain `fetch` (no vendor SDKs — the REST surface is simple enough not to
need one, which keeps the dependency footprint small):

| Provider | Endpoint | Streaming | Notes |
|---|---|---|---|
| OpenAI | `api.openai.com/v1/chat/completions` | SSE (`data: {...}` → `data: [DONE]`) | Standard `role`/`content` messages |
| Anthropic Claude | `api.anthropic.com/v1/messages` | SSE (`content_block_delta` events) | `system` is a separate top-level field, not a message; `max_tokens` is required |
| Google Gemini | `generativelanguage.googleapis.com/v1beta/models/{model}:{generateContent\|streamGenerateContent}` | SSE via `?alt=sse` | Assistant role is `"model"`; system text goes in `systemInstruction` |
| xAI Grok | `api.x.ai/v1/chat/completions` | SSE, same shape as OpenAI | OpenAI-compatible API |

**Shared infrastructure** (so none of the above duplicate this logic):
- `src/lib/ai/http-client.ts` — `providerFetch()`: merges the caller's `AbortSignal` with an internal timeout, retries 429/5xx up to `PROVIDER_MAX_RETRIES` with exponential backoff + jitter (respecting `Retry-After`), never retries 4xx validation errors, and throws a `NormalizedProviderError` for every failure mode.
- `src/lib/ai/sse-reader.ts` — turns a `Response` into parsed SSE events, reusing the same pure parser (`src/lib/api/parse-sse.ts`) the client uses to consume `/api/chat`'s own stream.
- `src/lib/ai/provider.ts` — `NormalizedProviderError` + `ProviderErrorCode` (`PROVIDER_NOT_CONFIGURED`, `INVALID_API_KEY`, `RATE_LIMITED`, `PROVIDER_UNAVAILABLE`, `MODEL_UNAVAILABLE`, `REQUEST_TIMEOUT`, `REQUEST_ABORTED`, `INVALID_REQUEST`, `UNKNOWN_PROVIDER_ERROR`) with a friendly message per code; `httpStatusToProviderErrorCode()` maps vendor HTTP status → code, shared by all four adapters.
- `src/lib/ai/orchestrator.ts` — normalizes every adapter's errors into the app's `ProviderError` (preserving the code in `details.code`) and records usage after every request, success or failure.
- `src/lib/ai/usage.ts` + `src/lib/ai/pricing.ts` — foundation for future cost/credits tracking (see below).

**Provider status & model selector**: `GET /api/models` now returns, per provider, `configured`, `models` (always returned, even unconfigured — the UI shows and disables them rather than hiding them), and `capabilities` (`{ streaming, cancellable }`). The model selector (`src/components/ModelSelector.tsx`) reads this live, lets you pick any *configured* model, and persists the choice via `src/lib/selected-model.ts` (localStorage + a custom event — chosen over React Context since the selector and the chat page that consumes the selection don't share a subtree). The chat page now sends the actually-selected `provider`/`model` instead of a hardcoded `'mock'`.

**Usage/cost foundation**: every `orchestrator.generate()`/`generateStream()` call logs and best-effort persists a `UsageRecord` row (provider, model, prompt/completion tokens, duration, success/failure) via `src/lib/ai/usage.ts`. `src/lib/ai/pricing.ts` holds a small, explicitly-labeled-as-illustrative per-model pricing table and an `estimateCostUsd()` helper that returns `null` rather than guessing for any unlisted model — nothing here is wired into a user-facing cost display yet, it's the data layer for one.

### Configuring a real provider

1. Get an API key from the provider's dashboard (OpenAI, Anthropic Console, Google AI Studio, or the xAI console).
2. Set it in `.env` — e.g. `OPENAI_API_KEY=sk-...`.
3. Optionally override `OPENAI_MODEL` / `ANTHROPIC_MODEL` / `GEMINI_MODEL` / `XAI_MODEL` to pick a specific model.
4. Restart the dev server. The provider now shows "Ready" in the model selector and Settings → AI models & providers.

No key configured → the provider still appears (so you can see what exists), marked unavailable, and cannot be selected. Selecting it and sending a message would surface `PROVIDER_NOT_CONFIGURED` as a normal, friendly in-chat error — never a fake response.

### Security notes specific to Phase 4

- Every provider key is read only via `getConfig()` on the server; no provider file is ever imported by client components.
- API keys are sent as `Authorization: Bearer` (OpenAI/xAI), `x-api-key` (Anthropic), or `x-goog-api-key` (Gemini) headers — never as URL query parameters, so they can't end up in server access logs.
- `NormalizedProviderError` never carries the raw vendor response body (which can echo back request content) — only a status-derived code and a generic message.
- `src/lib/logger.ts`'s redaction list already covers `*.apiKey`/`*.OPENAI_API_KEY`/etc., so even an accidental `logger.info({ config })` won't leak a key.

### Provider limitations (honest, as of this implementation)

- **None of the four real providers have been called against the real network** — this sandbox has no network access. Everything below "Tests run" was verified by reading the code, an offline TypeScript syntax pass, and unit tests against mocked `fetch`. Real API behavior (exact error body shapes, rate-limit headers, streaming edge cases) can differ from what's implemented here and should be verified against a live account before production use.
- Model id strings (`gpt-4o-mini`, `claude-3-5-haiku-20241022`, `gemini-1.5-flash`, `grok-2-latest`) are current as of when this was written — vendors version and retire models; check each provider's current list.
- Usage token counts are only as accurate as what each vendor's streaming API reports — OpenAI/Anthropic/Gemini can be asked to include usage in the final stream event, but this implementation currently only captures usage on the non-streaming path (`generate()`); streaming responses record `0`/`0` tokens rather than estimating.
- Retry backoff uses real timers (not configurable to be instant), so a request against a consistently-429ing provider will take several seconds to fail.

## Phase 5 — AI Router, smart model selection & multi-model synthesis

`src/lib/ai/router.ts` (`AIRouter`) sits between `/api/chat` and the orchestrator:

```
Frontend → /api/chat → AI Router → AI Orchestrator → Provider Adapter → AI Provider
```

It contains no provider-specific HTTP code — every call goes through the orchestrator, so it works identically against the real registry or a fully mocked one in tests.

**Modes** (`mode` field on `/api/chat`, defaults to `manual`):
- **Manual** — uses exactly the `provider`/`model` given; validated against the allowlist and what that provider actually offers.
- **Auto** — `src/lib/ai/classifier.ts` heuristically classifies the message (coding/math/summarization/vision/long-context/…) using keyword/pattern matching — **never an extra AI call**, so Auto mode costs nothing extra in latency or tokens. Real providers are preferred over `mock` (which is dev/test-only, per Phase 4's own rule) unless mock is the only thing configured. Low-confidence classifications fall back to `ROUTER_DEFAULT_PROVIDER`/`MODEL` rather than trusting a shaky guess.
- **Compare** — runs the same message against 2+ explicitly chosen models concurrently (`Promise.allSettled`), returns every result (or per-model error) as one JSON response. **Not streamed** (there's no single "the" response to stream) and **not persisted** into the conversation thread yet — see the scope note below.
- **Synthesize** — runs Compare internally, then streams a combined answer from a configured synthesis model, built from a prompt that only contains the real, labeled source responses (`buildSynthesisMessages` — never fabricates content). Sources are sent as a `sources` SSE event before the synthesized answer starts streaming; only the synthesized answer is persisted as the turn's reply.

**Capability matching**: `ProviderCapabilities.visionInput` is `false` for every adapter today (none of them build multimodal request bodies yet). Auto mode genuinely enforces this — a message the classifier flags as needing vision, with zero vision-capable providers configured, throws `NoCompatibleModelError` (`NO_COMPATIBLE_MODEL`, HTTP 422) rather than silently answering as if an image had been seen.

**Fallback**: gated by `ROUTER_FALLBACK_ENABLED` (default on). If the primary model fails *before producing any output*, the router tries up to `ROUTER_MAX_FALLBACK_ATTEMPTS` other configured, allowed models. Once any real content has streamed to the user, a later failure is **never** retried — the partial output is real and shouldn't be silently discarded or duplicated by restarting (same principle as Phase 3's stop-generation handling). Never retries after a genuine user abort (`REQUEST_ABORTED`).

**Routing configuration** — centralized in `src/lib/config.ts`, nothing hard-coded: `ROUTER_DEFAULT_PROVIDER`/`MODEL`, `ROUTER_AUTO_ENABLED`, `ROUTER_FALLBACK_ENABLED`, `ROUTER_MAX_FALLBACK_ATTEMPTS`, `ROUTER_COMPARE_MAX_MODELS`, `ROUTER_SYNTHESIS_PROVIDER`/`MODEL`, `ROUTER_ALLOWED_PROVIDERS` (comma-separated allowlist, empty = no restriction), `ROUTER_COST_PREFERENCE` (`cheap`/`balanced`/`quality`).

**Cost awareness**: Auto mode's `cheap` preference sorts candidates by `estimateCostUsd()` from Phase 4's pricing table (unknown-pricing models sort last, never guessed). `quality` sorts by context window as an explicitly-labeled *heuristic proxy only* — this codebase makes no claim that any model is objectively smarter, per the spec's own instruction.

**Routing transparency**: every response includes a `decision` object — `{ mode, provider, model, reason, fallbackFrom?, classification? }` — sent as part of the `start`/`done` SSE events (streaming) or the JSON body (non-streaming). `reason` is a short, user-safe string (e.g. *"Classified as 'coding' (confidence 0.75)"*) — never raw chain-of-thought.

**Security**: provider/model allowlisting (`ROUTER_ALLOWED_PROVIDERS`) is enforced server-side in `resolveManual`/`listCandidates` — a client can't request a model outside it no matter what the UI sends. Compare/Synthesize are capped at `ROUTER_COMPARE_MAX_MODELS` (default 4) server-side, validated before any request fires, so a crafted request can't fan out unlimited provider calls.

**Scope note — Compare/Synthesize persistence**: per-candidate Compare results are *not* written as `Message` rows — the existing schema/UI assume one linear reply per turn, and writing N assistant messages per turn would break that model. Compare results are returned to the client and shown as a local-only "Compare results" card (`src/components/CompareBlock.tsx`) that **does not survive a reload** — clearly labeled "Not saved" in the UI. Synthesize's *sources* are the same (shown, not persisted); only its final synthesized answer is a real, persisted `Message`. Making Compare/Synthesize fully part of conversation history is flagged as Phase 6 work.

**Usage/cost tracking**: every `AIRouter` call ultimately goes through `orchestrator.generate()`/`generateStream()`, which already records a `UsageRecord` row per Phase 4. Routing-specific metadata (mode, fallback occurrence, classification) is captured in structured logs (`log.info(...)`/`log.warn(...)` in `/api/chat/route.ts`) rather than added as new `UsageRecord` columns — extending that table would need a migration this sandbox can't run against a real database to verify, so it's deliberately left as a documented Phase 6 step instead of an unverified schema change.

### What was and wasn't actually run

- **Network is categorically blocked in this sandbox**, not just the npm registry — confirmed via direct `curl` to unrelated hosts (`x-deny-reason: host_not_allowed` from the egress proxy). `npm install`/`npm test` cannot run here. One exception was found and used honestly: `api.anthropic.com` happens to be reachable through this proxy (the other three provider hosts are not). With no real API key, a request to `POST /v1/messages` with a deliberately invalid key was made for real — it returned a genuine `401` with `{"type":"error","error":{"type":"authentication_error",...}}`, confirming the endpoint path, the `x-api-key`/`anthropic-version` header names, and the `401 → INVALID_API_KEY` mapping against the real live API. That's the one piece of this whole project verified against a real vendor over the network; everything else about all four providers remains unverified beyond static checking.
- **47 assertions genuinely executed** with `tsx`/plain `node` (no `node_modules` needed) across `http-client`, `provider` error-normalization, `parse-sse`, `MockProvider`, the classifier, and — this pass — the boolean-env-var parser. This caught **three real bugs before they shipped**:
  1. (Phase 3) A race condition in the chat page's URL-change effect.
  2. (Phase 5, previous pass) `classifyTask`'s `long_context` override only fired for `category === 'general'`, never the `'writing'` fallback that plain long text actually hits.
  3. (Phase 5, this pass) **`z.coerce.boolean()` on `ROUTER_AUTO_ENABLED`/`ROUTER_FALLBACK_ENABLED` coerces via `Boolean(value)`, and `Boolean("false")` is `true`** — a well-known Zod gotcha. Setting either to `false` in a real `.env` file would have silently been ignored. Found by manually tracing the "does not fall back when ROUTER_FALLBACK_ENABLED=false" test case against the implementation (since the test itself couldn't be executed), verified with a standalone Node script confirming the exact failure mode and the fix, and replaced with a correct string-based parser (`booleanEnvVar()` in `src/lib/config.ts`). A regression test now lives in `tests/config.test.ts`.
- **A fourth bug was found by manual trace and fixed**: `resolveAuto`'s low-confidence fallback checked `ROUTER_DEFAULT_PROVIDER` against the raw orchestrator instead of the already-capability/mock-filtered candidate pool — since that default is `"mock"`, every low-confidence message would have routed to `mock` even when a real provider was configured, silently defeating the "prefer real providers over mock" rule. Traced against the "prefers real providers over mock" test case, fixed by checking membership in the filtered `pool` instead.
- **`AIRouter`'s full logic (manual/auto/fallback/compare/synthesize), the four provider adapters, and every Vitest test file**: statically checked (0 genuine syntax errors via `tsc --noResolve`) and manually traced line-by-line against `tests/router.test.ts`'s 26 cases (the two bugs above were found this way) — but never executed, and no assertion beyond the two bugs found should be treated as "verified" rather than "reasoned through by hand." Run `npm install && npm test` yourself for real confirmation.

## Phase 6 — files, PDFs, image understanding, image generation, games

**Files** (`/api/files`, `src/lib/files/*`): multipart upload → `validateUpload()` (type allowlist: .txt .md .csv .json .pdf .png .jpg .webp .gif; 20 MB, 8 MB for images; rejects path separators/traversal in filenames) → **content sniffing** (`sniffImageSignature` / `sniffIsPdf` check real magic bytes, so a renamed file claiming to be a PNG/PDF is rejected — declared MIME types are never trusted alone) → `storeFileBytes` (server-generated UUID path; the client filename is display metadata only, and `readStoredFile` refuses any path escaping `UPLOAD_DIR`) → `extractText` (plain text decode; PDFs via `pdfjs-dist`'s Node "legacy" build) → a `File` row (new nullable `extractedText` column). `GET /api/files/:id/raw` serves bytes back for previews. **Storage is local disk** (`UPLOAD_DIR`) — real, but development-grade; swap `storage.ts` for S3-compatible storage before production (nothing above it changes). DOCX is deliberately not supported rather than half-supported.

**Attaching files to chat**: the composer's paperclip (and drag-drop) uploads immediately with per-file progress/error chips and blocks Send while uploading; `attachmentIds` go in the chat turn. Text/PDF content is appended to *that turn's* outgoing prompt only; images are base64-attached to the outgoing user message. Attachment content is **not** persisted into stored message text and is not automatically re-attached on later turns (no message↔file relation exists yet).

**Vision**: `ChatMessage.images` + model-level `ProviderModelInfo.supportsVision`. OpenAI (`image_url` data URLs), Anthropic (`image` base64 source blocks), Gemini (`inlineData` parts) and Grok (OpenAI-compatible `image_url`) adapters each build their vendor's real multimodal shape — and only when images are present, so text-only requests are byte-for-byte unchanged. `supportsVision` is `true` for the curated OpenAI/Anthropic/Gemini models and **`false` for Grok** (I'm not confident `grok-2-latest` accepts images, so the code path exists but the model isn't advertised). Enforcement: Auto mode treats a real attachment as a hard requirement (stronger than the keyword classifier) and errors with `NO_COMPATIBLE_MODEL` if nothing qualifies; Manual mode rejects a non-vision model with a clear message instead of silently switching; **Compare/Synthesize and fallback pools also only use vision-capable models when an image is attached** (a gap found by tracing, fixed and tested). `MockProvider` acknowledges images honestly ("received N image(s), does not analyze") so the pipeline is testable with no key.

**Image generation** (`/api/images/generate`, `src/lib/ai/image-provider.ts`, `image-orchestrator.ts`): a separate abstraction from text chat, with one real adapter — OpenAI's `/v1/images/generations` (`OPENAI_IMAGE_MODEL`, default `dall-e-3`), reusing the same timeout/retry/error-normalization as text. Unconfigured → the UI says so and disables Generate; failures show the real error — never a placeholder image. Gemini/xAI image endpoints aren't implemented.

**Video** (`video-provider.ts`, `video-orchestrator.ts`, `/api/videos/generate`): interface and route exist; **zero adapters** — I don't have confident knowledge of a general-access video API from the four configured providers, and guessing a request shape would ship something that looks real but isn't. The Create → Video tab says exactly that.

**Games** (`/api/games/generate`, `src/lib/games/*`): a real call through the existing text router asking a model to write one self-contained HTML5 game; the reply must actually contain an HTML document or it's rejected (so the mock provider — which isn't a game generator — honestly fails rather than faking a game). Preview is an `<iframe sandbox="allow-scripts">` (no same-origin) with an injected restrictive CSP (`default-src 'none'`) as defense in depth; download is the `.html` file. **Nothing is compiled, deployed, or hosted**, and the CSP/sandbox is layered mitigation, not a proof of safety.

**Requirements**: `pdfjs-dist@5` declares Node `>=20.19`, so `engines` now says so (it previously said 18.18 — that mismatch was found this phase and fixed).

### Phase 6 verification, honestly
- **Genuinely executed** (tsx/node, no npm install): file validation incl. magic-byte checks (18), real-disk storage incl. traversal defense (5), **text extraction against a real 26-page PDF** (4), game HTML extraction (6) and preview CSP/filename helpers (8) — plus all earlier suites (93 assertions total across 10 scripts, all passing).
- **Written + statically checked + hand-traced, never executed** (need `zod`/`next`/`@prisma/client`, unavailable offline): `/api/files*`, `/api/images/generate`, `/api/games/generate`, the chat route's attachment handling, all four providers' multimodal bodies, router vision enforcement, and every new Vitest file (`multimodal`, `files`, `storage`, `image-provider`, `games`, updated `router`/`models-route`). Two of my own earlier tests were found stale/broken by this phase's changes (model-level vision; mock capabilities) and fixed by reading, not by running.
- **Never verified against any real API**: every provider's image format, OpenAI image generation, and all vision behavior. Requires real keys + network.
- PDF extraction was verified via a Node symlink to a globally-installed `pdfjs-dist` because `npm install` is blocked; in-project resolution after a real install is expected but unconfirmed.

## Phase 7 — web research + citations

**Pipeline** (`src/lib/research/pipeline.ts`, `/api/research`): search → fetch each result page (SSRF-safe, bounded time/size, concurrent) → extract readable text → ask a real model to answer using **only** the numbered sources, with inline `[n]` citations → validate every citation against the real source list. A source that couldn't be fetched still appears, `fetched: false`, using the search snippet as its text — never dropped silently, never backfilled with invented content.

**Search providers** (`src/lib/research/providers/*`): real adapters for **Brave Search** and **Tavily**, built the same way as Phase 4's text providers — plain `fetch`, `providerFetch` for retry/timeout, request shapes verified against each vendor's current API docs via live web search this session (not from training memory). Neither has been called with a real key; see verification notes below. `SEARCH_PROVIDER` selection happens per-request, with recency support (`freshness`: day/week/month/year) mapped to each provider's own parameter.

**Page fetching** (`src/lib/research/fetch-page.ts`) is hand-rolled on `node:http`/`node:https` rather than built on `fetch()`, specifically to close a gap `fetch()` can't: **DNS-rebinding-safe SSRF protection**. `url-safety.ts` blocks loopback/private/link-local/CGNAT/multicast/reserved ranges and encoding tricks (decimal/hex/octal IPv4, IPv4-mapped/NAT64/6to4 IPv6) for both the initial URL *and* every redirect hop; `fetch-page.ts` re-validates at **connect time** via a custom DNS `lookup`, so a hostname that resolves differently between the check and the connection (rebinding) is still caught — checking once up front and trusting `fetch()` to resolve again later would not have closed that gap. Also bounded: request timeout, decoded response size (protects against gzip/deflate/brotli bombs — the cap applies post-decompression), redirect count, and a content-type allowlist (HTML/text/PDF only). Errors are mapped to a fixed set of friendly, non-technical messages — no stack traces, hostnames, or internals ever reach the client.

**Content extraction** (`extract-content.ts`): a small self-contained regex/entity-decode HTML→text function (not a full DOM parser — installing an HTML-parsing package wasn't something I could verify working in this sandbox, and this isn't a security boundary since the page was already fetched read-only). PDFs reuse Phase 6's `pdfjs-dist` extraction, already proven against a real file.

**Citations** (`citations.ts`): `[n]` markers are extracted and checked against the real 1-based source list — `validIds`, `invalidIds` (fabricated citation numbers — shown to the user as a warning, not hidden), and `uncitedSourceIds` (real sources the model didn't reference — also shown, so nothing found is buried). The UI renders `[n]` as small linked badges jumping to the matching source card; an invalid one renders in a warning color rather than silently looking legitimate.

**Source comparison**: the synthesis prompt explicitly instructs the model to note disagreement between sources rather than silently pick one; independently, every source card (title, domain, date/age, fetched-or-snippet status, direct link) is shown regardless of what the answer says, so a user can compare them directly without trusting the synthesis alone.

**UI** (`/research`): question + provider + recency controls, real loading/error states, the cited answer, and numbered source cards. Unconfigured (no `BRAVE_SEARCH_API_KEY`/`TAVILY_API_KEY`) shows a plain, honest notice — not a disabled fake button.

**Security**: rate-limited like every other route; `BRAVE_SEARCH_API_KEY`/`TAVILY_API_KEY` are server-only; SSRF protections above; PDF/HTML parsing failures degrade to "use the snippet" rather than crashing the request.

### Phase 7 verification, honestly
- **Genuinely executed** (`tsx`/`node`, no npm install): `url-safety.ts` (68 assertions — every private/reserved IPv4+IPv6 range, every URL-obfuscation trick), `fetch-page.ts` (22 assertions **against a real local HTTP server** — real gzip/brotli decoding, a simulated 5 MB gzip bomb capped correctly, a real redirect loop, a real stalled connection timing out, and **simulated DNS rebinding to a private address correctly blocked at connect time with the real server confirmed never contacted**), `extract-content.ts` (7), `citations.ts` (7). 104 assertions total this phase, all passing — full command history and scripts are reproducible from this conversation.
- **A real, live web search was used to verify the Brave and Tavily API shapes** (endpoint, params, auth header, response fields) against each vendor's current documentation before writing the adapters — not from training memory, which can be stale for API details. This is a first for this project: previous phases' provider work was written from memory alone.
- **Written + statically checked + mocked-fetch tested, never executed** (need `zod`/`next`/`@prisma/client`): both search provider adapters, the full pipeline (mocked search/fetch/router — source numbering, snippet-fallback-on-fetch-failure, citation checking, `maxSources` capping all covered), and `/api/research`.
- **The Vitest copy of the `fetch-page` suite is the same server setup and assertions as the genuinely-executed script** — very high confidence it passes once `npm test` can run, though it hasn't been run through Vitest itself here.
- **Never verified**: an actual Brave or Tavily API call, or a fetch against the real public internet (only a local test server was reachable for real HTTP verification — see fetch-page above). Requires real keys + network.

## Phase 8 — memory & personalization

**Storage**: the `Memory` model (Phase 1) plus a new `User.memoryEnabled` boolean (default on). Every write — manual or automatic — goes through `checkSensitiveContent()` first (`src/lib/memory/sensitive-filter.ts`): password/API-key/private-key/SSN/CVV phrases, and credit-card-shaped numbers that actually pass the Luhn checksum (so ordinary digit runs like phone/order numbers aren't false-flagged). A blocked save throws a clear error — nothing is silently stripped-and-saved.

**Personalization**: enabled memories are prepended to the model's context as a system message before each manual/auto chat turn (`src/app/api/chat/route.ts`) — never injected into the stored message content, so it doesn't bloat what's persisted or shown in the transcript.

**Auto-extraction**: after a manual/auto turn completes, a real call through the existing text router (`src/lib/memory/extract.ts`, configurable via `MEMORY_EXTRACTION_PROVIDER`/`MODEL`) proposes durable facts, one per line; each still passes through the same sensitive-content filter before saving. Fire-and-forget — never blocks or can fail the chat response already sent to the user. Scoped to manual/auto only, not Compare/Synthesize.

**Settings & controls** (`/memory`, `/api/memory*`): enable/disable toggle, search, add/edit/delete, clear-all with a confirmation dialog. `offTheRecord` on a chat turn skips extraction for that one turn even with memory enabled overall.

**Tests — genuinely executed** (`tsx`, no npm install): `sensitive-filter.ts` (13 assertions, including the Luhn-validity distinction) and `parse-facts.ts` (7 assertions), both dependency-free. **Written + statically checked, not executed**: `records.ts` (mocked Prisma), `extract.ts` (mocked router), the API routes.

## Phase 9 — authentication & security

**Real auth, without breaking anonymous use**: `getCurrentUser()` (`src/lib/auth/current-user.ts`) returns the real signed-in user when a session exists, and falls back to the same dev-user bridge every phase since Phase 3 has used otherwise — so Phases 1–7's "works with zero setup" behavior is unchanged, while a real account now gets genuinely isolated conversations/files/memory/usage (every data-access module was switched from the raw dev-user bridge to this function). `requireCurrentUser()` is the opposite: it throws (401) rather than falling back — used by the one route that should actually require login, `/api/account`, to demonstrate real route protection end-to-end. Session-check failures fail *open* in `getCurrentUser` (degrade to anonymous rather than break chat) and fail *closed* in `requireCurrentUser` (treated as unauthenticated, never a 500) — different defaults for different risk directions, both deliberate.

**Password security**: `src/lib/auth/password.ts` uses Node's built-in `scrypt` (no bcrypt/argon2 package needed or installable here) — real random salt per hash, OWASP-minimum cost parameters, constant-time comparison, Unicode-normalized input. `checkPasswordStrength()` rejects common passwords even with trailing digits ("password123") via a strip-and-check approach, not just an exact-match list (an exact-match-only version was tried first, genuinely executed, and found to miss exactly this case — now fixed).

**Sign-up/login/logout**: `/signup` → `POST /api/auth/signup` (real uniqueness check, real strength check, real hash — never stores or compares plaintext) → auto sign-in. `/login` → NextAuth's `CredentialsProvider`, checked against `password.ts`. Both give the same generic "incorrect email or password" either way (not "no such account" vs "wrong password") — login can't be used to enumerate which emails have accounts. Logout via `AccountButton` (`signOut()`), shown in both the desktop sidebar and mobile nav with real session state (`useSession`).

**Rate limiting**: login attempts are limited per-email (5 per 15 minutes) independent of the general per-IP API limit (`checkLoginRateLimit`, `src/lib/rate-limit.ts`) — this is what actually slows down guessing against one account specifically.

**CSRF**: `src/lib/auth/csrf.ts` checks `Origin` (falling back to `Referer`) against the request's own origin for every state-changing method on our own API routes, wired into `src/middleware.ts` ahead of the existing CORS logic. NextAuth's own routes (`/api/auth/*`) are exempt — they manage their own CSRF token independently. This is a second, independent layer alongside NextAuth's SameSite=Lax session cookie, not a replacement for it.

**Security logging**: `src/lib/security-log.ts` writes to both the structured app log and a new `SecurityEvent` table for `login_success`/`login_failure`/`signup`/`logout`/`rate_limited` — every call site passes only `userId`/`email`/`ip`, so there is no password/token field that could ever be logged by mistake, by construction.

**Input validation / database security**: signup/login use dedicated Zod schemas (`src/lib/auth/validation.ts`); every other route already used Zod validation since earlier phases. Prisma parameterizes every query by default — there is no raw SQL string concatenation anywhere in this codebase (checked).

**Tests — genuinely executed** (`tsx`, no npm install): `password.ts` (17 assertions, including a real hash/verify round trip, Unicode normalization, and malformed-input handling — this is where the `password123` gap above was actually caught), `csrf.ts` (14 assertions, including spoofing attempts like origin-prefix and subdomain tricks). **Written + statically checked, not executed**: `current-user.ts` (mocked `next-auth`/Prisma — covers real-session / dev-user-fallback / deleted-account / session-check-failure cases), the signup route (mocked Prisma — confirms a weak password never reaches the database, and the stored value is a real `scrypt:` hash, never plaintext), rate-limit's login-specific bucket, and security-log.

### A circular-import bug found and fixed while wiring this up
Making every data-access module call the new `getCurrentUser()` created a cycle: `current-user.ts` needed `conversations.ts`'s dev-user bridge, and `conversations.ts` needed `current-user.ts`. Fixed by extracting the dev-user bridge into its own leaf module (`src/lib/auth/dev-user.ts`) that both depend on without depending on each other — `conversations.ts` still re-exports `getOrCreateDevUser` from there for backward compatibility with existing imports.

### Phase 8/9 verification, honestly
- **132 assertions genuinely executed this session** (`tsx`/`node`, no npm install) across the sensitive-content filter, fact parsing, password hashing, and CSRF origin-checking — all passing, two real bugs caught and fixed in the process (the `password123` gap, and a mis-written test using the wrong Unicode combining character, both described above).
- **Everything touching Prisma, NextAuth, or the AI router** (memory records/extraction, `current-user.ts`'s session resolution, the signup route, both auth pages, the chat route's memory wiring) is **written, statically checked (0 genuine syntax errors), and — for the database-touching pieces — mocked-Prisma tested**, but never actually executed, for the same reason as every prior phase: `npm install` is blocked in this sandbox (no network).
- **Never verified**: a real login/signup flow end-to-end in a browser, NextAuth's session cookie behavior in practice, or CSRF protection against a real cross-origin request. These need `npm install && npm run dev` in an environment with real network access.

## Phase 10 — membership, pricing & subscriptions

**Plans** (all in ONE file, `src/lib/membership/plans.ts` — names, prices in integer cents, per-feature limits, benefit text, Google Play product ids): Free $0/month · Pro $4.99/month · Pro Yearly $49.99/year · Premium $9.99/month · Premium Yearly $99.99/year. The "Save 17%" badge and "$4.17/month" figure are *computed* from those prices. Rename Premium → Ultimate by editing one `name` field.

**Limits are placeholders.** The spec fixed plans/prices/benefits but not numbers; the values in `TIER_CONFIG[...].limits` (e.g. chat 20 / 200 / 1000 per day; images 5 / 100 / 400 per month) are my defaults. Tune them to your real provider costs.

**Entitlements are enforced on the server.** `src/lib/membership/service.ts` is called by `/api/chat`, `/api/images/generate`, `/api/videos/generate`, `/api/games/generate` and `/api/research` *before* any provider call; over the limit → HTTP 429 `USAGE_LIMIT_REACHED` with plan/usage details, which the UI turns into an upgrade prompt (`UpgradePrompt`). Hiding buttons changes nothing. Design points: counters are reserved with an atomic increment (so concurrent requests can't exceed the limit) and **refunded if the request fails**; access is derived from a server-side `Subscription` row by pure, fail-closed rules (`rules.ts`: unknown status/tier/missing expiry/expired ⇒ Free; lapses on its own at `currentPeriodEnd`); Compare/Synthesize use their own `multiModel` allowance; video is limit-enforced but labelled "Coming soon" because no video provider exists. Free users hitting a feature their plan lacks (video) get "needs an upgrade".

**Billing architecture** (`src/lib/billing/`): provider interface + `GooglePlayBillingProvider` (server-side verification via Google's `purchases.subscriptionsv2.get`, service-account OAuth, fail-closed mapping, purchase bound to the account through the obfuscated account id) + a **development-only** `MockBillingProvider` (needs `BILLING_MOCK_ENABLED=true`, impossible when `NODE_ENV=production`, rows labelled "Test subscription", never counted as paid in production). No fake payment success exists. The web UI talks to a native Android shell through `window.NativeBilling` (`client-bridge.ts`): launch purchase → send token to `/api/membership/purchase` → server verifies → *then* acknowledge. Restore = re-verify device purchases (`/api/membership/restore`). Secrets (`GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`) are server-only and never in client code/APK; purchase tokens are never returned by any API.

**UI**: `/membership` (current plan, status, renewal, monthly/yearly toggle, plan cards, comparison table, restore, manage subscription), top-bar Upgrade/badge pill, sidebar link, Pro/Premium badge next to the account name, Settings → Membership + live "Usage remaining". Routes: `GET /api/membership`, `POST /api/membership/purchase|restore|mock-cancel`.

**Schema change — you must migrate:** new `Subscription` and `FeatureUsage` tables → run `npm run db:migrate` (or `db:push`).

### Phase 10 verification, honestly
- **Executed** (tsx + a minimal vitest shim, no `npm install` possible here): 37 assertions over `plans`, `rules`, `usage-core` (incl. 50 concurrent requests never exceeding a 20 limit, refunds) and `describe` — all passing (one failure was a bug in my own test, fixed). Server-rendered the plan cards/comparison/current-plan/upgrade prompt: all five prices render as specified.
- **Static**: 0 broken imports across 190 files; offline `tsc` shows no real errors in billing/membership/route files (remaining output is missing-`node_modules` noise).
- **Written, never executed**: `tests/membership/google-play.test.ts` (needs Vitest mocks), Prisma-backed store/service, the API routes, all React pages, `next build`. Run `npm install && npm run typecheck && npm test && npm run build`.
- **Never verified**: any real Google Play call (API shape was checked against Google's docs, not a live account); the Android bridge (no Android project or APK exists — **no APK was built**); `Subscription` upsert behaviour on a real database.
- **Known gaps**: no Play Real-time Developer Notifications webhook yet (status updates when the app restores/re-verifies, and access lapses at expiry regardless); anonymous visitors share one Free quota (the dev-user bridge) — require login in production; `priorityProcessing` is a flag only (no provider priority tier is wired); one subscription row per user (highest active plan wins).

## Design system

`tailwind.config.ts` + `src/app/globals.css` define the tokens (color,
type, radius, shadow, motion) — see the design plan in-conversation for
rationale. Reusable primitives live in `src/components/ui/`: Button,
Input, Textarea, Select, Card, Badge, Tabs, Tooltip, Modal, Toast,
Skeleton, EmptyState, ErrorState, ComingSoon. Import from
`@/components/ui` (barrel export) or the individual file.

`EmptyState` = "no data yet" (an honest empty list). `ComingSoon` =
"this whole workspace has no backend yet" (a labeled placeholder panel).
Both are used deliberately rather than faking content.

## Folder structure

```
ai-super-app/
├── src/
│   ├── app/
│   │   ├── page.tsx                # Chat UI (empty state, no fake AI replies)
│   │   ├── layout.tsx
│   │   ├── globals.css             # Theme tokens (light/dark)
│   │   └── api/
│   │       ├── health/route.ts     # GET /api/health
│   │       ├── models/route.ts     # GET /api/models
│   │       ├── chat/route.ts       # POST /api/chat
│   │       ├── auth/[...nextauth]/route.ts
│   │       └── _lib/handle-error.ts
│   ├── components/                 # Sidebar, ChatArea, MessageInput, ModelSelector, TopBar, ThemeProvider
│   ├── lib/
│   │   ├── config.ts               # Centralized, validated env config
│   │   ├── logger.ts                # Redacting structured logger
│   │   ├── errors.ts                # AppError + typed subclasses
│   │   ├── db.ts                    # Prisma client singleton
│   │   ├── rate-limit.ts            # Rate-limit architecture (in-memory placeholder)
│   │   ├── auth/config.ts           # NextAuth options (no providers wired yet)
│   │   ├── validation/chat.ts       # Zod request schemas
│   │   └── ai/
│   │       ├── provider.ts          # AIProvider interface (the core abstraction)
│   │       ├── orchestrator.ts      # Provider registry + routing
│   │       └── providers/           # mock, openai, anthropic, gemini, grok adapters
│   └── types/index.ts
├── prisma/schema.prisma            # Users, Sessions, Conversations, Messages, Files, Memories, ProviderConfig, UsageRecord
├── tests/                          # Vitest suite
├── .env.example
└── package.json
```

## Architecture

```
Frontend (React/Next.js)
   ↓  fetch('/api/chat')
API Route (src/app/api/chat/route.ts)
   ↓  validates request (Zod), checks rate limit
AI Orchestrator (src/lib/ai/orchestrator.ts)
   ↓  picks provider by id, checks isConfigured()
Provider Adapter (src/lib/ai/providers/*.ts)
   ↓  implements the AIProvider interface
AI Provider (vendor SDK — Phase 2)
```

The frontend never imports a provider adapter directly, and adapters never
know about Next.js routing or the UI. Adding a new AI vendor in Phase 2 is:
implement `AIProvider`, register it in `orchestrator.ts` — nothing else
changes.

## AI provider status

| Provider  | Adapter file                          | Status                                   |
|-----------|-----------------------------------------|-------------------------------------------|
| Mock      | `providers/mock-provider.ts`           | Fully working — echoes input, used for dev/tests |
| OpenAI    | `providers/openai-provider.ts`         | Skeleton — `isConfigured()` works, `generate()` throws until Phase 2 |
| Anthropic | `providers/anthropic-provider.ts`      | Skeleton — same as above                  |
| Gemini    | `providers/gemini-provider.ts`         | Skeleton — same as above                  |
| Grok      | `providers/grok-provider.ts`           | Skeleton — same as above                  |

Real vendor adapters are registered in the orchestrator today so the
registry/routing logic is fully exercised, but calling `generate()` on
them before Phase 2 throws a clear "not implemented yet" error rather
than returning fake AI output.

## Database foundation

`prisma/schema.prisma` defines: `User`, `Account`/`Session`/`VerificationToken`
(NextAuth-compatible), `Conversation`, `Message`, `File`, `Memory`,
`ProviderConfig`, `UsageRecord`. Default provider is PostgreSQL; for local
dev without a Postgres server, switch the `datasource` block to
`provider = "sqlite"` and set `DATABASE_URL="file:./dev.db"`.

Use `npm run db:migrate` (dev) to create migrations — never hand-edit a
production database.

## Getting started

```bash
cp .env.example .env
# Fill in DATABASE_URL and AUTH_SECRET at minimum.
# AI provider keys are optional — the app runs fine without them.

npm install
npm run db:generate
npm run db:migrate      # creates the initial migration + applies it
npm run dev              # http://localhost:3000
```

## Quality checks — run these yourself

I could not execute these in the sandbox that built this project (no
network access, so `npm install` fails with a 403 from the registry).
Run them locally / in CI before treating this as verified:

```bash
npm install
npm run typecheck
npm run lint
npm run test
npm run build
```

The test suite (`tests/*.test.ts`) covers:
- App/config: startup succeeds with optional AI keys absent; a missing
  required var throws a clear `ConfigurationError`
- Health endpoint: returns a well-formed body with status/checks
- Request validation: valid/invalid chat payloads
- AI provider interface: every adapter instantiates; mock provider
  generates correctly; orchestrator routes to known providers and
  rejects unknown/unconfigured ones with the right error
- Error handling: every `AppError` subclass maps to the correct HTTP
  status and code, and never leaks a stack trace in its message
- Database: `isDatabaseReachable()` resolves to a boolean instead of
  throwing when no DB is reachable

## Known limitations

- Four real AI providers (OpenAI/Anthropic/Gemini/Grok) plus the mock
  provider are implemented, but **none of the four real ones have been
  called over a real network** — see "Provider limitations" above.
- No auth providers configured (Google/email/etc.) — the NextAuth route
  exists but sign-in isn't functional yet; all conversations/usage are
  scoped to one temporary dev-user bridge.
- Rate limiting is in-memory and single-instance only; not safe for a
  multi-instance deployment as-is.
- No file upload handling, despite the `File` table existing; the Files
  page detects drops client-side only.
- Create/Files/Projects/Research/Memory/Agents are designed UI with no
  backend behind them — every disabled control and `ComingSoon` panel
  says so explicitly rather than pretending to work.
- Settings persists nothing except theme (which uses `localStorage`).
- Streaming token usage isn't captured (recorded as 0/0) — see Phase 4's
  provider limitations above.
- Full quality checks (`npm install`/typecheck/lint/test/build) have not
  been executed in the sandbox that built this — see above. A scoped,
  offline `tsc --noResolve` pass was run each phase and real bugs it
  caught were fixed (a malformed function signature in Phase 2; a race
  condition in Phase 3 where creating a new conversation mid-stream
  could wipe the in-progress streaming message, fixed with a "just
  created" guard in `src/app/chat/page.tsx`; an unnecessary
  `@ts-expect-error` in Phase 4's `NormalizedProviderError` that was
  itself a compile error under the project's real `lib` setting). The
  remaining flagged lines each phase are import-resolution noise from
  having no `node_modules`, confirmed by manual review every time.
- No integration test actually exercises `/api/chat` end-to-end (that
  needs a running Next.js server or a heavier test harness than this
  build includes) — coverage instead targets the pieces around it:
  request validation, conversation persistence (against a mocked Prisma
  client), provider/orchestrator streaming, and SSE parsing.
- Only one user exists (the dev-user bridge above) — there's no
  per-user isolation until real auth is wired up.

## Phase 6 (suggested)

1. **Verify all four providers, and the router, against real accounts/network** — this has only ever been statically checked and unit-tested against mocked `fetch`/a mocked orchestrator.
2. Persist Compare/Synthesize source responses into conversation history properly (needs a schema change — e.g. a `kind`/`turnGroup` column on `Message` — rather than the local-only client state used today).
3. Add `routingMode`/`fallbackOccurred` columns to `UsageRecord` (currently only in logs — see Phase 5's usage/cost tracking note above) once there's a real database to migrate against.
4. Wire at least one NextAuth provider, replace the dev-user bridge in `src/lib/conversations.ts`/`usage.ts` with the real session user, and protect the conversation/chat/usage data so one user can't read another's.
5. Capture real token usage on the streaming path (OpenAI/Anthropic/Gemini can all be asked to include usage in their final stream event) instead of recording 0/0.
6. Replace the in-memory rate limiter with a shared store (Redis) for multi-instance deployments.
7. File upload handling backed by the `File` table; wire it into the chat composer's attachment button, and then genuinely set `ProviderCapabilities.visionInput` where true.
8. Per-user `ProviderConfig` (bring-your-own-key) and a user-facing usage/cost display built on `src/lib/ai/usage.ts` + `pricing.ts`.
9. Real generation for Create (image/video/audio/game), Research (web-search tool), Memory (extraction pipeline), Agents (execution runtime).

---

# Phase 11 — Final polish, security & Android readiness

**Honest status:** audited and fixed by static analysis only. This environment had no npm registry access, so
`npm install`, `next build`, the full `vitest` suite and ESLint were **not run**. A syntax/type pass with a
stand-in `tsc` (third-party typings unavailable) showed no remaining errors in project code, and the new
pure-logic tests pass under a minimal shim. **No APK/AAB was produced** — see `ANDROID.md`.

## Fixed
- **Security:** production no longer shares one anonymous "dev user" between all visitors (`ALLOW_ANONYMOUS_ACCESS`,
  default off in production) + middleware sign-in gate for pages and APIs; rate limiting on every expensive/mutating
  route keyed by user/IP (first-hop, validated) with bucket eviction; SSE/compare errors no longer echo raw
  exception text; CSP, HSTS, COOP, `no-store` API responses; uploaded-file responses sandboxed; upload size pre-check;
  open-redirect fix on login `callbackUrl`; research links limited to http(s); `NEXTAUTH_URL` must be https in production.
  Bug: deleting a file used the shared dev user instead of the signed-in user.
- **Build:** `useSearchParams` in the shared shell now sits in a Suspense boundary (likely `next build` failure on
  every page but /chat); ~30 `noUncheckedIndexedAccess` type errors from earlier phases fixed; removed a junk
  brace-expansion directory.
- **Mobile:** 100dvh + safe areas, viewport/manifest/icons, working drawer (closes on navigation, now lists Membership,
  Settings, Files, Research, Memory), hover-only controls (copy/regenerate/rename/delete/sign-out) reachable on touch,
  model selector no longer overflows 360px screens, toasts/modals fit small screens, 16px inputs, touch-sized buttons,
  long text wraps, memoised chat bubbles + instant scroll for low-end devices, Enter = newline on phone keyboards.
- **Reliability:** `apiFetch` (timeout, GET retry, safe messages), stream idle/connect timeouts and a stuck-"loading"
  fix, offline banner, error/not-found boundaries, retry buttons, honest error states instead of fake empty lists.
- **Stale UI copy** ("sign-in isn't wired up", "conversations aren't persisted", wrong "Preview" badges) corrected.
- **Android:** `capacitor.config.ts`, `mobile/` (offline page, Play Billing plugin source), `scripts/prepare-android.mjs`,
  icons/splash sources, `ANDROID.md`.

## Membership (unchanged, verified)
FREE $0/mo · PRO $4.99/mo · PRO YEARLY $49.99/yr · PREMIUM $9.99/mo · PREMIUM YEARLY $99.99/yr. Entitlements remain
server-side (`reserveForCurrentUser`/`withUsage`, fail-closed `resolveEffectiveTier`).

## Known remaining
Run `npm install && npm run check && npm run build` first; in-memory rate limiter is per-instance (use Redis for
multi-instance); `projects`/`agents`/video/audio remain honest "not available" screens; Android items above.
