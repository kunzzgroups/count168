-- 移动端生物识别解锁 —— 设备令牌
--
-- 三种登录身份各自一张表：owner(owner) / user(user) / member(account)。
-- 现有 user.remember_token 只覆盖 user 一种身份，且是单设备（一个列=一台设备），
-- 所以移动端新增这张表：多设备、可单独吊销、明文不落库。
--
-- 冗余建表说明：仓库内已有 CREATE TABLE IF NOT EXISTS 的运行期建表先例
-- （api/domain/domain_api.php:501、api/datacapture/group_capture_draft_api.php:37 等），
-- includes/device_token.php 也带了同样的幂等兜底，本文件供 DBA 手动执行/存档。

CREATE TABLE IF NOT EXISTS `device_token` (
  `id`               bigint unsigned NOT NULL AUTO_INCREMENT,
  `user_type`        enum('owner','user','member') NOT NULL COMMENT '对应 owner / user / account 三张表',
  `user_id`          int NOT NULL,
  `token_hash`       char(64) NOT NULL COMMENT 'sha256(明文令牌)，明文不落库',
  `device_id`        varchar(64) NOT NULL COMMENT '客户端 UUID，同一设备恒定',
  `device_name`      varchar(100) DEFAULT NULL COMMENT '如 Xiaomi 14 / Android 15',
  `session_snapshot` mediumtext DEFAULT NULL COMMENT '签发时的身份会话快照(JSON)。secondary_password_verified 永不入内',
  `expires_at`       datetime NOT NULL COMMENT '默认 90 天',
  `last_used_at`     datetime DEFAULT NULL,
  `last_used_ip`     varbinary(16) DEFAULT NULL,
  `revoked_at`       datetime DEFAULT NULL,
  `created_at`       datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_token_hash` (`token_hash`),
  UNIQUE KEY `uk_device` (`user_type`,`user_id`,`device_id`),
  KEY `idx_user` (`user_type`,`user_id`,`revoked_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='移动端生物识别解锁的设备令牌';
