CREATE SEQUENCE "browser_session_intent_seq" AS BIGINT MINVALUE 1 START WITH 1 NO CYCLE;
-- One internal clock row only. No business rows are imported or rewritten.
CREATE TABLE "BrowserSessionClock" (
  "id" BOOLEAN PRIMARY KEY DEFAULT true CHECK ("id" = true),
  "lastOrder" BIGINT NOT NULL DEFAULT 0,
  "logicalTimeMs" BIGINT NOT NULL,
  "legacyExpiresAtMs" BIGINT NOT NULL
);
INSERT INTO "BrowserSessionClock" ("id", "logicalTimeMs", "legacyExpiresAtMs")
SELECT true, stamp, stamp + 2592000000 FROM
  (SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS stamp) AS initial;
