# Foundry team sync

GitHub Pages hosts only the static interface. Cloudflare Worker + D1 stores private preferences, per-copy manufacturing reservations, append-only operator reports and encrypted Onshape grants. GitHub commits, issues and Actions are not used as a database or always-running server.

## Current deployment

Website: https://tomas-1226.github.io/CatalystFoundrySync/

Private API: https://catalyst-foundry-sync.catalyst-foundry-sync.workers.dev

Cloudflare D1 migration and Worker deployment succeeded on 2026-10-18 UTC. Live GitHub authorization, device proof and authenticated D1-backed preference/record reads passed. Twelve live health, anonymous-session, callback and origin checks passed. This verification did not create manufacturing records, change preferences, read CAD or operate a printer. Live cross-device reservation writes remain untested. Onshape application registration and live consent are still pending.

In the installed desktop app, choose Project → Team sync & records and save the private API origin above once. Sign in using the allowed GitHub account. Initial team access is restricted to repository owner TomAs-1226; other team members need an explicit administrator allowlist update.

Provider requests use Workers-supported manual redirect handling. Unexpected OAuth redirects fail without forwarding credentials. This corrects a failure discovered during actual Cloudflare OAuth validation; local Node fetch accepts a redirect mode that Workers does not support.

The service is a team workspace, separate from CatalystApp project management, CatalystSetup installation and CatalystConsole telemetry. It does not control a printer. Foundry's installed local service still owns geometry validation, slicing, toolpath checks and the native Bambu Connect handoff.

## What is coordinated

A work order identifies one intended physical set of parts. Use the same work order on all devices making that set. Identifiers are normalized for case and whitespace. A new work order deliberately permits another physical set. The immutable CAD revision/configuration, geometry hash and exact leaf occurrence identify each required copy; local imports use normalized geometry identity. Required and backup copies have separate keys and permanent labels.

Before a connected desktop opens Bambu Connect, it reserves all exact copies in one D1 transaction. A conflict rolls back the entire batch. Different local job IDs, layouts or printer choices cannot reserve the same copies twice under the same work order. Manufacturing inputs and native 3MF hashes bind the reservation. Reservations do not expire automatically, including after a crash, ambiguous Connect launch or lost acknowledgement. A disconnected configured service blocks the handoff. Manual downloads/printing outside Foundry cannot be prevented or observed by this software.

Backup-only jobs are supported: set required quantity to zero and backup quantity above zero. The total must remain 1–1000. The same backup slot cannot be manufactured twice accidentally. Replenishing an already completed set requires a deliberately new work order; automatic inventory replenishment and per-copy scrap reconciliation are not implemented. A partially completed batch must remain held until an operator reconciles it; do not release an entire reservation if any of its copies were already produced.

Opening Connect records native review, never printer acceptance or printing. Manufacturing-started and manufactured states require an explicit owner attestation and note. Only the reservation owner can release/change it; team access is administrator controlled. Release confirmation means no copy was produced and no print is still active. Required/backup labels and event history remain after release/reallocation.

## End-user setup

1. The administrator deploys the private service once and supplies its HTTPS origin. In the desktop app choose Project → Team sync & records and save that URL.
2. Sign in with the allowed GitHub team account. The desktop opens your system browser; Foundry stores its own session using Windows secure storage. Sessions are scoped to this service and expire after seven days.
3. Select Connect Onshape and consent in the browser. No access-token file or personal API key is required. The service encrypts Onshape access/refresh tokens and rotates both on renewal. The desktop receives CAD responses through a narrow read/export proxy, never Onshape tokens. Each user connects their own grant.
4. Enter the shared work order. Preferences can suggest a default work order, included slicer profile and LAN/cloud mode; the machine/material profile still requires explicit review/application. No manufacturing profile is silently approved.
5. Review shared records in the desktop or website. Server-side optimistic revisions reject conflicting preference/record edits instead of overwriting another device.

The browser keeps its Foundry session only in memory, so reload requires sign-in again. Provider credentials and refresh tokens remain server-side. Disconnect removes the stored Onshape grant from Foundry; provider-level revocation can also be done in Onshape. Signing out revokes only the current Foundry session.

## Administrator deployment

The standalone CatalystFoundrySync repository contains only website/service code, not the desktop installer, CAD data, user profiles or credentials. Dependencies are pinned. Run npm ci, npm test and npm run build:sync. The output folders are web-dist (static GitHub Pages) and sync-dist (Cloudflare Worker).

Use Wrangler 4.151.1 with an authorized existing Cloudflare account. Do not use a temporary preview account for private manufacturing records. Create a D1 database named catalyst-foundry, place its returned ID in sync/wrangler.toml, and apply sync/migrations/0001.sql with `wrangler d1 migrations apply catalyst-foundry --remote --config sync/wrangler.toml`. Set PUBLIC_ORIGIN to the exact Worker HTTPS origin, SITE_ORIGIN to the GitHub Pages origin, TEAM_ID to this team's stable identifier, and ALLOWED_GITHUB_IDS to approved numeric GitHub IDs. It defaults only to the repository owner's public numeric ID; no other team access is inferred.

The administrator must register GitHub and Onshape OAuth applications and provide these Worker secrets: GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, ONSHAPE_CLIENT_ID, ONSHAPE_CLIENT_SECRET, TOKEN_ENCRYPTION_KEY. The encryption key is a newly generated 32-byte cryptographic key encoded as base64. Keep it in the Worker secret store; loss of the key requires reconnecting Onshape. Never put secrets in Pages variables/config.json, source, build artifacts or GitHub commits.

GitHub authorization callback: PUBLIC_ORIGIN/auth/callback/github. Onshape callback: PUBLIC_ORIGIN/auth/callback/onshape. Requested scopes are GitHub read:user and Onshape OAuth2Read. The service uses GitHub numeric IDs for team access and stores no GitHub provider token after identity lookup. Provider registration/publishing and test-user restrictions must be completed using authorized accounts; the code does not bypass them.

Deploy `sync-dist/worker.js` with `wrangler deploy --config sync/wrangler.toml` only after the database/bindings/secrets are configured. Set the GitHub repository variable FOUNDRY_SYNC_URL to the public Worker origin. Enable Pages with GitHub Actions and run the manual Foundry website workflow. The workflow uploads only web-dist. The static UI itself contains no private records or credentials and has no server functionality.

The current proxy supports the default immutable Onshape v17 reads and synchronous STL export. Advanced asynchronous translation and external artifact hosts require separate reviewed support. Token refresh uses a database lease and generation check; a reconnect cannot be overwritten by an in-flight older renewal. A 401/revocation requires reconnection. Cross-origin API access is restricted to SITE_ORIGIN and sessions are rechecked against the team allowlist on every request.

## Verification scope

Local tests exercise the real SQL schema via two independent SQLite connections, all-or-nothing reservation conflicts, duplicate retries, required/backup separation, backup-only batches, stale revisions, explicit operator reports, preferences, membership, OAuth browser state/device proof and encrypted refresh rotation. Injected provider responses are synthetic; they do not prove live GitHub/Onshape OAuth or Cloudflare D1 deployment. The complete desktop suite and native installation are checked separately. No live printer was operated. The latest UI is compiled/source-audited; interactive automation remains disabled at the user's request.

Authoritative references: [GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits), [D1 atomic batches](https://developers.cloudflare.com/d1/worker-api/d1-database/), [Onshape OAuth and token refresh](https://onshape-public.github.io/docs/auth/oauth/).
