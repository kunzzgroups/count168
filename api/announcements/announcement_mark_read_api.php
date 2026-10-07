<?php
/**
 * 公告标记已读 API：把该登录账号的 last_read_at 推到当前（DB 时钟）
 * 路径: api/announcements/announcement_mark_read_api.php
 * 身份取自 session（user_type + user_id），前端不传参数。
 * IT 账号不做任何事。
 */
header('Content-Type: application/json; charset=utf-8');
require_once __DIR__ . '/../../includes/config.php';
require_once __DIR__ . '/../../includes/group_company_access.php';
session_start();
session_write_close(); // 释放 session 锁，允许并发 AJAX 请求并行执行

function sendMarkReadJson(bool $success, string $message, $data = null): void {
    echo json_encode([
        'success' => $success,
        'message' => $message,
        'data' => $data === null ? [] : $data
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

/** 当前会话的已读主体（IT 账号返回 null，表示不跟踪）。 */
function announcementMarkReadActor(): ?array {
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
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
        http_response_code(405);
        sendMarkReadJson(false, 'POST required', null);
    }

    if (!isset($_SESSION['user_id'])) {
        http_response_code(401);
        sendMarkReadJson(false, 'User not logged in', null);
    }

    $actor = announcementMarkReadActor();
    if ($actor !== null) {
        $stmt = $pdo->prepare(
            "INSERT INTO announcement_read_state (user_type, user_id, last_read_at)
             VALUES (?, ?, NOW())
             ON DUPLICATE KEY UPDATE last_read_at = NOW()"
        );
        $stmt->execute([$actor['user_type'], $actor['user_id']]);
        // 已读是账号级状态：广播出去让同账号的其他设备立刻重新拉自己的未读数。
        require_once __DIR__ . '/../includes/realtime.php';
        realtime_publish_global('announcements', 'read');
    }

    sendMarkReadJson(true, '', ['unreadCount' => 0]);

} catch (Throwable $e) {
    error_log('Announcement mark read API error: ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine());
    http_response_code(500);
    sendMarkReadJson(false, 'Server error', null);
}
