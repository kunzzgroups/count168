-- 公告已读状态（按登录账号，后端存储）
--
-- 主键 (user_type, user_id)：
--   user_type 'user'   -> `user`.id     （后台员工账号）
--   user_type 'owner'  -> `owner`.id
--   user_type 'member' -> `account`.id
-- 三张表的 id 空间会重叠，所以 user_type 必须进主键。
--
-- 未读规则（只在 DB 时钟里算）：
--   未读数 = company_code='C168' 且 status='active' 的公告中，created_at > last_read_at 的条数。
--   账号还没有本表记录时，接口会先 INSERT IGNORE 锚定 last_read_at = NOW()，
--   即新账号从「第一次取未读数」起算，不会因为历史公告突然出现一堆未读。
--   （`account` 表没有 created_at，所以不能用「账号创建时间」做基准。）
--
-- 回填：所有现有账号写入 last_read_at = 迁移时间，上线瞬间没人会看到旧公告的未读。
--
-- 可重复执行：CREATE TABLE IF NOT EXISTS + INSERT IGNORE。

CREATE TABLE IF NOT EXISTS `announcement_read_state` (
    `user_type`    enum('owner','user','member') NOT NULL,
    `user_id`      int(11) NOT NULL,
    `last_read_at` datetime NOT NULL COMMENT '该账号最后一次标记已读的时间（DB 时钟）',
    `updated_at`   datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
    PRIMARY KEY (`user_type`, `user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='公告已读状态 - 按登录账号（user/owner/member）记录';

INSERT IGNORE INTO `announcement_read_state` (`user_type`, `user_id`, `last_read_at`)
SELECT 'user', id, NOW() FROM `user`;

INSERT IGNORE INTO `announcement_read_state` (`user_type`, `user_id`, `last_read_at`)
SELECT 'owner', id, NOW() FROM `owner`;

INSERT IGNORE INTO `announcement_read_state` (`user_type`, `user_id`, `last_read_at`)
SELECT 'member', id, NOW() FROM `account`;
