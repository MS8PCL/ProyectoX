FROM oven/bun:1.3.8

# FASE 5: export.zip requires zip CLI (no JS libs added)
RUN apt-get update && apt-get install -y --no-install-recommends zip && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lock* package-lock.json* ./

# Bun can install from package.json. If bun.lock is missing, it will still work.
RUN bun install --no-progress

COPY src ./src

ENV PORT=8787
EXPOSE 8787

CMD ["bun", "src/index.cjs"]
