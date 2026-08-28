-- 配送班表新增“按间隔送货”；旧记录默认保留为“按每周送货”。
ALTER TABLE "delivery_rules"
  ADD COLUMN "deliveryScheduleMode" VARCHAR(16) NOT NULL DEFAULT 'WEEKLY',
  ADD COLUMN "deliveryIntervalDays" INTEGER,
  ADD COLUMN "deliveryIntervalStart" DATE;

ALTER TABLE "delivery_rules"
  ADD CONSTRAINT "delivery_rules_schedule_mode_check"
  CHECK ("deliveryScheduleMode" IN ('WEEKLY', 'INTERVAL'));

ALTER TABLE "delivery_rules"
  ADD CONSTRAINT "delivery_rules_schedule_choice_check"
  CHECK (
    (
      "deliveryScheduleMode" = 'WEEKLY'
      AND cardinality("weekdays") >= 1
      AND "deliveryIntervalDays" IS NULL
      AND "deliveryIntervalStart" IS NULL
    )
    OR
    (
      "deliveryScheduleMode" = 'INTERVAL'
      AND cardinality("weekdays") = 0
      AND "deliveryIntervalDays" BETWEEN 1 AND 6
      AND "deliveryIntervalStart" IS NOT NULL
    )
  );
