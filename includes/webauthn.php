<?php
/**
 * WebAuthn / Passkey（生物识别登录）—— 密码学与解析核心。
 *
 * 设计取舍：**不引入 composer**（仓库没有 composer 基础设施，见
 * docs/webauthn-passkey-feasibility.md §4.1）。
 *
 * 之所以敢手写，是因为范围被刻意收窄到几乎不会出错：
 *   - 注册时请求 `attestation: "none"` → **完全不需要解析 attestation 证书链**；
 *   - 只接受 **ES256**（平台验证器都用它）→ 不做算法协商；
 *   - 因此 CBOR 只需要读「attestationObject 的顶层 map」和「COSE 公钥那一个小 map」，
 *     一个约 80 行的迷你读取器就够，不需要完整 CBOR 实现。
 *
 * 若将来要支持 RS256 / 完整 attestation，**应改为引入 web-auth/webauthn-lib**，
 * 不要在这上面继续加。
 */

/** 支持的最大时钟偏移（秒）：验证 clientDataJSON 里的 challenge 不做时间校验， 但保留常量以便将来加 */
const WA_CHALLENGE_TTL = 300;

/** 公钥 PEM 只允许这些开头，防止把任意内容写进库后被当成密钥用 */
const WA_PEM_PREFIX = '-----BEGIN PUBLIC KEY-----';

/* ────────────────────────── base64url ────────────────────────── */

/**
 * base64url 解码（严格）。
 * 用宽严模式解码后**重新编码比对**，避免 PHP 静默忽略非法字符。
 */
function wa_b64url_decode(string $input): ?string
{
    $s = strtr($input, '-_', '+/');
    $pad = strlen($s) % 4;
    if ($pad === 1) {
        return null;   // 非法长度
    }
    if ($pad > 0) {
        $s .= str_repeat('=', 4 - $pad);
    }
    $bin = base64_decode($s, true);
    if ($bin === false) {
        return null;
    }
    // 往返比对，确保输入本身是规范 base64url
    return wa_b64url_encode($bin) === rtrim($input, '=') ? $bin : null;
}

function wa_b64url_encode(string $bin): string
{
    return rtrim(strtr(base64_encode($bin), '+/', '-_'), '=');
}

/* ────────────────────────── 迷你 CBOR ────────────────────────── */

/**
 * 读取一个 CBOR 数据项。只实现 WebAuthn 这条路上会遇到的类型。
 *
 * @param string $bin    输入
 * @param int    $offset 起始位置；**引用传入**，返回时指向下一项
 * @return mixed 失败返回 null（用 WA_CBOR_FAIL 哨兵区分“真的是 null”）
 */
function wa_cbor_read(string $bin, int &$offset)
{
    $len = strlen($bin);
    if ($offset >= $len) {
        return null;
    }

    $first = ord($bin[$offset]);
    $major = $first >> 5;
    $minor = $first & 0x1f;
    $offset++;

    // 读取长度/值
    if ($minor < 24) {
        $value = $minor;
    } elseif ($minor === 24) {
        if ($offset + 1 > $len) return null;
        $value = ord($bin[$offset]);
        $offset += 1;
    } elseif ($minor === 25) {
        if ($offset + 2 > $len) return null;
        $value = unpack('n', substr($bin, $offset, 2))[1];
        $offset += 2;
    } elseif ($minor === 26) {
        if ($offset + 4 > $len) return null;
        $value = unpack('N', substr($bin, $offset, 4))[1];
        $offset += 4;
    } else {
        // 27(8字节)/28-30(保留)/31(不定长) —— WebAuthn 的公钥结构里不会出现
        return null;
    }

    switch ($major) {
        case 0:   // unsigned int
            return $value;
        case 1:   // negative int
            return -1 - $value;
        case 2:   // byte string
        case 3:   // text string
            if ($offset + $value > $len) return null;
            $out = substr($bin, $offset, $value);
            $offset += $value;
            return $out;
        case 4:   // array
            $arr = [];
            for ($i = 0; $i < $value; $i++) {
                $item = wa_cbor_read($bin, $offset);
                if ($item === null && $offset > $len) return null;
                $arr[] = $item;
            }
            return $arr;
        case 5:   // map
            $map = [];
            for ($i = 0; $i < $value; $i++) {
                $k = wa_cbor_read($bin, $offset);
                if ($k === null && $offset > $len) return null;
                $v = wa_cbor_read($bin, $offset);
                if ($v === null && $offset > $len) return null;
                // 键必须是标量（int/string）；对象键不可能出现在 COSE/attestationObject 里
                if (!is_int($k) && !is_string($k)) return null;
                $map[$k] = $v;
            }
            return $map;
        case 7:   // simple values
            if ($minor === 20) return false;
            if ($minor === 21) return true;
            if ($minor === 22) return null;
            return null;
        default:
            return null;
    }
}

