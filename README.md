# Foundry team sync

GitHub Pages hosts only the static interface. Cloudflare Worker + D1 stores private preferences, per-copy manufacturing reservations, append-only operator reports and encrypted Onshape grants. GitHub commits, issues and Actions are not used as a database or always-running server.

## Current deployment

Website: https://tomas-1226.github.io/CatalystFoundrySync/

Private API: https://catalyst-foundry-sync.catalyst-foundry-sync.workers.dev

Cloudflare D1 migration and Worker deployment succeeded on 2026-10-18 UTC. Live GitHub authorization, device proof and authenticated D1-backed preference/record reads passed. The read-only Onshape application is registered; live authorization, encrypted renewable-grant storage and connection confirmation passed. Fourteen live health, anonymous-session, callback and origin checks passed. A genuine public tutorial part now transfers through the installed desktop service, including STL export, unit conversion, CAD-dimension checks and geometry hashing. No geometry was added to the user’s project and no manufacturing records, preferences or CAD documents were changed. Live private/whole-robot CAD intake, cross-device reservation writes and separately controlled provider refresh remain untested.

The installed app includes the service origin. Sign in with GitHub and connect your own Onshape account. Open GitHub admission is enabled at the user’s request; see Current access policy below.

Provider requests use Workers-supported manual redirect handling. Unexpected OAuth redirects fail without forwarding credentials. This corrects a failure discovered during actual Cloudflare OAuth validation; local Node fetch accepts a redirect mode that Workers does not support.

The service is a team workspace, separate from CatalystApp project management, CatalystSetup installation and CatalystConsole telemetry. It does not control a printer. Foundry's installed local service still owns geometry validation, slicing, toolpath checks and the native Bambu Connect handoff.

## Robot library and guided intake

The website and installed app use the same team service. The packaged desktop already includes its HTTPS origin: sign in, then connect Onshape in your browser. Advanced team-service settings remain available for a different administrator-provided backend. Existing custom service settings are preserved.

Your available Onshape document names refresh on connection, when you return to the view, and once a minute while visible. This is metadata discovery, not automatic geometry replacement. A changing Onshape workspace cannot silently update an existing job. Each teammate connects their own Onshape account and must have access to the CAD; sharing a Foundry link grants no extra Onshape permissions.

Use Team robots → Share a robot to save a robot name, assembly link and common work order once. That explicit link appears on the website and desktop for every signed-in workspace member. Document discovery alone never shares the rest of your document list. A failed or revoked Onshape connection does not hide already shared robot links. Shared source edits are revision-checked and owner-only through the API.

In desktop Select design, paste a whole-document or robot assembly link, or choose a team robot. Foundry suggests a single assembly and, only from a complete dated version list, a newest saved version; ambiguous choices require selection. A version supplied in a link remains pinned. Find robot parts traverses nested assembly occurrences and preserves installed copy counts and subsystem paths, including parts shared by multiple subsystems. Suppressed/inaccessible parts remain excluded or visibly unavailable. A Part Studio provides one of each solid; a merged mesh cannot be intelligently reconstructed into a robot assembly.

Search parts by name, material or subsystem. Choosing a subsystem recounts its exact occurrences. Suggestions separate standard/purchased hardware, likely printed polymers, other materials and unknown parts. These use CAD metadata/name heuristics, not AI qualification or structural analysis. Use suggested print parts is an explicit selection; classification remains editable. Downloaded STL dimensions, units and geometry hashes are checked. Imports use at most four concurrent metadata/bounds requests, batches of at most 100 selected part types and a 24 MiB combined response budget. A failed/cancelled/oversized transfer adds nothing to the project.

After dimension/version confirmation, new print parts can become unapproved draft jobs grouped by top-level subsystem and CAD material. Cross-subsystem parts stay in one Shared parts group. Repeated import does not duplicate assigned drafts; overlapping whole-robot/subsystem copies are rejected even when local IDs differ. Inspection-only parts remain outside print jobs. Printer/material profiles, orientation, plate fit, use case and approval still need explicit review. Advanced intake retains precise configuration/quantity controls. Geometry validation, preparation and offline Bambu slicing run in the Windows app. Explicitly shared CAD snapshots are stored behind sign-in in Cloudflare Worker/D1; the website offers their searchable catalog and portable project download.

