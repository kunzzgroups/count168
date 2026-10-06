<?php
/**
 * 用户列表 CRUD API（创建/更新/删除/获取用户）
 * 路径: api/users/userlist_api.php
 */
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

require_once __DIR__ . '/../../includes/config.php';
require_once __DIR__ . '/../../includes/password_hashing.php';
require_once __DIR__ . '/../../includes/email_validation.php';
require_once __DIR__ . '/../../includes/auth_invalidation.php';
require_once __DIR__ . '/../includes/partnership_audit_readonly.php';
require_once __DIR__ . '/../../includes/group_company_access.php';
require_once __DIR__ . '/../../includes/group_scope_resolve.php';
require_once __DIR__ . '/../../includes/permissions.php';
require_once __DIR__ . '/../get_companies_helper.php';

session_start();
session_write_close(); // 释放 session 锁，允许并发 AJAX 请求并行执行

// 检查用户是否登录（集团登录可无 session company_id）
if (!isset($_SESSION['user_id']) || (int) $_SESSION['user_id'] <= 0) {
    sendResponse(false, 'Unauthorized access', null);
}

$current_company_id = (int) ($_SESSION['company_id'] ?? 0);
if ($current_company_id <= 0 && gc_is_group_login()) {
    $loginGroup = gc_session_login_identifier();
    if ($loginGroup !== null && $loginGroup !== '') {
        $current_company_id = gc_resolve_group_anchor_company_id($pdo, $loginGroup);
    }
}
$current_user_role = $_SESSION['role'] ?? '';

function canCreateUserByRole($role): bool {
    $hierarchy = [
        'owner' => 0,
        'partnership' => 1,
        'admin' => 2,
        'manager' => 3,
        'supervisor' => 4,
        'accountant' => 5,
        'audit' => 6,
        'customer service' => 7,
    ];
    $normalized = strtolower(trim((string)$role));
    $level = $hierarchy[$normalized] ?? 999;
    return $level < 4;
}

function userlistRoleLevel(string $role): int {
    $hierarchy = [
        'owner' => 0,
        'partnership' => 1,
        'admin' => 2,
        'manager' => 3,
        'supervisor' => 4,
        'accountant' => 5,
        'audit' => 6,
        'customer service' => 7,
    ];
    return $hierarchy[strtolower(trim($role))] ?? 999;
}

function userlist_can_edit_target_access(string $currentRole, string $targetRole, int $currentUserId, int $targetUserId): bool
{
    if ($currentUserId <= 0 || $targetUserId <= 0 || $currentUserId === $targetUserId) {
        return false;
    }
    return userlistRoleLevel($currentRole) < userlistRoleLevel($targetRole);
}

/** Non-owner may update own Acc/Process flags (self_hidden only; cannot clear superior_closed). */
function userlist_can_edit_own_account_access(string $currentRole, int $currentUserId, int $targetUserId): bool
{
    if ($currentUserId <= 0 || $targetUserId <= 0 || $currentUserId !== $targetUserId) {
        return false;
    }
    return strtolower(trim($currentRole)) !== 'owner';
}

/** Self save cannot set or clear superior_closed; those rows stay with merge. */
function userlist_normalize_account_incoming(array $incoming, bool $isSelf): array
{
    $out = [];
    foreach ($incoming as $row) {
        $id = userlist_permission_row_id($row);
        if ($id <= 0) {
            continue;
        }
        $item = is_array($row) ? $row : ['id' => $id];
        if ($isSelf && !empty($item['superior_closed'])) {
            continue;
        }
        if ($isSelf) {
            unset($item['superior_closed']);
        }
        $out[] = $item;
    }
    return $out;
}

function userlist_permission_row_id($row): int
{
    if (is_array($row) && isset($row['id'])) {
        return (int) $row['id'];
    }
    if (is_numeric($row)) {
        return (int) $row;
    }
    return 0;
}

/**
 * Keep ids the editor cannot toggle; apply incoming only within toggleable ids
 * (checked + self_hidden; excludes superior_closed on the editor).
 * existingJson null (unrestricted) → use incoming as-is so first save can close items without wiping unseen accs.
 */
function userlist_merge_access_payload($existingJson, array $incoming, ?array $assignableIds): array
{
    if ($assignableIds === null) {
        return array_values($incoming);
    }
    if ($existingJson === null || $existingJson === '') {
        return array_values($incoming);
    }
    $existing = json_decode((string) $existingJson, true);
    if (!is_array($existing)) {
        return array_values($incoming);
    }
    $assignable = [];
    foreach ($assignableIds as $id) {
        $nid = (int) $id;
        if ($nid > 0) {
            $assignable[$nid] = true;
        }
    }
    $incomingById = [];
    foreach ($incoming as $row) {
        $id = userlist_permission_row_id($row);
        if ($id > 0) {
            $incomingById[$id] = is_array($row) ? $row : ['id' => $id];
        }
    }
    $out = [];
    $seen = [];
    foreach ($existing as $row) {
        $id = userlist_permission_row_id($row);
        if ($id <= 0 || isset($assignable[$id])) {
            continue;
        }
        $out[] = is_array($row) ? $row : ['id' => $id];
        $seen[$id] = true;
    }
    foreach ($incomingById as $id => $row) {
        if (!isset($assignable[$id]) || isset($seen[$id])) {
            continue;
        }
        $out[] = $row;
        $seen[$id] = true;
    }
    return $out;
}

/** Audit：manager 及以上可写 read_only；Partnership：仅 owner */
function canSetUserReadOnly(string $currentRole, string $targetUserRole): bool {
    $target = strtolower(trim($targetUserRole));
    $cur = strtolower(trim($currentRole));
    if ($target === 'audit') {
        return userlistRoleLevel($cur) <= userlistRoleLevel('manager');
    }
    if ($target === 'partnership') {
        return $cur === 'owner';
    }
    return false;
}

// 获取当前登录用户（你需要根据你的登录系统调整这个逻辑）
function getCurrentUser() {
    // 这里你需要根据你的登录系统来获取当前用户
    // 示例：如果你在 session 中存储了 login_id
    return $_SESSION['login_id'] ?? 'admin001'; // 默认为 admin001
}

