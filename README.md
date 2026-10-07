# Steel Browser MACU overlay

This repository builds a deliberately small overlay on the official Steel
Browser image. It preserves the upstream runtime and replaces only the two
copies of `live-session-streamer.ejs` with output from a deterministic,
hash-gated patcher.

No full upstream template is vendored here.

## Pinned inputs

- Base image:
  `ghcr.io/steel-dev/steel-browser@sha256:f5cd68fbc2cb27e5d7766269860fd0fb29cbe5fe506245a49c82f85ba210e7da`
- Runtime template: `/app/api/build/templates/live-session-streamer.ejs`
- Source template: `/app/api/src/templates/live-session-streamer.ejs`
- Required SHA-256 for each original template:
  `2de2e9328a568d00df9dd8d11b36fde58b3d1da97e71f9cacb863530a215064d`

The build stops if either template hash or any exact patch anchor changes.
That is intentional: a new Steel base must be reviewed before this overlay is
rebased.

## Parent-frame contract

Every message added by this overlay has `schema_version: 1`.

| Message | When it is emitted | Safe fields |
| --- | --- | --- |
| `steel:connecting` | Immediately before an active tab's WebSocket is constructed | `schema_version`, `type` |
| `steel:connected` | The active tab's WebSocket opens | `schema_version`, `type` |
| `navigation` | After the first successful JPEG draw, once per tab and only while that tab is active | `schema_version`, `type` |
| `steel:error` | The active tab's WebSocket reports an error | `schema_version`, `type` |
| `steel:disconnected` | An active tab connection closes abnormally without a prior error and was not intentionally closed | `schema_version`, `type` |
| `steel:state` | In reply to `steel:get-state` from `window.parent` | `schema_version`, `type`, `state`, positive dimensions when ready, and a safe `probe_id` echoed when supplied |

`steel:get-state` requests must carry `schema_version: 1`. `probe_id` is
accepted only as a string of at most 128 characters or a safe integer.
Requests from any window other than `window.parent` are ignored.

If constructing an active tab's WebSocket throws synchronously, the player
emits exactly one sanitized `steel:error` and rethrows the original exception.
The error object is never added to the message.

Only `steel:state` replies contain the `state` field. A successful JPEG draw
updates that replay state to `ready` with positive dimensions, but does not
emit a standalone `steel:ready` event. The normal message order is therefore
`steel:connecting`, `steel:connected`, then `navigation`. The overlay never
adds a URL, session ID, page ID, token, WebSocket endpoint, error text, or close
code to these messages. In particular, it replaces the
upstream `navigation` payload containing URL and favicon data with the marker
shown above. Existing upstream player features, including its separate
interactive clipboard protocol, remain upstream-owned and are not redefined
by this lifecycle contract.

## Test locally

Node.js 22 or newer is required only to test the patcher:

```powershell
npm.cmd test
```

On macOS or Linux, `npm test` is equivalent.

The tests cover exact-hash and anchor drift failures, deterministic output,
message ordering, first-frame gating, state replay, sensitive-field absence,
and error/intentional-close suppression.

## Build locally

```powershell
docker build --platform linux/amd64 -t steel-browser-macu:local .
```

The final image inherits the official image's entrypoint and configuration.
Only the two template files and this project's license/notice are added.

To inspect the patched files without starting Steel:

```powershell
docker run --rm --entrypoint sh steel-browser-macu:local -lc "sha256sum /app/api/build/templates/live-session-streamer.ejs /app/api/src/templates/live-session-streamer.ejs"
```

Both patched paths must have the same digest.

When the player is exposed through an HTTPS/WSS reverse proxy, set Steel's
`USE_SSL=true` and keep `DOMAIN` as a bare authority (host plus optional port,
without `https://`). Steel derives the advertised HTTP and WebSocket schemes
from `USE_SSL`; omitting it while pointing at a TLS-only proxy causes the
player request to use plaintext and can return HTTP 400 before `/cast` opens.
The proxy may still use private HTTP for its upstream connection to Steel.

## Publishing and consumption

The GitHub Actions workflow tests every pull request and builds for
`linux/amd64`. On `main`, a version tag, or a manual run it authenticates with
the repository's standard `GITHUB_TOKEN` and publishes to:

```text
ghcr.io/<repository-owner>/steel-browser-macu
```

Published tags include an immutable commit-SHA tag; Git version tags are also
preserved. Deployment consumers should resolve the selected tag and pin the
resulting manifest digest rather than tracking a mutable tag.

## Updating Steel

1. Resolve and record the new upstream image digest.
2. Extract both template files from that exact image and verify they are
   byte-identical.
3. Review the upstream template diff, then update the image digest in both
   `FROM` instructions.
4. Update `BASE_TEMPLATE_SHA256` and both Docker build assertions to the newly
   reviewed original template digest.
5. Adjust exact anchors only where the reviewed upstream source requires it.
6. Run the Node tests and a clean `linux/amd64` container build.
7. Inspect the final image, publish an immutable tag, and roll out to a
   non-production viewer before changing a production digest pin.

If the overlay fails in production, roll back the deployment's image digest to
the previously verified Steel or overlay manifest; do not rebuild an old tag.

## License

This overlay is licensed under Apache-2.0. See `LICENSE` and `NOTICE`. The base
image remains subject to its upstream notices and licenses.
