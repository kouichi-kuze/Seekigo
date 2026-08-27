<?php
/**
 * Cloudflare Turnstile Secret Key（Xserver 本番用）
 *
 * 1. このファイルを turnstile.php にコピー
 * 2. secret_key に Cloudflare の Secret Key を設定
 * 3. public_html の外（document root の1つ上）の config/ に配置
 *
 * 例: /home/ユーザー名/seekigo.com/config/turnstile.php
 *     /home/ユーザー名/seekigo.com/public_html/  ← dist の中身
 *
 * Git へ commit しないこと。
 */
return [
    'secret_key' => '',
];
