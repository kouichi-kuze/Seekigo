<?php
/**
 * Seekigo 主催者向け問い合わせフォーム API（Xserver / PHP mail）
 * POST /api/contact-event.php
 */

declare(strict_types=1);

ini_set('display_errors', '0');
error_reporting(0);

const MAX_NAME = 120;
const MAX_ORG = 200;
const MAX_EMAIL = 200;
const MAX_EVENT_URL = 500;
const MAX_MESSAGE = 4000;
const MAX_POST_BYTES = 65536;
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TURNSTILE_ACTION = 'contact_event';
const MAIL_TO = 'contact@seekigo.com';
const MAIL_FROM = 'contact@seekigo.com';
const MAIL_SUBJECT = '[Seekigo] イベント掲載・情報提供のお問い合わせ';

/** @var array<string, string> */
const TOPIC_LABELS = [
    'correction' => '掲載内容の修正',
    'official_image' => '公式画像の提供',
    'additional_info' => '情報の追加',
    'new_event' => '新規掲載の相談',
    'other' => 'その他',
];

/** @var list<string> */
const ALLOWED_ORIGIN_HOSTS = [
    'seekigo.com',
    'www.seekigo.com',
    'localhost',
    '127.0.0.1',
];

/** @var list<string> */
const ALLOWED_TURNSTILE_HOSTNAMES = [
    'seekigo.com',
    'www.seekigo.com',
    'localhost',
    '127.0.0.1',
];

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonResponse(false, genericError(), 405);
}

$contentLength = isset($_SERVER['CONTENT_LENGTH']) ? (int) $_SERVER['CONTENT_LENGTH'] : 0;
if ($contentLength > MAX_POST_BYTES) {
    jsonResponse(false, genericError(), 413);
}

if (!isAllowedRequestOrigin()) {
    jsonResponse(false, genericError(), 403);
}

// honeypot — bot には成功風レスポンス
$honeypot = sanitizeField(readPostString('company_website'), 200);
if ($honeypot !== '') {
    jsonResponse(true);
}

$name = sanitizeField(readPostString('name'), MAX_NAME);
$organization = sanitizeField(readPostString('organization'), MAX_ORG);
$emailRaw = sanitizeField(readPostString('email'), MAX_EMAIL);
$eventUrl = sanitizeField(readPostString('event_url'), MAX_EVENT_URL);
$topic = sanitizeField(readPostString('topic'), 64);
$message = sanitizeField(readPostString('message'), MAX_MESSAGE);
$turnstileToken = sanitizeField(readPostString('cf-turnstile-response'), 2048);

if ($name === '' || $emailRaw === '' || $topic === '' || $message === '') {
    jsonResponse(false, genericError(), 400);
}

if (!filter_var($emailRaw, FILTER_VALIDATE_EMAIL)) {
    jsonResponse(false, genericError(), 400);
}

if (!array_key_exists($topic, TOPIC_LABELS)) {
    jsonResponse(false, genericError(), 400);
}

if ($eventUrl !== '' && !isValidHttpUrl($eventUrl)) {
    jsonResponse(false, genericError(), 400);
}

$secretKey = loadTurnstileSecretKey();
if ($secretKey === null || $secretKey === '') {
    jsonResponse(false, genericError(), 500);
}

if (!verifyTurnstile($secretKey, $turnstileToken)) {
    jsonResponse(false, genericError(), 400);
}

$topicLabel = TOPIC_LABELS[$topic];
$sentAt = (new DateTimeImmutable('now', new DateTimeZone('Asia/Tokyo')))
    ->format('Y-m-d H:i:s T');

$body = implode("\n", [
    'Seekigo イベント掲載・情報提供フォームよりお問い合わせがありました。',
    '',
    '---',
    'お名前: ' . $name,
    '団体名 / 主催者名: ' . ($organization !== '' ? $organization : '（未入力）'),
    'メールアドレス: ' . $emailRaw,
    '対象イベントURL: ' . ($eventUrl !== '' ? $eventUrl : '（未入力）'),
    'ご連絡内容: ' . $topicLabel . ' (' . $topic . ')',
    '',
    'メッセージ:',
    $message,
    '',
    '---',
    '送信日時: ' . $sentAt,
]);

if (!sendMail($emailRaw, $body)) {
    jsonResponse(false, genericError(), 500);
}

jsonResponse(true);

/**
 * @return never
 */
function jsonResponse(bool $success, ?string $error = null, int $code = 200): void
{
    http_response_code($code);
    header('Content-Type: application/json; charset=UTF-8');
    header('X-Content-Type-Options: nosniff');

    $payload = ['success' => $success];
    if (!$success && $error !== null && $error !== '') {
        $payload['error'] = $error;
    }

    echo json_encode($payload, JSON_UNESCAPED_UNICODE);
    exit;
}

function genericError(): string
{
    return '送信できませんでした。時間をおいてもう一度お試しください。';
}

function readPostString(string $key): string
{
    $value = $_POST[$key] ?? '';
    return is_string($value) ? trim($value) : '';
}

function sanitizeField(string $value, int $maxLength): string
{
    $value = stripHeaderInjection($value);
    if (mb_strlen($value, 'UTF-8') > $maxLength) {
        $value = mb_substr($value, 0, $maxLength, 'UTF-8');
    }
    return $value;
}

