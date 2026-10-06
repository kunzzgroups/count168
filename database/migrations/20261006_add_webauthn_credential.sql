-- WebAuthn / Passkey 凭据（Face ID / 指纹登录）
--
-- 只接受 ES256（平台验证器都用它）且注册时请求 attestation: "none"，
-- 所以不存 attestation 证书链，只存转换好的 SPKI PEM 公钥。
--
-- session_snapshot 与 device_token 表同款：注册时快照身份会话键，
-- 登录时整体还原，避免为三种身份（owner/user/member）复刻三分支会话重建。

CREATE TABLE IF NOT EXISTS `webauthn_credential` (
  `id`               bigint unsigned NOT NULL AUTO_INCREMENT,
  `user_type`        enum('owner','user','member') NOT NULL,
  `user_id`          int NOT NULL,
  `credential_id`    varbinary(255) NOT NULL COMMENT '验证器给的凭据 ID（原始字节）',
  `public_key_pem`   text NOT NULL COMMENT '由 COSE EC2 公钥转出的 SPKI PEM',
  `sign_count`       int unsigned NOT NULL DEFAULT 0,
  `device_name`      varchar(100) DEFAULT NULL,
  `session_snapshot` mediumtext DEFAULT NULL COMMENT '注册时的身份会话快照(JSON)',
  `created_at`       datetime NOT NULL DEFAULT current_timestamp(),
  `last_used_at`     datetime DEFAULT NULL,
  `revoked_at`       datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_credential` (`credential_id`),
  KEY `idx_user` (`user_type`,`user_id`,`revoked_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='WebAuthn/Passkey 凭据';
