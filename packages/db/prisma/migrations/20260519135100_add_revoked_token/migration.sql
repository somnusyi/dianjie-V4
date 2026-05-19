-- ════════════════════════════════════════════════════════════════════════════
-- 新增 revoked_tokens 表 (JWT 撤销机制)
--
-- 配套代码: apps/api/src/routes/auth.ts (commit 85121b4)
--   - access (2h) 不查此表
--   - refresh (30d) 在 /api/auth/refresh 查 jti 命中即拒绝
--   - logout 写入 refresh jti
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "revoked_tokens" (
    "id"          TEXT         NOT NULL,
    "jti"         TEXT         NOT NULL,
    "userId"      TEXT         NOT NULL,
    "tokenType"   TEXT         NOT NULL,
    "expiresAt"   TIMESTAMP(3) NOT NULL,
    "revokedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason"      TEXT,
    CONSTRAINT "revoked_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "revoked_tokens_jti_key"
  ON "revoked_tokens" ("jti");

CREATE INDEX IF NOT EXISTS "revoked_tokens_userId_idx"
  ON "revoked_tokens" ("userId");

CREATE INDEX IF NOT EXISTS "revoked_tokens_expiresAt_idx"
  ON "revoked_tokens" ("expiresAt");
