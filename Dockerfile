# Shapewall in a container: the official Playwright image (Chromium and its
# system libraries included), pinned to the Playwright version in
# package-lock.json (test/doctor.test.js fails when they drift apart).
#
#   docker build -t shapewall .
#   docker run --rm -it -p 127.0.0.1:4600:4600 -v "$PWD:/work" --user "$(id -u):$(id -g)" shapewall
#   docker run --rm -it -v "$PWD:/work" --user "$(id -u):$(id -g)" shapewall capture
#
# See docs/deployment.md.

FROM mcr.microsoft.com/playwright:v1.64.1-noble AS build
WORKDIR /opt/shapewall
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --no-fund && chmod 755 bin/shapewall.js

FROM mcr.microsoft.com/playwright:v1.64.1-noble
# HOME=/tmp: the container may run as any uid (--user), which has no home.
# The Host check stays on for the names a published local port is reached by;
# add yours (comma-separated), or "*" when an authenticating proxy checks it.
ENV NODE_ENV=production \
    HOME=/tmp \
    SHAPEWALL_ALLOWED_HOSTS=localhost,127.0.0.1
WORKDIR /opt/shapewall
COPY --from=build /opt/shapewall/package.json ./package.json
COPY --from=build /opt/shapewall/bin ./bin
COPY --from=build /opt/shapewall/src ./src
COPY --from=build /opt/shapewall/dist ./dist
COPY --from=build /opt/shapewall/node_modules ./node_modules
RUN ln -s /opt/shapewall/bin/shapewall.js /usr/local/bin/shapewall
# pwuser is the image's unprivileged user; --user overrides it to match the
# owner of the mounted project folder.
USER pwuser
WORKDIR /work
VOLUME /work
EXPOSE 4600
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:4600/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
ENTRYPOINT ["node", "/opt/shapewall/bin/shapewall.js"]
CMD ["serve", "--host", "0.0.0.0", "--port", "4600"]
