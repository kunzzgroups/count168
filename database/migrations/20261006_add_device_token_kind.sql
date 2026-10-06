-- device_token 增加 kind 列：区分「移动端指纹解锁」与「网页端记住我」
--
-- 为什么要区分：两种凭据共用一张表（复用哈希存储、吊销、会话快照与三分支还原），
-- 但配额与「我的登录设备」列表**只应统计 biometric** —— 否则用户在几个浏览器上
-- 勾了记住我，就会占掉手机的 5 台上限，导致再也开不了指纹解锁。
--
-- 幂等：列已存在时只打印一行提示，不报错。
-- 背景：includes/device_token.php 的 device_token_ensure_kind_column() 会在请求内
-- 自动补这一列，而新建的表（create table 已含 kind）不需要补 —— 所以本脚本在两种
-- 环境下都可能被重复执行，必须容错。

SET @has_kind := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'device_token' AND COLUMN_NAME = 'kind'
);

SET @sql := IF(
  @has_kind = 0,
  'ALTER TABLE `device_token`
     ADD COLUMN `kind` varchar(20) NOT NULL DEFAULT ''biometric''
       COMMENT ''biometric=移动端指纹解锁, web=网页端记住我'' AFTER `user_id`,
     ADD KEY `idx_kind_user` (`kind`, `user_type`, `user_id`, `revoked_at`)',
  'SELECT ''device_token.kind 已存在，跳过'' AS note'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 已存在的行都来自移动端路径，DEFAULT 'biometric' 已覆盖，无需回填。
