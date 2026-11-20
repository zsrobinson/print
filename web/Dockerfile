FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN apk add --no-cache git && npm ci
COPY . .
RUN npm run build && npm prune --omit=dev
FROM node:24-alpine
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json server.ts ./
COPY server ./server
COPY src/lib/limits.ts ./src/lib/limits.ts
ENV BIND_ADDRESS=0.0.0.0 PORT=8787
USER node
EXPOSE 8787
CMD ["node", "--import", "tsx", "server.ts"]
