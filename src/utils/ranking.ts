// Ranking weights for the "hot" feed (GET /posts?sort=rank).
//
// Score formula, computed per (post, viewer):
//
//   score = -geoPerKm × distance_km(post, viewer)
//         + (votesGain × (upvotes - downvotes)) / (hours_since_creation + 2)
//         + (affinityBonus if post.author.animal === viewer.animal else 0)
//
// Higher score = higher in the feed. The math runs in Postgres
// via $queryRaw in posts.ts so pagination is correct and indexed.
//
// These weights are starting guesses. Tune as real data arrives —
// watch what surfaces in your test feed and adjust:
//   • Too local-clustered?  ↓ geoPerKm (less geo penalty)
//   • Old viral posts dominating?  ↓ votesGain  or  steepen time decay
//   • Affinity feels weak?  ↑ affinityBonus
//
// The "+ 2" in the time-decay denominator is the HN trick — keeps
// fresh posts (hours_old ≈ 0) from exploding to infinity, and
// lets a 1-hour-old post still be roughly comparable to a 2-hour-old.

export const RANKING_WEIGHTS = {
  geoPerKm:      0.1,   // distance penalty per km — 100km away = -10
  votesGain:    10,     // each net vote contributes this, scaled by time decay
  affinityBonus: 5,     // matching-animal flat bonus
} as const;
