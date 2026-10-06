<?php
/**
 * device_token（移动端指纹解锁）回归测试。
 *
 * 用法：
 *   php scripts/test-device-token.php
 *
 * 安全性：只使用临时库 `c168_devtok_test`，每次运行前 DROP 重建，
 *        绝不连接或修改任何真实数据库。
 *
 * 为什么要留着这个脚本：
 *   1. 二级密码「必须重输」是安全底线，靠 device_token_excluded_session_keys()
 *      维持。将来若有人往 session 里加了键又想绕过二级密码，第 3 组会红。
 *   2. 三分支（owner/user/member）的 redirect 判定容易被误改，第 11 组会红。
 *   3. 迁移文件本身也在这里被执行，DDL 写错能立刻发现。
 */

$root = dirname(__DIR__);
$dbName = 'c168_devtok_test';
$migration = $root . '/database/migrations/20261006_add_device_token.sql';

if (!is_file($migration)) {
    fwrite(STDERR, "找不到迁移文件: $migration\n");
    exit(2);
}

$pass = 0;
$fail = 0;

function ok(string $name, bool $cond, string $detail = ''): void
{
    global $pass, $fail;
    if ($cond) {
        $pass++;
        echo "  PASS  $name\n";
    } else {
        $fail++;
        echo "  FAIL  $name" . ($detail !== '' ? "  <-- $detail" : '') . "\n";
    }
}

function clean(PDO $pdo): void
{
    $pdo->exec('DELETE FROM device_token');
}

$opt = [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_EMULATE_PREPARES => false];