/** 顶层读取：必须**恰好**用完整个字节串（多出尾巴说明结构不对） */
function wa_cbor_read_exact(string $bin)
{
    $offset = 0;
    $value = wa_cbor_read($bin, $offset);
    if ($value === null || $offset !== strlen($bin)) {
        return null;
    }

    return $value;
}

/* ────────────────────────── COSE → PEM ────────────────────────── */

/**
 * COSE EC2 (P-256) 公钥 → SPKI PEM。
 *
 * COSE 结构：{1: 2(kty=EC2), 3: -7(alg=ES256), -1: 1(crv=P-256), -2: x(32B), -3: y(32B)}
 *
 * SPKI 的 P-256 前缀是固定 26 字节常量；后面跟未压缩点 0x04 || x || y（共 65 字节）。
 * 这是标准做法，不涉及任何自定义编码。
 */
function wa_cose_ec2_to_pem(array $cose): ?string
{
    // kty 必须 EC2(2)，alg 必须 ES256(-7)，crv 必须 P-256(1)
    if ((int) ($cose[1] ?? 0) !== 2) return null;
    if ((int) ($cose[3] ?? 0) !== -7) return null;
    if ((int) ($cose[-1] ?? 0) !== 1) return null;

    $x = $cose[-2] ?? null;
    $y = $cose[-3] ?? null;
    if (!is_string($x) || !is_string($y) || strlen($x) !== 32 || strlen($y) !== 32) {
        return null;
    }

    $prefix = hex2bin('3059301306072a8648ce3d020106082a8648ce3d030107034200');
    if ($prefix === false) {
        return null;
    }

    $der = $prefix . "\x04" . $x . $y;

    return WA_PEM_PREFIX . "\n" . chunk_split(base64_encode($der), 64, "\n") . "-----END PUBLIC KEY-----\n";
}

/* ────────────────────────── 签名归一化 ────────────────────────── */

/**
 * 把签名规整成 openssl 能吃的 DER 形式。
 *
 * WebAuthn 的断言签名按规范就是 ASN.1 DER（CTAP2 如此），openssl_verify 直接可用。
 * 但少数实现会给出裸的 r||s（64 字节）。这里做一层兼容：**只在长度恰好 64 时**按裸格式
 * 转换，其余原样返回，避免把合法 DER 误判。
 */
function wa_signature_to_der(string $sig): ?string
{
    if ($sig === '') {
        return null;
    }
    if (strlen($sig) !== 64) {
        return $sig;   // 当作已是 DER
    }

    $r = substr($sig, 0, 32);
    $s = substr($sig, 32, 32);

    $encodeInt = static function (string $v): string {
        $v = ltrim($v, "\x00");
        if ($v === '') {
            $v = "\x00";
        }
        if ((ord($v[0]) & 0x80) !== 0) {
            $v = "\x00" . $v;   // 保证被解释为正数
        }
        return "\x02" . chr(strlen($v)) . $v;
    };

    $body = $encodeInt($r) . $encodeInt($s);
    if (strlen($body) > 127) {
        return null;
    }

    return "\x30" . chr(strlen($body)) . $body;
}

/* ────────────────────────── RP ID / origin ────────────────────────── */

function wa_request_host(): string
{
    $host = strtolower(trim((string) ($_SERVER['HTTP_HOST'] ?? '')));
    $colon = strrpos($host, ':');
    if ($colon !== false) {
        $host = substr($host, 0, $colon);
    }

    return $host;
}

