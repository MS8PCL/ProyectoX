FROM oven/bun:1.3.8

WORKDIR /app

COPY package.json bun.lock* package-lock.json* ./
RUN bun install --no-progress

COPY . .

EXPOSE 5173

CMD ["bash", "-lc", "bunx vite --host 0.0.0.0 --port 5173 --strictPort"]
