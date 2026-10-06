<?php
/**
 * 移动端生物识别解锁 —— 设备令牌。
 *
 * 四条设计取舍（勿轻改）：
 *
 * 1. 解锁时**不重新实现登录**。api/session/login_api.php 的三个身份分支
 *    (owner / user / member) 各自带 group-tenant、子公司、owner 专属逻辑，
 *    复刻必然随时间发散。改为「签发时快照身份会话键，解锁时还原」。
 *    好处：login 流程将来新增会话键会被自动捕获，不必回来改这里。
 *
 * 2. `secondary_password_verified` **永不快照、永不还原** —— 指纹解锁后必须
 *    重新输入二级密码。这是确认过的安全底线，见 device_token_excluded_session_keys()。
 *
 * 3. 明文令牌只在签发响应里出现一次，库内只存 sha256（uk_token_hash 走索引）。
 *
 * 4. 失败路径**不写库、不计次**。理由见 device_token_note_on_rate_limit()。
 */

/** 令牌有效期（天） */
const DEVICE_TOKEN_TTL_DAYS = 90;

/** 同一账号最多可授权的设备数（**只统计移动端指纹**，网页端记住我不占额度） */
const DEVICE_TOKEN_MAX_DEVICES = 5;

/** 移动端指纹解锁 */
const DEVICE_TOKEN_KIND_BIOMETRIC = 'biometric';

/** 网页端「记住我」 */
const DEVICE_TOKEN_KIND_WEB = 'web';

/** 网页端记住我有效期（天）。比移动端短：cookie 更易被复制 */
const DEVICE_TOKEN_WEB_TTL_DAYS = 30;

/** 网页端浏览器标识 cookie（非机密，只为让不同浏览器各自一条记录，而不是互相覆盖） */
const DEVICE_TOKEN_WEB_COOKIE = 'ec_web_device';

/**
 * 受信任凭据（指纹解锁 / 网页记住我）恢复会话时，是否跳过二级密码。
 *
 * ⚠️ 这个开关**推翻了**方案文档决策 4 的结论「二级密码必须重输」——
 * 那是当时经产品方确认的安全底线，现在是产品方明确要求改掉。
 *
 * 影响面（已核实）：二级密码在本项目里**只做登录门禁**，
 * 不参与交易审批或任何其它敏感动作。所以跳过它不会额外解锁任何能力，
 * 唯一的门槛从「已解锁手机 + 指纹 + 6 位码」变成「已解锁手机 + 指纹」
 * （网页端则是「拿到那个勾了记住我的浏览器」）。
 *
 * 要恢复原行为：把这里改成 false，**不需改其它任何地方**。
 */
const DEVICE_TOKEN_TRUSTED_SKIPS_SECONDARY = true;

/** 会话快照体积上限；超出则丢弃数组值（防某个账号的租户列表把行撑爆） */
const DEVICE_TOKEN_SNAPSHOT_MAX_BYTES = 65536;

/**
 * 会话快照中永不持久化的键。
 *
 * @return list<string>
 */
function device_token_excluded_session_keys(): array
{
    return [
        // 必须重新验证：指纹解锁不等于通过了二级密码
        'secondary_password_verified',
        // 必须刷新，不能还原签发时的旧值（会导致会话永不过期）
        'last_activity',
        // 派生自密码哈希。存进快照等于多复制一份密码哈希派生物；
        // 解锁后由 auth_session_password_stale() 自动重建（见 includes/auth_invalidation.php:107）
        'password_fingerprint',
    ];
}

/** 明文 → 库内存储值 */
function device_token_hash(string $plainToken): string
{
    return hash('sha256', $plainToken);
}

/**
 * device_id 合法性（签发与校验共用一份规则）。
 *
 * 必须挡在签发入口：空 device_id 会被 uk_device 当成一个共享槽位，
 * 而 device_token_resolve() 又拒绝空 device_id，结果是占着名额却永远解不开的死令牌。
 *
 * 长度只按列宽限制（1–64），不自定下限 —— 客户端约定是 UUID，但没理由
 * 因此把短 id 的客户端全拒了；uk_device 含 user_id，不存在跟别人撞位的风险。
 */
function device_token_is_valid_device_id(?string $deviceId): bool
{
    $deviceId = (string) $deviceId;

    return (bool) preg_match('/^[A-Za-z0-9._:-]{1,64}$/', $deviceId);
}

/** 归一化身份，非法值返回 '' */
function device_token_normalize_user_type(?string $userType): string
{
    $t = strtolower(trim((string) $userType));

    return in_array($t, ['owner', 'user', 'member'], true) ? $t : '';
}