try {
    $rootPdo = new PDO('mysql:host=127.0.0.1;charset=utf8mb4', 'root', '', $opt);
    $rootPdo->exec("DROP DATABASE IF EXISTS `$dbName`");
    $rootPdo->exec("CREATE DATABASE `$dbName` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
    $pdo = new PDO("mysql:host=127.0.0.1;dbname=$dbName;charset=utf8mb4", 'root', '', $opt);
} catch (Throwable $e) {
    fwrite(STDERR, "无法连接本地 MySQL: " . $e->getMessage() . "\n");
    exit(2);
}

require_once $root . '/includes/device_token.php';

echo "=== 0. 迁移文件可直接执行 ===\n";
$sql = file_get_contents($migration);
$pdo->exec($sql);
ok('迁移文件执行成功', true);
$cols = $pdo->query("SHOW COLUMNS FROM device_token")->fetchAll(PDO::FETCH_COLUMN);
foreach (['user_type', 'user_id', 'token_hash', 'device_id', 'device_name',
          'session_snapshot', 'expires_at', 'last_used_at', 'last_used_ip',
          'revoked_at', 'created_at'] as $c) {
    ok("列 $c 存在", in_array($c, $cols, true));
}
$idx = $pdo->query("SHOW INDEX FROM device_token")->fetchAll(PDO::FETCH_ASSOC);
$idxNames = array_unique(array_column($idx, 'Key_name'));
ok('uk_token_hash 存在', in_array('uk_token_hash', $idxNames, true));
ok('uk_device 存在', in_array('uk_device', $idxNames, true));
$enum = $pdo->query("SHOW COLUMNS FROM device_token LIKE 'user_type'")->fetch(PDO::FETCH_ASSOC);
ok('user_type 覆盖 owner/user/member 三种身份',
    strpos((string) $enum['Type'], "'owner'") !== false
    && strpos((string) $enum['Type'], "'member'") !== false);

// ── 桩表 ────────────────────────────────────────────────────────────
$pdo->exec("CREATE TABLE owner (
    id INT PRIMARY KEY, owner_code VARCHAR(50), name VARCHAR(150), status VARCHAR(20))");
$pdo->exec("CREATE TABLE user (
    id INT PRIMARY KEY, login_id VARCHAR(50), name VARCHAR(100),
    status VARCHAR(20) DEFAULT 'active', secondary_password VARCHAR(255) NULL)");
$pdo->exec("CREATE TABLE account (
    id INT PRIMARY KEY, account_id VARCHAR(50), name VARCHAR(100), status VARCHAR(20))");
$pdo->exec("CREATE TABLE company (
    id INT PRIMARY KEY, company_id VARCHAR(50), group_id VARCHAR(50) NULL,
    expiration_date DATETIME NULL)");

$pdo->exec("INSERT INTO owner VALUES (7,'K','BOSS','active')");
$pdo->exec("INSERT INTO user (id,login_id,name,status,secondary_password) VALUES
    (11,'alice','Alice','active','\$2y\$10\$abc'),
    (12,'bob','Bob','active',NULL),
    (13,'carol','Carol','inactive',NULL)");
$pdo->exec("INSERT INTO account VALUES (21,'ACC1','Member One','active')");
$pdo->exec("INSERT INTO company VALUES
    (1,'C168',NULL,'2099-01-01 00:00:00'),
    (2,'BANK',NULL,'2099-01-01 00:00:00')");

echo "\n=== 1. 建表幂等 ===\n";
device_token_ensure_table($pdo);
device_token_ensure_table($pdo);
ok('ensure_table 可重复调用', true);

echo "\n=== 2. 基础工具函数 ===\n";
ok('hash 为 64 位 hex', strlen(device_token_hash('x')) === 64);
ok('normalize user_type 合法值', device_token_normalize_user_type('OWNER') === 'owner');
ok('normalize user_type 非法值→空', device_token_normalize_user_type('hacker') === '');
ok('normalize user_type null→空', device_token_normalize_user_type(null) === '');

echo "\n=== 3. 会话快照：排除表 + 双保险（安全底线）===\n";
$_SESSION = [
    'user_id' => 11, 'user_type' => 'user', 'role' => 'admin', 'company_id' => 1,
    'company_code' => 'C168', 'login_id' => 'alice',
    'secondary_password_verified' => true,      // 必须被排除
    'last_activity' => 12345,                   // 必须被排除
    'password_fingerprint' => 'SECRETHASH',     // 必须被排除
    '_spa_user_payload_cache' => ['junk'],      // 必须被排除
    'assigned_company_ids' => [1, 2],           // 数组应保留
];
$snap = device_token_capture_session();
ok('排除 secondary_password_verified', !array_key_exists('secondary_password_verified', $snap));
ok('排除 last_activity', !array_key_exists('last_activity', $snap));
ok('排除 password_fingerprint', !array_key_exists('password_fingerprint', $snap));
ok('排除 _ 前缀缓存', !array_key_exists('_spa_user_payload_cache', $snap));
ok('保留标量 user_id', ($snap['user_id'] ?? null) === 11);
ok('保留数组 assigned_company_ids', ($snap['assigned_company_ids'] ?? null) === [1, 2]);

$_SESSION = ['junk' => 1];
device_token_restore_session($snap + ['secondary_password_verified' => true]);
ok('还原后不含 secondary_password_verified', !isset($_SESSION['secondary_password_verified']));
ok('还原后无残留旧键 junk', !isset($_SESSION['junk']));
ok('还原后 user_id 正确', ($_SESSION['user_id'] ?? null) === 11);
ok('还原后 last_activity 已刷新', ($_SESSION['last_activity'] ?? 0) > 12345);

echo "\n=== 4. 签发 / 校验 ===\n";
clean($pdo);
$r = device_token_issue($pdo, 'user', 11, 'devAAA', 'Xiaomi 14', $snap);
ok('签发出 64 位 hex 令牌', $r['ok'] && preg_match('/^[0-9a-f]{64}$/', $r['token']));
ok('返回 expires_at', $r['ok'] && $r['expires_at'] !== '');
$t1 = $r['token'];

ok('正确令牌+设备 → ok', device_token_resolve($pdo, $t1, 'devAAA')['ok']);
ok('错误 device_id → TOKEN_INVALID',
    device_token_resolve($pdo, $t1, 'devOTHER')['code'] === 'TOKEN_INVALID');
ok('格式非法令牌 → TOKEN_INVALID',
    device_token_resolve($pdo, 'nothex', 'devAAA')['code'] === 'TOKEN_INVALID');
ok('未知但格式合法 → TOKEN_INVALID',
    device_token_resolve($pdo, str_repeat('a', 64), 'devAAA')['code'] === 'TOKEN_INVALID');
ok('空 device_id → TOKEN_INVALID', device_token_resolve($pdo, $t1, '')['code'] === 'TOKEN_INVALID');

echo "\n=== 5. 同设备重复开启 = 覆盖，不占名额 ===\n";
$r2 = device_token_issue($pdo, 'user', 11, 'devAAA', 'Xiaomi 14', $snap);
ok('重复签发成功', $r2['ok']);
ok('旧令牌已失效', !device_token_resolve($pdo, $t1, 'devAAA')['ok']);
ok('新令牌可用', device_token_resolve($pdo, $r2['token'], 'devAAA')['ok']);
$n = (int) $pdo->query('SELECT COUNT(*) FROM device_token WHERE user_id=11')->fetchColumn();
ok('同设备仍只有 1 行', $n === 1, "实际 $n");

echo "\n=== 6. 设备数上限 5 ===\n";
clean($pdo);
$tokens = [];
for ($i = 1; $i <= 5; $i++) {
    $ri = device_token_issue($pdo, 'user', 11, "dev$i", "Phone $i", $snap);
    if ($ri['ok']) {
        $tokens[$i] = $ri['token'];
    }
}
ok('5 台全部签发成功', count($tokens) === 5, '实际 ' . count($tokens));
$r6 = device_token_issue($pdo, 'user', 11, 'dev6', 'Phone 6', $snap);
ok('第 6 台 → DEVICE_LIMIT', !$r6['ok'] && $r6['code'] === 'DEVICE_LIMIT', $r6['code'] ?? '');
ok('第 6 台未落库',
    (int) $pdo->query('SELECT COUNT(*) FROM device_token WHERE user_id=11')->fetchColumn() === 5);
ok('达上限时原有设备仍可用', device_token_resolve($pdo, $tokens[1], 'dev1')['ok']);
ok('达上限时未被自动踢掉（多设备硬需求）', device_token_count_active($pdo, 'user', 11) === 5);

echo "\n=== 7. 吊销 ===\n";
ok('吊销 1 台返回 1', device_token_revoke($pdo, 'user', 11, 'dev1') === 1);
ok('被吊销 → TOKEN_REVOKED',
    device_token_resolve($pdo, $tokens[1], 'dev1')['code'] === 'TOKEN_REVOKED');
ok('活跃数降为 4', device_token_count_active($pdo, 'user', 11) === 4);
$r7 = device_token_issue($pdo, 'user', 11, 'dev7', 'Phone 7', $snap);
ok('腾出名额后可再签发', $r7['ok'], $r7['code'] ?? '');
ok('全部吊销返回 5', device_token_revoke($pdo, 'user', 11, null) === 5);
ok('全吊销后活跃数为 0', device_token_count_active($pdo, 'user', 11) === 0);
ok('全吊销后令牌不可用', !device_token_resolve($pdo, $r7['token'], 'dev7')['ok']);

echo "\n=== 8. 过期 ===\n";
clean($pdo);
$r8 = device_token_issue($pdo, 'user', 11, 'devX', 'X', $snap);
$pdo->exec('UPDATE device_token SET expires_at = DATE_SUB(NOW(), INTERVAL 1 DAY)');
ok('已过期 → TOKEN_EXPIRED',
    device_token_resolve($pdo, $r8['token'], 'devX')['code'] === 'TOKEN_EXPIRED');
ok('过期后不计入活跃数', device_token_count_active($pdo, 'user', 11) === 0);

echo "\n=== 9. touch / list ===\n";
clean($pdo);
$_SERVER['REMOTE_ADDR'] = '203.0.113.7';   // CLI 下不存在，手动补上才能验证 IP 写入
device_token_issue($pdo, 'user', 11, 'devT', 'Touch Me', $snap);
$id = (int) $pdo->query("SELECT id FROM device_token WHERE device_id='devT'")->fetchColumn();
ok('使用前 last_used_at 为空',
    $pdo->query("SELECT last_used_at FROM device_token WHERE id=$id")->fetchColumn() === null);
device_token_touch($pdo, $id);
ok('touch 后 last_used_at 已写',
    $pdo->query("SELECT last_used_at FROM device_token WHERE id=$id")->fetchColumn() !== null);
$ipRaw = $pdo->query("SELECT last_used_ip FROM device_token WHERE id=$id")->fetchColumn();
ok('touch 把 IPv4 存成 4 字节', $ipRaw !== null && strlen($ipRaw) === 4);
ok('touch 存的 IP 可反解', $ipRaw !== null && inet_ntop($ipRaw) === '203.0.113.7');
$list = device_token_list($pdo, 'user', 11);
ok('list 返回 1 条', count($list) === 1);
ok('list 标记 is_active=1', (int) $list[0]['is_active'] === 1);
device_token_revoke($pdo, 'user', 11, 'devT');
$list = device_token_list($pdo, 'user', 11);
ok('吊销后 is_active=0', (int) $list[0]['is_active'] === 0);

echo "\n=== 10. 身份查询（三分支）===\n";
$p = device_token_fetch_principal($pdo, 'owner', 7);
ok('owner 主体可查', $p !== null && $p['login_id'] === 'K' && $p['status'] === 'active');
$p = device_token_fetch_principal($pdo, 'user', 11);
ok('user 主体可查', $p !== null && $p['login_id'] === 'alice');
$p = device_token_fetch_principal($pdo, 'member', 21);
ok('member 主体可查', $p !== null && $p['login_id'] === 'ACC1');
ok('停用 user 状态可读出', device_token_fetch_principal($pdo, 'user', 13)['status'] === 'inactive');
ok('不存在的主体 → null', device_token_fetch_principal($pdo, 'user', 999) === null);

echo "\n=== 11. 二级密码 redirect（决策 4 的核心）===\n";
$sC168 = ['company_id' => 1, 'company_code' => 'C168', 'user_id' => 11];
$sBank = ['company_id' => 2, 'company_code' => 'BANK', 'user_id' => 12];
ok('owner 总是要 → /owner-secondary-password',
    device_token_secondary_password_redirect($pdo, 'owner', 7, []) === '/owner-secondary-password');
ok('member 不需要 → null',
    device_token_secondary_password_redirect($pdo, 'member', 21, $sC168) === null);
ok('user+C168+已设二级密码 → /user-secondary-password',
    device_token_secondary_password_redirect($pdo, 'user', 11, $sC168) === '/user-secondary-password');
ok('user+C168+未设二级密码 → null',
    device_token_secondary_password_redirect($pdo, 'user', 12, $sC168) === null);
ok('user+非C168公司 → null',
    device_token_secondary_password_redirect($pdo, 'user', 11, $sBank) === null);
ok('company_code 缺失时按 company_id 回查（C168）',
    device_token_secondary_password_redirect($pdo, 'user', 11, ['company_id' => 1]) === '/user-secondary-password');
ok('company_code 缺失时按 company_id 回查（BANK）',
    device_token_secondary_password_redirect($pdo, 'user', 11, ['company_id' => 2]) === null);

echo "\n=== 12. 快照体积守卫 ===\n";
ok('正常快照可编码', device_token_encode_snapshot(['a' => 1]) !== null);
$bigArray = ['user_id' => 11, 'assigned_company_ids' => range(1, 20000)];
ok('前置条件：原始快照确实超限', strlen(json_encode($bigArray)) > DEVICE_TOKEN_SNAPSHOT_MAX_BYTES);
$enc = device_token_encode_snapshot($bigArray);
ok('超限时丢弃数组而非报错', $enc !== null);
ok('丢弃数组后保留标量身份键', $enc !== null && strpos($enc, '"user_id":11') !== false);
ok('丢弃数组后体积达标', $enc !== null && strlen($enc) <= DEVICE_TOKEN_SNAPSHOT_MAX_BYTES);
$hopeless = ['a' => str_repeat('Z', 70000), 'b' => str_repeat('Y', 70000)];
ok('无法压缩 → null（交回调用方报错）', device_token_encode_snapshot($hopeless) === null);

echo "\n=== 13. 入口参数校验 ===\n";
ok('非法 user_type → BAD_PRINCIPAL',
    device_token_issue($pdo, 'hacker', 11, 'devZ', 'Z', [])['code'] === 'BAD_PRINCIPAL');
ok('user_id<=0 → BAD_PRINCIPAL',
    device_token_issue($pdo, 'user', 0, 'devZ', 'Z', [])['code'] === 'BAD_PRINCIPAL');
ok('空 device_id → BAD_DEVICE_ID',
    device_token_issue($pdo, 'user', 11, '', 'x', [])['code'] === 'BAD_DEVICE_ID');
ok('过短但仍合法（不设人为下限）', device_token_is_valid_device_id('abc'));
ok('超长 device_id 被拒', !device_token_is_valid_device_id(str_repeat('d', 65)));
ok('含非法字符被拒', !device_token_is_valid_device_id("dev\0AAA123"));
ok('UUID 形式通过', device_token_is_valid_device_id('3f2504e0-4f89-11d3-9a0c-0305e82c3301'));

echo "\n=== 14. 跨身份隔离（uk_device 含 user_type + user_id）===\n";
clean($pdo);
device_token_issue($pdo, 'user', 11, 'sameDev', 'A', $snap);
device_token_issue($pdo, 'owner', 7, 'sameDev', 'B', $snap);
device_token_issue($pdo, 'member', 21, 'sameDev', 'C', $snap);
$n = (int) $pdo->query("SELECT COUNT(*) FROM device_token WHERE device_id='sameDev'")->fetchColumn();
ok('同 device_id 跨三种身份互不干扰', $n === 3, "实际 $n");
ok('user 身份活跃数为 1', device_token_count_active($pdo, 'user', 11) === 1);
ok('owner 身份活跃数为 1', device_token_count_active($pdo, 'owner', 7) === 1);
ok('member 身份活跃数为 1', device_token_count_active($pdo, 'member', 21) === 1);

// 收尾：不把测试库留在机器上
$rootPdo->exec("DROP DATABASE IF EXISTS `$dbName`");

echo "\n============================\n";
echo "PASS: $pass   FAIL: $fail\n";
echo "============================\n";
exit($fail === 0 ? 0 : 1);