function wa_is_local_host(string $host): bool
{
    return $host === 'localhost' || $host === '127.0.0.1' || str_ends_with($host, '.localhost');
}

/**
 * RP ID = 请求主机去掉开头的 `www.`。
 *
 * 本项目三个域名本身都是可注册域（不是子域），所以这样推导对
 * count168.com / www.count168.com / count168.org / count168.site 都正确，
 * 而且 **www 与裸域共用同一个 RP ID** —— 用户在两者之间切换不必重新注册。
 *
 * 注意：RP ID 是**按域名隔离**的，在 com 注册的 passkey 不能用于 org。
 * 三个域名本来各自独立数据库，所以这是一致的（见可行性文档 §4.2）。
 */
function wa_rp_id(): string
{
    $host = wa_request_host();

    return str_starts_with($host, 'www.') ? substr($host, 4) : $host;
}

/** RP ID 必须非空，且不能是明显的占位值 */
function wa_rp_id_valid(): bool
{
    $rp = wa_rp_id();

    return $rp !== '' && strpos($rp, '.') !== false;
}

/**
 * 允许的 origin 集合。
 * www 与裸域都放行（同一个 RP ID）；本地开发额外放行 http。
 */
function wa_expected_origins(): array
{
    $rp = wa_rp_id();
    if ($rp === '') {
        return [];
    }

    $origins = ['https://' . $rp, 'https://www.' . $rp];
    if (wa_is_local_host($rp) || wa_is_local_host(wa_request_host())) {
        $origins[] = 'http://' . wa_request_host();
        $origins[] = 'http://' . $rp;
    }

    return array_values(array_unique($origins));
}

/** origin 必须**精确匹配**（大小写不敏感），绝不能用前缀/包含判断 —— 那是钓鱼入口 */
function wa_origin_ok(?string $origin): bool
{
    if (!is_string($origin) || $origin === '') {
        return false;
    }
    $needle = strtolower(rtrim($origin, '/'));

    foreach (wa_expected_origins() as $allowed) {
        if ($needle === strtolower($allowed)) {
            return true;
        }
    }

    return false;
}

/* ────────────────────────── clientDataJSON ────────────────────────── */

/**
 * 校验 clientDataJSON。
 *
 * @param string $b64          base64url 编码的原始 clientDataJSON
 * @param string $expectedType 'webauthn.create' 或 'webauthn.get'
 * @param string $challengeB64 服务端下发、且**本次必须已消费**的 challenge（base64url）
 * @return array{raw:string,challenge:string,origin:string,type:string}|null
 */
function wa_check_client_data(string $b64, string $expectedType, string $challengeB64): ?array
{
    $raw = wa_b64url_decode($b64);
    if ($raw === null || $raw === '') {
        return null;
    }

    $data = json_decode($raw, true);
    if (!is_array($data)) {
        return null;
    }

    // type 必须完全一致：注册与登录的 clientData 不能互相冒用
    if ((string) ($data['type'] ?? '') !== $expectedType) {
        return null;
    }

    // challenge 必须与本次下发的**逐字节**相同（用 hash_equals 防时序侧信道）
    $gotChallenge = (string) ($data['challenge'] ?? '');
    $got = wa_b64url_decode($gotChallenge);
    $want = wa_b64url_decode($challengeB64);
    if ($got === null || $want === null || !hash_equals($want, $got)) {
        return null;
    }

    if (!wa_origin_ok($data['origin'] ?? null)) {
        return null;
    }

    return [
        'raw'       => $raw,
        'challenge' => $gotChallenge,
        'origin'    => (string) $data['origin'],
        'type'      => $expectedType,
    ];
}

/* ────────────────────────── authenticatorData ────────────────────────── */

/** authenticatorData 的 flag 位 */
const WA_FLAG_UP = 0x01;   // user present
const WA_FLAG_UV = 0x04;   // user verified
const WA_FLAG_AT = 0x40;   // attested credential data 存在
const WA_FLAG_ED = 0x80;   // extension data 存在

