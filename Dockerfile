FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=7860

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates iverilog \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY DCDV.html server.js ./
COPY backend ./backend
COPY screenshots ./screenshots
COPY assets ./assets

USER node

EXPOSE 7860

CMD ["node", "server.js"]
