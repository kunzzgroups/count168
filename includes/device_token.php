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

/** 同一账号最多可授权的设备数 */
const DEVICE_TOKEN_MAX_DEVICES = 5;

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
              KEY `idx_user` (`user_type`,`user_id`,`revoked_at`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
        );
    } catch (Throwable $e) {
        error_log('device_token_ensure_table failed: ' . $e->getMessage());
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
function device_token_count_active(PDO $pdo, string $userType, int $userId): int
{
    try {
        $stmt = $pdo->prepare(
            'SELECT COUNT(*) FROM device_token
             WHERE user_type = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > NOW()'
        );
        $stmt->execute([$userType, $userId]);

        return (int) $stmt->fetchColumn();
    } catch (Throwable $e) {
        error_log('device_token_count_active failed: ' . $e->getMessage());

        return 0;
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
    array $snapshot
): array {
    $userType = device_token_normalize_user_type($userType);
    if ($userType === '' || $userId <= 0) {
        return ['ok' => false, 'code' => 'BAD_PRINCIPAL'];
    }
    if (!device_token_is_valid_device_id($deviceId)) {
        return ['ok' => false, 'code' => 'BAD_DEVICE_ID'];
    }

    $encoded = device_token_encode_snapshot($snapshot);
    if ($encoded === null) {
        return ['ok' => false, 'code' => 'SNAPSHOT_TOO_LARGE'];
    }

    // 已有同设备记录时不占新名额
    try {
        $stmt = $pdo->prepare(
            'SELECT id FROM device_token WHERE user_type = ? AND user_id = ? AND device_id = ? LIMIT 1'
        );
        $stmt->execute([$userType, $userId, $deviceId]);
        $existing = $stmt->fetchColumn();

        if ($existing === false && device_token_count_active($pdo, $userType, $userId) >= DEVICE_TOKEN_MAX_DEVICES) {
            return ['ok' => false, 'code' => 'DEVICE_LIMIT'];
        }

        $plain = bin2hex(random_bytes(32));
        $hash = device_token_hash($plain);
        $stmt = $pdo->prepare(
            'INSERT INTO device_token
                (user_type, user_id, token_hash, device_id, device_name, session_snapshot, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? DAY))
             ON DUPLICATE KEY UPDATE
                token_hash       = VALUES(token_hash),
                device_name      = VALUES(device_name),
                session_snapshot = VALUES(session_snapshot),
                expires_at       = VALUES(expires_at),
                revoked_at       = NULL,
                last_used_at     = NULL,
                last_used_ip     = NULL'
        );
        $stmt->execute([
            $userType,
            $userId,
            $hash,
            $deviceId,
            $deviceName !== null && $deviceName !== '' ? mb_substr($deviceName, 0, 100) : null,
            $encoded,
            DEVICE_TOKEN_TTL_DAYS,
        ]);

        $stmt = $pdo->prepare(
            'SELECT expires_at FROM device_token WHERE user_type = ? AND user_id = ? AND device_id = ? LIMIT 1'
        );
        $stmt->execute([$userType, $userId, $deviceId]);

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
function device_token_resolve(PDO $pdo, string $plainToken, string $deviceId): array
{
    if (!preg_match('/^[0-9a-f]{64}$/', $plainToken)) {
        return ['ok' => false, 'code' => 'TOKEN_INVALID'];
    }
    if (!device_token_is_valid_device_id($deviceId)) {
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
        if (!hash_equals((string) $row['device_id'], $deviceId)) {
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
function device_token_revoke(PDO $pdo, string $userType, int $userId, ?string $deviceId = null): int
{
    $userType = device_token_normalize_user_type($userType);
    if ($userType === '' || $userId <= 0) {
        return 0;
    }

    try {
        if ($deviceId === null || $deviceId === '') {
            $stmt = $pdo->prepare(
                'UPDATE device_token SET revoked_at = NOW()
                 WHERE user_type = ? AND user_id = ? AND revoked_at IS NULL'
            );
            $stmt->execute([$userType, $userId]);
        } else {
            $stmt = $pdo->prepare(
                'UPDATE device_token SET revoked_at = NOW()
                 WHERE user_type = ? AND user_id = ? AND device_id = ? AND revoked_at IS NULL'
            );
            $stmt->execute([$userType, $userId, $deviceId]);
        }

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
function device_token_list(PDO $pdo, string $userType, int $userId): array
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
             WHERE user_type = ? AND user_id = ?
             ORDER BY is_active DESC, last_used_at DESC, created_at DESC'
        );
        $stmt->execute([$userType, $userId]);

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