/**
 * 解析 authenticatorData。
 *
 * 布局：rpIdHash(32) | flags(1) | signCount(4) | [AT: aaguid(16) + credIdLen(2) + credId + COSE公钥]
 */
function wa_parse_auth_data(string $bin, bool $requireAttested): ?array
{
    if (strlen($bin) < 37) {
        return null;
    }

    $rpIdHash = substr($bin, 0, 32);
    $flags = ord($bin[32]);
    $signCount = unpack('N', substr($bin, 33, 4))[1];

    if (!hash_equals(hash('sha256', wa_rp_id(), true), $rpIdHash)) {
        return null;   // 不是发给本站点的，防跨域钓鱼
    }
    if (($flags & WA_FLAG_UP) === 0) {
        return null;   // 规范要求 user present
    }
    if (($flags & WA_FLAG_UV) === 0) {
        return null;   // 我们请求的是 userVerification: required
    }

    $hasAttested = ($flags & WA_FLAG_AT) !== 0;
    if ($requireAttested && !$hasAttested) {
        return null;
    }

    $out = [
        'flags'      => $flags,
        'sign_count' => $signCount,
        'has_attested' => $hasAttested,
        'credential_id' => null,
        'cose_key'   => null,
    ];

    if ($hasAttested) {
        if (strlen($bin) < 55) {
            return null;
        }
        $credIdLen = unpack('n', substr($bin, 53, 2))[1];
        if ($credIdLen < 1 || $credIdLen > 1023) {
            return null;
        }
        if (strlen($bin) < 55 + $credIdLen) {
            return null;
        }
        $out['credential_id'] = substr($bin, 55, $credIdLen);

        // COSE 公钥紧接着 credentialId；用迷你 CBOR 读一个 map
        $offset = 55 + $credIdLen;
        $cose = wa_cbor_read($bin, $offset);
        if (!is_array($cose)) {
            return null;
        }
        $out['cose_key'] = $cose;
    }

    return $out;
}

/**
 * 从 attestationObject 里取出 authData 与 COSE 公钥。
 *
 * 我们请求 `attestation: "none"`，所以结构就是 {fmt:"none", attStmt:{}, authData:bstr}。
 * fmt 不是 none 的一律拒绝 —— 因为我们**不校验** attestation statement，
 * 接受它等于把未经验证的声明当真。
 */
function wa_parse_attestation_none(string $b64): ?array
{
    $raw = wa_b64url_decode($b64);
    if ($raw === null || $raw === '') {
        return null;
    }

    $obj = wa_cbor_read_exact($raw);
    if (!is_array($obj)) {
        return null;
    }
    if ((string) ($obj['fmt'] ?? '') !== 'none') {
        return null;
    }
    $authData = $obj['authData'] ?? null;
    if (!is_string($authData)) {
        return null;
    }

    $parsed = wa_parse_auth_data($authData, true);
    if ($parsed === null) {
        return null;
    }
    $cose = $parsed['cose_key'];
    if (!is_array($cose)) {
        return null;
    }
    $pem = wa_cose_ec2_to_pem($cose);
    if ($pem === null) {
        return null;
    }

    return [
        'auth_data'     => $authData,
        'credential_id' => (string) $parsed['credential_id'],
        'public_key_pem' => $pem,
        'sign_count'    => (int) $parsed['sign_count'],
    ];
}

/* ────────────────────────── 断言验签 ────────────────────────── */

/**
 * 验证登录断言。
 *
 * 签名覆盖 `authenticatorData || SHA256(clientDataJSON)`，openssl_verify 内部会再做
 * 一次 SHA-256，所以直接传拼接后的数据即可。
 */
function wa_verify_assertion(
    string $authData,
    string $clientDataJsonRaw,
    string $signature,
    string $publicKeyPem
): bool {
    if ($authData === '' || $signature === '') {
        return false;
    }
    if (strpos($publicKeyPem, WA_PEM_PREFIX) !== 0) {
        return false;
    }

    $der = wa_signature_to_der($signature);
    if ($der === null) {
        return false;
    }

    $pub = @openssl_pkey_get_public($publicKeyPem);
    if ($pub === false) {
        return false;
    }

    $signed = $authData . hash('sha256', $clientDataJsonRaw, true);
    $result = @openssl_verify($signed, $der, $pub, OPENSSL_ALGO_SHA256);

    return $result === 1;
}

