# repo-ai in Docker (#284): one image, run as the dashboard or as a worker.
# Build from the repo root:  docker compose -f docker/compose.yml up --build

# ── build: compile and pack this checkout ────────────────────────────────────
FROM node:24-slim AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/docs/package.json apps/docs/package.json
# ponytail: installs the docs workspace too (the lockfile is shared); --ignore-scripts skips its native builds.
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm run build && mkdir /out && npm pack --ignore-scripts --pack-destination /out

# ── runtime: node, git, gh, Claude Code, repo-ai ─────────────────────────────
FROM node:24-slim
ARG CLAUDE_CODE_VERSION=latest
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl git openssh-client \
	&& curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
		-o /usr/share/keyrings/githubcli-archive-keyring.gpg \
	&& echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
		> /etc/apt/sources.list.d/github-cli.list \
	&& apt-get update && apt-get install -y --no-install-recommends gh \
	&& rm -rf /var/lib/apt/lists/* \
	&& corepack enable \
	&& npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"
COPY --from=build /out/*.tgz /tmp/repo-ai.tgz
RUN npm install -g /tmp/repo-ai.tgz && rm /tmp/repo-ai.tgz \
	# Named volumes copy this ownership on first creation, so the non-root user can write them.
	&& mkdir -p /repos /data /work && chown node:node /repos /data /work

USER node
# git authenticates through gh, which reads the GH_TOKEN each task is handed; no token is ever written to disk.
RUN git config --global credential.https://github.com.helper '!gh auth git-credential' \
	&& git config --global init.defaultBranch main
ENV NO_UPDATE_NOTIFIER=1 \
	DISABLE_AUTOUPDATER=1
WORKDIR /repos
ENTRYPOINT ["repo-ai"]
CMD ["dashboard"]
