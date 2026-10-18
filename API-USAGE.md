# Onshape request protection

Printing or slicing saved Foundry geometry uses zero Onshape requests. A new
import needs saved-version metadata, CAD dimensions and an STL export. Regional
export redirects are separate requests. Repeated assembly copies share geometry;
they are not individually downloaded.

The document pickers no longer poll Onshape on focus or every minute. Search or
refresh explicitly. Team links, preferences and manufacturing records synchronize
through Foundry's database and do not consume Onshape calls.

The desktop keeps bounded immutable metadata for two minutes per connection,
keyed by the full version/configuration/link reference. It clears that cache on
identity changes. Exported geometry also has the existing bounded local cache.
Saved portable projects retain their own geometry for offline reuse.

The shared Worker reserves one database counter increment **before every**
allowed upstream read, including redirects and failed attempts. At 1,000 future
attempts it pauses new CAD requests for everyone using this private app. There
is no automatic counter reset, client override or per-user quota multiplication.
Counting attempts overestimates Onshape's billable successful calls.

The operator reported 663 of 2,500 consumed on 2026-10-18. A 1,000-attempt ceiling
leaves 837 against that reported snapshot. This is not an authoritative provider
balance: previous/in-flight calls and other applications can consume it. An
administrator must verify the current Onshape balance and allocation period
before deliberately increasing or resetting the protective counter. The budget
endpoint is authenticated and does not contact Onshape. Missing database state
or migration errors fail closed before an upstream read.

Onshape documents the 2,500 tier as an annual allowance. Private OAuth apps charge
their owner, so teammates share it. Installing a private extension inside Onshape
does not remove those charges. The documented exemption is for OAuth apps publicly
available in the Onshape App Store; that requires Onshape's publication process.
No App Store publication or quota exemption has been obtained for Foundry.

Source: https://onshape-public.github.io/docs/auth/limits/
