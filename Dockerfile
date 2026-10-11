FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json* ./
# sharp ships prebuilt binaries for Debian/glibc, so no compiler is needed
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server ./server
COPY public ./public
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
ENV PORT=3000 HOST=0.0.0.0 DATA_DIR=/app/data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=4s --start-period=10s CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
