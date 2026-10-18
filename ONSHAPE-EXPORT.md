# Individual Onshape part import — verified server-side correction

Status: authorized by the user, enabled and deployed. Worker version 2b8cb17f-7338-4b75-a883-ba20a2f79ba4. A genuine public Onshape part transferred successfully through the installed desktop service; no reinstall was needed.

A read-only transfer of Onshape's documented public tutorial part reproduced the failure through the user's installed Foundry service. Document/version/element/configuration reads and CAD bounds succeeded. The STL request returned a redirect to cad-usw2.onshape.com. The service initially rejected that origin; omitting authorization at the regional handler instead returned HTTP 401. These are live observations, not a claim about the user's still-unidentified part.

The change:

- Only starts with the existing authenticated GET proxy and its allowed immutable version/part STL endpoint.
- Accepts a regional redirect only for a binary STL download, to the exact HTTPS origin https://cad-usw2.onshape.com.
- Sends the existing read-only Onshape bearer token to that Onshape-owned regional handler. The Foundry session, browser cookies and other client headers are not forwarded.
- Rejects unrelated/lookalike hosts, non-HTTPS schemes, credentials embedded in URLs and alternate ports before issuing a request.
- Checks every hop, limits redirect loops, and keeps JSON/bounding-box reads from using this regional-export exception.
- Never includes signed redirect queries, document paths, credentials or upstream response bodies in errors.

The protected regional download handler uses a different path from the original API request. Restricting bearer forwarding to a byte-for-byte matching path still failed with HTTP 401. The correction authorizes the exact regional origin during the issuer-provided STL redirect chain; it does not accept arbitrary download URLs from clients.

Local validation: 312 integrated tests and 28 standalone tests passed, including nine redirect/authorization boundary tests; production build and type checking passed. Tests prove that an unset/disabled administrator switch prevents the regional request entirely. After the user explicitly authorized token delivery to https://cad-usw2.onshape.com for redirected STL exports, the switch was enabled and deployment succeeded. The same public test transfer completed with real geometry; source access, saved CAD, configuration, CAD bounds, STL download, inch-to-mm conversion and geometry validation all succeeded. No CAD geometry was added to the user's project, no CAD document changed, and no printer was contacted.

The existing installed desktop binary needs no replacement for this server-side correction. The desktop's account session and website service URL remain in place.

Reference: [Onshape's documented synchronous STL API](https://github.com/onshape-public/go-client/blob/master/onshape/docs/PartApi.md), [public tutorial CAD/export example](https://onshape-public.github.io/docs/api-adv/translation/).

## Live result

Verified at 2026-10-18T17:16:41.585Z. The inspection-only transfer returned one part, dimensions 44.8770248 × 47.4624146 × 120.000014 mm. Geometry SHA-256: 77218dc47b85590155ee744dab2d1ee55d945a8b23a4bd0a01db6807bc41feac. No geometry was committed to the user’s project. The user’s specific part and whole-robot assembly still require their own intake checks; no private source was selected for this test. Latest Foundry UI/GPU interactions and real printing remain untested.