Use the same work order for the same intended physical robot on every device. Required and backup copies retain distinct immutable labels and reservations. New CAD revisions or a deliberately new work order identify a different set. Existing manufacturing/approval invalidation rules still apply. Foundry does not infer printer acceptance or completion from opening Bambu Connect.

## Current access policy

At the user's explicit request, ALLOWED_GITHUB_IDS is configured as an exact asterisk (*): any verified, signed-in GitHub account may enter this shared workspace. Distribution of the installer is not an access restriction on the public website. Such users can see shared robot links/manufacturing records, download explicitly shared CAD snapshots, and create their own records; they cannot modify another owner's records or links. Preferences and encrypted Onshape grants remain private per user; CAD reads use the signed-in user's grant. Anonymous/expired sessions, other website origins and unauthorized CAD endpoints remain rejected. The UI identifies open admission after sign-in. To restrict entry later, replace * with comma-separated approved numeric GitHub IDs and redeploy; existing sessions are rechecked on every request.

## What is coordinated

A work order identifies one intended physical set of parts. Use the same work order on all devices making that set. Identifiers are normalized for case and whitespace. A new work order deliberately permits another physical set. The immutable CAD revision/configuration, geometry hash and exact leaf occurrence identify each required copy; local imports use normalized geometry identity. Required and backup copies have separate keys and permanent labels.

Before a connected desktop opens Bambu Connect, it reserves all exact copies in one D1 transaction. A conflict rolls back the entire batch. Different local job IDs, layouts or printer choices cannot reserve the same copies twice under the same work order. Manufacturing inputs and native 3MF hashes bind the reservation. Reservations do not expire automatically, including after a crash, ambiguous Connect launch or lost acknowledgement. A disconnected configured service blocks the handoff. Manual downloads/printing outside Foundry cannot be prevented or observed by this software.

Backup-only jobs are supported: set required quantity to zero and backup quantity above zero. The total must remain 1–1000. The same backup slot cannot be manufactured twice accidentally. Replenishing an already completed set requires a deliberately new work order; automatic inventory replenishment and per-copy scrap reconciliation are not implemented. A partially completed batch must remain held until an operator reconciles it; do not release an entire reservation if any of its copies were already produced.

Opening Connect records native review, never printer acceptance or printing. Manufacturing-started and manufactured states require an explicit owner attestation and note. Only the reservation owner can release/change it; team access is administrator controlled. Release confirmation means no copy was produced and no print is still active. Required/backup labels and event history remain after release/reallocation.

## End-user setup

1. The included Catalyst service is already configured. Open Project → Team sync & records, or Connect Onshape from Select design. Advanced service settings support another administrator-provided origin.
2. Sign in with your GitHub account. The desktop opens your system browser; Foundry stores its own session using Windows secure storage. Sessions are scoped to this service and expire after seven days.
3. Select Connect Onshape and consent in the browser. No access-token file or personal API key is required. The service encrypts Onshape access/refresh tokens and rotates both on renewal. The desktop receives CAD responses through a narrow read/export proxy, never Onshape tokens. Each user connects their own grant.
4. Enter the shared work order. Preferences can suggest a default work order, included slicer profile and LAN/cloud mode; the machine/material profile still requires explicit review/application. No manufacturing profile is silently approved.
5. Review shared records in the desktop or website. Server-side optimistic revisions reject conflicting preference/record edits instead of overwriting another device.

The browser keeps its Foundry session only in memory, so reload requires sign-in again. Provider credentials and refresh tokens remain server-side. Disconnect removes the stored Onshape grant from Foundry; provider-level revocation can also be done in Onshape. Signing out revokes only the current Foundry session.

## Administrator deployment

The standalone CatalystFoundrySync repository contains only website/service code, not the desktop installer, CAD data, user profiles or credentials. Dependencies are pinned. Run npm ci, npm test and npm run build:sync. The output folders are web-dist (static GitHub Pages) and sync-dist (Cloudflare Worker).

