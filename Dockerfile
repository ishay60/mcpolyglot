# mcpolyglot over Streamable HTTP. Mount a config at /config/mcpolyglot.config.json.
#   docker build -t mcpolyglot .
#   docker run -p 7337:7337 -v $PWD/mcpolyglot.config.json:/config/mcpolyglot.config.json:ro \
#     -e DATABASE_URL=... -e MCPOLYGLOT_TOKEN=... mcpolyglot

FROM node:22-slim AS build
WORKDIR /repo
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @mcpolyglot/cli... build \
 && pnpm --filter @mcpolyglot/cli deploy --prod /out

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out /app
USER node
EXPOSE 7337
ENTRYPOINT ["node", "/app/dist/bin.js"]
CMD ["serve", "--http", "--host", "0.0.0.0", "--port", "7337", "--config", "/config/mcpolyglot.config.json"]
