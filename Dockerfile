FROM oven/bun:1
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg openssl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock ./
# --ignore-scripts skips the root package's lifecycle scripts, i.e. the `prepare: husky` hook:
# husky is a devDependency (absent under --production), so without this the install fails with
# "husky: command not found". A production image has no use for git hooks anyway.
RUN bun install --frozen-lockfile --production --ignore-scripts
# tsconfig.json is required at RUNTIME too: Bun resolves the @server/@shared/@web
# import path aliases from its `paths`, so the server can't start without it.
COPY tsconfig.json ./
COPY src ./src
EXPOSE 8443 8080
CMD ["bun", "run", "src/server/index.ts"]
