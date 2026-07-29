# Multi-stage so build-only dependencies and the npm cache never reach the
# runtime layer. Previously single-stage with `COPY . .`, which shipped tests/
# (100 files) and all documentation into the deployed image.

# --- deps: production node_modules only --------------------------------------
FROM node:22-bookworm-slim AS deps

WORKDIR /opt/agent-chat

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

# --- runtime ------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# util-linux provides flock, used by services/run-bridge-container.sh to
# serialise bridge ownership.
RUN apt-get update \
    && apt-get install -y --no-install-recommends util-linux \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/agent-chat

COPY --from=deps --chown=node:node /opt/agent-chat/node_modules ./node_modules
COPY --chown=node:node . .

RUN chmod 0755 services/run-bridge-container.sh \
               services/docker-entrypoint.sh \
               services/docker-healthcheck.sh

RUN mkdir -p /var/lib/agent-chat/data /var/lib/agent-chat/logs \
    && chown -R node:node /var/lib/agent-chat

ENV NODE_ENV=production
ENV AGENT_CHAT_RUNTIME_DIR=/var/lib/agent-chat

# Build identity. build-info.json is excluded from the build context (it is a
# build output), so it is written here instead. Without this a published image
# reports a release but no revision, because the image has no .git.
ARG HAFLEET_RELEASE=""
ARG HAFLEET_REVISION=""
ARG HAFLEET_BUILT_AT=""
ARG HAFLEET_CHANNEL="container"
RUN if [ -n "$HAFLEET_REVISION" ]; then \
      printf '{\n  "release": "%s",\n  "revision": "%s",\n  "builtAt": "%s",\n  "channel": "%s"\n}\n' \
        "$HAFLEET_RELEASE" "$HAFLEET_REVISION" "$HAFLEET_BUILT_AT" "$HAFLEET_CHANNEL" \
        > build-info.json \
      && chown node:node build-info.json; \
    fi

# Documented for operators and for bridge-network compose profiles. With
# network_mode: host these are inert, which is why they were easy to overlook.
EXPOSE 8090 8084

# Role-aware; the entrypoint exports AGENTCHAT_ROLE. Compose profiles override
# this with their own per-service healthcheck.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=4 \
    CMD ["services/docker-healthcheck.sh"]

USER node

# Makes the image runnable on its own: `docker run <image> backend`. An explicit
# command such as `node server.js` is still passed through unchanged, so the
# existing compose profiles keep working.
ENTRYPOINT ["services/docker-entrypoint.sh"]
CMD ["--help"]
