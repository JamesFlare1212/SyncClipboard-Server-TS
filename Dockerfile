FROM oven/bun:1.4.4 AS build
WORKDIR /build
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN bun run build

FROM oven/bun:1.4.4-slim
WORKDIR /app
COPY --from=build /build/dist/index.js ./index.js
COPY LICENSE ./LICENSE
COPY LICENSES ./LICENSES
ENV HOST=0.0.0.0 PORT=5033
RUN mkdir -p /app/server && chown bun:bun /app/server
USER bun
VOLUME ["/app/server"]
EXPOSE 5033
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["bun", "index.js", "--healthcheck"]
CMD ["bun", "index.js"]