Use Wrangler 4.151.1 with an authorized existing Cloudflare account. Do not use a temporary preview account for private manufacturing records. Create a D1 database named catalyst-foundry, place its returned ID in sync/wrangler.toml, and apply all numbered SQL migrations (including 0001.sql and 0002_team_sources.sql) with `wrangler d1 migrations apply catalyst-foundry --remote --config sync/wrangler.toml`. Set PUBLIC_ORIGIN to the exact Worker HTTPS origin, SITE_ORIGIN to the GitHub Pages origin, TEAM_ID to this team's stable identifier, and ALLOWED_GITHUB_IDS to approved numeric GitHub IDs. An exact * enables the explicitly requested open admission; a comma-separated numeric ID list restricts entry.

The administrator must register GitHub and Onshape OAuth applications and provide these Worker secrets: GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, ONSHAPE_CLIENT_ID, ONSHAPE_CLIENT_SECRET, TOKEN_ENCRYPTION_KEY. The encryption key is a newly generated 32-byte cryptographic key encoded as base64. Keep it in the Worker secret store; loss of the key requires reconnecting Onshape. Never put secrets in Pages variables/config.json, source, build artifacts or GitHub commits.

GitHub authorization callback: PUBLIC_ORIGIN/auth/callback/github. Onshape callback: PUBLIC_ORIGIN/auth/callback/onshape. Requested scopes are GitHub read:user and Onshape OAuth2Read. The service uses GitHub numeric IDs for team access and stores no GitHub provider token after identity lookup. Provider registration/publishing and test-user restrictions must be completed using authorized accounts; the code does not bypass them.

Deploy `sync-dist/worker.js` with `wrangler deploy --config sync/wrangler.toml` only after the database/bindings/secrets are configured. Set the GitHub repository variable FOUNDRY_SYNC_URL to the public Worker origin. Enable Pages with GitHub Actions and run the manual Foundry website workflow. The workflow uploads only web-dist. The static UI itself contains no private records or credentials and has no server functionality.

The current proxy supports the default immutable Onshape v17 reads and synchronous STL export. Advanced asynchronous translation and external artifact hosts require separate reviewed support. Token refresh uses a database lease and generation check; a reconnect cannot be overwritten by an in-flight older renewal. A 401/revocation requires reconnection. Cross-origin API access is restricted to SITE_ORIGIN and sessions are rechecked against the team allowlist on every request.

The STL proxy follows bounded redirects to the exact reviewed HTTPS Onshape regional origin https://cad-usw2.onshape.com only for a requested immutable per-part binary STL export. Its protected download handler requires the user’s read-only Onshape bearer token. Regional token delivery defaults to disabled in code and requires ONSHAPE_REGIONAL_STL_AUTH=enabled; this deployment was enabled after explicit user authorization. Foundry sessions, cookies and client headers are never forwarded. Unexpected/lookalike hosts, insecure/credentialed URLs, alternate ports and redirects from metadata reads remain blocked. Signed URL queries and private upstream bodies are omitted from errors. See [the actual failure and live fix evidence](ONSHAPE-EXPORT.md).

## Verification scope

The standalone suite passes 37 tests; the complete integrated suite passes 333 tests in 30 files. Local tests exercise the real SQL schema via two independent SQLite connections, all-or-nothing reservation conflicts, duplicate retries, required/backup separation, backup-only batches, stale revisions, explicit operator reports, preferences, membership, OAuth browser state/device proof, Workers-compatible redirect handling and encrypted refresh rotation. Mocked provider tests are separate from the live GitHub/Onshape authorization and D1 read checks described above. Native installation is checked separately. No live printer was operated. The latest Foundry UI is compiled/source-audited; interactive automation remains disabled at the user's request.

Authoritative references: [GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits), [D1 atomic batches](https://developers.cloudflare.com/d1/worker-api/d1-database/), [Onshape OAuth and token refresh](https://onshape-public.github.io/docs/auth/oauth/).


## Shared imported geometry

A successful Onshape CAD pull automatically queues and uploads its immutable geometry to the team library. Desktop apps list all cloud parts and cache the geometry for offline preparation. Teammates do not import Onshape again. The website lists the same catalog automatically and provides portable projects. Existing projects are never crawled or uploaded on startup; automatic sharing is attached to an intentional new CAD pull, with the current audience displayed. See SHARED-CAD.md for scope, offline behavior, account isolation and bounded storage.
