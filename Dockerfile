FROM node:22-alpine AS web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:22-alpine
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY server/ ./
COPY --from=web /app/web/dist /app/web/dist
ENV NODE_ENV=production PORT=8787 BOTLOOM_DB=/data/botloom.db
VOLUME /data
EXPOSE 8787
CMD ["npx", "tsx", "src/index.ts", "--demo"]
