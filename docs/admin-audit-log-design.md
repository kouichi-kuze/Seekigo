# Admin Audit Log 設計案（将来実装）

## 目的

管理画面で「誰が・何を・いつ変更したか」を追跡し、手動編集と sync の境界を可視化する。

## テーブル案: `admin_audit_logs`

| カラム | 型 | 説明 |
|--------|-----|------|
| id | bigserial PK | |
| created_at | timestamptz | 操作時刻 |
| actor | text | 将来: auth user id / email。現状 DEV-only なら `dev-local` 固定 |
| action | text | `event_update`, `hide_event`, `publish`, `delete_event`, … |
| entity_type | text | `event`, `field_review`, … |
| entity_id | bigint | events.id 等 |
| before_json | jsonb | 変更前スナップショット（任意） |
| after_json | jsonb | 変更後 |
| meta | jsonb | intent, source_ip, user_agent 等 |

## 記録タイミング

- `admin-event-edit.ts` — 更新成功後
- `admin-hide.ts` — status 変更後
- `admin-delete.ts` — 削除前に before のみ
- `admin-publish.ts` — publish / bulk publish
- `admin-field-review.ts` — accept / reject
- `admin-image-usage.ts` — 画像ステータス変更

## 実装方針

1. `src/lib/admin-audit.ts` に `logAdminAction()` を集約
2. 各 handler の成功パスで fire-and-forget（失敗しても本操作は成功させる）
3. 管理 UI は `/admin/events/audit/` を Phase 3 で追加
4. 本番 admin 認証導入時に `actor` を session から注入

## 保持期間

- 90 日ローテーション（pg_cron または GitHub Action で DELETE）

## プライバシー

- summary 全文は after_json に含めず diff または field 名のみに限定するオプションあり
