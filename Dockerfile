# One image, two roles: `node apps/api/dist/main.js` (API) or `node apps/api/dist/worker.js` (worker).
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY . .
RUN npm run build -w @s360/core && npm run build -w @s360/api && npm run build -w @s360/web \
 && cp -r apps/api/src/db/migrations apps/api/dist/db/migrations

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package*.json ./
COPY --from=build /app/packages/core/package.json packages/core/
COPY --from=build /app/apps/api/package.json apps/api/
COPY --from=build /app/apps/web/package.json apps/web/
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/web/dist apps/web/dist
USER node
EXPOSE 4000
CMD ["node", "apps/api/dist/main.js"]
