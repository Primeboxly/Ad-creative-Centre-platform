# Railway (or any Docker host) builds and runs the app from this file.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
EXPOSE 3100
CMD ["node", "server/index.js"]
