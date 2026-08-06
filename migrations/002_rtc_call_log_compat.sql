ALTER TABLE rtc_calls
    ADD COLUMN IF NOT EXISTS id BIGINT UNSIGNED NULL,
    ADD COLUMN IF NOT EXISTS legacy_call_id INT NULL;

ALTER TABLE rtc_calls
    MODIFY COLUMN id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    ADD UNIQUE KEY IF NOT EXISTS uq_rtc_calls_id (id),
    ADD UNIQUE KEY IF NOT EXISTS uq_rtc_calls_legacy (legacy_call_id);

INSERT IGNORE INTO rtc_calls (
    call_id, legacy_call_id, caller_id, callee_id, call_type, status,
    initiated_at, answered_at, ended_at, ended_by, duration_seconds
)
SELECT
    UUID(), c.id, c.caller_id, c.callee_id, c.call_type, c.status,
    c.created_at,
    CASE WHEN c.status = 'completed' AND c.duration_seconds > 0 THEN c.created_at ELSE NULL END,
    DATE_ADD(c.created_at, INTERVAL GREATEST(c.duration_seconds, 0) SECOND),
    NULL,
    GREATEST(c.duration_seconds, 0)
FROM calls c;