function stripHeaderInjection(string $value): string
{
    return str_replace(["\r", "\n", "\0"], '', $value);
}

function isValidHttpUrl(string $url): bool
{
    if (!filter_var($url, FILTER_VALIDATE_URL)) {
        return false;
    }
    $parts = parse_url($url);
    if (!is_array($parts)) {
        return false;
    }
    $scheme = strtolower($parts['scheme'] ?? '');
    return $scheme === 'http' || $scheme === 'https';
}

function isAllowedRequestOrigin(): bool
{
    $candidates = [
        $_SERVER['HTTP_ORIGIN'] ?? '',
        $_SERVER['HTTP_REFERER'] ?? '',
    ];

    $matched = false;
    foreach ($candidates as $candidate) {
        if ($candidate === '') {
            continue;
        }
        $host = parse_url($candidate, PHP_URL_HOST);
        if (!is_string($host) || $host === '') {
            continue;
        }
        $host = strtolower($host);
        if (in_array($host, ALLOWED_ORIGIN_HOSTS, true)) {
            $matched = true;
            break;
        }
    }

    return $matched;
}

function loadTurnstileSecretKey(): ?string
{
    $documentRoot = $_SERVER['DOCUMENT_ROOT'] ?? '';
    $candidates = [];

    if ($documentRoot !== '') {
        $candidates[] = dirname($documentRoot) . '/config/turnstile.php';
    }

    $candidates[] = dirname(__DIR__, 2) . '/config/turnstile.php';

    foreach ($candidates as $path) {
        if (!is_readable($path)) {
            continue;
        }
        /** @var mixed $config */
        $config = require $path;
        if (!is_array($config)) {
            continue;
        }
        $secret = $config['secret_key'] ?? null;
        if (is_string($secret) && $secret !== '') {
            return $secret;
        }
    }

    return null;
}

function verifyTurnstile(string $secretKey, string $token): bool
{
    if ($token === '') {
        return false;
    }

    $payload = http_build_query([
        'secret' => $secretKey,
        'response' => $token,
        'remoteip' => stripHeaderInjection($_SERVER['REMOTE_ADDR'] ?? ''),
    ]);

    $responseBody = postUrl(TURNSTILE_VERIFY_URL, $payload);
    if ($responseBody === null) {
        return false;
    }

    /** @var mixed $decoded */
    $decoded = json_decode($responseBody, true);
    if (!is_array($decoded) || empty($decoded['success'])) {
        return false;
    }

    if (isset($decoded['action']) && $decoded['action'] !== TURNSTILE_ACTION) {
        return false;
    }

    if (isset($decoded['hostname'])) {
        $hostname = strtolower((string) $decoded['hostname']);
        if (!in_array($hostname, ALLOWED_TURNSTILE_HOSTNAMES, true)) {
            return false;
        }
    }

    return true;
}

function postUrl(string $url, string $body): ?string
{
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        if ($ch === false) {
            return null;
        }
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $body,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => ['Content-Type: application/x-www-form-urlencoded'],
            CURLOPT_TIMEOUT => 10,
        ]);
        $result = curl_exec($ch);
        curl_close($ch);
        return is_string($result) ? $result : null;
    }

    $context = stream_context_create([
        'http' => [
            'method' => 'POST',
            'header' => "Content-Type: application/x-www-form-urlencoded\r\n",
            'content' => $body,
            'timeout' => 10,
            'ignore_errors' => true,
        ],
    ]);

    $result = @file_get_contents($url, false, $context);
    return is_string($result) ? $result : null;
}

function sendMail(string $replyEmail, string $body): bool
{
    $replyEmail = stripHeaderInjection($replyEmail);
    if (!filter_var($replyEmail, FILTER_VALIDATE_EMAIL)) {
        return false;
    }

    if (function_exists('mb_language')) {
        mb_language('Japanese');
    }
    if (function_exists('mb_internal_encoding')) {
        mb_internal_encoding('UTF-8');
    }

    $fromHeader = formatMailbox('Seekigo', MAIL_FROM);
    $replyHeader = formatMailbox('', $replyEmail);

    $headers = [
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: 8bit',
        'From: ' . $fromHeader,
        'Reply-To: ' . $replyHeader,
    ];

    $headerString = implode("\r\n", $headers);

    $subject = MAIL_SUBJECT;
    if (function_exists('mb_encode_mimeheader')) {
        $subject = mb_encode_mimeheader(MAIL_SUBJECT, 'UTF-8', 'B', "\r");
    }

    if (function_exists('mb_send_mail')) {
        return mb_send_mail(MAIL_TO, $subject, $body, $headerString, '-f' . MAIL_FROM);
    }

    return mail(MAIL_TO, $subject, $body, $headerString, '-f' . MAIL_FROM);
}

function formatMailbox(string $name, string $email): string
{
    $email = stripHeaderInjection($email);
    $name = stripHeaderInjection($name);

    if ($name === '') {
        return $email;
    }

    if (function_exists('mb_encode_mimeheader')) {
        $encodedName = mb_encode_mimeheader($name, 'UTF-8', 'B', "\r");
        return $encodedName . ' <' . $email . '>';
    }

    return $name . ' <' . $email . '>';
}
