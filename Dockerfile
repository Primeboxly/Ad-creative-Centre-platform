# Railway (or any Docker host) builds and runs the app from this file.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
# Footage processing uses Debian's ffmpeg and ffprobe (no download of ffmpeg-static's binary during the build).
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
ENV FFMPEG_PATH=/usr/bin/ffmpeg
ENV FFPROBE_PATH=/usr/bin/ffprobe
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server ./server
COPY public ./public
EXPOSE 3100
CMD ["node", "server/index.js"]
