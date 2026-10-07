<?php
/**
 * 公告未读数 API：按登录账号（后端计算，不依赖公司 / 浏览器）
 * 路径: api/announcements/announcement_unread_count_api.php
 * 返回: data.unreadCount
 *
 * 未读数 = company_code='C168' 且 status='active' 的公告中，created_at > last_read_at 的条数。
 * 账号还没有 announcement_read_state 记录时，先锚定 last_read_at = NOW()（新账号看不到历史公告）。
 * IT 账号不参与未读提醒，恒为 0。
 */
header('Content-Type: application/json; charset=utf-8');
require_once __DIR__ . '/../../includes/config.php';
require_once __DIR__ . '/../../includes/group_company_access.php';
session_start();
session_write_close(); // 释放 session 锁，允许并发 AJAX 请求并行执行

function sendUnreadJson(bool $success, string $message, $data = null): void {
    echo json_encode([
        'success' => $success,
        'message' => $message,
        'data' => $data === null ? [] : $data
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

/** 当前会话的已读主体（IT 账号返回 null，表示不跟踪）。 */
function announcementReadActor(): ?array {
    $userId = (int) ($_SESSION['user_id'] ?? 0);
    $userType = strtolower(trim((string) ($_SESSION['user_type'] ?? '')));
    if ($userId <= 0 || !in_array($userType, ['user', 'owner', 'member'], true)) {
        return null;
    }
    if (function_exists('gc_is_system_it_login') && gc_is_system_it_login()) {
        return null;
    }
    return ['user_type' => $userType, 'user_id' => $userId];
}

try {
    if (!isset($_SESSION['user_id'])) {
        http_response_code(401);
        sendUnreadJson(false, 'User not logged in', null);
    }

    $actor = announcementReadActor();
    if ($actor === null) {
        sendUnreadJson(true, '', ['unreadCount' => 0]);
    }

    // 首次取未读时锚定基准（`account` 表没有 created_at，不能用账号创建时间）。
    $anchor = $pdo->prepare(
        "INSERT IGNORE INTO announcement_read_state (user_type, user_id, last_read_at)
         VALUES (?, ?, NOW())"
    );
    $anchor->execute([$actor['user_type'], $actor['user_id']]);

    $stmt = $pdo->prepare(
        "SELECT COUNT(*)
           FROM announcements a
           JOIN announcement_read_state s
             ON s.user_type = ? AND s.user_id = ?
          WHERE a.company_code = 'C168'
            AND a.status = 'active'
            AND a.created_at > s.last_read_at"
    );
    $stmt->execute([$actor['user_type'], $actor['user_id']]);

    sendUnreadJson(true, '', ['unreadCount' => (int) $stmt->fetchColumn()]);

} catch (Throwable $e) {
    error_log('Announcement unread count API error: ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine());
    http_response_code(500);
    sendUnreadJson(false, 'Server error', null);
}
