CREATE TABLE IF NOT EXISTS rtc_calls (
    id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE,
    call_id             CHAR(36) PRIMARY KEY,
    legacy_call_id      INT NULL UNIQUE,
    caller_id           INT NOT NULL,
    callee_id           INT NOT NULL,
    call_type           ENUM('audio', 'video') NOT NULL,
    status              ENUM(
                            'ringing',
                            'active',
                            'completed',
                            'declined',
                            'cancelled',
                            'missed',
                            'busy',
                            'failed'
                        ) NOT NULL,
    initiated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    answered_at         DATETIME NULL,
    ended_at            DATETIME NULL,
    ended_by            INT NULL,
    duration_seconds    INT UNSIGNED NOT NULL DEFAULT 0,
    INDEX idx_rtc_calls_caller_time (caller_id, initiated_at),
    INDEX idx_rtc_calls_callee_time (callee_id, initiated_at),
    INDEX idx_rtc_calls_status (status),
    CONSTRAINT fk_rtc_calls_caller
        FOREIGN KEY (caller_id) REFERENCES users(UID) ON DELETE CASCADE,
    CONSTRAINT fk_rtc_calls_callee
        FOREIGN KEY (callee_id) REFERENCES users(UID) ON DELETE CASCADE,
    CONSTRAINT fk_rtc_calls_ended_by
        FOREIGN KEY (ended_by) REFERENCES users(UID) ON DELETE SET NULL,
    CONSTRAINT chk_rtc_calls_distinct_users CHECK (caller_id <> callee_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
