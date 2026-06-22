# pigweed-be — Railway deploy image.
#
# WHY THIS EXISTS: Railway's default nixpacks builder pulls its own (older)
# Bun, which predates `Bun.Image` — so `new Bun.Image()` in src/utils/images.ts
# throws "undefined is not a constructor" only in prod, breaking POST /media.
# Pinning the base image to a Bun that ships Bun.Image fixes it. Bump this tag
# in lockstep with the local toolchain (packageManager in package.json), and
# re-test image upload after a bump — Bun.Image is a young API.
FROM oven/bun:1.3.14
WORKDIR /app

# Manifest + schema first so `bun install` can run the `postinstall: prisma
# generate` hook (it needs prisma/schema.prisma present) and still cache the
# install layer across source-only changes.
COPY package.json bun.lock ./
COPY prisma ./prisma
RUN bun install --frozen-lockfile

# App source. .dockerignore keeps node_modules/.env/.git out so this COPY can't
# clobber the freshly-installed Linux deps with the host's macOS ones.
COPY . .

# Set AFTER install so devDependencies (prisma) are available to the hook above.
ENV NODE_ENV=production

# App binds to $PORT (Railway injects it); falls back to 3000. See src/index.ts.
EXPOSE 3000
CMD ["bun", "src/index.ts"]