/**
 * signCount 单调性检查。
 *
 * 平台验证器（Face ID / Touch ID / 安卓指纹）**一律返回 0**，所以规范允许
 * 「新旧都为 0」时跳过。只有在双方都非 0 且新值不大于旧值时，才按疑似克隆处理。
 */
function wa_sign_count_ok(int $stored, int $received): bool
{
    if ($stored === 0 || $received === 0) {
        return true;
    }

    return $received > $stored;
}

/* ────────────────────────── 挑战（一次性，存 session） ────────────────────────── */

/**
 * 把未捕获异常 / 致命错误变成 JSON，而不是 500 HTML。
 *
 * 为何必须：API 返回 HTML 时前端的 JSON.parse 会失败，于是只能显示
 * “服务器未能验证”这种无从下手的信息 —— 定位一个真实的 TypeError 因此绕了一大圈
 * （最后是翻服务端日志才找到的）。有了它，任何异常都以带 code 的 JSON 返回，
 * 前端就能直接给出可读原因。
 *
 * 故意**不**把异常原文回给客户端（会泄露路径与内部结构），只记服务端日志。
 */
function wa_install_error_handler(string $endpoint): void
{
    static $installed = false;
    if ($installed) {
        return;
    }
    $installed = true;

    $emit = static function (string $summary) use ($endpoint): void {
        error_log(sprintf('[%s] %s', $endpoint, $summary));
        if (!headers_sent()) {
            header('Content-Type: application/json; charset=utf-8');
        }
        if (ob_get_level() > 0) {
            ob_clean();
        }
        echo json_encode([
            'success' => false,
            'status'  => 'error',
            'code'    => 'SERVER_ERROR',
            'message' => 'Server error',
        ], JSON_UNESCAPED_UNICODE);
        exit;
    };

    set_exception_handler(static function (Throwable $e) use ($emit): void {
        $emit(sprintf(
            '%s: %s @ %s:%d',
            get_class($e),
            $e->getMessage(),
            basename($e->getFile()),
            $e->getLine()
        ));
    });

    register_shutdown_function(static function () use ($emit): void {
        $err = error_get_last();
        if ($err !== null && in_array(
            $err['type'],
            [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR],
            true
        )) {
            $emit(sprintf('FATAL %s @ %s:%d', $err['message'], basename($err['file']), $err['line']));
        }
    });
}

/**
 * 挑战存在 session 的自定义键。
 * 下划线开头很重要：device_token_capture_session() 会跳过 `_` 前缀的键，
 * 所以挑战不会被写进会话快照。
 */
const WA_CHALLENGE_KEY = '_webauthn_challenge';

/** 生成一次性 challenge（32 字节随机，base64url） */
function wa_challenge_issue(string $purpose): string
{
    $challenge = wa_b64url_encode(random_bytes(32));
    $_SESSION[WA_CHALLENGE_KEY] = [
        'value'   => $challenge,
        'purpose' => $purpose,          // 'register' | 'login'
        'at'      => time(),
    ];

    return $challenge;
}

/**
 * 取出并**立即作废**挑战。
 *
 * 一次性是防重放的核心：无论验证成功与否都先 unset，绝不复用。
 * 同时校验 purpose，避免拿注册挑战去过登录验签。
 */
function wa_challenge_consume(string $purpose): ?string
{
    $slot = $_SESSION[WA_CHALLENGE_KEY] ?? null;
    unset($_SESSION[WA_CHALLENGE_KEY]);

    if (!is_array($slot)) {
        return null;
    }
    if ((string) ($slot['purpose'] ?? '') !== $purpose) {
        return null;
    }
    if (time() - (int) ($slot['at'] ?? 0) > WA_CHALLENGE_TTL) {
        return null;
    }
    $value = (string) ($slot['value'] ?? '');

    return $value !== '' ? $value : null;
}

/* ────────────────────────── 凭据存储 ────────────────────────── */

