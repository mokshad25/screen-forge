FROM node:22-slim AS build
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web ./
# The browser talks to the API and the plant's control port on the host.
ARG NEXT_PUBLIC_API_BASE=http://127.0.0.1:8000
ARG NEXT_PUBLIC_PLANT_CONTROL=http://127.0.0.1:8090
RUN npm run build

FROM node:22-slim
WORKDIR /web
ENV NODE_ENV=production
COPY --from=build /web/package.json /web/package-lock.json ./
COPY --from=build /web/node_modules ./node_modules
COPY --from=build /web/.next ./.next
COPY --from=build /web/public ./public
USER node
EXPOSE 3000
CMD ["npx", "next", "start", "-p", "3000"]
