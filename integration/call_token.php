<?php
declare(strict_types=1);

require_once __DIR__ . '/../session.php';
require_once __DIR__ . '/../connect.php';
require_once __DIR__ . '/../vendor/autoload.php';

use Firebase\JWT\JWT;

header('Content-Type: application/json');
header('Cache-Control: no-store');

if (empty($_SESSION['user_id'])) {
    http_response_code(401);
    echo json_encode(['error' => 'Unauthenticated']);
    exit;
}

$secret = $_ENV['CALL_JWT_SECRET'] ?? getenv('CALL_JWT_SECRET') ?: '';
if (strlen($secret) < 32) {
    error_log('CALL_JWT_SECRET is missing or too short');
    http_response_code(503);
    echo json_encode(['error' => 'Call service unavailable']);
    exit;
}

$userId = (int) $_SESSION['user_id'];
$stmt = $conn->prepare(
    'SELECT full_name, username, profile_picture
     FROM users WHERE UID = ? LIMIT 1'
);
$stmt->bind_param('i', $userId);
$stmt->execute();
$user = $stmt->get_result()->fetch_assoc();

if (!$user) {
    http_response_code(404);
    echo json_encode(['error' => 'User not found']);
    exit;
}

$now = time();
$payload = [
    'iss' => 'ink-web',
    'aud' => 'ink-call-service',
    'sub' => (string) $userId,
    'iat' => $now,
    'nbf' => $now - 5,
    'exp' => $now + 300,
    'jti' => bin2hex(random_bytes(16)),
    'name' => $user['full_name'] ?: $user['username'],
    'avatar' => $user['profile_picture'] ?: null,
];

echo json_encode([
    'token' => JWT::encode($payload, $secret, 'HS256'),
    'expires_at' => $payload['exp'],
    'service_url' => $_ENV['CALL_SERVICE_PUBLIC_URL'] ?? '/calls',
]);

