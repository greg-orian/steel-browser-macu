FROM ghcr.io/steel-dev/steel-browser@sha256:f5cd68fbc2cb27e5d7766269860fd0fb29cbe5fe506245a49c82f85ba210e7da AS patcher

WORKDIR /opt/steel-browser-macu
COPY scripts/patch-template.mjs ./patch-template.mjs

RUN node ./patch-template.mjs \
      --input /app/api/build/templates/live-session-streamer.ejs \
      --output /opt/steel-browser-macu/patched/build/live-session-streamer.ejs \
      --expected-sha256 2de2e9328a568d00df9dd8d11b36fde58b3d1da97e71f9cacb863530a215064d \
    && node ./patch-template.mjs \
      --input /app/api/src/templates/live-session-streamer.ejs \
      --output /opt/steel-browser-macu/patched/src/live-session-streamer.ejs \
      --expected-sha256 2de2e9328a568d00df9dd8d11b36fde58b3d1da97e71f9cacb863530a215064d

FROM ghcr.io/steel-dev/steel-browser@sha256:f5cd68fbc2cb27e5d7766269860fd0fb29cbe5fe506245a49c82f85ba210e7da

LABEL org.opencontainers.image.title="Steel Browser MACU overlay" \
      org.opencontainers.image.description="Pinned Steel Browser image with a sanitized iframe lifecycle contract for MACU" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.source="https://github.com/greg-orian/steel-browser-macu" \
      org.opencontainers.image.base.name="ghcr.io/steel-dev/steel-browser@sha256:f5cd68fbc2cb27e5d7766269860fd0fb29cbe5fe506245a49c82f85ba210e7da"

COPY --from=patcher /opt/steel-browser-macu/patched/build/live-session-streamer.ejs /app/api/build/templates/live-session-streamer.ejs
COPY --from=patcher /opt/steel-browser-macu/patched/src/live-session-streamer.ejs /app/api/src/templates/live-session-streamer.ejs
COPY LICENSE NOTICE /usr/share/doc/steel-browser-macu/
