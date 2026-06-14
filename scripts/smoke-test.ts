// End-to-end smoke test for the two live integrations: the Redis (Upstash)
// achievement fan-out and the R2 media upload. Run against a LOCAL BE
// (`bun run dev` in another terminal) with a real .env (live Upstash + R2):
//
//   bun run smoke            # uses a default macOS HEIC wallpaper as input
//   bun run smoke <path>     # use your own image
//
// It: signs up a fresh user → opens the SSE stream → uploads an image
// through POST /media to R2 → creates a post (trips "first_post") → and
// waits for the achievement_unlocked toast to round-trip back through
// Upstash to the SSE connection. Leaves one throwaway user in the DB
// (delete with `bun run delete:user` if you care).
const API = process.env.SMOKE_API ?? "http://localhost:3000";
const SRC = process.argv[2] ?? "/System/Library/Desktop Pictures/iMac Blue.heic";

const rand = Math.random().toString(36).slice(2, 8);
const creds = {
  email: `smoke_${rand}@example.com`,
  password: "smoke-test-pw-123",
  name: `smoke ${rand}`,
  username: `smoke_${rand}`,
  gender: "UNDISCLOSED",
};

const log = (ok: boolean, msg: string) => console.log(`${ok ? "✅" : "❌"} ${msg}`);
const die = (msg: string) => {
  log(false, msg);
  process.exit(1);
};

// ── 0. Shrink the source to a small JPEG so we stay under the upload cap
//      and don't depend on the input format (HEIC decode is unit-tested
//      separately). On macOS Bun.Image decodes the HEIC wallpaper fine.
let upload: Buffer;
try {
  upload = await new Bun.Image(Buffer.from(await Bun.file(SRC).arrayBuffer()))
    .resize(1600, 1600, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .buffer();
} catch (e: any) {
  die(`could not read/shrink source image "${SRC}": ${e?.message}`);
}

// ── 1. Sign up (fresh user ⇒ first post trips "first_post") ──────────
const signup = await fetch(`${API}/api/auth/sign-up/email`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(creds),
});
if (!signup.ok) die(`sign-up failed (${signup.status}): ${await signup.text()}`);
const cookie = signup.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
log(true, `signed up as ${creds.username}`);

// ── 2. Open the SSE stream, wait for the "connected" handshake ───────
const achievementSeen = Promise.withResolvers<any>();
let connected = false;
(async () => {
  const res = await fetch(`${API}/users/me/events`, { headers: { cookie } });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop() ?? "";
    for (const f of frames) {
      const ev = /event:\s*(.*)/.exec(f)?.[1]?.trim();
      const data = /data:\s*(.*)/.exec(f)?.[1]?.trim();
      if (ev === "connected") connected = true;
      if (ev === "achievement_unlocked") achievementSeen.resolve(JSON.parse(data!));
    }
  }
})().catch((e) => achievementSeen.reject(e));

for (let i = 0; i < 100 && !connected; i++) await new Promise((r) => setTimeout(r, 50));
if (!connected) die("SSE never connected");
log(true, "SSE stream connected");

// ── 3. Upload through POST /media → R2 ──────────────────────────────
const fd = new FormData();
fd.append("file", new Blob([upload!], { type: "image/jpeg" }), "smoke.jpg");
const up = await fetch(`${API}/media`, { method: "POST", headers: { cookie }, body: fd });
if (!up.ok) die(`upload failed (${up.status}): ${await up.text()}`);
const media = await up.json();
log(true, `uploaded → ${media.url} (${media.width}x${media.height})`);

const head = await fetch(media.url);
log(head.ok, `R2 public URL serves the file (${head.status}, ${head.headers.get("content-type")})`);

// ── 4. Create a post with that media (KL coords) ────────────────────
const post = await fetch(`${API}/posts`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie },
  body: JSON.stringify({
    title: "smoke test egg review",
    body: "this egg is a 10/10. testing the whole pipeline.",
    latitude: 3.139,
    longitude: 101.6869,
    media: [{ url: media.url, kind: media.kind, order: 0, width: media.width, height: media.height }],
  }),
});
if (post.status !== 201) die(`create post failed (${post.status}): ${await post.text()}`);
log(true, "post created (with media)");

// ── 5. Await the achievement toast (round-trips through Upstash) ─────
const winner: any = await Promise.race([
  achievementSeen.promise,
  new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 15000)),
]).catch((e) => ({ error: e.message }));

if (winner.error) {
  log(false, `no achievement toast within 15s (${winner.error})`);
  console.log("   (is the achievements catalog seeded? run `bun run seed:achievements`)");
  process.exit(1);
}
log(true, `🏆 "${winner.achievement.name}" +${winner.achievement.rewardCoins} coins (newBalance ${winner.newCoinBalance})`);
console.log(`\nThrowaway user left in DB: ${creds.username}`);
process.exit(0);
