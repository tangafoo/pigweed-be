// Stripe-style prefixed IDs. Pass at every prisma create / upsert site:
//
//   prisma.post.create({ data: { id: makeId(ID_PREFIX.POST), ... } })
//
// Better Auth's tables (User, Session, Account, Verification) are NOT
// prefixed — Better Auth manages those IDs internally and overriding
// would break auth flows.
//
// We use crypto.randomUUID() (Bun built-in, no dependency) and strip the
// dashes. IDs end up longer than cuid2 (35 chars after the prefix) but the
// prefix is the whole point — readability in logs beats brevity.

export const ID_PREFIX = {
  POST: "post",
  POST_MEDIA: "pm",
  COMMENT: "cmt",
  COIN_PACK: "cp",
  COIN_PURCHASE: "cpur",
  AWARD_TYPE: "at",
  POST_AWARD: "paw",
  COMMENT_AWARD: "caw",
  ACHIEVEMENT: "ach",
  SUBSCRIPTION_PLAN: "subplan",
  SUBSCRIPTION: "sub",
  SUBSCRIPTION_PAYMENT: "subpay",
  SUBSCRIPTION_BENEFIT: "subben",
  EGG_ORDER: "egg",
} as const;

export const makeId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
