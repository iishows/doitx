# Per-bot browser proxy (independent egress IP per bot)

## Goal & scope

Let a user set an upstream proxy — **with username/password auth** — on a bot, in bot settings.
That bot's Chromium then browses through it, so each bot appears from an independent egress IP.

Decided scope (from user):
- **Authenticated proxies required** → needs a local forwarder inside the container.
- **Browser only** — do *not* proxy the bot's shell/`curl`/`git` (no `HTTP_PROXY` env injection).
- **Config in the `Bot` table.**

Default sandbox provider for this fork is `docker` (`packages/adapters/src/sandbox-factory.ts`,
`SANDBOX_PROVIDER` defaults to `docker` in `infra/compose/.env.images.example`). Target that path.

## Core architecture decision

**A `Computer` (container) can be shared by multiple bots** — `packages/db/prisma/schema.prisma:1309`
(`scope String @default("team")`). A machine-global Chromium managed policy
(`/etc/chromium/policies/managed/rakazo-browser.json`) would therefore leak one bot's proxy to
every other bot on that computer. **Rejected.**

Instead, inject **per bot at browser launch**. Each bot already has its own Chromium profile dir
(`chromium-bot-<32hex>`), so this is the natural per-bot boundary.

**Chromium cannot take credentials in `--proxy-server`.** So per bot we run a small **local
forwarder** on `127.0.0.1:<port>` inside the container that holds the upstream creds; Chromium
always points at it as a plain HTTP proxy, and the forwarder speaks either HTTP `CONNECT` or
SOCKS5 (RFC1929 user/pass) upstream. This mirrors what commercial fingerprint browsers do.

```
Chromium --proxy-server=http://127.0.0.1:<port>
      -> bot proxy relay (127.0.0.1, holds creds)
           -> upstream http:// or socks5://user:pass@host:port   (real egress IP)
```

## 1. Data model — `packages/db/prisma/schema.prisma`

Add to `model Bot` (`schema.prisma:1293-1309` region):

- `browserProxyUrl String?` — scheme+host+port only, **no credentials** (e.g. `socks5://host:1080`).
- `browserProxyCiphertext String?` — the `user:pass` blob, encrypted at rest.
- `browserProxyEnabled Boolean @default(false)` — explicit toggle.

Migration via the repo's existing Prisma migrate workflow. Do **not** put the password in a plain
column.

## 2. Crypto

Reuse the existing secret machinery rather than inventing crypto:
- `packages/db/src/content-crypto.ts` — `EncryptedSecretStore` / seal+open helpers (`packages/adapters/src/secrets.ts` wraps it).
- Follow the `BotSecret` precedent (`ciphertext` + `auth` json) for shape/conventions.

Encrypt/decrypt only in `apps/api` (and the agent runtime), never in the supervisor.
**Never return the plaintext password to the client** — the settings read path returns
`browserProxyUrl` + a boolean "has credentials".

## 3. API + validation

- Contract: `UpdateBotInput` in `packages/contracts/src/domain.ts:399`. Add optional
  `browserProxy: { enabled, url, username, password } | null` (password write-only).
- Validation: restrict scheme to `http` / `https` / `socks5` / `socks5h`; validate host:port;
  reject anything else. Keep validation in contracts so web + api + mobile share it.
- Handler: `apps/api/src/routes/bots.ts:329` (`authed.bots.update`) — persist the three fields,
  sealing the credential. A `null` payload clears the proxy.
- Ensure the read path (`BotSchema` in `packages/contracts/src/domain.ts`) exposes only
  `browserProxyUrl` + `hasProxyCredentials`, never the secret.

## 4. UI — `apps/web/src/pages/shell/bot-settings.tsx`

- New "Browser proxy" section: enable toggle, URL field, username, password (write-only,
  placeholder shows "unchanged" when one is stored), plus a short helper text.
- Follow the existing section/form pattern in that file; reuse the same save mutation.
- Add strings to the existing i18n catalogs (incl. zh-CN) per the repo pattern.

## 5. Config path: api → supervisor (over HTTP)

The supervisor has **no DB access** (`infra/sandboxes/supervisor/package.json` deps: no
`@rakazo/db`/prisma), so proxy config must be handed to it per launch.

- `packages/adapters/src/docker-sandbox.ts:237` `pageBrowser()` POSTs to
  `/computers/:id/browser` with a `PageBrowserCommand` body. Extend that body with the resolved
  proxy for the calling bot.
- `AdapterContext` carries `botId` (`packages/adapters/src/computer-screens.ts:22`
  `screenSessionKey` = `context.botId ?? "default"`), so the adapter can load the bot's proxy
  config (via core/api) and attach it. **Flag:** decide the cleanest load point — either extend
  `AdapterContext` with an already-resolved proxy, or a launch-time lookup in the adapter. Prefer
  doing it in the caller so adapters stay storage-agnostic.
- Supervisor side: accept + validate the proxy in the browser route
  (`infra/sandboxes/supervisor/src/index.ts:864` region) and thread it into the launch.

## 6. Container-side relay

New script next to the other container tooling (`infra/sandboxes/computer/`, Python — consistent
with `control.py`/`close-browser.py`; ship it in `infra/sandboxes/computer/Dockerfile`).