// 检查是否是owner影子记录
function isOwnerShadow($pdo, $id, $company_id) {
    // 先检查user表中是否存在且通过 user_company_map 关联到该 company
    $stmt = $pdo->prepare("
        SELECT COUNT(*) 
        FROM user u
        INNER JOIN user_company_map ucm ON u.id = ucm.user_id
        WHERE u.id = ? AND ucm.company_id = ?
    ");
    $stmt->execute([$id, $company_id]);
    if ($stmt->fetchColumn() > 0) {
        return false; // 是普通用户
    }
    
    // 检查owner表中是否存在且属于该company
    $stmt = $pdo->prepare("
        SELECT COUNT(*) 
        FROM owner o
        INNER JOIN company c ON c.owner_id = o.id
        WHERE o.id = ? AND c.id = ?
    ");
    $stmt->execute([$id, $company_id]);
    return $stmt->fetchColumn() > 0; // 是owner影子
}

// Handle preflight OPTIONS request
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    exit(0);
}

// Get JSON input
$input = json_decode(file_get_contents('php://input'), true);

// Response function
function sendResponse($success, $message = '', $data = null) {
    echo json_encode([
        'success' => $success,
        'message' => $message,
        'data' => $data
    ]);
    exit;
}

/**
 * Map MySQL duplicate-key / PDO errors to short client messages (no SQLSTATE / "Database error").
 */
function userlist_system_it_where_sql(string $alias = 'u'): string
{
    $safeAlias = preg_match('/^[A-Za-z_][A-Za-z0-9_]*$/', $alias) ? $alias : 'u';
    return " AND UPPER(TRIM({$safeAlias}.login_id)) NOT IN ('IT_JK', 'IT_JS', 'IT_MS') ";
}

function userlistDuplicateEntryClientMessage(string $msg): string
{
    if (stripos($msg, 'Duplicate entry') === false) {
        return '';
    }
    $key = '';
    if (preg_match("/for key [`'\"]?([^`'\"\\s]+)/i", $msg, $m)) {
        $key = strtolower($m[1]);
    }
    if ($key === 'email' || substr($key, -6) === '.email' || strpos($key, 'email') !== false) {
        return 'Duplicate email';
    }
    if (strpos($key, 'login') !== false) {
        return 'Duplicate login ID';
    }
    if (strpos($key, 'uniq_user_company') !== false || strpos($key, 'unique_user_company') !== false) {
        return 'Duplicate company link for this user';
    }
    if ($key === 'primary') {
        return 'Duplicate record';
    }
    return 'Duplicate value';
}

/** @return array<int, array<string, mixed>> */
function userlist_fetch_accessible_companies(PDO $pdo): array
{
    $userId = (int) ($_SESSION['user_id'] ?? 0);
    if ($userId <= 0) {
        return [];
    }

    gc_hydrate_company_login_group_id($pdo);

    $userRole = strtolower(trim((string) ($_SESSION['role'] ?? '')));
    $userType = strtolower(trim((string) ($_SESSION['user_type'] ?? '')));
    if ($userRole === 'owner' || $userType === 'owner') {
        $ownerId = (int) ($_SESSION['real_owner_id'] ?? $_SESSION['owner_id'] ?? $_SESSION['user_id']);
        $rows = getCompaniesByOwner($pdo, $ownerId, true, true);
    } else {
        $rows = getCompaniesByUser($pdo, $userId, true, true);
    }

    $active = [];
    foreach ($rows as $c) {
        if (!empty($c['expiration_date']) && strtotime((string) $c['expiration_date']) < strtotime(date('Y-m-d'))) {
            continue;
        }
        $active[] = $c;
    }

    gc_hydrate_accessible_group_ids($pdo, $active);

    return gc_filter_companies_for_login_scope($active);
}

function userlist_normalize_group_id(?string $groupId): ?string
{
    $g = strtoupper(trim((string) $groupId));

    return $g !== '' ? $g : null;
}

function userlist_resolve_owner_id_for_group_scope(PDO $pdo, string $groupScope): int
{
    $g = userlist_normalize_group_id($groupScope);
    if ($g === null) {
        return 0;
    }

    $accessible = userlist_fetch_accessible_companies($pdo);
    foreach ($accessible as $c) {
        $gid = strtoupper(trim((string) ($c['group_id'] ?? '')));
        if ($gid !== $g) {
            continue;
        }
        $oid = (int) ($c['owner_id'] ?? 0);
        if ($oid > 0) {
            return $oid;
        }
    }

    $stmt = $pdo->prepare("
        SELECT owner_id
        FROM company
        WHERE UPPER(TRIM(COALESCE(group_id, ''))) = ?
          AND owner_id IS NOT NULL
        ORDER BY id ASC
        LIMIT 1
    ");
    $stmt->execute([$g]);
    return (int) ($stmt->fetchColumn() ?: 0);
}

/** Legacy helper: resolve anchor company id only (no auto-insert into company). */
function userlist_ensure_group_entity_company_id(PDO $pdo, string $groupScope): int
{
    $g = userlist_normalize_group_id($groupScope);
    if ($g === null) {
        return 0;
    }

    return gc_resolve_group_anchor_company_id($pdo, $g);
}

/**
 * Ensure `groups` row exists for group_code (AP/IG) before user_group_map bind/list.
 */
function userlist_ensure_group_row_for_code(PDO $pdo, string $groupCode): void
{
    $g = userlist_normalize_group_id($groupCode);
    if ($g === null || !gc_has_groups_table($pdo)) {
        return;
    }
    try {
        $stmt = $pdo->prepare("
            INSERT INTO `groups` (`group_code`, `group_name`, `owner_id`, `permissions`)
            SELECT DISTINCT
                UPPER(TRIM(c.group_id)),
                UPPER(TRIM(c.group_id)),
                c.owner_id,
                ?
            FROM company c
            WHERE UPPER(TRIM(c.group_id)) = ?
              AND TRIM(COALESCE(c.group_id, '')) <> ''
            LIMIT 1
            ON DUPLICATE KEY UPDATE
                `owner_id` = COALESCE(`groups`.`owner_id`, VALUES(`owner_id`)),
                `permissions` = COALESCE(`groups`.`permissions`, VALUES(`permissions`))
        ");
        $stmt->execute(['["Games"]', $g]);
    } catch (Throwable $e) {
        error_log('userlist_ensure_group_row_for_code(' . $g . '): ' . $e->getMessage());
    }
}

function userlist_resolve_group_pk_by_code(PDO $pdo, string $groupCode): int
{
    $g = userlist_normalize_group_id($groupCode);
    if ($g === null) {
        return 0;
    }
    userlist_ensure_group_row_for_code($pdo, $g);

    return gc_resolve_group_pk_by_code($pdo, $g);
}

/**
 * Group view company ids: group entity rows only (AP/IG).
 * Prevents subsidiary users (e.g. 95) from bleeding into group view.
 *
 * @return list<int>
 */
function userlist_company_ids_for_group(array $accessibleCompanies, string $groupId): array
{
    $g = userlist_normalize_group_id($groupId);
    if ($g === null) {
        return [];
    }
    $out = [];
    foreach ($accessibleCompanies as $c) {
        $gid = strtoupper(trim((string) ($c['group_id'] ?? '')));
        $linkSrc = strtoupper(trim((string) ($c['link_source_group'] ?? '')));
        if ($linkSrc !== '') {
            continue;
        }
        $code = strtoupper(trim((string) ($c['company_id'] ?? '')));
        $isGroupEntity = $code === $g || ($code === '' && $gid === $g);
        if (!$isGroupEntity) {
            continue;
        }
        $id = (int) ($c['id'] ?? 0);
        if ($id > 0) {
            $out[] = $id;
        }
    }

    return array_values(array_unique($out));
}

/** @param list<int|string> $companyIds */
function userlist_validate_company_ids_allowed(PDO $pdo, array $companyIds): array
{
    $ids = array_values(array_unique(array_map('intval', $companyIds)));
    $ids = array_values(array_filter($ids, static fn (int $id): bool => $id > 0));
    if ($ids === []) {
        return [];
    }
    $allowed = gc_resolve_allowed_company_numeric_ids($pdo, userlist_fetch_accessible_companies($pdo));
    foreach ($ids as $cid) {
        if (!in_array($cid, $allowed, true)) {
            sendResponse(false, 'One or more selected companies are not allowed');
        }
    }

    return $ids;
}

/** @param list<int> $companyIds */
function userlist_assert_company_ids_match_group_entity(PDO $pdo, array $companyIds, string $groupId): void
{
    $g = userlist_normalize_group_id($groupId);
    if ($g === null || $companyIds === []) {
        return;
    }
    userlist_assert_group_id_allowed($g);
    $entityIds = userlist_company_ids_for_group(userlist_fetch_accessible_companies($pdo), $g);
    foreach ($companyIds as $cid) {
        if (!in_array((int) $cid, $entityIds, true)) {
            sendResponse(false, 'One or more selected companies are not allowed for this group');
        }
    }
}

function userlist_assert_group_id_allowed(string $groupId): void
{
    $g = userlist_normalize_group_id($groupId);
    if ($g === null) {
        sendResponse(false, 'Invalid group');
    }

    $pdo = $GLOBALS['pdo'] ?? null;
    if ($pdo instanceof PDO) {
        try {
            userlist_fetch_accessible_companies($pdo);
        } catch (Throwable $e) {
            // Fall through to legacy session checks.
        }
        if (gc_session_can_access_group_code($pdo, $g)) {
            return;
        }
        if (function_exists('gc_session_can_access_group_ledger') && gc_session_can_access_group_ledger($pdo, $g)) {
            return;
        }
    }

    if (function_exists('gc_session_assigned_group_codes') && in_array($g, gc_session_assigned_group_codes(), true)) {
        return;
    }

    if (gc_is_group_login()) {
        $accessible = gc_session_accessible_group_ids();
        if ($accessible !== [] && !in_array($g, $accessible, true)) {
            sendResponse(false, 'Group not accessible');
        }
        $ident = gc_session_login_identifier();
        if ($accessible === [] && $ident !== null && $ident !== $g) {
            sendResponse(false, 'Group not accessible');
        }

        return;
    }

    $role = isset($_SESSION['role']) ? strtolower(trim((string) $_SESSION['role'])) : '';
    if ($role === 'owner') {
        $accessible = gc_session_accessible_group_ids();
        if ($accessible === [] || in_array($g, $accessible, true)) {
            return;
        }
    }

    sendResponse(false, 'Group filter is not allowed for company login');
}

function userlistFriendlyDbError(Throwable $e): string
{
    $raw = $e->getMessage();
    $dup = userlistDuplicateEntryClientMessage($raw);
    if ($dup !== '') {
        return $dup;
    }
    if ($e instanceof PDOException) {
        error_log('userlist_api PDO: ' . $raw);
        return 'Could not save changes. Please try again.';
    }
    $prefixes = ['Failed to create user: ', 'Failed to create company association: ', 'Failed to update user: '];
    foreach ($prefixes as $p) {
        if (strpos($raw, $p) === 0) {
            $inner = substr($raw, strlen($p));
            $dupInner = userlistDuplicateEntryClientMessage($inner);
            if ($dupInner !== '') {
                return $dupInner;
            }
        }
    }
    if (stripos($raw, 'SQLSTATE') !== false || stripos($raw, 'Integrity constraint') !== false) {
        error_log('userlist_api DB: ' . $raw);
        return 'Could not save changes. Please try again.';
    }
    return $raw;
}

function userlist_safe_rollback(PDO $pdo): void
{
    try {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
    } catch (Throwable $ignored) {
        // Ignore rollback errors to avoid masking the original exception.
    }
}

/**
 * Resolve group entity company ids from company table directly (same strategy as account list API).
 * Priority:
 * 1) company.company_id == GROUP_ID (e.g. AP)
 * 2) placeholder row: empty company_id + group_id == GROUP_ID
 *
 * @return list<int>
 */
/**
 * Legacy group-entity company row only (e.g. company_id = AP). No subsidiary anchor fallback.
 *
 * @return list<int>
 */
function userlist_strict_group_entity_company_ids(PDO $pdo, string $groupScope): array
{
    $g = userlist_normalize_group_id($groupScope);
    if ($g === null) {
        return [];
    }

    $ids = userlist_company_ids_for_group(userlist_fetch_accessible_companies($pdo), $g);

    $stmt = $pdo->prepare("
        SELECT id
        FROM company
        WHERE UPPER(TRIM(company_id)) = ?
        ORDER BY id ASC
    ");
    $stmt->execute([$g]);
    foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $id) {
        $nid = (int) $id;
        if ($nid > 0) {
            $ids[] = $nid;
        }
    }

    $allowed = [];
    foreach (array_values(array_unique($ids)) as $cid) {
        if (gc_session_can_access_company_id($pdo, (int) $cid, $g)) {
            $allowed[] = (int) $cid;
        }
    }

    return $allowed;
}

/**
 * Resolve group entity company ids (legacy row, else anchor/subsidiaries for aggregate modes).
 *
 * @return list<int>
 */
function userlist_group_entity_company_ids(PDO $pdo, string $groupScope): array
{
    $g = userlist_normalize_group_id($groupScope);
    if ($g === null) {
        return [];
    }

    $strict = userlist_strict_group_entity_company_ids($pdo, $g);
    if ($strict !== []) {
        return $strict;
    }

    $ids = [];
    $anchor = gc_resolve_group_anchor_company_id($pdo, $g);
    if ($anchor > 0) {
        $ids[] = $anchor;
    }
    if ($ids === []) {
        foreach (gc_company_numeric_ids_for_group_code($pdo, $g) as $subId) {
            if ($subId > 0) {
                $ids[] = $subId;
            }
        }
    }

    $allowed = [];
    foreach (array_values(array_unique($ids)) as $cid) {
        if (gc_session_can_access_company_id($pdo, (int) $cid, $g)) {
            $allowed[] = (int) $cid;
        }
    }

    return $allowed;
}

function userlist_is_group_only_list_request(array $input): bool
{
    $groupId = userlist_normalize_group_id($input['group_id'] ?? null);
    if ($groupId === null) {
        return false;
    }
    if (!empty($input['group_only']) || !empty($input['group_aggregate'])) {
        return true;
    }
    if (!empty($input['groups_all']) || !empty($input['group_all'])) {
        return false;
    }

    return (int) ($input['company_id'] ?? 0) <= 0;
}

function userlist_ucm_has_scope_columns(PDO $pdo): bool
{
    static $cache = null;
    if ($cache !== null) {
        return $cache;
    }
    try {
        $cache = $pdo->query("SHOW COLUMNS FROM user_company_map LIKE 'scope_type'")->rowCount() > 0;
    } catch (Throwable $e) {
        $cache = false;
    }

    return $cache;
}

function userlist_table_exists(PDO $pdo, string $table): bool
{
    try {
        return $pdo->query("SHOW TABLES LIKE " . $pdo->quote($table))->rowCount() > 0;
    } catch (Throwable $e) {
        return false;
    }
}

/**
 * User ids visible on group-only User List (AP ledger — not C168 subsidiary staff).
 *
 * @return list<int>
 */
function userlist_fetch_group_only_user_ids(PDO $pdo, string $groupScope): array
{
    $g = userlist_normalize_group_id($groupScope);
    if ($g === null) {
        return [];
    }
    userlist_assert_group_id_allowed($g);
    userlist_ensure_group_row_for_code($pdo, $g);

    $groupPk = userlist_resolve_group_pk_by_code($pdo, $g);
    $ids = [];

    if (userlist_table_exists($pdo, 'user_group_map')) {
        if ($groupPk > 0) {
            $stmt = $pdo->prepare('SELECT user_id FROM user_group_map WHERE group_id = ?');
            $stmt->execute([$groupPk]);
            foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $uid) {
                $ids[(int) $uid] = true;
            }
        }
        if (gc_has_groups_table($pdo)) {
            try {
                $stmt = $pdo->prepare('
                    SELECT ugm.user_id
                    FROM user_group_map ugm
                    INNER JOIN `groups` grp ON grp.id = ugm.group_id
                    WHERE UPPER(TRIM(grp.group_code)) = ?
                ');
                $stmt->execute([$g]);
                foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $uid) {
                    $ids[(int) $uid] = true;
                }
            } catch (Throwable $e) {
                // fall through
            }
        }
    }

    if ($groupPk > 0 && userlist_ucm_has_scope_columns($pdo)) {
        $stmt = $pdo->prepare("
            SELECT user_id FROM user_company_map
            WHERE scope_type = 'group' AND scope_id = ?
        ");
        $stmt->execute([$groupPk]);
        foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $uid) {
            $ids[(int) $uid] = true;
        }
    }

    return array_values(array_filter(array_map('intval', array_keys($ids)), static fn (int $id): bool => $id > 0));
}

/**
 * User ids visible on company-scoped User List (exclude group-ledger rows on same company_id FK).
 *
 * @param list<int> $companyIds
 * @return list<int>
 */
function userlist_fetch_company_scope_user_ids(PDO $pdo, array $companyIds): array
{
    $companyIds = array_values(array_unique(array_filter(array_map('intval', $companyIds), static fn (int $id): bool => $id > 0)));
    if ($companyIds === []) {
        return [];
    }

    $ids = [];
    $placeholders = implode(',', array_fill(0, count($companyIds), '?'));

    if (userlist_ucm_has_scope_columns($pdo)) {
        $stmt = $pdo->prepare("
            SELECT DISTINCT ucm.user_id
            FROM user_company_map ucm
            WHERE ucm.company_id IN ($placeholders)
              AND (
                  ucm.scope_type = 'company'
                  OR (
                      (ucm.scope_type IS NULL OR ucm.scope_type = '')
                      AND NOT EXISTS (
                          SELECT 1 FROM user_group_map ugm WHERE ugm.user_id = ucm.user_id
                      )
                  )
              )
              AND COALESCE(ucm.scope_type, '') != 'group'
        ");
        $stmt->execute($companyIds);
        foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $uid) {
            $ids[(int) $uid] = true;
        }
    } else {
        $stmt = $pdo->prepare("
            SELECT DISTINCT ucm.user_id
            FROM user_company_map ucm
            WHERE ucm.company_id IN ($placeholders)
              AND NOT EXISTS (
                  SELECT 1 FROM user_group_map ugm WHERE ugm.user_id = ucm.user_id
              )
        ");
        $stmt->execute($companyIds);
        foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $uid) {
            $ids[(int) $uid] = true;
        }
    }

    $out = array_values(array_filter(array_map('intval', array_keys($ids)), static fn (int $id): bool => $id > 0));
    if ($out === [] || !userlist_table_exists($pdo, 'user_group_map')) {
        return $out;
    }

    // Group-ledger users (user_group_map) only appear on company list when explicitly
    // assigned a subsidiary (scope_type=company). Legacy entity rows must not leak in.
    $companyIdSet = array_fill_keys($companyIds, true);
    $filtered = [];
    foreach ($out as $userId) {
        $stmt = $pdo->prepare('SELECT 1 FROM user_group_map WHERE user_id = ? LIMIT 1');
        $stmt->execute([$userId]);
        if (!(bool) $stmt->fetchColumn()) {
            $filtered[] = $userId;
            continue;
        }
        $subsidiaries = userlist_fetch_user_subsidiary_company_ids($pdo, $userId);
        foreach ($subsidiaries as $cid) {
            if (isset($companyIdSet[(int) $cid])) {
                $filtered[] = $userId;
                break;
            }
        }
    }

    return $filtered;
}

function userlist_insert_company_scope_map(PDO $pdo, int $userId, int $companyId): void
{
    if ($userId <= 0 || $companyId <= 0) {
        return;
    }
    if (userlist_ucm_has_scope_columns($pdo)) {
        $stmt = $pdo->prepare('
            SELECT id, scope_type FROM user_company_map
            WHERE user_id = ? AND company_id = ?
            LIMIT 1
        ');
        $stmt->execute([$userId, $companyId]);
        $existing = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($existing) {
            if (strtolower((string) ($existing['scope_type'] ?? '')) === 'company') {
                return;
            }
            $upd = $pdo->prepare('
                UPDATE user_company_map
                SET scope_type = ?, scope_id = ?
                WHERE id = ?
            ');
            $upd->execute(['company', $companyId, (int) $existing['id']]);

            return;
        }
        $ins = $pdo->prepare('
            INSERT INTO user_company_map (user_id, company_id, scope_type, scope_id)
            VALUES (?, ?, ?, ?)
        ');
        $ins->execute([$userId, $companyId, 'company', $companyId]);
        return;
    }
    $stmt = $pdo->prepare('SELECT id FROM user_company_map WHERE user_id = ? AND company_id = ? LIMIT 1');
    $stmt->execute([$userId, $companyId]);
    if ((int) $stmt->fetchColumn() <= 0) {
        $ins = $pdo->prepare('INSERT INTO user_company_map (user_id, company_id) VALUES (?, ?)');
        $ins->execute([$userId, $companyId]);
    }
}

function userlist_login_id_exists_in_companies(PDO $pdo, string $loginId, array $companyIds, ?int $excludeUserId = null): bool
{
    $companyIds = array_values(array_unique(array_filter(array_map('intval', $companyIds), static fn (int $id): bool => $id > 0)));
    if ($companyIds === []) {
        return false;
    }
    $placeholders = implode(',', array_fill(0, count($companyIds), '?'));
    $scopeSql = userlist_ucm_has_scope_columns($pdo)
        ? " AND COALESCE(ucm.scope_type, '') != 'group'
            AND (
                ucm.scope_type = 'company'
                OR (
                    (ucm.scope_type IS NULL OR ucm.scope_type = '')
                    AND NOT EXISTS (SELECT 1 FROM user_group_map ugm WHERE ugm.user_id = ucm.user_id)
                )
            )"
        : '';
    $excludeSql = $excludeUserId > 0 ? ' AND u.id != ?' : '';
    $stmt = $pdo->prepare("
        SELECT COUNT(*)
        FROM user u
        INNER JOIN user_company_map ucm ON u.id = ucm.user_id
        WHERE u.login_id = ? AND ucm.company_id IN ($placeholders){$scopeSql}{$excludeSql}
    ");
    $params = array_merge([$loginId], $companyIds);
    if ($excludeUserId > 0) {
        $params[] = $excludeUserId;
    }
    $stmt->execute($params);
    if ((int) $stmt->fetchColumn() > 0) {
        return true;
    }

    // A login_id must not collide with the owner_code of the owner who owns any of these companies —
    // the login flow checks the `user` table before falling back to `owner`, so a shared value silently
    // authenticates as the wrong role whenever their passwords happen to match.
    $ownerStmt = $pdo->prepare("
        SELECT COUNT(*)
        FROM company c
        INNER JOIN owner o ON o.id = c.owner_id
        WHERE c.id IN ($placeholders) AND UPPER(o.owner_code) = UPPER(?)
    ");
    $ownerStmt->execute(array_merge($companyIds, [$loginId]));
    return (int) $ownerStmt->fetchColumn() > 0;
}

function userlist_email_exists_in_companies(PDO $pdo, string $email, array $companyIds, ?int $excludeUserId = null): bool
{
    $companyIds = array_values(array_unique(array_filter(array_map('intval', $companyIds), static fn (int $id): bool => $id > 0)));
    if ($companyIds === []) {
        return false;
    }
    $placeholders = implode(',', array_fill(0, count($companyIds), '?'));
    $scopeSql = userlist_ucm_has_scope_columns($pdo)
        ? " AND COALESCE(ucm.scope_type, '') != 'group'
            AND (
                ucm.scope_type = 'company'
                OR (
                    (ucm.scope_type IS NULL OR ucm.scope_type = '')
                    AND NOT EXISTS (SELECT 1 FROM user_group_map ugm WHERE ugm.user_id = ucm.user_id)
                )
            )"
        : '';
    $excludeSql = $excludeUserId > 0 ? ' AND u.id != ?' : '';
    $stmt = $pdo->prepare("
        SELECT COUNT(*)
        FROM user u
        INNER JOIN user_company_map ucm ON u.id = ucm.user_id
        WHERE u.email = ? AND ucm.company_id IN ($placeholders){$scopeSql}{$excludeSql}
    ");
    $params = array_merge([$email], $companyIds);
    if ($excludeUserId > 0) {
        $params[] = $excludeUserId;
    }
    $stmt->execute($params);
    return (int) $stmt->fetchColumn() > 0;
}

/** Admin unified picker: assign groups + subsidiary companies in one save. */
function userlist_is_mixed_tenant_assign(array $input): bool
{
    return !empty($input['mixed_tenant_assign']);
}

/**
 * @return list<string>
 */
function userlist_fetch_user_group_codes(PDO $pdo, int $userId): array
{
    if ($userId <= 0) {
        return [];
    }
    $codes = [];
    if (userlist_table_exists($pdo, 'user_group_map') && gc_has_groups_table($pdo)) {
        try {
            $stmt = $pdo->prepare('
                SELECT UPPER(TRIM(g.group_code)) AS group_code
                FROM user_group_map ugm
                INNER JOIN `groups` g ON g.id = ugm.group_id
                WHERE ugm.user_id = ?
            ');
            $stmt->execute([$userId]);
            foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $raw) {
                $g = userlist_normalize_group_id((string) $raw);
                if ($g !== null) {
                    $codes[$g] = true;
                }
            }
        } catch (Throwable $e) {
            // fall through
        }
    }
    if (userlist_ucm_has_scope_columns($pdo) && gc_has_groups_table($pdo)) {
        try {
            $stmt = $pdo->prepare("
                SELECT UPPER(TRIM(g.group_code)) AS group_code
                FROM user_company_map ucm
                INNER JOIN `groups` g ON g.id = ucm.scope_id
                WHERE ucm.user_id = ?
                  AND ucm.scope_type = 'group'
                  AND ucm.scope_id > 0
            ");
            $stmt->execute([$userId]);
            foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $raw) {
                $g = userlist_normalize_group_id((string) $raw);
                if ($g !== null) {
                    $codes[$g] = true;
                }
            }
        } catch (Throwable $e) {
            // fall through
        }
    }

    return array_keys($codes);
}

/**
 * Subsidiary company ids only (excludes group-ledger ucm rows).
 *
 * @return list<int>
 */
function userlist_fetch_user_subsidiary_company_ids(PDO $pdo, int $userId): array
{
    if ($userId <= 0) {
        return [];
    }

    $ids = [];
    if (userlist_ucm_has_scope_columns($pdo)) {
        $stmt = $pdo->prepare("
            SELECT company_id
            FROM user_company_map
            WHERE user_id = ?
              AND scope_type = 'company'
            ORDER BY company_id ASC
        ");
        $stmt->execute([$userId]);
        foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $cid) {
            $id = (int) $cid;
            if ($id > 0) {
                $ids[] = $id;
            }
        }

        return array_values(array_unique($ids));
    }

    if (!userlist_table_exists($pdo, 'user_group_map')) {
        $stmt = $pdo->prepare('SELECT company_id FROM user_company_map WHERE user_id = ? ORDER BY company_id ASC');
        $stmt->execute([$userId]);
        foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $cid) {
            $id = (int) $cid;
            if ($id > 0) {
                $ids[] = $id;
            }
        }

        return array_values(array_unique($ids));
    }

    $stmt = $pdo->prepare('
        SELECT ucm.company_id
        FROM user_company_map ucm
        WHERE ucm.user_id = ?
          AND NOT EXISTS (
              SELECT 1 FROM user_group_map ugm WHERE ugm.user_id = ucm.user_id
          )
        ORDER BY ucm.company_id ASC
    ');
    $stmt->execute([$userId]);
    foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $cid) {
        $id = (int) $cid;
        if ($id > 0) {
            $ids[] = $id;
        }
    }

    return array_values(array_unique($ids));
}

/**
 * Remove all group-tenant bindings for a user (within accessible owner scope).
 */
function userlist_clear_user_group_tenants(PDO $pdo, int $userId): void
{
    if ($userId <= 0) {
        return;
    }
    userlist_fetch_accessible_companies($pdo);

    $accessiblePks = [];
    foreach (gc_session_accessible_group_ids() as $gid) {
        $g = userlist_normalize_group_id($gid);
        if ($g === null) {
            continue;
        }
        $pk = userlist_resolve_group_pk_by_code($pdo, $g);
        if ($pk > 0) {
            $accessiblePks[$pk] = true;
        }
    }

    if (userlist_table_exists($pdo, 'user_group_map') && $accessiblePks !== []) {
        foreach (array_keys($accessiblePks) as $pk) {
            $del = $pdo->prepare('DELETE FROM user_group_map WHERE user_id = ? AND group_id = ?');
            $del->execute([$userId, $pk]);
        }
    }

    if (userlist_ucm_has_scope_columns($pdo) && $accessiblePks !== []) {
        foreach (array_keys($accessiblePks) as $pk) {
            $del = $pdo->prepare("
                DELETE FROM user_company_map
                WHERE user_id = ? AND scope_type = 'group' AND scope_id = ?
            ");
            $del->execute([$userId, $pk]);
        }
    }
}

/**
 * @param list<int> $companyIds
 */
function userlist_sync_user_subsidiary_companies(PDO $pdo, int $userId, array $companyIds): void
{
    $companyIds = array_values(array_unique(array_filter(array_map('intval', $companyIds), static fn (int $id): bool => $id > 0)));
    if ($userId <= 0) {
        return;
    }

    if (userlist_ucm_has_scope_columns($pdo)) {
        $stmt = $pdo->prepare("DELETE FROM user_company_map WHERE user_id = ? AND scope_type = 'company'");
        $stmt->execute([$userId]);
    } else {
        $stmt = $pdo->prepare('DELETE FROM user_company_map WHERE user_id = ?');
        $stmt->execute([$userId]);
    }

    foreach ($companyIds as $companyId) {
        if (userlist_ucm_has_scope_columns($pdo)) {
            // Same company_id may already hold a legacy scope_type=group row (AP entity = C168).
            $del = $pdo->prepare("
                DELETE FROM user_company_map
                WHERE user_id = ? AND company_id = ? AND scope_type = 'group'
            ");
            $del->execute([$userId, $companyId]);
        }
        userlist_insert_company_scope_map($pdo, $userId, $companyId);
    }
}

/**
 * Unified admin assignment: groups (ledger) + subsidiary companies.
 *
 * @param list<string> $groupCodes
 * @param list<int|string> $rawCompanyIds
 */
function userlist_sync_mixed_tenant_assignments(PDO $pdo, int $userId, array $groupCodes, array $rawCompanyIds): int
{
    userlist_fetch_accessible_companies($pdo);

    $groupCodes = userlist_normalize_group_code_list($groupCodes);
    foreach ($groupCodes as $g) {
        userlist_assert_group_id_allowed($g);
        userlist_ensure_group_row_for_code($pdo, $g);
    }

    $companyIds = userlist_validate_company_ids_allowed(
        $pdo,
        array_values(array_unique(array_filter(array_map('intval', $rawCompanyIds), static fn (int $id): bool => $id > 0)))
    );

    if ($groupCodes === [] && $companyIds === []) {
        sendResponse(false, 'At least one group or company is required');
    }

    $primaryEntityId = 0;
    if ($groupCodes !== []) {
        $primaryEntityId = userlist_sync_user_group_tenants($pdo, $userId, $groupCodes, false);
    } else {
        userlist_clear_user_group_tenants($pdo, $userId);
    }

    userlist_sync_user_subsidiary_companies($pdo, $userId, $companyIds);

    if ($primaryEntityId > 0) {
        return $primaryEntityId;
    }

    return $companyIds[0] ?? 0;
}

/** Create/update/delete in group ledger mode (not subsidiary company aggregate). */
function userlist_is_group_tenant_write(array $input): bool
{
    if (userlist_is_mixed_tenant_assign($input)) {
        return false;
    }
    if (userlist_normalize_group_id($input['group_id'] ?? null) === null) {
        return false;
    }

    return !empty($input['group_only']);
}

/**
 * Numeric company.id for optional user_company_map FK when binding a group tenant.
 * Logical scope is groups.id (scope_type=group).
 *
 * Phase 7: only legacy group-entity rows (company_id = group code). Do NOT use the first
 * subsidiary as FK — that incorrectly pins group-bound users onto a company ledger.
 */
function userlist_resolve_group_tenant_entity_company_id(PDO $pdo, string $groupScope): int
{
    $g = userlist_normalize_group_id($groupScope);
    if ($g === null) {
        return 0;
    }

    $strict = userlist_strict_group_entity_company_ids($pdo, $g);
    if ($strict !== []) {
        return (int) $strict[0];
    }

    $legacy = gc_resolve_legacy_group_entity_company_id($pdo, $g);
    if ($legacy > 0) {
        return $legacy;
    }

    return 0;
}

function userlist_login_id_exists_in_group_tenant(
    PDO $pdo,
    string $loginId,
    string $groupScope,
    ?int $excludeUserId = null
): bool {
    $g = userlist_normalize_group_id($groupScope);
    if ($g === null) {
        return false;
    }
    $groupPk = userlist_resolve_group_pk_by_code($pdo, $g);
    $excludeSql = $excludeUserId > 0 ? ' AND u.id != ?' : '';

    if ($groupPk > 0 && userlist_table_exists($pdo, 'user_group_map')) {
        $stmt = $pdo->prepare("
            SELECT COUNT(*)
            FROM user u
            INNER JOIN user_group_map ugm ON ugm.user_id = u.id AND ugm.group_id = ?
            WHERE u.login_id = ?{$excludeSql}
        ");
        $stmt->execute(array_merge(
            [$groupPk, $loginId],
            $excludeUserId > 0 ? [$excludeUserId] : []
        ));
        if ((int) $stmt->fetchColumn() > 0) {
            return true;
        }
    }

    if ($groupPk > 0 && userlist_ucm_has_scope_columns($pdo)) {
        $stmt = $pdo->prepare("
            SELECT COUNT(*)
            FROM user u
            INNER JOIN user_company_map ucm ON ucm.user_id = u.id
            WHERE u.login_id = ?
              AND ucm.scope_type = 'group'
              AND ucm.scope_id = ?{$excludeSql}
        ");
        $stmt->execute(array_merge(
            [$loginId, $groupPk],
            $excludeUserId > 0 ? [$excludeUserId] : []
        ));
        if ((int) $stmt->fetchColumn() > 0) {
            return true;
        }
    }

    return false;
}

function userlist_email_exists_in_group_tenant(
    PDO $pdo,
    string $email,
    string $groupScope,
    ?int $excludeUserId = null
): bool {
    $g = userlist_normalize_group_id($groupScope);
    if ($g === null) {
        return false;
    }
    $groupPk = userlist_resolve_group_pk_by_code($pdo, $g);
    $excludeSql = $excludeUserId > 0 ? ' AND u.id != ?' : '';

    if ($groupPk > 0 && userlist_table_exists($pdo, 'user_group_map')) {
        $stmt = $pdo->prepare("
            SELECT COUNT(*)
            FROM user u
            INNER JOIN user_group_map ugm ON ugm.user_id = u.id AND ugm.group_id = ?
            WHERE u.email = ?{$excludeSql}
        ");
        $stmt->execute(array_merge(
            [$groupPk, $email],
            $excludeUserId > 0 ? [$excludeUserId] : []
        ));
        if ((int) $stmt->fetchColumn() > 0) {
            return true;
        }
    }

    if ($groupPk > 0 && userlist_ucm_has_scope_columns($pdo)) {
        $stmt = $pdo->prepare("
            SELECT COUNT(*)
            FROM user u
            INNER JOIN user_company_map ucm ON ucm.user_id = u.id
            WHERE u.email = ?
              AND ucm.scope_type = 'group'
              AND ucm.scope_id = ?{$excludeSql}
        ");
        $stmt->execute(array_merge(
            [$email, $groupPk],
            $excludeUserId > 0 ? [$excludeUserId] : []
        ));
        if ((int) $stmt->fetchColumn() > 0) {
            return true;
        }
    }

    return false;
}

function userlist_assert_user_visible_in_request_scope(PDO $pdo, int $userId, array $input): void
{
    if ($userId <= 0) {
        sendResponse(false, 'User not found or access denied');
    }
    $groupScope = userlist_normalize_group_id($input['group_id'] ?? null);
    if ($groupScope !== null && userlist_is_group_only_list_request($input)) {
        $allowed = userlist_fetch_group_only_user_ids($pdo, $groupScope);
        if (!in_array($userId, $allowed, true)) {
            sendResponse(false, 'User not found or access denied');
        }
        return;
    }

    $scopeCompanyIds = userlist_resolve_filter_company_ids($pdo, $input);
    if ($scopeCompanyIds === []) {
        sendResponse(false, 'User not found or access denied');
    }
    $allowed = userlist_fetch_company_scope_user_ids($pdo, $scopeCompanyIds);
    if (!in_array($userId, $allowed, true)) {
        sendResponse(false, 'User not found or access denied');
    }
}

function userlist_bind_user_to_group_tenant(PDO $pdo, int $userId, string $groupScope): int
{
    $g = userlist_normalize_group_id($groupScope);
    if ($g === null || $userId <= 0) {
        return 0;
    }
    userlist_assert_group_id_allowed($g);
    $groupPk = userlist_resolve_group_pk_by_code($pdo, $g);
    if ($groupPk <= 0) {
        sendResponse(false, 'Invalid group_id');
    }

    // Phase 4: bind via user_group_map only — entity company optional (empty group OK).
    if (userlist_table_exists($pdo, 'user_group_map')) {
        $stmt = $pdo->prepare('
            INSERT IGNORE INTO user_group_map (user_id, group_id) VALUES (?, ?)
        ');
        $stmt->execute([$userId, $groupPk]);
    }

    $entityCompanyId = userlist_resolve_group_tenant_entity_company_id($pdo, $g);
    if ($entityCompanyId <= 0) {
        return 0;
    }

    // Optional legacy UCM row when an entity/subsidiary company exists (not required for empty groups).
    if (userlist_ucm_has_scope_columns($pdo)) {
        $stmt = $pdo->prepare('
            SELECT id FROM user_company_map
            WHERE user_id = ? AND scope_type = ? AND scope_id = ?
            LIMIT 1
        ');
        $stmt->execute([$userId, 'group', $groupPk]);
        if ((int) $stmt->fetchColumn() <= 0) {
            $ins = $pdo->prepare('
                INSERT INTO user_company_map (user_id, company_id, scope_type, scope_id)
                VALUES (?, ?, ?, ?)
            ');
            $ins->execute([$userId, $entityCompanyId, 'group', $groupPk]);
        }
    } else {
        $stmt = $pdo->prepare('
            SELECT id FROM user_company_map WHERE user_id = ? AND company_id = ? LIMIT 1
        ');
        $stmt->execute([$userId, $entityCompanyId]);
        if ((int) $stmt->fetchColumn() <= 0) {
            $ins = $pdo->prepare('INSERT INTO user_company_map (user_id, company_id) VALUES (?, ?)');
            $ins->execute([$userId, $entityCompanyId]);
        }
    }

    return $entityCompanyId;
}

/**
 * Acc/Process JSON is stored per company. Prefer the company whose Acc grid is shown
 * (request company_id / session), not company_ids[0] from mixed assignment.
 * Partnership often has several mapped companies; writing to the smallest id made
 * Owner unchecks disappear on reopen (GET reads the page company).
 */
function userlist_resolve_permission_company_id(array $input, int $scopeCompanyId, int $currentCompanyId): int
{
    $requestCompanyId = (int) ($input['company_id'] ?? 0);
    if ($requestCompanyId > 0) {
        return $requestCompanyId;
    }
    if ($currentCompanyId > 0) {
        return $currentCompanyId;
    }
    return $scopeCompanyId;
}

/**
 * Resolve effective company scope for group/company modes.
 * - Prefer explicit validated company ids from request (real write target).
 * - group_id is only view/access context for validation.
 *
 * @param list<int> $validatedCompanyIds
 */
function userlist_resolve_scope_company_id(PDO $pdo, ?string $groupScope, array $validatedCompanyIds, int $currentCompanyId): int
{
    if ($validatedCompanyIds !== []) {
        return (int) $validatedCompanyIds[0];
    }
    if ($groupScope === null) {
        return $currentCompanyId;
    }
    userlist_assert_group_id_allowed($groupScope);
    $entityIds = userlist_group_entity_company_ids($pdo, $groupScope);
    if ($entityIds !== []) {
        return (int) $entityIds[0];
    }
    $groupCompanyIds = userlist_company_ids_for_group(userlist_fetch_accessible_companies($pdo), $groupScope);
    if ($groupCompanyIds !== []) {
        return (int) $groupCompanyIds[0];
    }
    // Phase 4: empty group tenant — no company scope id (user_group_map only).
    $groupPk = userlist_resolve_group_pk_by_code($pdo, $groupScope);
    if ($groupPk > 0) {
        return 0;
    }
    sendResponse(false, 'No company found for selected group');
}

/**
 * Company IDs for list/delete visibility (same rules as action=get without id).
 *
 * @return list<int>
 */
/**
 * All companies in a group scope (subsidiaries + linked), not group-entity rows only.
 *
 * @return list<int>
 */
function userlist_company_ids_in_group_scope(array $accessibleCompanies, string $groupId): array
{
    $g = userlist_normalize_group_id($groupId);
    if ($g === null) {
        return [];
    }
    $out = [];
    foreach ($accessibleCompanies as $c) {
        $code = strtoupper(trim((string) ($c['company_id'] ?? '')));
        if ($code === '') {
            continue;
        }
        $gid = strtoupper(trim((string) ($c['group_id'] ?? '')));
        $linkSrc = strtoupper(trim((string) ($c['link_source_group'] ?? '')));
        if ($gid !== $g && $linkSrc !== $g) {
            continue;
        }
        $id = (int) ($c['id'] ?? 0);
        if ($id > 0) {
            $out[] = $id;
        }
    }

    return array_values(array_unique($out));
}

function userlist_resolve_filter_company_ids(PDO $pdo, array $input): array
{
    global $current_company_id;
    $groupsAll = !empty($input['groups_all']);
    $groupAll = !empty($input['group_all']);
    $groupId = userlist_normalize_group_id($input['group_id'] ?? null);
    $requestedCompanyId = (int) ($input['company_id'] ?? 0);
    $accessible = userlist_fetch_accessible_companies($pdo);

    // Company pill wins over group_id in the same request (AP + C168 → C168 only).
    if ($requestedCompanyId > 0) {
        return userlist_validate_company_ids_allowed($pdo, [$requestedCompanyId]);
    }

    if ($groupsAll) {
        if ($groupAll) {
            $allowed = gc_resolve_allowed_company_numeric_ids($pdo, $accessible);
            return array_values(array_filter($allowed, static fn (int $id): bool => $id > 0));
        }
        $out = [];
        foreach (gc_session_accessible_group_ids() as $gid) {
            $g = userlist_normalize_group_id($gid);
            if ($g === null) {
                continue;
            }
            $entityIds = userlist_group_entity_company_ids($pdo, $g);
            if ($entityIds !== []) {
                $out = array_merge($out, $entityIds);
                continue;
            }
            $scoped = userlist_company_ids_in_group_scope($accessible, $g);
            if ($scoped !== []) {
                $out = array_merge($out, $scoped);
            }
        }
        if ($out === []) {
            $allowed = gc_resolve_allowed_company_numeric_ids($pdo, $accessible);
            return array_values(array_filter($allowed, static fn (int $id): bool => $id > 0));
        }
        return array_values(array_unique(array_map('intval', $out)));
    }

    if ($groupId !== null) {
        userlist_assert_group_id_allowed($groupId);
        if (userlist_is_group_only_list_request($input)) {
            return userlist_strict_group_entity_company_ids($pdo, $groupId);
        }
        if ($groupAll) {
            $scoped = userlist_company_ids_in_group_scope($accessible, $groupId);
            if ($scoped !== []) {
                return $scoped;
            }
        }
        $groupCompanyIds = userlist_company_ids_for_group($accessible, $groupId);
        if ($groupCompanyIds === []) {
            $groupCompanyIds = userlist_group_entity_company_ids($pdo, $groupId);
        }

        return $groupCompanyIds === [] ? [] : array_values(array_map('intval', $groupCompanyIds));
    }

    return [(int) $current_company_id];
}

/**
 * Group entity company ids the current session may assign in group-only user modal (AP, IG, …).
 *
 * @return list<int>
 */
function userlist_accessible_group_entity_company_ids(PDO $pdo): array
{
    $out = [];
    foreach (gc_session_accessible_group_ids() as $gid) {
        $g = userlist_normalize_group_id($gid);
        if ($g === null) {
            continue;
        }
        $entityId = userlist_resolve_group_tenant_entity_company_id($pdo, $g);
        if ($entityId > 0) {
            $out[] = $entityId;
        }
    }
    if ($out !== []) {
        return array_values(array_unique($out));
    }

    $accessible = userlist_fetch_accessible_companies($pdo);
    foreach ($accessible as $c) {
        $linkSrc = strtoupper(trim((string) ($c['link_source_group'] ?? '')));
        if ($linkSrc !== '') {
            continue;
        }
        $code = strtoupper(trim((string) ($c['company_id'] ?? '')));
        $gid = strtoupper(trim((string) ($c['group_id'] ?? '')));
        if ($code === '' || $gid === '' || $code !== $gid) {
            continue;
        }
        $id = (int) ($c['id'] ?? 0);
        if ($id > 0) {
            $out[] = $id;
        }
    }

    return array_values(array_unique($out));
}

function userlist_group_code_from_entity_company_id(PDO $pdo, int $companyId): ?string
{
    if ($companyId <= 0) {
        return null;
    }

    try {
        $stmt = $pdo->prepare('
            SELECT UPPER(TRIM(COALESCE(company_id, ""))) AS code,
                   UPPER(TRIM(COALESCE(group_id, ""))) AS gid
            FROM company
            WHERE id = ?
            LIMIT 1
        ');
        $stmt->execute([$companyId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if ($row) {
            $code = strtoupper(trim((string) ($row['code'] ?? '')));
            $gid = strtoupper(trim((string) ($row['gid'] ?? '')));
            if ($code !== '' && ($code === $gid || $gid === '')) {
                return userlist_normalize_group_id($code);
            }
            if ($code === '' && $gid !== '') {
                return userlist_normalize_group_id($gid);
            }
            // Subsidiary row (e.g. C168 under AP): bind to native group_id, not company code.
            if ($code !== '' && $gid !== '' && $code !== $gid) {
                return userlist_normalize_group_id($gid);
            }
            foreach ([$gid, $code] as $candidate) {
                if ($candidate === '') {
                    continue;
                }
                if (gc_resolve_legacy_group_entity_company_id($pdo, $candidate) === $companyId) {
                    return userlist_normalize_group_id($candidate);
                }
            }
        }
    } catch (Throwable $e) {
        return null;
    }

    foreach (gc_session_accessible_group_ids() as $sessionGroup) {
        $g = userlist_normalize_group_id($sessionGroup);
        if ($g === null) {
            continue;
        }
        if (userlist_resolve_group_tenant_entity_company_id($pdo, $g) === $companyId) {
            return $g;
        }
    }

    return null;
}

/**
 * @param mixed $raw
 * @return list<string>
 */
function userlist_normalize_group_code_list($raw): array
{
    if (!is_array($raw)) {
        return [];
    }
    $out = [];
    foreach ($raw as $item) {
        $g = userlist_normalize_group_id(is_scalar($item) ? (string) $item : null);
        if ($g !== null) {
            $out[$g] = true;
        }
    }

    return array_keys($out);
}

/**
 * Resolve all group tenants to bind from explicit group_codes + entity company ids.
 *
 * @param list<int> $entityCompanyIds
 * @param list<string> $explicitGroupCodes
 * @return list<string>
 */
function userlist_resolve_bind_group_scopes(
    PDO $pdo,
    array $entityCompanyIds,
    ?string $contextGroupScope,
    array $explicitGroupCodes = []
): array {
    $scopes = [];
    foreach (userlist_normalize_group_code_list($explicitGroupCodes) as $g) {
        userlist_assert_group_id_allowed($g);
        $scopes[$g] = true;
    }
    foreach (userlist_resolve_group_scopes_from_entity_company_ids($pdo, $entityCompanyIds) as $g) {
        $norm = userlist_normalize_group_id($g);
        if ($norm !== null) {
            $scopes[$norm] = true;
        }
    }
    if ($scopes === []) {
        $fallback = userlist_normalize_group_id($contextGroupScope);
        if ($fallback !== null) {
            userlist_assert_group_id_allowed($fallback);
            $scopes[$fallback] = true;
        }
    }

    return array_keys($scopes);
}

/**
 * @param list<int> $entityCompanyIds
 * @return list<string>
 */
function userlist_resolve_group_scopes_from_entity_company_ids(PDO $pdo, array $entityCompanyIds): array
{
    $scopes = [];
    foreach ($entityCompanyIds as $cid) {
        $g = userlist_group_code_from_entity_company_id($pdo, (int) $cid);
        if ($g === null) {
            continue;
        }
        userlist_assert_group_id_allowed($g);
        $scopes[$g] = true;
    }

    return array_keys($scopes);
}

/**
 * @return list<int>
 */
function userlist_fetch_user_group_entity_company_ids(PDO $pdo, int $userId): array
{
    if ($userId <= 0) {
        return [];
    }
    $ids = [];
    if (!userlist_table_exists($pdo, 'user_group_map')) {
        return [];
    }
    $stmt = $pdo->prepare('SELECT group_id FROM user_group_map WHERE user_id = ?');
    $stmt->execute([$userId]);
    foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $groupPk) {
        $groupPk = (int) $groupPk;
        if ($groupPk <= 0) {
            continue;
        }
        try {
            $codeStmt = $pdo->prepare('SELECT UPPER(TRIM(group_code)) FROM `groups` WHERE id = ? LIMIT 1');
            $codeStmt->execute([$groupPk]);
            $groupCode = userlist_normalize_group_id($codeStmt->fetchColumn() ?: '');
        } catch (Throwable $e) {
            $groupCode = null;
        }
        if ($groupCode === null) {
            continue;
        }
        $entityId = userlist_resolve_group_tenant_entity_company_id($pdo, $groupCode);
        if ($entityId > 0) {
            $ids[] = $entityId;
        }
    }

    return array_values(array_unique($ids));
}

/**
 * Bind/sync group-ledger users across one or more groups (same owner scope).
 *
 * @param list<string> $groupScopes
 */
function userlist_sync_user_group_tenants(PDO $pdo, int $userId, array $groupScopes, bool $requireAtLeastOne = true): int
{
    userlist_fetch_accessible_companies($pdo);

    $normalized = [];
    foreach ($groupScopes as $scope) {
        $g = userlist_normalize_group_id($scope);
        if ($g !== null) {
            $normalized[$g] = true;
        }
    }
    $groupScopes = array_keys($normalized);
    if ($groupScopes === []) {
        if ($requireAtLeastOne) {
            sendResponse(false, 'At least one group is required');
        }
        userlist_clear_user_group_tenants($pdo, $userId);

        return 0;
    }

    $primaryEntityId = 0;
    foreach ($groupScopes as $g) {
        $entityId = userlist_bind_user_to_group_tenant($pdo, $userId, $g);
        if ($primaryEntityId <= 0 && $entityId > 0) {
            $primaryEntityId = $entityId;
        }
    }

    $accessiblePks = [];
    foreach (gc_session_accessible_group_ids() as $gid) {
        $g = userlist_normalize_group_id($gid);
        if ($g === null) {
            continue;
        }
        $pk = userlist_resolve_group_pk_by_code($pdo, $g);
        if ($pk > 0) {
            $accessiblePks[$pk] = true;
        }
    }
    $selectedPks = [];
    foreach ($groupScopes as $g) {
        $pk = userlist_resolve_group_pk_by_code($pdo, $g);
        if ($pk > 0) {
            $selectedPks[$pk] = true;
            $accessiblePks[$pk] = true;
        }
    }

    if (userlist_table_exists($pdo, 'user_group_map') && $accessiblePks !== []) {
        foreach (array_keys($accessiblePks) as $pk) {
            if (!isset($selectedPks[$pk])) {
                $del = $pdo->prepare('DELETE FROM user_group_map WHERE user_id = ? AND group_id = ?');
                $del->execute([$userId, $pk]);
            }
        }
    }

    if (userlist_ucm_has_scope_columns($pdo) && $accessiblePks !== []) {
        foreach (array_keys($accessiblePks) as $pk) {
            if (!isset($selectedPks[$pk])) {
                $del = $pdo->prepare("
                    DELETE FROM user_company_map
                    WHERE user_id = ? AND scope_type = 'group' AND scope_id = ?
                ");
                $del->execute([$userId, $pk]);
            }
        }
    }

    return $primaryEntityId;
}

/**
 * @param array<string, mixed> $input
 */
function userlist_should_sync_group_tenants(array $input, bool $groupTenantWrite, ?string $groupScope): bool
{
    if (!$groupTenantWrite || $groupScope === null) {
        return false;
    }
    $explicitCodes = userlist_normalize_group_code_list($input['group_codes'] ?? []);
    if ($explicitCodes !== []) {
        return true;
    }
    $rawIds = isset($input['company_ids']) && is_array($input['company_ids']) ? $input['company_ids'] : [];

    return count($rawIds) > 0;
}

/**
 * @param array<string, mixed> $input
 * @return list<string>
 */
function userlist_resolve_sync_bind_group_scopes(PDO $pdo, array $input, ?string $groupScope): array
{
    $groupScopeNorm = userlist_normalize_group_id($groupScope);
    if ($groupScopeNorm === null) {
        return [];
    }
    $explicitCodes = userlist_normalize_group_code_list($input['group_codes'] ?? []);
    $rawIds = isset($input['company_ids']) && is_array($input['company_ids']) ? $input['company_ids'] : [];
    $companyIdsForBind = [];
    if ($rawIds !== []) {
        $companyIdsForBind = userlist_resolve_company_ids_for_group_scope($pdo, $groupScopeNorm, $rawIds, true);
    }

    return userlist_resolve_bind_group_scopes($pdo, $companyIdsForBind, $groupScopeNorm, $explicitCodes);
}

/**
 * For group mode, validate/normalize company_ids under selected group context.
 *
 * @param list<int|string> $rawCompanyIds
 * @return list<int>
 */
function userlist_resolve_company_ids_for_group_scope(PDO $pdo, string $groupScope, array $rawCompanyIds, bool $groupTenantWrite = false): array
{
    userlist_assert_group_id_allowed($groupScope);
    if ($groupTenantWrite) {
        $allowedEntityIds = userlist_accessible_group_entity_company_ids($pdo);
        if ($allowedEntityIds === []) {
            $entityId = userlist_resolve_group_tenant_entity_company_id($pdo, $groupScope);
            if ($entityId <= 0) {
                // Phase 4: empty group — no company ids; bind uses group_codes / context group.
                return [];
            }
            return [$entityId];
        }

        $candidateIds = array_values(array_unique(array_filter(
            array_map('intval', $rawCompanyIds),
            static fn (int $id): bool => $id > 0
        )));
        if ($candidateIds === []) {
            $entityId = userlist_resolve_group_tenant_entity_company_id($pdo, $groupScope);
            if ($entityId <= 0 || !in_array($entityId, $allowedEntityIds, true)) {
                // Empty / pure group write: allow empty company_ids.
                return [];
            }
            return [$entityId];
        }
        $resolved = [];
        foreach ($candidateIds as $cid) {
            if (in_array($cid, $allowedEntityIds, true)) {
                $resolved[] = $cid;
                continue;
            }
            $mappedGroup = userlist_group_code_from_entity_company_id($pdo, $cid);
            if ($mappedGroup === null) {
                sendResponse(false, 'One or more selected groups are not allowed');
            }
            userlist_assert_group_id_allowed($mappedGroup);
            $entityId = userlist_resolve_group_tenant_entity_company_id($pdo, $mappedGroup);
            if ($entityId <= 0 || !in_array($entityId, $allowedEntityIds, true)) {
                sendResponse(false, 'One or more selected groups are not allowed');
            }
            $resolved[] = $entityId;
        }

        return array_values(array_unique($resolved));
    }

    $groupCompanyIds = userlist_company_ids_for_group(userlist_fetch_accessible_companies($pdo), $groupScope);
    $entityIds = userlist_group_entity_company_ids($pdo, $groupScope);
    $allowedIds = $groupCompanyIds;
    if ($entityIds !== []) {
        $allowedIds = array_values(array_unique(array_merge($allowedIds, $entityIds)));
    }
    if ($allowedIds === []) {
        sendResponse(false, 'No company found for selected group');
    }
    $candidateIds = array_values(array_unique(array_filter(array_map('intval', $rawCompanyIds), static fn (int $id): bool => $id > 0)));
    if ($candidateIds === []) {
        if ($entityIds !== []) {
            return [(int) $entityIds[0]];
        }
        return [(int) $allowedIds[0]];
    }
    foreach ($candidateIds as $cid) {
        if (!in_array($cid, $allowedIds, true)) {
            sendResponse(false, 'One or more selected companies are not allowed for this group');
        }
    }
    return $candidateIds;
}

// Validate required fields for create/update
function validateUserData($data, $isUpdate = false) {
    $required = ['login_id', 'name', 'email', 'role', 'status'];
    if (!$isUpdate) {
        $required[] = 'password';
    }
    
    foreach ($required as $field) {
        if (!isset($data[$field]) || trim($data[$field]) === '') {
            return "Field '$field' is required";
        }
    }
    
    // Validate email format
    $emailValidation = validate_email($data['email'] ?? '');
    if (!$emailValidation['ok']) {
        return "Invalid email format";
    }
    $data['email'] = $emailValidation['normalized'];
    
    // Validate role
    $validRoles = ['owner', 'partnership', 'admin', 'manager', 'supervisor', 'accountant', 'audit', 'customer service', 'company'];
    if (!in_array($data['role'], $validRoles)) {
        return "Invalid role";
    }

    // Validate status (添加这个)
    $validStatuses = ['active', 'inactive'];
    if (!in_array($data['status'], $validStatuses)) {
        return "Invalid status";
    }
    
    return true;
}

// Check if login_id already exists
function checkLoginIdExists($pdo, $login_id, $company_id, $excludeId = null) {
    // 使用 user_company_map 来检查 login_id 是否存在
    $sql = "SELECT COUNT(*) 
            FROM user u
            INNER JOIN user_company_map ucm ON u.id = ucm.user_id
            WHERE u.login_id = ? AND ucm.company_id = ?";
    $params = [$login_id, $company_id];
    
    if ($excludeId) {
        $sql .= " AND u.id != ?";
        $params[] = $excludeId;
    }
    
    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    return $stmt->fetchColumn() > 0;
}

// Check if email already exists
function checkEmailExists($pdo, $email, $company_id, $excludeId = null) {
    // 使用 user_company_map 来检查 email 是否存在
    $sql = "SELECT COUNT(*) 
            FROM user u
            INNER JOIN user_company_map ucm ON u.id = ucm.user_id
            WHERE u.email = ? AND ucm.company_id = ?";
    $params = [$email, $company_id];
    
    if ($excludeId) {
        $sql .= " AND u.id != ?";
        $params[] = $excludeId;
    }
    
    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    return $stmt->fetchColumn() > 0;
}

try {
    if (!$input || !isset($input['action'])) {
        sendResponse(false, 'Invalid request');
    }
    
    $action = $input['action'];
    
    switch ($action) {
        case 'create':
            if (is_partnership_audit_read_only_active($pdo)) {
                sendResponse(false, '只读账号无法执行此操作');
            }
            if (!canCreateUserByRole($current_user_role)) {
                sendResponse(false, 'You do not have permission to create new accounts');
            }

            // Validate input
            $required = ['login_id', 'name', 'password', 'email', 'role', 'status'];
            foreach ($required as $field) {
                if (!isset($input[$field]) || trim($input[$field]) === '') {
                    sendResponse(false, "Field '$field' is required");
                }
            }
            
            // Validate email format
            $emailValidation = validate_email($input['email'] ?? '');
            if (!$emailValidation['ok']) {
                sendResponse(false, "Invalid email format");
            }
            $input['email'] = $emailValidation['normalized'];
            
            // Validate role
            $validRoles = ['partnership', 'admin', 'manager', 'supervisor', 'accountant', 'audit', 'customer service', 'company'];
            if (!in_array($input['role'], $validRoles)) {
                sendResponse(false, "Invalid role");
            }
            
            // Validate status
            $validStatuses = ['active', 'inactive'];
            if (!in_array($input['status'], $validStatuses)) {
                sendResponse(false, "Invalid status");
            }
            
            $groupScope = userlist_normalize_group_id($input['group_id'] ?? null);
            $mixedTenantAssign = userlist_is_mixed_tenant_assign($input);
            $groupTenantWrite = userlist_is_group_tenant_write($input);
            $mixedGroupCodes = [];
            // 验证 company_ids
            global $current_company_id;
            $rawCompanyIds = isset($input['company_ids']) && is_array($input['company_ids']) ? $input['company_ids'] : [];
            if ($mixedTenantAssign) {
                $mixedGroupCodes = userlist_normalize_group_code_list($input['group_codes'] ?? []);
                $company_ids = userlist_validate_company_ids_allowed(
                    $pdo,
                    array_values(array_unique(array_filter(array_map('intval', $rawCompanyIds), static fn (int $id): bool => $id > 0)))
                );
                if ($mixedGroupCodes === [] && $company_ids === []) {
                    sendResponse(false, 'At least one group or company is required');
                }
                foreach ($mixedGroupCodes as $bindGroup) {
                    userlist_assert_group_id_allowed($bindGroup);
                    if (userlist_login_id_exists_in_group_tenant($pdo, $input['login_id'], $bindGroup)) {
                        sendResponse(false, 'Login ID already exists in this group');
                    }
                    if (userlist_email_exists_in_group_tenant($pdo, $input['email'], $bindGroup)) {
                        sendResponse(false, 'Email already exists in this group');
                    }
                }
                if ($company_ids !== []) {
                    if (userlist_login_id_exists_in_companies($pdo, $input['login_id'], $company_ids)) {
                        sendResponse(false, 'Login ID already exists in one of the selected companies');
                    }
                    if (userlist_email_exists_in_companies($pdo, $input['email'], $company_ids)) {
                        sendResponse(false, 'Email already exists in one of the selected companies');
                    }
                }
                $scope_company_id = userlist_resolve_scope_company_id($pdo, $groupScope, $company_ids, (int) $current_company_id);
                $primary_company_id = $scope_company_id;
                $bindGroupScopes = [];
            } elseif ($groupScope !== null) {
                $company_ids = userlist_resolve_company_ids_for_group_scope($pdo, $groupScope, $rawCompanyIds, $groupTenantWrite);
                $scope_company_id = userlist_resolve_scope_company_id($pdo, $groupScope, $company_ids, (int) $current_company_id);
                $primary_company_id = $company_ids[0] ?? $scope_company_id;
                $bindGroupScopes = [];
                if ($groupTenantWrite) {
                    $bindGroupScopes = userlist_resolve_bind_group_scopes(
                        $pdo,
                        $company_ids,
                        $groupScope,
                        userlist_normalize_group_code_list($input['group_codes'] ?? [])
                    );
                    foreach ($bindGroupScopes as $bindGroup) {
                        if (userlist_login_id_exists_in_group_tenant($pdo, $input['login_id'], $bindGroup)) {
                            sendResponse(false, 'Login ID already exists in this group');
                        }
                        if (userlist_email_exists_in_group_tenant($pdo, $input['email'], $bindGroup)) {
                            sendResponse(false, 'Email already exists in this group');
                        }
                    }
                } elseif (count($company_ids) > 0) {
                    if (userlist_login_id_exists_in_companies($pdo, $input['login_id'], $company_ids)) {
                        sendResponse(false, 'Login ID already exists in one of the selected companies');
                    }
                    if (userlist_email_exists_in_companies($pdo, $input['email'], $company_ids)) {
                        sendResponse(false, 'Email already exists in one of the selected companies');
                    }
                }
            } else {
                $company_ids = $rawCompanyIds;
                if (empty($company_ids)) {
                    // Company mode fallback keeps original behavior.
                    $company_ids = [$current_company_id];
                }
                $company_ids = userlist_validate_company_ids_allowed($pdo, $company_ids);
                $scope_company_id = userlist_resolve_scope_company_id($pdo, $groupScope, $company_ids, (int) $current_company_id);
                $primary_company_id = $company_ids[0];
                $bindGroupScopes = [];
                if (count($company_ids) > 0) {
                    if (userlist_login_id_exists_in_companies($pdo, $input['login_id'], $company_ids)) {
                        sendResponse(false, 'Login ID already exists in one of the selected companies');
                    }
                    if (userlist_email_exists_in_companies($pdo, $input['email'], $company_ids)) {
                        sendResponse(false, 'Email already exists in one of the selected companies');
                    }
                }
            }

            if (!$mixedTenantAssign && count($company_ids) > 0) {
                $placeholders = str_repeat('?,', count($company_ids) - 1) . '?';
                $stmt = $pdo->prepare("SELECT id FROM company WHERE id IN ($placeholders)");
                $stmt->execute($company_ids);
                $validCompanies = $stmt->fetchAll(PDO::FETCH_COLUMN);

                if (count($validCompanies) !== count($company_ids)) {
                    sendResponse(false, 'One or more selected companies are invalid');
                }
            }

            // user.email 为全局 UNIQUE：与所选公司无关，需单独拦截以免落到 PDO 异常
            $stmt = $pdo->prepare('SELECT COUNT(*) FROM user WHERE email = ?');
            $stmt->execute([$input['email']]);
            if ((int) $stmt->fetchColumn() > 0) {
                sendResponse(false, 'Duplicate email');
            }
            
            // Hash password
            $hashedPassword = secure_hash_password($input['password']);
            
            // Hash secondary_password if provided (for c168 company users)
            $hashedSecondaryPassword = null;
            if (isset($input['secondary_password']) && trim($input['secondary_password']) !== '') {
                // 验证二级密码：必须是6位数字
                if (!preg_match('/^\d{6}$/', $input['secondary_password'])) {
                    sendResponse(false, 'Secondary password must be exactly 6 digits');
                }
                $hashedSecondaryPassword = secure_hash_password($input['secondary_password']);
            }
            
            // 处理权限数据
            $permissionsArray = null;
            if (isset($input['permissions']) && is_array($input['permissions'])) {
                $permissionsArray = sanitize_sidebar_permissions_for_role($input['role'] ?? '', $input['permissions']);
            }
            $permissions = $permissionsArray !== null ? json_encode($permissionsArray) : null;

            // 开始事务
            $pdo->beginTransaction();
            
            try {
                // Insert new user (不再使用 company_id，因为已移除)
                $readOnly = 1;
                if (isset($input['read_only']) && canSetUserReadOnly($current_user_role, $input['role'] ?? '')) {
                    $readOnly = (int)$input['read_only'];
                }
                $sql = "INSERT INTO user (login_id, name, password, secondary_password, email, role, permissions, read_only, status, created_by, created_at) 
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())";
                
                $stmt = $pdo->prepare($sql);
                $result = $stmt->execute([
                    $input['login_id'],
                    $input['name'],
                    $hashedPassword,
                    $hashedSecondaryPassword,
                    $input['email'],
                    $input['role'],
                    $permissions,
                    $readOnly,
                    $input['status'],
                    getCurrentUser()
                ]);
                
                if (!$result) {
                    $errorInfo = $stmt->errorInfo();
                    error_log("Failed to create user - SQL Error: " . print_r($errorInfo, true));
                    throw new Exception('Failed to create user: ' . ($errorInfo[2] ?? 'Unknown database error'));
                }
                
                $newUserId = $pdo->lastInsertId();
                
                if (!$newUserId || $newUserId <= 0) {
                    error_log("Failed to get new user ID after insert");
                    throw new Exception('Failed to get new user ID');
                }
                
                if ($mixedTenantAssign) {
                    $scope_company_id = userlist_sync_mixed_tenant_assignments(
                        $pdo,
                        (int) $newUserId,
                        $mixedGroupCodes,
                        $company_ids
                    );
                    $primary_company_id = $scope_company_id;
                } elseif ($groupTenantWrite && $groupScope !== null) {
                    $primary_company_id = userlist_sync_user_group_tenants(
                        $pdo,
                        (int) $newUserId,
                        $bindGroupScopes !== [] ? $bindGroupScopes : [$groupScope]
                    );
                    $scope_company_id = $primary_company_id;
                } else {
                    foreach ($company_ids as $company_id) {
                        userlist_insert_company_scope_map($pdo, (int) $newUserId, (int) $company_id);
                    }
                }
                
                // Acc/Process JSON 写在当前 Acc 列表公司（request/session），不是 company_ids[0]
                $permCompanyId = userlist_resolve_permission_company_id($input, (int) $scope_company_id, (int) $current_company_id);
                if (
                    $permCompanyId > 0
                    && (isset($input['account_permissions']) || isset($input['process_permissions']))
                ) {
                    $accountPerms = null;
                    $processPerms = null;
                    
                    if (isset($input['account_permissions'])) {
                        if (is_array($input['account_permissions']) && count($input['account_permissions']) > 0) {
                            $accountPerms = json_encode($input['account_permissions']);
                        } else {
                            $accountPerms = json_encode([]);
                        }
                    }
                    
                    if (isset($input['process_permissions'])) {
                        if (is_array($input['process_permissions']) && count($input['process_permissions']) > 0) {
                            $processPerms = json_encode($input['process_permissions']);
                        } else {
                            $processPerms = json_encode([]);
                        }
                    }
                    
                    $permStmt = $pdo->prepare("INSERT INTO user_company_permissions (user_id, company_id, account_permissions, process_permissions) VALUES (?, ?, ?, ?)");
                    $permStmt->execute([$newUserId, $permCompanyId, $accountPerms, $processPerms]);
                }
                
                // 提交事务
                $pdo->commit();
                
                // Post-commit reads must never fail the create result.
                $newUser = [
                    'id' => (int)$newUserId,
                    'login_id' => (string)$input['login_id'],
                    'name' => (string)$input['name'],
                    'email' => (string)$input['email'],
                    'role' => (string)$input['role'],
                    'status' => (string)$input['status'],
                    'last_login' => null,
                    'created_by' => getCurrentUser(),
                    'account_permissions' => null,
                    'process_permissions' => null,
                ];
                try {
                    $stmt = $pdo->prepare("SELECT id, login_id, name, email, role, status, last_login, created_by FROM user WHERE id = ?");
                    $stmt->execute([$newUserId]);
                    $dbUser = $stmt->fetch(PDO::FETCH_ASSOC);
                    if ($dbUser) {
                        $newUser = array_merge($newUser, $dbUser);
                    }

                    $stmt = $pdo->prepare("SELECT account_permissions, process_permissions FROM user_company_permissions WHERE user_id = ? AND company_id = ?");
                    $stmt->execute([$newUserId, $permCompanyId > 0 ? $permCompanyId : $scope_company_id]);
                    $companyPermissions = $stmt->fetch(PDO::FETCH_ASSOC);
                    if ($companyPermissions) {
                        $newUser['account_permissions'] = $companyPermissions['account_permissions'];
                        $newUser['process_permissions'] = $companyPermissions['process_permissions'];
                    }
                } catch (Throwable $postCommitReadError) {
                    error_log("Create user post-commit read error: " . $postCommitReadError->getMessage());
                }

                require_once __DIR__ . '/../includes/realtime.php';
                $publishIds = array_values(array_filter(array_map('intval', is_array($company_ids ?? null) ? $company_ids : [])));
                if ($publishIds === [] && !empty($scope_company_id)) {
                    $publishIds = [(int) $scope_company_id];
                }
                if ($publishIds === [] && (int) $current_company_id > 0) {
                    $publishIds = [(int) $current_company_id];
                }
                if ($publishIds !== []) {
                    realtime_publish_companies($publishIds, 'users', 'create');
                }
                
                sendResponse(true, 'User created successfully', $newUser);
            } catch (PDOException $e) {
                userlist_safe_rollback($pdo);
                error_log("Create user PDO error: " . $e->getMessage());
                error_log("SQL State: " . $e->getCode());
                error_log("Error Info: " . print_r($e->errorInfo, true));
                sendResponse(false, userlistFriendlyDbError($e));
            } catch (Exception $e) {
                userlist_safe_rollback($pdo);
                error_log("Create user error: " . $e->getMessage());
                sendResponse(false, userlistFriendlyDbError($e));
            }
            break;
            
        case 'update':
            if (!isset($input['id'])) {
                sendResponse(false, 'User ID is required');
            }
            $updateUserId = (int) $input['id'];
            if (partnership_audit_read_only_blocks_userlist_self_edit($pdo, $updateUserId)) {
                sendResponse(false, '只读账号无法执行此操作');
            }
            
            global $current_company_id, $current_user_role;
            $groupScope = userlist_normalize_group_id($input['group_id'] ?? null);
            $mixedTenantAssign = userlist_is_mixed_tenant_assign($input);
            $groupTenantWrite = userlist_is_group_tenant_write($input);
            $mixedGroupCodes = $mixedTenantAssign
                ? userlist_normalize_group_code_list($input['group_codes'] ?? [])
                : [];
            $rawCompanyIds = isset($input['company_ids']) && is_array($input['company_ids']) ? $input['company_ids'] : [];
            $will_lose_access = false;
            if ($mixedTenantAssign) {
                $validatedScopeCompanyIds = userlist_validate_company_ids_allowed(
                    $pdo,
                    array_values(array_unique(array_filter(array_map('intval', $rawCompanyIds), static fn (int $id): bool => $id > 0)))
                );
                if ($mixedGroupCodes === [] && $validatedScopeCompanyIds === []) {
                    sendResponse(false, 'At least one group or company is required');
                }
            } elseif ($groupScope !== null) {
                $validatedScopeCompanyIds = userlist_resolve_company_ids_for_group_scope($pdo, $groupScope, $rawCompanyIds, $groupTenantWrite);
            } else {
                $validatedScopeCompanyIds = userlist_validate_company_ids_allowed($pdo, $rawCompanyIds);
            }
            $scope_company_id = userlist_resolve_scope_company_id($pdo, $groupScope, $validatedScopeCompanyIds, (int) $current_company_id);
            
            // 检查是否是owner影子
            if (isOwnerShadow($pdo, $input['id'], $scope_company_id)) {
                // 只有owner本人可以更新owner记录
                if ($current_user_role !== 'owner') {
                    sendResponse(false, '只有owner本人可以编辑owner记录');
                }
                
                // 更新owner表
                $updateFields = [];
                $updateValues = [];
                
                if (isset($input['name'])) {
                    $updateFields[] = "name = ?";
                    $updateValues[] = $input['name'];
                }
                
                if (isset($input['email'])) {
                    $emailValidation = validate_email($input['email']);
                    if (!$emailValidation['ok']) {
                        sendResponse(false, "Invalid email format");
                    }
                    $updateFields[] = "email = ?";
                    $updateValues[] = $emailValidation['normalized'];
                }
                
                if (isset($input['status'])) {
                    $validStatuses = ['active', 'inactive'];
                    if (!in_array($input['status'], $validStatuses)) {
                        sendResponse(false, "Invalid status");
                    }
                    $updateFields[] = "status = ?";
                    $updateValues[] = $input['status'];
                }
                
                // Only update password if provided
                if (isset($input['password']) && trim($input['password']) !== '') {
                    $updateFields[] = "password = ?";
                    $updateValues[] = secure_hash_password($input['password']);
                }
                
                // Only update secondary_password if provided (for c168 company)
                if (isset($input['secondary_password']) && trim($input['secondary_password']) !== '') {
                    // 验证二级密码：必须是6位数字
                    if (!preg_match('/^\d{6}$/', $input['secondary_password'])) {
                        sendResponse(false, 'Secondary password must be exactly 6 digits');
                    }
                    $updateFields[] = "secondary_password = ?";
                    $updateValues[] = secure_hash_password($input['secondary_password']);
                }
                
                if (empty($updateFields)) {
                    sendResponse(false, 'No fields to update');
                }
                
                $updateValues[] = $input['id'];
                $sql = "UPDATE owner SET " . implode(', ', $updateFields) . " WHERE id = ?";
                
                $stmt = $pdo->prepare($sql);
                $result = $stmt->execute($updateValues);
                
                if ($result) {
                    // 获取更新后的owner信息
                    $stmt = $pdo->prepare("
                        SELECT o.id, o.owner_code as login_id, o.name, o.email, 'owner' as role, o.status, NULL as last_login, NULL as created_by
                        FROM owner o
                        INNER JOIN company c ON c.owner_id = o.id
                        WHERE o.id = ? AND c.id = ?
                    ");
                    $stmt->execute([$input['id'], $scope_company_id]);
                    $updatedOwner = $stmt->fetch(PDO::FETCH_ASSOC);

                    require_once __DIR__ . '/../includes/realtime.php';
                    if ((int) $scope_company_id > 0) {
                        realtime_publish_companies([(int) $scope_company_id], 'users', 'update');
                    }
                    
                    sendResponse(true, 'Owner updated successfully', $updatedOwner);
                } else {
                    sendResponse(false, 'Failed to update owner');
                }
                break;
            }
            
            // 获取原有的 login_id 并验证用户是否存在
            // 注意：用户可能属于多个公司，所以不限制在当前公司
            $stmt = $pdo->prepare("
                SELECT u.login_id, u.role, u.id
                FROM user u
                WHERE u.id = ?
            ");
            $stmt->execute([$input['id']]);
            $originalUser = $stmt->fetch(PDO::FETCH_ASSOC);
            
            if (!$originalUser) {
                sendResponse(false, 'User not found');
            }
            
            $belongsToCurrentCompany = false;
            if ($mixedTenantAssign) {
                $uid = (int) $input['id'];
                $allowedCompany = userlist_fetch_company_scope_user_ids($pdo, [$scope_company_id]);
                $belongsToCurrentCompany = in_array($uid, $allowedCompany, true);
                if (!$belongsToCurrentCompany && $groupScope !== null && userlist_is_group_only_list_request($input)) {
                    userlist_assert_user_visible_in_request_scope($pdo, $uid, $input);
                } elseif (!$belongsToCurrentCompany) {
                    $groupCodesForCheck = $mixedGroupCodes;
                    if ($groupCodesForCheck === [] && $groupScope !== null) {
                        $groupCodesForCheck = [$groupScope];
                    }
                    $visible = false;
                    foreach ($groupCodesForCheck as $gCheck) {
                        if (in_array($uid, userlist_fetch_group_only_user_ids($pdo, $gCheck), true)) {
                            $visible = true;
                            break;
                        }
                    }
                    if (!$visible && !in_array($uid, $allowedCompany, true)) {
                        sendResponse(false, 'User not found or access denied');
                    }
                }
            } elseif ($groupTenantWrite && $groupScope !== null) {
                userlist_assert_user_visible_in_request_scope($pdo, (int) $input['id'], $input);
            } else {
                $allowed = userlist_fetch_company_scope_user_ids($pdo, [$scope_company_id]);
                $belongsToCurrentCompany = in_array((int) $input['id'], $allowed, true);
                if (!$belongsToCurrentCompany) {
                    sendResponse(false, 'User not found or access denied');
                }
            }

            // 角色层级校验：只有严格上级或本人可以编辑（含改密码）。
            // owner 影子记录走上面的 isOwnerShadow 分支（仅 owner 本人），此处只覆盖 user 表记录。
            $currentUserId = (int) ($_SESSION['user_id'] ?? 0);
            $targetUserId = (int) $input['id'];
            $isSelfUpdate = $currentUserId > 0 && $targetUserId === $currentUserId;
            $currentRoleLevel = userlistRoleLevel((string) $current_user_role);
            $targetRoleLevel = userlistRoleLevel((string) ($originalUser['role'] ?? ''));
            if (!$isSelfUpdate && $targetRoleLevel <= $currentRoleLevel) {
                sendResponse(false, '无权限修改同级或上级账号');
            }
            
            // 如果没有提交 login_id，使用原有的
            if (!isset($input['login_id'])) {
                $input['login_id'] = $originalUser['login_id'];
            }
            
            // Validate input
            $validation = validateUserData($input, true);
            if ($validation !== true) {
                sendResponse(false, $validation);
            }
            
            $updateBindGroupScopes = [];
            if ($groupTenantWrite && $groupScope !== null) {
                $updateBindGroupScopes = userlist_resolve_bind_group_scopes(
                    $pdo,
                    $validatedScopeCompanyIds,
                    $groupScope,
                    userlist_normalize_group_code_list($input['group_codes'] ?? [])
                );
                foreach ($updateBindGroupScopes as $bindGroup) {
                    if (userlist_login_id_exists_in_group_tenant($pdo, $input['login_id'], $bindGroup, (int) $input['id'])) {
                        sendResponse(false, 'Login ID already exists in this group');
                    }
                    if (userlist_email_exists_in_group_tenant($pdo, $input['email'], $bindGroup, (int) $input['id'])) {
                        sendResponse(false, 'Email already exists in this group');
                    }
                }
            } else {
                if (userlist_login_id_exists_in_companies($pdo, $input['login_id'], [$scope_company_id], (int) $input['id'])) {
                    sendResponse(false, 'Login ID already exists in current company');
                }
                if (userlist_email_exists_in_companies($pdo, $input['email'], [$scope_company_id], (int) $input['id'])) {
                    sendResponse(false, 'Email already exists in current company');
                }
            }

            $stmt = $pdo->prepare('SELECT COUNT(*) FROM user WHERE email = ? AND id != ?');
            $stmt->execute([$input['email'], $input['id']]);
            if ((int) $stmt->fetchColumn() > 0) {
                sendResponse(false, 'Duplicate email');
            }
            
            // Prepare update query
            $updateFields = [];
            $updateValues = [];
            
            $updateFields[] = "login_id = ?";
            $updateValues[] = $input['login_id'];
            
            $updateFields[] = "name = ?";
            $updateValues[] = $input['name'];
            
            $updateFields[] = "email = ?";
            $updateValues[] = $input['email'];
            
            $updateFields[] = "role = ?";
            $updateValues[] = $input['role'];

            $updateFields[] = "status = ?";
            $updateValues[] = $input['status'];

            // 保存 read_only（Audit：manager+；Partnership：仅 owner）
            if (isset($input['read_only']) && canSetUserReadOnly($current_user_role, $input['role'] ?? '')) {
                $updateFields[] = "read_only = ?";
                $updateValues[] = (int)$input['read_only'];
            }

            // 添加权限字段到更新列表（系统级权限仍然存储在 user 表）
            $updateFields[] = "permissions = ?";
            $permissionsArray = null;
            if (isset($input['permissions']) && is_array($input['permissions'])) {
                $permissionsArray = sanitize_sidebar_permissions_for_role($input['role'] ?? '', $input['permissions']);
            }
            $updateValues[] = $permissionsArray !== null ? json_encode($permissionsArray) : null;
            
            // Account 和 Process 权限不再更新到 user 表，而是更新到 user_company_permissions 表
            // 这些字段保留在 $input 中，稍后在事务中处理
            
            // Only update password if provided
            $userPasswordWasUpdated = false;
            if (isset($input['password']) && trim($input['password']) !== '') {
                $updateFields[] = "password = ?";
                $updateValues[] = secure_hash_password($input['password']);
                $userPasswordWasUpdated = true;
            }
            
            // Only update secondary_password if provided (for c168 company users)
            if (isset($input['secondary_password']) && trim($input['secondary_password']) !== '') {
                // 验证二级密码：必须是6位数字
                if (!preg_match('/^\d{6}$/', $input['secondary_password'])) {
                    sendResponse(false, 'Secondary password must be exactly 6 digits');
                }
                $updateFields[] = "secondary_password = ?";
                $updateValues[] = secure_hash_password($input['secondary_password']);
            }
            
            // 添加 WHERE 条件的参数
            $updateValues[] = $input['id'];
            
            // 开始事务
            $pdo->beginTransaction();
            
            try {
                // 更新用户基本信息
                $sql = "UPDATE user SET " . implode(', ', $updateFields) . " WHERE id = ?";
                $stmt = $pdo->prepare($sql);
                $result = $stmt->execute($updateValues);
                
                if (!$result) {
                    throw new Exception('Failed to update user');
                }

                if ($userPasswordWasUpdated) {
                    invalidate_user_remember_token($pdo, (int) $input['id']);
                    // 指纹解锁凭据同步作废（device_token 覆盖 owner/user/member）
                    invalidate_device_tokens($pdo, 'user', (int) $input['id']);
                }
                
                // 同步 read_only 到 company_ownership
                if ($current_user_role === 'owner' && isset($input['read_only']) && strtolower($input['role']) === 'partnership') {
                    $updCoStmt = $pdo->prepare("UPDATE company_ownership SET read_only = ? WHERE company_id = ? AND account_id = ? AND owner_type = 'user'");
                    $updCoStmt->execute([(int)$input['read_only'], $scope_company_id, $input['id']]);
                }
                
                if ($mixedTenantAssign) {
                    $syncCompanyIds = $validatedScopeCompanyIds;
                    if ($belongsToCurrentCompany && !in_array($scope_company_id, $syncCompanyIds, true)) {
                        $will_lose_access = true;
                    }
                    userlist_sync_mixed_tenant_assignments(
                        $pdo,
                        (int) $input['id'],
                        $mixedGroupCodes,
                        $syncCompanyIds
                    );
                } elseif (isset($input['company_ids']) && is_array($input['company_ids']) && count($input['company_ids']) > 0) {
                    if ($groupTenantWrite && $groupScope !== null) {
                        $input['company_ids'] = userlist_resolve_company_ids_for_group_scope($pdo, $groupScope, $input['company_ids'], true);
                    } elseif ($groupScope !== null) {
                        $input['company_ids'] = userlist_resolve_company_ids_for_group_scope($pdo, $groupScope, $input['company_ids'], false);
                    } else {
                        $input['company_ids'] = userlist_validate_company_ids_allowed($pdo, $input['company_ids']);
                    }
                    $placeholders = str_repeat('?,', count($input['company_ids']) - 1) . '?';
                    $stmt = $pdo->prepare("SELECT id FROM company WHERE id IN ($placeholders)");
                    $stmt->execute($input['company_ids']);
                    $validCompanies = $stmt->fetchAll(PDO::FETCH_COLUMN);

                    if (count($validCompanies) !== count($input['company_ids'])) {
                        throw new Exception('One or more selected companies are invalid');
                    }

                    if ($belongsToCurrentCompany && !in_array($scope_company_id, $input['company_ids'])) {
                        $will_lose_access = true;
                    }

                    if (!$groupTenantWrite) {
                        if (userlist_ucm_has_scope_columns($pdo)) {
                            $stmt = $pdo->prepare("DELETE FROM user_company_map WHERE user_id = ? AND scope_type = 'company'");
                            $stmt->execute([$input['id']]);
                        } else {
                            $stmt = $pdo->prepare('DELETE FROM user_company_map WHERE user_id = ?');
                            $stmt->execute([$input['id']]);
                        }
                        foreach ($input['company_ids'] as $company_id) {
                            userlist_insert_company_scope_map($pdo, (int) $input['id'], (int) $company_id);
                        }
                    }
                }

                if (!$mixedTenantAssign && userlist_should_sync_group_tenants($input, $groupTenantWrite, $groupScope)) {
                    $bindGroupScopes = userlist_resolve_sync_bind_group_scopes($pdo, $input, $groupScope);
                    userlist_sync_user_group_tenants($pdo, (int) $input['id'], $bindGroupScopes);
                }
                
                // Acc/Process: superior may update both; non-owner self may update own flags only.
                $currentUid = (int) ($_SESSION['user_id'] ?? 0);
                $targetUid = (int) $input['id'];
                $targetRole = (string) ($originalUser['role'] ?? '');
                $canSuperiorAccess = userlist_can_edit_target_access($current_user_role, $targetRole, $currentUid, $targetUid);
                $canSelfAccountAccess = userlist_can_edit_own_account_access($current_user_role, $currentUid, $targetUid);
                if (!$canSuperiorAccess && !$canSelfAccountAccess) {
                    unset($input['account_permissions'], $input['process_permissions']);
                }
                $accountPermsUpdated = false;
                $processPermsUpdated = false;
                $permCompanyId = userlist_resolve_permission_company_id($input, (int) $scope_company_id, (int) $current_company_id);
                if (
                    $permCompanyId > 0
                    && (isset($input['account_permissions']) || isset($input['process_permissions']))
                ) {
                    $existingPermStmt = $pdo->prepare("SELECT account_permissions, process_permissions FROM user_company_permissions WHERE user_id = ? AND company_id = ? LIMIT 1");
                    $existingPermStmt->execute([$targetUid, $permCompanyId]);
                    $existingPermRow = $existingPermStmt->fetch(PDO::FETCH_ASSOC) ?: null;
                    $isSelfAccessSave = $canSelfAccountAccess && !$canSuperiorAccess;

                    $accountPerms = null;
                    $processPerms = null;
                    
                    if (isset($input['account_permissions'])) {
                        $accountPermsUpdated = true;
                        $incomingAccounts = is_array($input['account_permissions']) ? $input['account_permissions'] : [];
                        $incomingAccounts = userlist_normalize_account_incoming($incomingAccounts, $isSelfAccessSave);
                        $editorAccountAssignable = permissions_account_toggleable_ids($pdo, $currentUid, $permCompanyId, $current_user_role);
                        $mergedAccounts = userlist_merge_access_payload(
                            $existingPermRow['account_permissions'] ?? null,
                            $incomingAccounts,
                            $editorAccountAssignable
                        );
                        $accountPerms = json_encode(array_values($mergedAccounts));
                    }
                    
                    if (isset($input['process_permissions'])) {
                        $processPermsUpdated = true;
                        $incomingProcesses = is_array($input['process_permissions']) ? $input['process_permissions'] : [];
                        $incomingProcesses = userlist_normalize_account_incoming($incomingProcesses, $isSelfAccessSave);
                        $editorProcessAssignable = permissions_process_toggleable_ids($pdo, $currentUid, $permCompanyId, $current_user_role);
                        $mergedProcesses = userlist_merge_access_payload(
                            $existingPermRow['process_permissions'] ?? null,
                            $incomingProcesses,
                            $editorProcessAssignable
                        );
                        $processPerms = json_encode(array_values($mergedProcesses));
                    }
                    
                    // 使用 INSERT ... ON DUPLICATE KEY UPDATE 来更新或插入
                    $stmt = $pdo->prepare("
                        INSERT INTO user_company_permissions (user_id, company_id, account_permissions, process_permissions) 
                        VALUES (?, ?, ?, ?)
                        ON DUPLICATE KEY UPDATE 
                            account_permissions = IF(? IS NOT NULL, VALUES(account_permissions), account_permissions),
                            process_permissions = IF(? IS NOT NULL, VALUES(process_permissions), process_permissions),
                            updated_at = CURRENT_TIMESTAMP
                    ");
                    $stmt->execute([
                        $input['id'], 
                        $permCompanyId, 
                        $accountPerms, 
                        $processPerms,
                        $accountPerms, // 用于条件判断
                        $processPerms  // 用于条件判断
                    ]);
                }
                
                // 提交事务
                $pdo->commit();
                
                // 获取更新后的用户信息；提交后读取失败不应影响保存结果。
                $updatedUser = [
                    'id' => (int) $input['id'],
                    'login_id' => (string) ($input['login_id'] ?? ''),
                    'name' => (string) ($input['name'] ?? ''),
                    'email' => (string) ($input['email'] ?? ''),
                    'role' => (string) ($input['role'] ?? ''),
                    'status' => (string) ($input['status'] ?? ''),
                    'last_login' => null,
                    'created_by' => null,
                    'account_permissions' => null,
                    'process_permissions' => null,
                ];
                try {
                    $stmt = $pdo->prepare("SELECT id, login_id, name, email, role, status, last_login, created_by FROM user WHERE id = ?");
                    $stmt->execute([$input['id']]);
                    $dbUser = $stmt->fetch(PDO::FETCH_ASSOC);
                    if ($dbUser) {
                        $updatedUser = array_merge($updatedUser, $dbUser);
                    }

                    // 仅从 user_company_permissions 读取公司级权限。
                    $stmt = $pdo->prepare("SELECT account_permissions, process_permissions FROM user_company_permissions WHERE user_id = ? AND company_id = ?");
                    $stmt->execute([$input['id'], $permCompanyId > 0 ? $permCompanyId : $scope_company_id]);
                    $companyPermissions = $stmt->fetch(PDO::FETCH_ASSOC);
                    if ($companyPermissions) {
                        $updatedUser['account_permissions'] = $companyPermissions['account_permissions'];
                        $updatedUser['process_permissions'] = $companyPermissions['process_permissions'];
                    }
                } catch (Throwable $postCommitReadError) {
                    error_log("Update user post-commit read error: " . $postCommitReadError->getMessage());
                }
                
                $message = 'User updated successfully';
                if ($will_lose_access) {
                    $message .= '。注意：移除后用户将不再属于当前公司，如需继续操作请切换到用户所属的其他公司';
                }
                
                // 在响应中添加 will_lose_access 标志
                $responseData = $updatedUser;
                if (isset($responseData)) {
                    $responseData = array_merge((array)$responseData, ['will_lose_access' => $will_lose_access]);
                } else {
                    $responseData = ['will_lose_access' => $will_lose_access];
                }

                require_once __DIR__ . '/../includes/realtime.php';
                $publishIds = array_values(array_filter(array_map('intval', is_array($validatedScopeCompanyIds ?? null) ? $validatedScopeCompanyIds : [])));
                if ($publishIds === [] && !empty($scope_company_id)) {
                    $publishIds = [(int) $scope_company_id];
                }
                if ($publishIds === [] && (int) $current_company_id > 0) {
                    $publishIds = [(int) $current_company_id];
                }
                if ($publishIds !== []) {
                    realtime_publish_companies($publishIds, 'users', 'update');
                    // Acc/Process 白名单变更：Account / Process 下拉 + ledger 立刻按新权限重拉
                    if (!empty($accountPermsUpdated)) {
                        realtime_publish_companies($publishIds, 'accounts', 'user_account_permissions');
                        realtime_publish_companies($publishIds, 'ledger', 'user_account_permissions');
                    }
                    if (!empty($processPermsUpdated)) {
                        realtime_publish_companies($publishIds, 'processes', 'user_process_permissions');
                    }
                }
                
                sendResponse(true, $message, $responseData);
            } catch (PDOException $e) {
                $pdo->rollBack();
                error_log("Update user PDO error: " . $e->getMessage());
                error_log("SQL State: " . $e->getCode());
                error_log("Error Info: " . print_r($e->errorInfo, true));
                sendResponse(false, userlistFriendlyDbError($e));
            } catch (Exception $e) {
                $pdo->rollBack();
                error_log("Update user error: " . $e->getMessage());
                sendResponse(false, userlistFriendlyDbError($e));
            }
            break;
            
        case 'delete':
            if (is_partnership_audit_read_only_active($pdo)) {
                sendResponse(false, '只读账号无法执行此操作');
            }
            if (!isset($input['id'])) {
                sendResponse(false, 'User ID is required');
            }
            
            // 确保ID是整数类型
            $userId = intval($input['id']);
            if ($userId <= 0) {
                sendResponse(false, 'Invalid user ID');
            }
            
            global $current_company_id, $current_user_role;

            $groupScope = userlist_normalize_group_id($input['group_id'] ?? null);
            if ($groupScope !== null && userlist_is_group_only_list_request($input)) {
                userlist_assert_user_visible_in_request_scope($pdo, $userId, $input);
                $scopeCompanyIds = userlist_strict_group_entity_company_ids($pdo, $groupScope);
                if ($scopeCompanyIds === []) {
                    $anchor = userlist_resolve_group_tenant_entity_company_id($pdo, $groupScope);
                    $scopeCompanyIds = $anchor > 0 ? [$anchor] : [];
                }
            } else {
                $scopeCompanyIds = userlist_resolve_filter_company_ids($pdo, $input);
                if ($scopeCompanyIds === []) {
                    sendResponse(false, 'User not found or access denied');
                }
            }
            $requestedCompanyId = (int) ($input['company_id'] ?? 0);
            $validatedScopeCompanyIds = $requestedCompanyId > 0
                ? userlist_validate_company_ids_allowed($pdo, [$requestedCompanyId])
                : [];
            $scopeCompanyId = userlist_resolve_scope_company_id(
                $pdo,
                $groupScope,
                $validatedScopeCompanyIds,
                (int) $current_company_id
            );
            
            // 检查用户是否试图删除自己
            $currentUserId = $_SESSION['user_id'] ?? null;
            if ($currentUserId && intval($currentUserId) === $userId) {
                sendResponse(false, 'You cannot delete your own account');
            }
            
            // 检查是否是owner影子
            if (isOwnerShadow($pdo, $userId, $scopeCompanyId)) {
                // 只有owner本人可以删除owner记录
                if ($current_user_role !== 'owner') {
                    sendResponse(false, '只有owner本人可以删除owner记录');
                }
                
                // owner记录不允许删除（因为company表有外键约束）
                sendResponse(false, 'Owner记录不能删除，因为它是公司的所有者');
            }
            
            if ($groupScope !== null && userlist_is_group_only_list_request($input)) {
                $stmt = $pdo->prepare('SELECT id, login_id, name, role FROM user WHERE id = ? LIMIT 1');
                $stmt->execute([$userId]);
                $user = $stmt->fetch(PDO::FETCH_ASSOC);
                if (!$user) {
                    sendResponse(false, 'User not found or access denied');
                }
            } else {
                $allowed = userlist_fetch_company_scope_user_ids($pdo, $scopeCompanyIds);
                if (!in_array($userId, $allowed, true)) {
                    sendResponse(false, 'User not found or access denied');
                }
                $stmt = $pdo->prepare('SELECT id, login_id, name, role FROM user WHERE id = ? LIMIT 1');
                $stmt->execute([$userId]);
                $user = $stmt->fetch(PDO::FETCH_ASSOC);
                if (!$user) {
                    sendResponse(false, 'User not found or access denied');
                }
            }
            
            // 检查是否试图删除同等级或更高层级的用户
            $role_hierarchy = [
                'owner' => 0,
                'partnership' => 1,
                'admin' => 2,
                'manager' => 3,
                'supervisor' => 4,
                'accountant' => 5,
                'audit' => 6,
                'customer service' => 7,

            ];
            $current_user_level = $role_hierarchy[strtolower($current_user_role)] ?? 999;
            $target_user_level = $role_hierarchy[strtolower($user['role'] ?? '')] ?? 999;
            
            if ($current_user_level === $target_user_level) {
                sendResponse(false, 'You cannot delete accounts with the same role level');
            }
            
            // 检查是否试图删除比自己层级更高的用户（数字越小，层级越高）
            if ($target_user_level < $current_user_level) {
                sendResponse(false, 'You cannot delete accounts with higher role level');
            }
            
            // 获取当前登录用户ID（用于替换NOT NULL字段）
            $currentUserId = $_SESSION['user_id'] ?? null;
            
            // 获取替换用户ID（用于NOT NULL字段和优先使用替换用户的字段）
            $replacementUserId = null;
            $isGroupOnlyDelete = $groupScope !== null && userlist_is_group_only_list_request($input);
            
                // 优先级1: 使用当前登录用户（如果不是要删除的用户）
                if (isset($_SESSION['user_id']) && $_SESSION['user_id'] != $userId) {
                    $currentUserId = $_SESSION['user_id'];
                    if ($isGroupOnlyDelete && $scopeCompanyId <= 0) {
                        // Pure group: current session user is a valid replacement when they share the group.
                        $allowed = userlist_fetch_group_only_user_ids($pdo, $groupScope);
                        if (in_array((int) $currentUserId, $allowed, true) || strtolower((string) $current_user_role) === 'owner') {
                            $replacementUserId = (int) $currentUserId;
                        }
                    } else {
                        // 验证当前用户是否存在且属于同一公司
                        $stmt = $pdo->prepare("
                            SELECT u.id 
                            FROM user u
                            INNER JOIN user_company_map ucm ON u.id = ucm.user_id
                            WHERE u.id = ? AND ucm.company_id = ?
                            LIMIT 1
                        ");
                        $stmt->execute([$currentUserId, $scopeCompanyId]);
                        $replacementUserId = $stmt->fetchColumn();
                    }
                }
                
                // 优先级2: 如果当前用户不可用，找同公司的活动用户
                if (!$replacementUserId) {
                    if ($isGroupOnlyDelete && $scopeCompanyId <= 0) {
                        $peerIds = array_values(array_filter(
                            userlist_fetch_group_only_user_ids($pdo, $groupScope),
                            static fn (int $id): bool => $id !== $userId
                        ));
                        if ($peerIds !== []) {
                            $ph = implode(',', array_fill(0, count($peerIds), '?'));
                            $stmt = $pdo->prepare("
                                SELECT id FROM user
                                WHERE id IN ($ph) AND status = 'active'
                                LIMIT 1
                            ");
                            $stmt->execute($peerIds);
                            $replacementUserId = $stmt->fetchColumn();
                            if (!$replacementUserId) {
                                $stmt = $pdo->prepare("SELECT id FROM user WHERE id IN ($ph) LIMIT 1");
                                $stmt->execute($peerIds);
                                $replacementUserId = $stmt->fetchColumn();
                            }
                        }
                        if (!$replacementUserId && isset($_SESSION['user_id']) && (int) $_SESSION['user_id'] !== $userId) {
                            $replacementUserId = (int) $_SESSION['user_id'];
                        }
                    } else {
                        $stmt = $pdo->prepare("
                            SELECT u.id 
                            FROM user u
                            INNER JOIN user_company_map ucm ON u.id = ucm.user_id
                            WHERE ucm.company_id = ? AND u.id != ? AND u.status = 'active'
                            LIMIT 1
                        ");
                        $stmt->execute([$scopeCompanyId, $userId]);
                        $replacementUserId = $stmt->fetchColumn();
                    }
                }
                
                // 优先级3: 如果还是没有活动用户，找任何同公司的用户
                if (!$replacementUserId && !($isGroupOnlyDelete && $scopeCompanyId <= 0)) {
                    $stmt = $pdo->prepare("
                        SELECT u.id 
                        FROM user u
                        INNER JOIN user_company_map ucm ON u.id = ucm.user_id
                        WHERE ucm.company_id = ? AND u.id != ?
                        LIMIT 1
                    ");
                    $stmt->execute([$scopeCompanyId, $userId]);
                    $replacementUserId = $stmt->fetchColumn();
                }
            
            // 定义所有需要处理的表和字段配置
            // 格式: [表名 => [字段名 => ['nullable' => true/false, 'description' => '描述']]]
            $userReferences = [
                'transactions' => [
                    'created_by' => ['nullable' => false, 'description' => '交易记录的创建者']
                ],
                'submitted_processes' => [
                    'user_id' => ['nullable' => false, 'description' => '提交处理记录的用户']
                ],
                'data_captures' => [
                    'created_by' => ['nullable' => true, 'description' => '数据捕获记录的创建者']
                ],
                'process' => [
                    'created_by' => ['nullable' => true, 'description' => '流程记录的创建者'],
                    'modified_by' => ['nullable' => true, 'description' => '流程记录的修改者']
                ],
                'company' => [
                    'created_by' => ['nullable' => true, 'description' => '公司记录的创建者']
                ]
            ];
            
            // 检查NOT NULL字段的引用，如果没有替换用户则阻止删除
            if (!$replacementUserId) {
                $constraints = [];
                foreach ($userReferences as $table => $fields) {
                    foreach ($fields as $field => $config) {
                        if (!$config['nullable']) {
                            try {
                                $checkStmt = $pdo->prepare("SELECT COUNT(*) FROM `{$table}` WHERE `{$field}` = ?");
                                $checkStmt->execute([$userId]);
                                if ($checkStmt->fetchColumn() > 0) {
                                    $constraints[] = "{$table}.{$field} ({$config['description']})";
                                }
                            } catch (PDOException $e) {
                                // 如果表不存在，跳过
                                error_log("Table {$table} may not exist: " . $e->getMessage());
                            }
                        }
                    }
                }
                
                if (!empty($constraints)) {
                    sendResponse(false, 'Cannot delete user. No replacement user available. The user is referenced by: ' . implode(', ', $constraints) . '. Please ensure there is at least one other user in the company.');
                }
            }
            
            // 开始事务
            $pdo->beginTransaction();
            
            try {
                $updatedCounts = [];
                
                // 统一处理所有表和字段的引用转移
                foreach ($userReferences as $table => $fields) {
                    foreach ($fields as $field => $config) {
                        try {
                            $count = 0;
                            
                            if (!$config['nullable']) {
                                // NOT NULL字段：必须有替换用户才能更新
                                if ($replacementUserId) {
                                    $stmt = $pdo->prepare("UPDATE `{$table}` SET `{$field}` = ? WHERE `{$field}` = ?");
                                    $stmt->execute([$replacementUserId, $userId]);
                                    $count = $stmt->rowCount();
                                } else {
                                    // 如果没有替换用户且是NOT NULL字段，记录错误
                                    error_log("Cannot update {$table}.{$field}: No replacement user available for NOT NULL field");
                                }
                            } else {
                                // NULL字段：优先使用替换用户，如果没有则设置为NULL
                                if ($replacementUserId) {
                                    // 如果有替换用户，优先使用替换用户
                                    $stmt = $pdo->prepare("UPDATE `{$table}` SET `{$field}` = ? WHERE `{$field}` = ?");
                                    $stmt->execute([$replacementUserId, $userId]);
                                    $count = $stmt->rowCount();
                                    
                                    if ($count == 0) {
                                        // 如果没有更新任何行，检查是否真的有引用
                                        $checkStmt = $pdo->prepare("SELECT COUNT(*) FROM `{$table}` WHERE `{$field}` = ?");
                                        $checkStmt->execute([$userId]);
                                        $hasRefs = $checkStmt->fetchColumn();
                                        if ($hasRefs > 0) {
                                            error_log("Warning: UPDATE {$table}.{$field} returned 0 rows but there are {$hasRefs} references. Replacement user ID: {$replacementUserId}");
                                        }
                                    }
                                } else {
                                    // 如果没有替换用户，尝试设置为NULL
                                    try {
                                        $stmt = $pdo->prepare("UPDATE `{$table}` SET `{$field}` = NULL WHERE `{$field}` = ?");
                                        $stmt->execute([$userId]);
                                        $count = $stmt->rowCount();
                                        
                                        if ($count == 0) {
                                            // 检查是否真的有引用
                                            $checkStmt = $pdo->prepare("SELECT COUNT(*) FROM `{$table}` WHERE `{$field}` = ?");
                                            $checkStmt->execute([$userId]);
                                            $hasRefs = $checkStmt->fetchColumn();
                                            if ($hasRefs > 0) {
                                                error_log("Warning: UPDATE {$table}.{$field} to NULL returned 0 rows but there are {$hasRefs} references.");
                                            }
                                        }
                                    } catch (PDOException $e) {
                                        // 如果字段不允许NULL或更新失败，记录错误并抛出异常
                                        $errorMsg = "Cannot set {$table}.{$field} to NULL: " . $e->getMessage();
                                        error_log($errorMsg);
                                        throw new Exception($errorMsg . " Please ensure there is a replacement user available.");
                                    }
                                }
                            }
                            
                            // 记录更新数量
                            if ($count > 0) {
                                $updatedCounts[] = "{$table}.{$field} ({$count} records)";
                            }
                        } catch (PDOException $e) {
                            // 如果表不存在或字段不存在，记录错误并抛出异常
                            $errorMsg = "Error updating {$table}.{$field}: " . $e->getMessage();
                            error_log($errorMsg);
                            // 对于NOT NULL字段，必须抛出异常阻止删除
                            if (!$config['nullable']) {
                                throw new Exception($errorMsg . " - Cannot update NOT NULL field without replacement user.");
                            }
                            // 对于NULL字段，如果设置为NULL失败，说明字段可能不允许NULL，抛出异常
                            if ($config['nullable'] && !$replacementUserId) {
                                throw new Exception($errorMsg . " - Cannot set nullable field to NULL. Please ensure there is a replacement user.");
                            }
                        }
                    }
                }
                
                // 验证所有引用是否已被清除（在删除前再次检查）
                $remainingRefs = [];
                foreach ($userReferences as $table => $fields) {
                    foreach ($fields as $field => $config) {
                        try {
                            $checkStmt = $pdo->prepare("SELECT COUNT(*) FROM `{$table}` WHERE `{$field}` = ?");
                            $checkStmt->execute([$userId]);
                            $remainingCount = $checkStmt->fetchColumn();
                            if ($remainingCount > 0) {
                                $remainingRefs[] = "{$table}.{$field} ({$remainingCount} records)";
                            }
                        } catch (PDOException $e) {
                            // 表不存在，跳过
                            error_log("Cannot check {$table}.{$field}: " . $e->getMessage());
                        }
                    }
                }
                
                // 如果还有引用，阻止删除并报错
                if (!empty($remainingRefs)) {
                    throw new Exception('Cannot delete user. The user is still referenced by: ' . implode(', ', $remainingRefs) . '. Please ensure there is a replacement user available.');
                }
                
                // 6. 硬删除用户：清除所有公司关联与公司级权限，再删除 user 记录
                // 需求：当 inactive 账号在列表被清除时，数据库也要彻底清除该 Login ID。
                $stmt = $pdo->prepare("DELETE FROM user_company_permissions WHERE user_id = ?");
                $stmt->execute([$userId]);

                $stmt = $pdo->prepare("DELETE FROM user_company_map WHERE user_id = ?");
                $stmt->execute([$userId]);

                if (userlist_table_exists($pdo, 'user_group_map')) {
                    $stmt = $pdo->prepare('DELETE FROM user_group_map WHERE user_id = ?');
                    $stmt->execute([$userId]);
                }

                $stmt = $pdo->prepare("DELETE FROM user WHERE id = ?");
                $result = $stmt->execute([$userId]);
                $deletedUserRows = $stmt->rowCount();
                
                if (!$result || $deletedUserRows === 0) {
                    throw new Exception('Failed to delete user. No rows were affected. This may be due to foreign key constraints.');
                }
                
                // 提交事务
                $pdo->commit();

                require_once __DIR__ . '/../includes/realtime.php';
                $publishIds = array_values(array_unique(array_filter(array_map('intval', $scopeCompanyIds))));
                if ($scopeCompanyId > 0 && !in_array($scopeCompanyId, $publishIds, true)) {
                    $publishIds[] = $scopeCompanyId;
                }
                if ($publishIds !== []) {
                    realtime_publish_companies($publishIds, 'users', 'delete');
                }
                
                // 构建成功消息
                $message = 'User deleted successfully';
                if (!empty($updatedCounts)) {
                    $message .= '. Updated references: ' . implode(', ', $updatedCounts);
                }
                
                sendResponse(true, $message);
                
            } catch (Exception $e) {
                // 回滚事务
                $pdo->rollBack();
                error_log("Delete user error: " . $e->getMessage());
                
                // 检查是否是外键约束错误
                if (strpos($e->getMessage(), 'foreign key') !== false || 
                    strpos($e->getMessage(), '1451') !== false ||
                    strpos($e->getMessage(), 'Cannot delete') !== false ||
                    strpos($e->getMessage(), 'a foreign key constraint fails') !== false) {
                    
                    // 详细检查是哪些表还有引用
                    $remainingRefs = [];
                    foreach ($userReferences as $table => $fields) {
                        foreach ($fields as $field => $config) {
                            try {
                                $checkStmt = $pdo->prepare("SELECT COUNT(*) FROM `{$table}` WHERE `{$field}` = ?");
                                $checkStmt->execute([$userId]);
                                $count = $checkStmt->fetchColumn();
                                if ($count > 0) {
                                    $remainingRefs[] = "{$table}.{$field} ({$count} records)";
                                }
                            } catch (PDOException $ex) {
                                // 表不存在，跳过
                            }
                        }
                    }
                    
                    $errorMsg = 'Cannot delete user due to foreign key constraint. ';
                    if (!empty($remainingRefs)) {
                        $errorMsg .= 'The user is still referenced by: ' . implode(', ', $remainingRefs) . '. ';
                        $errorMsg .= 'Please ensure there is a replacement user available.';
                    } else {
                        $errorMsg .= 'The user is referenced by other records that could not be transferred.';
                    }
                    
                    sendResponse(false, $errorMsg);
                } else {
                    sendResponse(false, userlistFriendlyDbError($e));
                }
            }
            break;
            
        case 'get':
            global $current_company_id;
            if (isset($input['id'])) {
                // Get specific user - 只从 user 表获取基本字段，权限从 user_company_permissions 表获取
                $uid = (int) $input['id'];
                $groupScopeForGet = userlist_normalize_group_id($input['group_id'] ?? null);
                if ($groupScopeForGet !== null && userlist_is_group_only_list_request($input)) {
                    userlist_assert_user_visible_in_request_scope($pdo, $uid, $input);
                }
                $stmt = $pdo->prepare("SELECT id, login_id, name, email, role, permissions, status, read_only, created_by, created_at, last_login FROM user WHERE id = ?");
                $stmt->execute([$uid]);
                $user = $stmt->fetch(PDO::FETCH_ASSOC);
                
                if ($user) {
                    $user['group_codes'] = userlist_fetch_user_group_codes($pdo, (int) $user['id']);
                    $user['company_ids'] = userlist_fetch_user_subsidiary_company_ids($pdo, (int) $user['id']);
                    
                    // Acc/Process JSON：与 save 同一家公司（request company_id / session），避免 partnership 多公司时读到空行
                    $permCompanyId = userlist_resolve_permission_company_id($input, 0, (int) $current_company_id);
                    if ($permCompanyId <= 0 && $groupScopeForGet !== null) {
                        $permCompanyId = userlist_resolve_group_tenant_entity_company_id($pdo, $groupScopeForGet);
                    }
                    if ($permCompanyId > 0) {
                        $stmt = $pdo->prepare("SELECT account_permissions, process_permissions FROM user_company_permissions WHERE user_id = ? AND company_id = ?");
                        $stmt->execute([$user['id'], $permCompanyId]);
                        $companyPermissions = $stmt->fetch(PDO::FETCH_ASSOC);
                    } else {
                        $companyPermissions = false;
                    }
                    
                    if ($companyPermissions) {
                        // 使用公司特定的权限
                        $user['account_permissions'] = $companyPermissions['account_permissions'];
                        $user['process_permissions'] = $companyPermissions['process_permissions'];
                    } else {
                        // 如果公司特定的权限不存在，设置为 null（表示未设置，默认可以看到所有）
                        $user['account_permissions'] = null;
                        $user['process_permissions'] = null;
                    }
                    
                    // 同步获取 company_ownership 中的 read_only 状态（如果有，优先级更高）
                    if (strtolower($user['role']) === 'partnership' && $permCompanyId > 0) {
                        $roStmt = $pdo->prepare("SELECT read_only FROM company_ownership WHERE company_id = ? AND account_id = ? AND owner_type = 'user'");
                        $roStmt->execute([$permCompanyId, $user['id']]);
                        $co_ro = $roStmt->fetchColumn();
                        if ($co_ro !== false) {
                            $user['read_only'] = (int)$co_ro;
                        }
                    }
                    
                    sendResponse(true, 'User found', $user);
                } else {
                    // 如果不是user，检查是否是owner影子
                    $shadowCompanyId = (int) $current_company_id;
                    if ($shadowCompanyId <= 0 && $groupScopeForGet !== null) {
                        $shadowCompanyId = userlist_resolve_group_tenant_entity_company_id($pdo, $groupScopeForGet);
                    }
                    if ($shadowCompanyId > 0 && isOwnerShadow($pdo, $uid, $shadowCompanyId)) {
                        $stmt = $pdo->prepare("
                            SELECT o.id, o.owner_code as login_id, o.name, o.email, 'owner' as role, o.status, NULL as last_login, NULL as created_by, NULL as permissions
                            FROM owner o
                            INNER JOIN company c ON c.owner_id = o.id
                            WHERE o.id = ? AND c.id = ?
                        ");
                        $stmt->execute([$uid, $shadowCompanyId]);
                        $owner = $stmt->fetch(PDO::FETCH_ASSOC);
                        
                        if ($owner) {
                            sendResponse(true, 'Owner found', $owner);
                        } else {
                            sendResponse(false, 'Owner not found or access denied');
                        }
                    } else {
                        sendResponse(false, 'User not found or access denied');
                    }
                }
            } else {
                // Get all users — single company, group-only (AP ledger), or group aggregate
                $groupScope = userlist_normalize_group_id($input['group_id'] ?? null);
                if ($groupScope !== null && userlist_is_group_only_list_request($input)) {
                    $groupUserIds = userlist_fetch_group_only_user_ids($pdo, $groupScope);
                    if ($groupUserIds === []) {
                        sendResponse(true, 'Users retrieved successfully', []);
                    }
                    $placeholders = implode(',', array_fill(0, count($groupUserIds), '?'));
                    $stmt = $pdo->prepare("
                        SELECT DISTINCT u.id, u.login_id, u.name, u.email, u.role, u.permissions, u.status, u.created_by, u.created_at, u.last_login
                        FROM user u
                        WHERE u.id IN ($placeholders)
                        " . userlist_system_it_where_sql('u') . "
                        ORDER BY
                        CASE
                            WHEN u.login_id REGEXP '^[0-9]' THEN 0
                            ELSE 1
                        END,
                        CASE
                            WHEN u.login_id REGEXP '^[0-9]' THEN CAST(u.login_id AS UNSIGNED)
                            ELSE ASCII(UPPER(u.login_id))
                        END,
                        u.login_id ASC
                    ");
                    $stmt->execute($groupUserIds);
                    $users = $stmt->fetchAll(PDO::FETCH_ASSOC);
                    sendResponse(true, 'Users retrieved successfully', $users);
                }

                $filterCompanyIds = userlist_resolve_filter_company_ids($pdo, $input);
                $companyUserIds = userlist_fetch_company_scope_user_ids($pdo, $filterCompanyIds);
                if ($companyUserIds === []) {
                    sendResponse(true, 'Users retrieved successfully', []);
                }

                $placeholders = implode(',', array_fill(0, count($companyUserIds), '?'));
                $stmt = $pdo->prepare("
                    SELECT DISTINCT u.id, u.login_id, u.name, u.email, u.role, u.permissions, u.status, u.created_by, u.created_at, u.last_login
                    FROM user u
                    WHERE u.id IN ($placeholders)
                    " . userlist_system_it_where_sql('u') . "
                    ORDER BY
                        CASE 
                            WHEN u.login_id REGEXP '^[0-9]' THEN 0 
                            ELSE 1 
                        END,
                        CASE 
                            WHEN u.login_id REGEXP '^[0-9]' THEN CAST(u.login_id AS UNSIGNED)
                            ELSE ASCII(UPPER(u.login_id))
                        END,
                        u.login_id ASC
                ");
                $stmt->execute($companyUserIds);
                $users = $stmt->fetchAll(PDO::FETCH_ASSOC);
                sendResponse(true, 'Users retrieved successfully', $users);
            }
            break;
            
        default:
            sendResponse(false, 'Invalid action');
            break;
    }
    
} catch (PDOException $e) {
    error_log("Database error in userlist_api: " . $e->getMessage());
    error_log("SQL State: " . $e->getCode());
    error_log("Error Info: " . print_r($e->errorInfo, true));
    sendResponse(false, userlistFriendlyDbError($e), null);
} catch (Exception $e) {
    error_log("General error in userlist_api: " . $e->getMessage());
    sendResponse(false, userlistFriendlyDbError($e), null);
}