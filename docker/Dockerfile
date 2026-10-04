# repo-ai in Docker (#284): one image, run as the dashboard or as a worker.
# Build from the repo root:  docker compose -f docker/compose.yml up --build

# ── build: compile and pack this checkout ────────────────────────────────────
FROM node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/docs/package.json apps/docs/package.json
# ponytail: installs the docs workspace too (the lockfile is shared); --ignore-scripts skips its native builds.
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm run build && mkdir /out && npm pack --ignore-scripts --pack-destination /out

# ── runtime: node, git, gh, Claude Code, repo-ai ─────────────────────────────
FROM node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
ARG CLAUDE_CODE_VERSION=2.1.289
ARG GH_KEY_SHA256=6084d5d7bd8e288441e0e94fc6275570895da18e6751f70f057485dc2d1a811b
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl git openssh-client \
	&& curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
		-o /usr/share/keyrings/githubcli-archive-keyring.gpg \
	&& echo "${GH_KEY_SHA256}  /usr/share/keyrings/githubcli-archive-keyring.gpg" | sha256sum -c - \
	&& echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
		> /etc/apt/sources.list.d/github-cli.list \
	&& apt-get update && apt-get install -y --no-install-recommends gh \
	&& rm -rf /var/lib/apt/lists/* \
	&& corepack enable \
	&& npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"
COPY --from=build /out/*.tgz /tmp/repo-ai.tgz
RUN npm install -g /tmp/repo-ai.tgz && rm /tmp/repo-ai.tgz \
	# Named volumes copy this ownership on first creation, so the non-root user can write them.
	&& mkdir -p /repos /data /work && chown node:node /repos /data \
	# #293: a worker runs as root only to drop each agent to this uid, which cannot read the worker's /proc/<pid>/environ.
	&& useradd --uid 1001 --create-home agent && chown agent:agent /work
# git authenticates through gh, which reads the GH_TOKEN each task is handed; no token is ever written to disk.
RUN git config --system credential.https://github.com.helper '!gh auth git-credential' \
	&& git config --system init.defaultBranch main
# The dashboard runs as node (compose `user:`); the worker service overrides to root.
USER node
ENV NO_UPDATE_NOTIFIER=1 \
	REPO_AI_AGENT_UID=1001 \
	DISABLE_AUTOUPDATER=1
WORKDIR /repos
ENTRYPOINT ["repo-ai"]
CMD ["dashboard"]