- Always presents a **plain HTTP proxy** to Chromium; converts to the upstream scheme:
  - `http(s)` upstream → forward `CONNECT`/absolute-URI with `Proxy-Authorization: Basic`.
  - `socks5(h)` upstream → SOCKS5 client handshake incl. RFC1929 user/pass, then pipe bytes.
- **Port**: deterministic per bot, derived from `botId` (hash → fixed range, e.g. 20000–29999), so
  launch and teardown agree without discovery. Reject port collisions (two bots → distinct ports).
- **Credential delivery**: pass the creds to the relay via the launch command's env (existing
  `CommandRequest` env mechanism) rather than writing them to disk. Tradeoff: env is visible in
  `/proc/<pid>/environ` to same-user processes inside the container — acceptable here since the
  container is single-tenant per computer, but note it.
- **Lifecycle**: started per bot at browser launch; stopped on browser close
  (`infra/sandboxes/computer/close-browser.py` path), so a shared computer doesn't accumulate
  relays. Handle the shared-computer case explicitly: several bots → several relays → several ports.
- Concurrency: relay must serve multiple concurrent connections (threaded/async), since Chromium
  opens many sockets.

## 7. Launch injection

Chromium is launched in the supervisor: `containerActionStep` in
`infra/sandboxes/supervisor/src/supervisor-logic.ts` builds argv and passes
`RAKAZO_BROWSER_PROFILE=<profile>` to the `infra/sandboxes/computer/rakazo-browser` wrapper
(also used by `packages/adapters/src/createos-sandbox.ts:1209-1221` for the CreateOS provider).

- Only add `--proxy-server=http://127.0.0.1:<port>` when the bot has an enabled proxy; otherwise
  argv is **byte-identical to today** (no behaviour change for existing bots).
- Add `--proxy-bypass-list` so loopback/CDP/screen traffic is never proxied.
- **Verified constraint:** `infra/sandboxes/computer/control.py:194,210-211` enforces a strict
  argv shape and a regex on the profile path
  (`^/home/rakazo/\.browser-profiles/chromium-bot-[a-f0-9]{32}$`) and `allowed_control_argv`
  whitelists supervisor-shaped argv. Any new flag must be added to that whitelist, and the relay
  launch must not violate the shape check.
- **Path mismatch to respect:** CreateOS uses `/home/desktop` + `google-chrome`, the Docker path
  uses `/home/rakazo` + `rakazo-browser`. Implement for the Docker/supervisor path; leave CreateOS
  out of scope (documented) unless you also want it.

## 8. Failure modes

- Proxy unreachable/misconfigured: **fail the launch with a clear error** rather than silently
  falling back to direct — a silent fallback leaks the real IP, which defeats the feature.
- Interaction with restricted egress: `infra/compose/restrict-computer-egress.sh` allowlists
  host egress at the Docker host level. If the proxy runs on a **private** address, the container
  must be able to reach it, so its host:port may need to be added to that allowlist; a **public**
  proxy address passes the existing rules. Document this in `docs/self-host.md` (the restricted
  egress section, ~line 140-180). Flag: the exact allowlist mechanism needs a read of the script's
  rule generation before finalizing (incomplete verification — the script's `MASQUERADE`/rule
  internals were only partially read).
- Do **not** touch `RESERVED_COMMAND_VARIABLE_NAMES` in
  `packages/contracts/src/bot-secrets.ts` — we are not injecting proxy env vars, and keeping those
  names reserved prevents users from doing an end-run around the browser-only scope.

## 9. Tests

- Contracts: `UpdateBotInput` accepts/rejects schemes; password never echoed.
- `apps/api`: update handler seals the credential and reads back redacted. Add/extend near
  `apps/api/src/routes/bots.ts` tests and the bot-secret tests.
- Adapter: `packages/adapters/src/createos-sandbox.test.ts` / docker-sandbox tests — argv gains
  `--proxy-server` only when enabled.
- Supervisor: `infra/sandboxes/supervisor/src/computer-loopback.test.ts` — proxy threaded into the
  browser launch; nothing changes when unset.
- Container: a Python unit test beside `infra/sandboxes/computer/test_page_browser.py` for the
  relay (HTTP `CONNECT` + SOCKS5 handshake, bad creds → reject).
- E2E/manual check: an IP-echo request from a proxied bot returns the proxy's IP, and a
  non-proxied bot on the **same** computer still returns the host IP — this is the test that
  proves the shared-computer leak is avoided.

## 10. Docs

- `docs/self-host.md`: add a proxy section (config, allowed schemes, restricted-egress caveat).
- `docs/computer-runtime.md`: note the per-bot relay and its port scheme.

## Out of scope

- Proxying the bot's shell/tools (browser only, by decision).
- Container-wide/transparent egress (iptables) — would affect co-tenant bots on a shared computer.
- CreateOS provider (`/home/desktop`, `google-chrome`).
- Proxy pooling/rotation, per-domain rules, fingerprint spoofing beyond the egress IP.

## Open risks

1. Shared-computer co-tenancy — mitigated by per-bot launch injection + distinct ports; must be
   covered by the E2E test in §9.
2. `control.py` argv whitelist/regex is a hard gate — must be updated deliberately, with its
   existing tests (`infra/sandboxes/computer/test_page_browser.py`,
   `test_focus_or_launch.py`) kept green.
3. Credentials in process env inside the container (multi-tenant computers only).
4. Restricted-egress allowlist for the proxy address — needs confirmation (§8).
