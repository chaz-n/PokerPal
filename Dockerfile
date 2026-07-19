FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data

RUN addgroup -S app && adduser -S app -G app \
    && mkdir -p /data \
    && chown -R app:app /data /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server.js game.js store.js ./
COPY public ./public

USER app
EXPOSE 3000
VOLUME ["/data"]

CMD ["node", "server.js"]