/** 归一化 kind，非法值返回 '' */
function device_token_normalize_kind(?string $kind): string
{
    $k = strtolower(trim((string) $kind));

    return in_array($k, [DEVICE_TOKEN_KIND_BIOMETRIC, DEVICE_TOKEN_KIND_WEB], true) ? $k : '';
}

/** 幂等建表（仓库已有同款先例：api/domain/domain_api.php:501） */
function device_token_ensure_table(PDO $pdo): void
{
    static $done = false;
    if ($done) {
        return;
    }
    $done = true;

    try {
        $pdo->exec(
            "CREATE TABLE IF NOT EXISTS `device_token` (
              `id`               bigint unsigned NOT NULL AUTO_INCREMENT,
              `user_type`        enum('owner','user','member') NOT NULL,
              `kind`             varchar(20) NOT NULL DEFAULT 'biometric',
              `user_id`          int NOT NULL,
              `token_hash`       char(64) NOT NULL,
              `device_id`        varchar(64) NOT NULL,
              `device_name`      varchar(100) DEFAULT NULL,
              `session_snapshot` mediumtext DEFAULT NULL,
              `expires_at`       datetime NOT NULL,
              `last_used_at`     datetime DEFAULT NULL,
              `last_used_ip`     varbinary(16) DEFAULT NULL,
              `revoked_at`       datetime DEFAULT NULL,
              `created_at`       datetime NOT NULL DEFAULT current_timestamp(),
              PRIMARY KEY (`id`),
              UNIQUE KEY `uk_token_hash` (`token_hash`),
              UNIQUE KEY `uk_device` (`user_type`,`user_id`,`device_id`),
              KEY `idx_user` (`user_type`,`user_id`,`revoked_at`),
              KEY `idx_kind_user` (`kind`,`user_type`,`user_id`,`revoked_at`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
        );
    } catch (Throwable $e) {
        error_log('device_token_ensure_table failed: ' . $e->getMessage());
    }

    // 已存在的表不会被上面的 CREATE IF NOT EXISTS 补列
    device_token_ensure_kind_column($pdo);
}

/**
 * 幂等补 `kind` 列（旧表升级用）。
 *
 * 只在列缺失时 ALTER，且每个请求最多试一次 —— 仓库里已有同款先例：
 * api/includes/auto_renew.php:384 的 auto_renew_ensure_request_table_columns()。
 */
function device_token_ensure_kind_column(PDO $pdo): void
{
    static $done = false;
    if ($done) {
        return;
    }
    $done = true;

    try {
        $stmt = $pdo->query("SHOW COLUMNS FROM `device_token` LIKE 'kind'");
        if ($stmt !== false && $stmt->fetch(PDO::FETCH_ASSOC)) {
            return;
        }
        $pdo->exec(
            "ALTER TABLE `device_token`
               ADD COLUMN `kind` varchar(20) NOT NULL DEFAULT 'biometric' AFTER `user_id`,
               ADD KEY `idx_kind_user` (`kind`,`user_type`,`user_id`,`revoked_at`)"
        );
    } catch (Throwable $e) {
        // 列已存在 / 无 ALTER 权限都不应阻断登录
        error_log('device_token_ensure_kind_column: ' . $e->getMessage());
    }
}

/**
 * 关于「限流」的取舍记录（方案文档 §5.3 ⑤ 原标为必做）：
 *
 * 未实现计数表，原因有两条：
 *   a) 令牌是 256 位随机 hex，暴力枚举在密码学上不可行，计数表防不了它；
 *   b) 计数表要为每个失败请求**多写一次库**，而失败请求正是洪水攻击的形态
 *      —— 它会放大而非缓解 DoS。
 * 因此失败路径只做一次走索引的 SELECT，不写库、不 touch last_used。
 * 若将来需要按 IP 限流，应放在网关/Nginx 层，而不是这个端点里。
 */

/**
 * 取身份主体的最小必要字段（存在性 + 状态 + 备用）
 *
 * @return array{login_id:string,status:string,name:string}|null
 */
function device_token_fetch_principal(PDO $pdo, string $userType, int $userId): ?array
{
    try {
        if ($userType === 'owner') {
            $stmt = $pdo->prepare('SELECT id, owner_code, name, status FROM owner WHERE id = ? LIMIT 1');
            $stmt->execute([$userId]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);

            return $row ? [
                'login_id' => (string) ($row['owner_code'] ?? ''),
                'name'     => (string) ($row['name'] ?? ''),
                'status'   => (string) ($row['status'] ?? ''),
            ] : null;
        }

        if ($userType === 'member') {
            $stmt = $pdo->prepare('SELECT id, account_id, name, status FROM account WHERE id = ? LIMIT 1');
            $stmt->execute([$userId]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);

            return $row ? [
                'login_id' => (string) ($row['account_id'] ?? ''),
                'name'     => (string) ($row['name'] ?? ''),
                'status'   => (string) ($row['status'] ?? ''),
            ] : null;
        }

        $stmt = $pdo->prepare('SELECT id, login_id, name, status FROM user WHERE id = ? LIMIT 1');
        $stmt->execute([$userId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        return $row ? [
            'login_id' => (string) ($row['login_id'] ?? ''),
            'name'     => (string) ($row['name'] ?? ''),
            'status'   => (string) ($row['status'] ?? ''),
        ] : null;
    } catch (Throwable $e) {
        error_log('device_token_fetch_principal failed: ' . $e->getMessage());

        return null;
    }
}

/**
 * 抓取当前会话中的身份键。
 *
 * 保留标量 + 数组（api/session/login_api.php 会把 assigned_company_ids /
 * assigned_group_codes 这类数组写进会话，还原时要一并带回）。
 * 跳过 `_` 前缀（_spa_user_payload_cache 之类的一次性缓存）。
 *
 * @return array<string, mixed>
 */
function device_token_capture_session(): array
{
    $exclude = device_token_excluded_session_keys();
    $snapshot = [];

    foreach ($_SESSION as $key => $value) {
        if (!is_string($key) || $key === '' || strncmp($key, '_', 1) === 0) {
            continue;
        }
        if (in_array($key, $exclude, true)) {
            continue;
        }
        $snapshot[$key] = $value;
    }

    return $snapshot;
}

/** 快照编码；超限则丢弃数组值再试，仍超限则报错交回调用方 */
function device_token_encode_snapshot(array $snapshot): ?string
{
    $json = json_encode($snapshot, JSON_UNESCAPED_UNICODE);
    if ($json === false) {
        return null;
    }
    if (strlen($json) <= DEVICE_TOKEN_SNAPSHOT_MAX_BYTES) {
        return $json;
    }

    $scalarsOnly = array_filter($snapshot, static fn($v) => is_scalar($v) || $v === null);
    $json = json_encode($scalarsOnly, JSON_UNESCAPED_UNICODE);
    if ($json === false || strlen($json) > DEVICE_TOKEN_SNAPSHOT_MAX_BYTES) {
        return null;
    }

    return $json;
}

/**
 * 还原会话。
 *
 * 先整体重置（与 login_api.php:64 的 session_unset() 行为对齐），再灌入快照，
 * 最后 unset 二级密码标记作为第二道保险 —— 即使快照被污染也不会放行二级密码。
 *
 * @param array<string, mixed> $snapshot
 */
function device_token_restore_session(array $snapshot): void
{
    $exclude = device_token_excluded_session_keys();
    $_SESSION = [];

    foreach ($snapshot as $key => $value) {
        if (!is_string($key) || $key === '' || strncmp($key, '_', 1) === 0) {
            continue;
        }
        if (in_array($key, $exclude, true)) {
            continue;
        }
        $_SESSION[$key] = $value;
    }

    // 安全底线：第二道保险
    unset($_SESSION['secondary_password_verified']);
    $_SESSION['last_activity'] = time();
}

/** 当前账号已授权的设备数（未吊销且未过期） */
function device_token_count_active(PDO $pdo, string $userType, int $userId, string $kind = DEVICE_TOKEN_KIND_BIOMETRIC): int
{
    try {
        $stmt = $pdo->prepare(
            'SELECT COUNT(*) FROM device_token
             WHERE user_type = ? AND user_id = ? AND kind = ? AND revoked_at IS NULL AND expires_at > NOW()'
        );
        $stmt->execute([$userType, $userId, $kind]);

        return (int) $stmt->fetchColumn();
    } catch (Throwable $e) {
        error_log('device_token_count_active failed: ' . $e->getMessage());

        return 0;
    }
}

/**
 * 超限时淘汰「最久未用」的那一台（吐销，保留历史）。
 *
 * 为什么需要自愈：设备管理界面已按产品要求去掉，但硬上限还在。
 * 没有界面又没有自愈，用户重装 App 五次就会永久无法再开启指纹解锁 —— 无法自救。
 *
 * 排序用 COALESCE(last_used_at, created_at)：从未用过的记录按创建时间参与比较，
 * 所以“最近用过”比“创建得早”更不容易被淘汰。同值时按 id 升序，保证确定性。
 *
 * @return bool 是否真的腾出了位置
 */
function device_token_evict_lru(PDO $pdo, string $userType, int $userId, string $kind): bool
{
    try {
        $stmt = $pdo->prepare(
            'SELECT id FROM device_token
             WHERE user_type = ? AND user_id = ? AND kind = ?
               AND revoked_at IS NULL AND expires_at > NOW()
             ORDER BY COALESCE(last_used_at, created_at) ASC, id ASC
             LIMIT 1'
        );
        $stmt->execute([$userType, $userId, $kind]);
        $victim = $stmt->fetchColumn();
        if ($victim === false) {
            return false;
        }

        error_log(sprintf(
            'device_token_evict_lru: user_type=%s user_id=%d kind=%s evicted id=%d',
            $userType,
            $userId,
            $kind,
            (int) $victim
        ));

        $upd = $pdo->prepare('UPDATE device_token SET revoked_at = NOW() WHERE id = ?');
        $upd->execute([(int) $victim]);

        return $upd->rowCount() > 0;
    } catch (Throwable $e) {
        error_log('device_token_evict_lru failed: ' . $e->getMessage());

        return false;
    }
}

/**
 * 签发令牌。同一账号同一设备重复开启 = 覆盖旧令牌（uk_device）。
 *
 * @param array<string, mixed> $snapshot
 * @return array{ok:bool,code:string,token?:string,expires_at?:string}
 */
function device_token_issue(
    PDO $pdo,
    string $userType,
    int $userId,
    string $deviceId,
    ?string $deviceName,
    array $snapshot,
    string $kind = DEVICE_TOKEN_KIND_BIOMETRIC,
    int $ttlDays = DEVICE_TOKEN_TTL_DAYS
): array {
    $userType = device_token_normalize_user_type($userType);
    if ($userType === '' || $userId <= 0) {
        return ['ok' => false, 'code' => 'BAD_PRINCIPAL'];
    }
    $kind = device_token_normalize_kind($kind);
    if ($kind === '') {
        return ['ok' => false, 'code' => 'BAD_KIND'];
    }
    if (!device_token_is_valid_device_id($deviceId)) {
        return ['ok' => false, 'code' => 'BAD_DEVICE_ID'];
    }
    $ttlDays = max(1, min(365, $ttlDays));

    $encoded = device_token_encode_snapshot($snapshot);
    if ($encoded === null) {
        return ['ok' => false, 'code' => 'SNAPSHOT_TOO_LARGE'];
    }

    // 已有同设备记录时不占新名额
    try {
        $stmt = $pdo->prepare(
            'SELECT id FROM device_token
             WHERE user_type = ? AND user_id = ? AND device_id = ? AND kind = ? LIMIT 1'
        );
        $stmt->execute([$userType, $userId, $deviceId, $kind]);
        $existing = $stmt->fetchColumn();

        // 配额只看同 kind：网页端记住我不能占掉手机的 5 台指纹额度
        if ($existing === false
            && device_token_count_active($pdo, $userType, $userId, $kind) >= DEVICE_TOKEN_MAX_DEVICES) {
            // 产品要求「设置里只要一个开关」，所以设备管理界面被去掉了。
            // 没有界面却保留硬上限，会让多次重装 App 的用户永久卡死
            // （重装会换 device_id，旧记录一直占位）—— 所以改为自愈式淘汰。
            // 仍把 DEVICE_LIMIT 留着做兜底：淘汰失败时不静默丢凭据。
            if (!device_token_evict_lru($pdo, $userType, $userId, $kind)
                || device_token_count_active($pdo, $userType, $userId, $kind) >= DEVICE_TOKEN_MAX_DEVICES) {
                return ['ok' => false, 'code' => 'DEVICE_LIMIT'];
            }
        }

        $plain = bin2hex(random_bytes(32));
        $hash = device_token_hash($plain);
        $stmt = $pdo->prepare(
            'INSERT INTO device_token
                (user_type, kind, user_id, token_hash, device_id, device_name, session_snapshot, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? DAY))
             ON DUPLICATE KEY UPDATE
                token_hash       = VALUES(token_hash),
                kind             = VALUES(kind),
                device_name      = VALUES(device_name),
                session_snapshot = VALUES(session_snapshot),
                expires_at       = VALUES(expires_at),
                revoked_at       = NULL,
                last_used_at     = NULL,
                last_used_ip     = NULL'
        );
        $stmt->execute([
            $userType,
            $kind,
            $userId,
            $hash,
            $deviceId,
            $deviceName !== null && $deviceName !== '' ? mb_substr($deviceName, 0, 100) : null,
            $encoded,
            $ttlDays,
        ]);

        $stmt = $pdo->prepare(
            'SELECT expires_at FROM device_token
             WHERE user_type = ? AND user_id = ? AND device_id = ? AND kind = ? LIMIT 1'
        );
        $stmt->execute([$userType, $userId, $deviceId, $kind]);

        return [
            'ok'         => true,
            'code'       => 'OK',
            'token'      => $plain,
            'expires_at' => (string) $stmt->fetchColumn(),
        ];
    } catch (Throwable $e) {
        error_log('device_token_issue failed: ' . $e->getMessage());

        return ['ok' => false, 'code' => 'SERVER_ERROR'];
    }
}

/**
 * 校验令牌 + 设备绑定。
 *
 * @return array{ok:bool,code:string,row?:array<string,mixed>}
 */
/**
 * 校验令牌。
 *
 * @param string|null $deviceId 移动端传设备 id 做绑定校验；**网页端传 null 跳过绑定**
 *                              （浏览器没有移动端那种稳定设备标识）
 * @param string|null $kind     null = 不限；否则只接受该 kind
 * @return array{ok:bool,code:string,row?:array<string,mixed>}
 */
function device_token_resolve(
    PDO $pdo,
    string $plainToken,
    ?string $deviceId = null,
    ?string $kind = null
): array {
    if (!preg_match('/^[0-9a-f]{64}$/', $plainToken)) {
        return ['ok' => false, 'code' => 'TOKEN_INVALID'];
    }
    if ($deviceId !== null && !device_token_is_valid_device_id($deviceId)) {
        return ['ok' => false, 'code' => 'TOKEN_INVALID'];
    }
    if ($kind !== null && device_token_normalize_kind($kind) === '') {
        return ['ok' => false, 'code' => 'TOKEN_INVALID'];
    }
    try {
        // 先按 hash 取，再区分「不存在 / 设备不匹配 / 已吊销 / 已过期」，
        // 便于前端决定是重试还是直接跳密码登录。
        $stmt = $pdo->prepare('SELECT * FROM device_token WHERE token_hash = ? LIMIT 1');
        $stmt->execute([device_token_hash($plainToken)]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        if (!$row) {
            return ['ok' => false, 'code' => 'TOKEN_INVALID'];
        }
        if ($deviceId !== null && !hash_equals((string) $row['device_id'], $deviceId)) {
            return ['ok' => false, 'code' => 'TOKEN_INVALID'];
        }
        // kind 列缺失时按 biometric 处理，避免旧表未升级就卡死移动端
        if ($kind !== null && (string) ($row['kind'] ?? DEVICE_TOKEN_KIND_BIOMETRIC) !== $kind) {
            return ['ok' => false, 'code' => 'TOKEN_INVALID'];
        }
        if (!empty($row['revoked_at'])) {
            return ['ok' => false, 'code' => 'TOKEN_REVOKED'];
        }

        $stmt = $pdo->prepare('SELECT NOW() > expires_at FROM device_token WHERE id = ?');
        $stmt->execute([(int) $row['id']]);
        if ((int) $stmt->fetchColumn() === 1) {
            return ['ok' => false, 'code' => 'TOKEN_EXPIRED'];
        }

        return ['ok' => true, 'code' => 'OK', 'row' => $row];
    } catch (Throwable $e) {
        error_log('device_token_resolve failed: ' . $e->getMessage());

        return ['ok' => false, 'code' => 'SERVER_ERROR'];
    }
}

/** 记录一次成功使用（只在成功路径写库） */
function device_token_touch(PDO $pdo, int $id): void
{
    try {
        $ip = $_SERVER['REMOTE_ADDR'] ?? null;
        $stmt = $pdo->prepare('UPDATE device_token SET last_used_at = NOW(), last_used_ip = ? WHERE id = ?');
        $stmt->execute([$ip !== null && $ip !== '' ? @inet_pton($ip) ?: null : null, $id]);
    } catch (Throwable $e) {
        error_log('device_token_touch failed: ' . $e->getMessage());
    }
}

/**
 * 吊销。$deviceId 为 null 表示吊销该账号全部设备。
 *
 * @return int 受影响行数
 */
function device_token_revoke(
    PDO $pdo,
    string $userType,
    int $userId,
    ?string $deviceId = null,
    ?string $kind = null
): int {
    $userType = device_token_normalize_user_type($userType);
    if ($userType === '' || $userId <= 0) {
        return 0;
    }
    if ($kind !== null && device_token_normalize_kind($kind) === '') {
        return 0;
    }

    try {
        $where = 'user_type = ? AND user_id = ? AND revoked_at IS NULL';
        $params = [$userType, $userId];
        if ($deviceId !== null && $deviceId !== '') {
            $where .= ' AND device_id = ?';
            $params[] = $deviceId;
        }
        if ($kind !== null) {
            $where .= ' AND kind = ?';
            $params[] = $kind;
        }

        $stmt = $pdo->prepare("UPDATE device_token SET revoked_at = NOW() WHERE $where");
        $stmt->execute($params);

        return $stmt->rowCount();
    } catch (Throwable $e) {
        error_log('device_token_revoke failed: ' . $e->getMessage());

        return 0;
    }
}

/**
 * 列出该账号的授权设备（含已吊销，便于「我的登录设备」页展示历史）。
 *
 * @return list<array<string,mixed>>
 */
function device_token_list(PDO $pdo, string $userType, int $userId, string $kind = DEVICE_TOKEN_KIND_BIOMETRIC): array
{
    $userType = device_token_normalize_user_type($userType);
    if ($userType === '' || $userId <= 0) {
        return [];
    }

    try {
        $stmt = $pdo->prepare(
            'SELECT id, device_id, device_name, expires_at, last_used_at, revoked_at, created_at,
                    (revoked_at IS NULL AND expires_at > NOW()) AS is_active
             FROM device_token
             WHERE user_type = ? AND user_id = ? AND kind = ?
             ORDER BY is_active DESC, last_used_at DESC, created_at DESC'
        );
        $stmt->execute([$userType, $userId, $kind]);

        return $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
    } catch (Throwable $e) {
        error_log('device_token_list failed: ' . $e->getMessage());

        return [];
    }
}

/**
 * 指纹解锁后是否仍需二级密码；需要则返回应跳转的路由。
 *
 * 逐个身份复刻 api/session/current_user_api.php 的既有判定：
 *   - owner (:102-105)          → 总是需要
 *   - user  + 公司为 C168 (:167-178) → 仅当 user.secondary_password 非空
 *   - member                    → 无二级密码概念
 *
 * 注意：不要改成读 $_SESSION['secondary_password_verified'] —— device_token_restore_session()
 * 已保证它不存在，这里只回答「这个身份本身是否需要二级密码」。
 *
 * @param array<string, mixed> $snapshot
 */
function device_token_secondary_password_redirect(
    PDO $pdo,
    string $userType,
    int $userId,
    array $snapshot
): ?string {
    if ($userType === 'owner') {
        return '/owner-secondary-password';
    }
    if ($userType !== 'user') {
        return null;
    }

    try {
        $companyCode = strtoupper(trim((string) ($snapshot['company_code'] ?? '')));
        $companyId = isset($snapshot['company_id']) ? (int) $snapshot['company_id'] : 0;

        if ($companyCode === '' && $companyId > 0) {
            $stmt = $pdo->prepare('SELECT company_id FROM company WHERE id = ? LIMIT 1');
            $stmt->execute([$companyId]);
            $companyCode = strtoupper(trim((string) $stmt->fetchColumn()));
        }
        if ($companyCode !== 'C168') {
            return null;
        }

        $stmt = $pdo->prepare('SELECT secondary_password FROM user WHERE id = ? LIMIT 1');
        $stmt->execute([$userId]);

        return !empty($stmt->fetchColumn()) ? '/user-secondary-password' : null;
    } catch (Throwable $e) {
        error_log('device_token_secondary_password_redirect failed: ' . $e->getMessage());

        // 判不出来时按「需要」处理，故障安全
        return $userType === 'user' ? '/user-secondary-password' : null;
    }
}

/**
 * 公司/组是否已过期（member 与 user 适用；owner 走 group 判定）。
 *
 * @param array<string, mixed> $snapshot
 */
function device_token_company_expired(PDO $pdo, array $snapshot): bool
{
    $companyId = isset($snapshot['company_id']) ? (int) $snapshot['company_id'] : 0;
    $companyCode = trim((string) ($snapshot['company_code'] ?? ''));

    // 缺依赖就退回「未过期」：过期在 login / session_check 另有强制点，
    // 而这里误判为已过期会让记住我彻底不可用（比漏抦一个已过期公司更糟）。
    if (!function_exists('gc_is_company_expiration_blocking')) {
        return false;
    }

    try {
        if ($companyId <= 0) {
            // Group 登录：company_id 为 null，用 groups 表判定
            if ($companyCode === '' || !function_exists('gt_v2_fetch_active_group_row')) {
                return false;
            }
            $group = gt_v2_fetch_active_group_row($pdo, $companyCode);

            return $group === null;
        }

        $stmt = $pdo->prepare('SELECT company_id, group_id, expiration_date FROM company WHERE id = ? LIMIT 1');
        $stmt->execute([$companyId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            return true;
        }

        return gc_is_company_expiration_blocking(
            $row['expiration_date'] ?? null,
            (string) ($row['company_id'] ?? ''),
            (string) ($row['group_id'] ?? '')
        );
    } catch (Throwable $e) {
        error_log('device_token_company_expired failed: ' . $e->getMessage());

        // 查不出来时按「已过期」处理，故障安全
        return true;
    }
}

/**
 * 按明文令牌精确吐销一条（登出 / 取消记住我用）。
 *
 * 与 device_token_revoke() 的区别：后者按「账号」刷一片，这个只打中当前 cookie
 * 对应的那一条，所以不会把用户其它浏览器的记住我一起干掉。
 */
function device_token_revoke_by_token(PDO $pdo, string $plainToken, ?string $kind = null): int
{
    if (!preg_match('/^[0-9a-f]{64}$/', $plainToken)) {
        return 0;
    }

    try {
        $sql = 'UPDATE device_token SET revoked_at = NOW() WHERE token_hash = ? AND revoked_at IS NULL';
        $params = [device_token_hash($plainToken)];
        if ($kind !== null) {
            $sql .= ' AND kind = ?';
            $params[] = $kind;
        }
        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);

        return $stmt->rowCount();
    } catch (Throwable $e) {
        error_log('device_token_revoke_by_token failed: ' . $e->getMessage());

        return 0;
    }
}

/**
 * 网页端浏览器标识（非机密）。
 *
 * 为何要单独一个 cookie：uk_device 是 (user_type,user_id,device_id)。
 * 若每次登录用随机 id，同账号会堆出无数行；若都用固定值，则不同浏览器互相覆盖
 * —— 那正是现有 user.remember_token 单列的老毛病（见方案文档事实 #7）。
 * per-browser 稳定 id 是这里唯一合适的选择。
 */
function device_token_web_device_id(): string
{
    $existing = strtolower(trim((string) ($_COOKIE[DEVICE_TOKEN_WEB_COOKIE] ?? '')));
    if (preg_match('/^[0-9a-f]{32}$/', $existing)) {
        return $existing;
    }

    $id = bin2hex(random_bytes(16));
    if (!headers_sent()) {
        $params = session_get_cookie_params();
        setcookie(DEVICE_TOKEN_WEB_COOKIE, $id, [
            'expires' => time() + (400 * 24 * 60 * 60),
            'path' => '/',
            'domain' => $params['domain'] ?: '',
            'secure' => function_exists('auth_cookie_secure_flag') ? auth_cookie_secure_flag() : true,
            'httponly' => true,
            'samesite' => 'Lax',
        ]);
    }

    return $id;
}

/** 设备名，仅用于日后在「登录设备」里区分浏览器 */
function device_token_web_device_name(): string
{
    $ua = trim((string) ($_SERVER['HTTP_USER_AGENT'] ?? ''));

    return mb_substr($ua !== '' ? $ua : 'Web browser', 0, 100);
}

/**
 * 网页端「记住我」。供 api/session/login_api.php 在 owner / member 分支的响应前调用。
 *
 * - 勾了：签发一条 kind='web' 的令牌并写 remember_token cookie
 * - 没勾：只吐销当前 cookie 对应的那一条并清 cookie
 *
 * 全程吞异常：记住我失败绝不能把登录本身搞挂。
 * 只在 owner / member 调用 —— user 身份走旧的 user.remember_token 列，保持原样不动。
 */
function device_token_web_remember_issue(PDO $pdo, string $userType, int $userId): void
{
    try {
        $userType = device_token_normalize_user_type($userType);
        if ($userType === '' || $userId <= 0) {
            return;
        }

        $existing = (string) ($_COOKIE['remember_token'] ?? '');

        if (empty($_POST['remember_me'])) {
            if ($existing !== '') {
                device_token_revoke_by_token($pdo, $existing, DEVICE_TOKEN_KIND_WEB);
            }
            if (function_exists('clear_remember_token_cookie')) {
                clear_remember_token_cookie();
            }

            return;
        }

        $issued = device_token_issue(
            $pdo,
            $userType,
            $userId,
            device_token_web_device_id(),
            device_token_web_device_name(),
            device_token_capture_session(),
            DEVICE_TOKEN_KIND_WEB,
            DEVICE_TOKEN_WEB_TTL_DAYS
        );

        if (!$issued['ok']) {
            error_log('device_token_web_remember_issue: ' . $issued['code']);

            return;
        }

        $ttlSeconds = DEVICE_TOKEN_WEB_TTL_DAYS * 86400;
        if (headers_sent()) {
            // 响应已开始输出，cookie 写不进去了。正常登录流程有 ob_start，不会走到这。
            error_log('device_token_web_remember_issue: headers already sent, cookie skipped');

            return;
        }
        if (function_exists('auth_set_remember_token_cookie')) {
            auth_set_remember_token_cookie($issued['token'], $ttlSeconds);
        } else {
            setcookie('remember_token', $issued['token'], time() + $ttlSeconds, '/');
        }
    } catch (Throwable $e) {
        error_log('device_token_web_remember_issue failed: ' . $e->getMessage());
    }
}

/**
 * 二级密码**是否尚未满足**（true = 必须先过二级密码）。
 *
 * 判定与 session_check.php / current_user_api.php 一致：
 * 只有 owner、以及所在公司为 C168 且已设二级密码的 user 才需要。
 * 供 passkey / 设备令牌的注册与移除做门槛 —— 不能用「标记是否已置位」
 * 直接当门槛，因为非 C168 用户本来就不会置位。
 */
function device_token_secondary_password_pending(
    PDO $pdo,
    string $userType,
    int $userId,
    array $snapshot
): bool {
    if (($snapshot['secondary_password_verified'] ?? null) === true) {
        return false;
    }

    return device_token_secondary_password_redirect($pdo, $userType, $userId, $snapshot) !== null;
}

/**
 * 受信任凭据（指纹解锁 / 网页记住我 / passkey）恢复会话后的二级密码收尾。
 *
 * ⚠️ 关键点：身份**本来就不需要**二级密码时也必须置位。
 * 该标记的语义是「本会话不再卡在二级密码上」—— login_api.php 一直都是这么做的，
 * 而当初恢复会话的路径只在“需要二级密码”时才置位，导致非 C168 的用户
 * （例如 95 · IG）在会话被恢复后，注册/移除 passkey 会误报「请先验证二级密码」。
 */
function device_token_apply_trusted_secondary_policy(
    PDO $pdo,
    string $userType,
    int $userId,
    array $snapshot
): void {
    $needs = device_token_secondary_password_redirect($pdo, $userType, $userId, $snapshot) !== null;
    if (!$needs || DEVICE_TOKEN_TRUSTED_SKIPS_SECONDARY) {
        $_SESSION['secondary_password_verified'] = true;
    }
}

/**
 * 用 remember_token cookie 恢复会话（网页端免登录），只处理 kind='web'。
 *
 * user 身份的旧路径（user.remember_token 明文列）由 current_user_api.php 自行处理并
 * **保留原样**；本函数是它之后追加的回退，服务 owner / member —— 这两种身份此前
 * 完全没有可用的记住我（owner 是空壳分支，account 表根本没那一列）。
 *
 * @return bool 是否成功恢复
 */
function device_token_try_restore_from_cookie(PDO $pdo): bool
{
    $plain = (string) ($_COOKIE['remember_token'] ?? '');
    if ($plain === '') {
        return false;
    }

    $resolved = device_token_resolve($pdo, $plain, null, DEVICE_TOKEN_KIND_WEB);
    if (!$resolved['ok']) {
        // 永久失效就清掉 cookie，避免每次引导都白查一次
        if (function_exists('clear_remember_token_cookie')) {
            clear_remember_token_cookie();
        }

        return false;
    }

    $row = $resolved['row'];
    $userType = device_token_normalize_user_type((string) $row['user_type']);
    $userId = (int) $row['user_id'];
    if ($userType === '' || $userId <= 0) {
        return false;
    }

    $snapshot = json_decode((string) ($row['session_snapshot'] ?? ''), true);
    if (!is_array($snapshot) || (int) ($snapshot['user_id'] ?? 0) !== $userId) {
        return false;
    }

    $principal = device_token_fetch_principal($pdo, $userType, $userId);
    if ($principal === null || strtolower($principal['status']) !== 'active') {
        device_token_revoke_by_token($pdo, $plain, DEVICE_TOKEN_KIND_WEB);

        return false;
    }
    if (device_token_company_expired($pdo, $snapshot)) {
        return false;
    }

    // 快照里永远不会有 secondary_password_verified（见 device_token_excluded_session_keys），
    // 所以恢复后二级密码仍会被强制要求。
    device_token_restore_session($snapshot);
    if ((int) ($_SESSION['user_id'] ?? 0) !== $userId
        || (string) ($_SESSION['user_type'] ?? '') !== $userType) {
        return false;
    }

    // 受信任凭据的二级密码收尾（见 device_token_apply_trusted_secondary_policy 的说明）。
    // 必须在 device_token_restore_session() **之后**调，因为还原会清掉这个标记。
    device_token_apply_trusted_secondary_policy($pdo, $userType, $userId, $snapshot);

    device_token_touch($pdo, (int) $row['id']);

    return true;
}