/** 同一账号最多可注册的 passkey 数 */
const WA_MAX_CREDENTIALS = 10;

/**
 * 用户的句柄（WebAuthn user.id）。
 *
 * 必须**稳定且不敏感**：它是记住式凭据（discoverable credential）存在验证器里的值，
 * 登录时会回传。所以只用 user_type:user_id 推导，不放密码/邮箱等。
 * 登录时会拿回传值与之比对，作为一道完整性检查。
 */
function wa_user_handle(string $userType, int $userId): string
{
    return $userType . ':' . $userId;
}

function wa_ensure_table(PDO $pdo): void
{
    static $done = false;
    if ($done) {
        return;
    }
    $done = true;

    try {
        $pdo->exec(
            "CREATE TABLE IF NOT EXISTS `webauthn_credential` (
              `id`               bigint unsigned NOT NULL AUTO_INCREMENT,
              `user_type`        enum('owner','user','member') NOT NULL,
              `user_id`          int NOT NULL,
              `credential_id`    varbinary(255) NOT NULL,
              `public_key_pem`   text NOT NULL,
              `sign_count`       int unsigned NOT NULL DEFAULT 0,
              `device_name`      varchar(100) DEFAULT NULL,
              `session_snapshot` mediumtext DEFAULT NULL,
              `created_at`       datetime NOT NULL DEFAULT current_timestamp(),
              `last_used_at`     datetime DEFAULT NULL,
              `revoked_at`       datetime DEFAULT NULL,
              PRIMARY KEY (`id`),
              UNIQUE KEY `uk_credential` (`credential_id`),
              KEY `idx_user` (`user_type`,`user_id`,`revoked_at`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
        );
    } catch (Throwable $e) {
        error_log('wa_ensure_table failed: ' . $e->getMessage());
    }
}

function wa_credential_count_active(PDO $pdo, string $userType, int $userId): int
{
    try {
        $stmt = $pdo->prepare(
            'SELECT COUNT(*) FROM webauthn_credential
             WHERE user_type = ? AND user_id = ? AND revoked_at IS NULL'
        );
        $stmt->execute([$userType, $userId]);

        return (int) $stmt->fetchColumn();
    } catch (Throwable $e) {
        error_log('wa_credential_count_active failed: ' . $e->getMessage());

        return 0;
    }
}

/**
 * 保存（或覆盖）一条凭据。
 *
 * ⚠️ $snapshot 必须是 **array**（与 device_token_issue 一致）。
 * 这里曾误写成 ?string，而调用方传的是 device_token_capture_session() 的数组，
 * 于是生产环境每次注册都抛 TypeError → 500 → 前端只能显示“服务器未能验证”。
 * 教训：密码学测得很足，但数据库层当时零覆盖 —— 现在有了。
 *
 * @param array<string,mixed>|null $snapshot 注册时的身份会话快照；登录时用它恢复会话
 * @return array{ok:bool,code:string}
 */
function wa_credential_save(
    PDO $pdo,
    string $userType,
    int $userId,
    string $credentialId,
    string $publicKeyPem,
    int $signCount,
    ?string $deviceName,
    ?array $snapshot
): array {
    if ($credentialId === '' || $credentialId === null) {
        return ['ok' => false, 'code' => 'BAD_CREDENTIAL_ID'];
    }
    if (strpos($publicKeyPem, WA_PEM_PREFIX) !== 0) {
        return ['ok' => false, 'code' => 'BAD_PUBLIC_KEY'];
    }

    try {
        // 同一账号重新注册同一把凭据 = 覆盖（换设备名/更新公钥），不占新名额
        $stmt = $pdo->prepare(
            'SELECT id FROM webauthn_credential WHERE credential_id = ? LIMIT 1'
        );
        $stmt->execute([$credentialId]);
        $existing = $stmt->fetchColumn();

        if ($existing === false
            && wa_credential_count_active($pdo, $userType, $userId) >= WA_MAX_CREDENTIALS) {
            return ['ok' => false, 'code' => 'CREDENTIAL_LIMIT'];
        }

        $snapshotJson = null;
        if (is_array($snapshot)) {
            $encoded = json_encode($snapshot, JSON_UNESCAPED_UNICODE);
            if ($encoded !== false && strlen($encoded) <= 65536) {
                $snapshotJson = $encoded;
            }
        }

        $stmt = $pdo->prepare(
            'INSERT INTO webauthn_credential
                (user_type, user_id, credential_id, public_key_pem, sign_count, device_name, session_snapshot)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                user_type        = VALUES(user_type),
                user_id          = VALUES(user_id),
                public_key_pem   = VALUES(public_key_pem),
                sign_count       = VALUES(sign_count),
                device_name      = VALUES(device_name),
                session_snapshot = VALUES(session_snapshot),
                revoked_at       = NULL'
        );
        $stmt->execute([
            $userType,
            $userId,
            $credentialId,
            $publicKeyPem,
            $signCount,
            $deviceName !== null && $deviceName !== '' ? mb_substr($deviceName, 0, 100) : null,
            $snapshotJson,
        ]);

        return ['ok' => true, 'code' => 'OK'];
    } catch (Throwable $e) {
        error_log('wa_credential_save failed: ' . $e->getMessage());

        return ['ok' => false, 'code' => 'SERVER_ERROR'];
    }
}

/** 按凭据 ID 查未吊销的凭据 */
function wa_credential_find(PDO $pdo, string $credentialId): ?array
{
    if ($credentialId === '') {
        return null;
    }

    try {
        $stmt = $pdo->prepare(
            'SELECT * FROM webauthn_credential WHERE credential_id = ? AND revoked_at IS NULL LIMIT 1'
        );
        $stmt->execute([$credentialId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);

        return $row ?: null;
    } catch (Throwable $e) {
        error_log('wa_credential_find failed: ' . $e->getMessage());

        return null;
    }
}

/** 记录一次成功使用（含 signCount 更新） */
function wa_credential_touch(PDO $pdo, int $id, int $signCount): void
{
    try {
        $stmt = $pdo->prepare(
            'UPDATE webauthn_credential SET last_used_at = NOW(), sign_count = ? WHERE id = ?'
        );
        $stmt->execute([$signCount, $id]);
    } catch (Throwable $e) {
        error_log('wa_credential_touch failed: ' . $e->getMessage());
    }
}

/** 列出该账号的 passkey（设置页用） */
function wa_credential_list(PDO $pdo, string $userType, int $userId): array
{
    try {
        $stmt = $pdo->prepare(
            'SELECT id, device_name, created_at, last_used_at, revoked_at,
                    (revoked_at IS NULL) AS is_active
             FROM webauthn_credential
             WHERE user_type = ? AND user_id = ?
             ORDER BY is_active DESC, last_used_at DESC, created_at DESC'
        );
        $stmt->execute([$userType, $userId]);

        return $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
    } catch (Throwable $e) {
        error_log('wa_credential_list failed: ' . $e->getMessage());

        return [];
    }
}

/** 该账号现有凭据 ID 列表（供 excludeCredentials 用，避免同一验证器重复注册） */
function wa_credential_ids(PDO $pdo, string $userType, int $userId): array
{
    try {
        $stmt = $pdo->prepare(
            'SELECT credential_id FROM webauthn_credential
             WHERE user_type = ? AND user_id = ? AND revoked_at IS NULL'
        );
        $stmt->execute([$userType, $userId]);

        return $stmt->fetchAll(PDO::FETCH_COLUMN) ?: [];
    } catch (Throwable $e) {
        error_log('wa_credential_ids failed: ' . $e->getMessage());

        return [];
    }
}

/** 吊销该账号的全部 passkey（账号级操作，不给单条任意吊销入口） */
function wa_credential_revoke_all(PDO $pdo, string $userType, int $userId): int
{
    try {
        $stmt = $pdo->prepare(
            'UPDATE webauthn_credential SET revoked_at = NOW()
             WHERE user_type = ? AND user_id = ? AND revoked_at IS NULL'
        );
        $stmt->execute([$userType, $userId]);

        return $stmt->rowCount();
    } catch (Throwable $e) {
        error_log('wa_credential_revoke_all failed: ' . $e->getMessage());

        return 0;
    }
}
