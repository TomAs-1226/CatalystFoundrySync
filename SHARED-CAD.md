# Import once, share exact robot parts

One teammate imports the required CAD into Foundry, then opens **Project → Team sync & records → Share imported robot CAD**. Name the snapshot, retain the robot's shared work order, review who can download it, and confirm permission to share those exported parts. Only the imported selection is included; a saved robot link is not a geometry snapshot.

Teammates can use **Team parts** in the desktop source picker without connecting an Onshape account. Search by part name, material or subsystem; select parts for printing and add them to draft plates. The website offers the same catalog and downloads a portable `.catalyst.json` project for the selected parts. Open that project in Foundry. The website can also publish an existing portable project, so the first uploader does not need to fetch CAD again.

These operations use zero Onshape calls. They read Foundry's authenticated Cloudflare Worker/D1 storage. GitHub Pages hosts the static interface only. New or changed CAD must be imported and shared as a new immutable snapshot; existing snapshots/jobs are never silently replaced with a current workspace.

Snapshots preserve original geometry/units/hashes, immutable CAD IDs/configurations, installed occurrence transforms, CAD quantities and subsystem memberships. Downloads independently check the compressed archive hash, expanded content hash, published metadata, mesh bounds and original-byte integrity before accepting parts. The portable project retains the same source-copy identity for existing work-order duplicate-manufacturing reservations.

Sharing does not copy jobs, approvals, toolpaths, machine/material qualification, physical checks, part-status claims or private part notes. Backup quantities start at zero and are chosen explicitly per job. Purchased/unavailable parts are excluded from print selection. Fixture sources retain their fixture identity and remain non-manufacturable. Profiles, placement/fit, use case and approvals still require review.

The workspace currently allows any signed-in GitHub account at the owner's request. Such accounts can download explicitly shared snapshots even if they have no Onshape document access. The uploader must confirm this audience before upload. Anonymous/expired/removed sessions are rejected; CAD credentials are never included. The uploader can remove a shared snapshot. Already downloaded portable projects remain on their recipients' devices.

Storage is bounded to 20 snapshots per team, each at most 24 MiB of expanded CAD JSON and 6 MiB gzip (with at most 512 KiB of catalog metadata). Oversized robots must be shared by subsystem rather than silently truncated. Compressed data is chunked into rows below D1's row limit, committed atomically with the catalog, and never read before authentication. Repeated identical uploads reuse the immutable ID; full-library failures leave no partial snapshot. There is no silent storage eviction or API-budget reset.

No private robot geometry is uploaded by development checks. Live acceptance uses a clearly labeled non-manufacturable fixture, removes that exact test snapshot afterward, and compares the protective Onshape counter before/after. User robot snapshots appear only after their uploader's sharing action.
