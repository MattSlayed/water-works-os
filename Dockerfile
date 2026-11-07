# Private Cloud Run image: synthetic data, in-memory graph, no API key. See docs/CLOUD-RUN.md.
FROM node:22.18.0-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY data ./data
COPY web ./web
ENV WWOS_HOST=0.0.0.0
USER node
CMD ["node", "src/server.mjs"]
