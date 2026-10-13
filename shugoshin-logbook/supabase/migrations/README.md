# supabase/migrations — マイグレーション管理ドキュメント

## 命名規則

| 種別 | 形式 | 例 |
|------|------|-----|
| **新規（標準）** | `YYYYMMDD_hhmmss_snake_case_description.sql` | `20260414000001_recover_missing_base_tables.sql` |
| **Lovable生成（旧）** | `YYYYMMDDhhmmss_<UUID>.sql` | `20260211044840_a7060698-....sql` |

> **注意**: Lovable生成ファイルのファイル名変更は禁止。`supabase_migrations` テーブルのレコードと不一致になりマイグレーション管理が破綻する。

---

## Lovable生成ファイル 対訳表

| ファイル名（タイムスタンプ部） | 内容 |
|------|------|
| `20260211044840` | **ベーススキーマ**: enums, organizations, profiles, user_roles, transport_orders, compliance_logs, RLS, トリガー, インデックス |
| `20260213081505` | organizations INSERT ポリシー修正（新規ユーザーのみ作成可） |
| `20260218095840` | organization_members RLSポリシー追加 |
| `20260218103506` | profiles.organization_id バリデーショントリガー |
| `20260218105418` | organization_financials RLSポリシー修正 |
| `20260218112542` | saved_locations テーブル作成・RLS・usage_countトリガー |
| `20260218123713` | create_organization_with_admin RPC作成 |
| `20260218124823` | organizations に住所・電話番号カラム追加 |
| `20260218131749` | transport_orders: 作成者UPDATE・メンバーINSERTポリシー追加 |
| `20260218132727` | transport_orders: approved_at/approved_by追加・承認フロー分割 |
| `20260221065508` | transport_orders に temperature_zone カラム追加 |
| `20260221180921` | organization_details テーブル作成・データ移行・旧カラム削除 |
| `20260221182821` | organizations RLSポリシー再作成・get_order_geofence RPC追加 |
| `20260222043601` | compliance_logs SELECTポリシー再設計（driver_id/organization_id分離） |
| `20260222050203` | invite_code生成・join_organization_by_invite_code RPC追加 |
| `20260222051850` | organization_invite_codes テーブル作成・招待コード管理RPC整備 |
| `20260222052240` | generate_invite_code 関数の search_path 修正 |
| `20260303145636` | compliance_logs に client_organization_id追加・monthly_wait_risk_reports VIEW再作成 |
| `20260303145918` | monthly_wait_risk_reports VIEW に security_invoker 設定 |
| `20260310063001` | daily_reports にカラム追加（summary, waiting_minutes 等） |
| `20260314182102` | submitted_reports にカラム追加（original_ai_output, is_edited, formal_report） |
| `20260323040012` | submitted_reports: RESTRICTIVE RLSで UPDATE/DELETE 禁止 |
| `20260327090043` | facilities テーブル作成・RLS |
| `20260331045352` | get_nearest_facility RPC作成（ハーバーサイン距離計算） |
| `20260409135804` | monthly_wait_risk_reports VIEW を wait_logs + facilities ベースに全面再設計 |

---

## 法的要件対応マイグレーション（2026-04-14）

| ファイル | 目的 | 法的根拠 |
|------|------|------|
| `20260414000001_recover_missing_base_tables.sql` | コンソール直接作成の5テーブルをマイグレーション管理下に正規化 | 監査証跡の完全性 |
| `20260414000002_wait_logs_add_gps.sql` | wait_logs に latitude/longitude カラム追加 | 場所の証拠能力（STEP 4前提） |
| `20260414000003_force_server_timestamps.sql` | compliance_logs・wait_logs の時刻をDBサーバー時刻で強制上書き | 時刻偽装防止（荷主待機時間の証拠能力） |
| `20260414000004_gps_not_null_constraints.sql` | GPS座標NULLのINSERTをトリガーで拒否 | 場所の証拠能力（位置不明レコードの作成禁止） |
| `20260414000005_immutable_submitted_reports_trigger.sql` | submitted_reports の UPDATE/DELETE/TRUNCATE を全ロールに対してDBトリガーでブロック | エビデンスの絶対的不変性（RLSのみでは不十分） |
| `20260414000006_fix_advance_wait_status_timestamps.sql` | advance_wait_status RPCをサーバー時刻強制・ステータス遷移検証付きで再定義 | 時刻偽装防止（フェーズ遷移時刻の証拠能力） |

---

## 適用前チェックリスト

### STEP 4 実施前（GPS NOT NULL）
```sql
-- 既存NULLレコード件数を確認
SELECT count(*) FROM public.compliance_logs WHERE latitude IS NULL OR longitude IS NULL;
SELECT count(*) FROM public.wait_logs        WHERE latitude IS NULL OR longitude IS NULL;
```
件数が0でない場合、既存データの修正またはデータ品質方針の決定が必要。

### STEP 5 動作確認（ステージング）
```sql
-- 以下がエラーになることを確認
UPDATE public.submitted_reports SET total_wait_minutes = 0 WHERE id = '<任意のID>';
DELETE FROM public.submitted_reports WHERE id = '<任意のID>';
```
`[法的保護]` プレフィックスの EXCEPTION が発生すれば正常。

### フェーズ2（将来: GPS DDL制約追加）
既存NULLが0件になった後、以下を別マイグレーションとして追加する:
```sql
ALTER TABLE public.compliance_logs
  ALTER COLUMN latitude  SET NOT NULL,
  ALTER COLUMN longitude SET NOT NULL;
ALTER TABLE public.wait_logs
  ALTER COLUMN latitude  SET NOT NULL,
  ALTER COLUMN longitude SET NOT NULL;
```

---

## テーブル依存関係

```
auth.users
  └─ profiles (user_id)
  └─ user_roles (user_id)
  └─ daily_reports (user_id)
  └─ submitted_reports (user_id)
  └─ wait_logs (user_id)

organizations
  └─ profiles (organization_id)
  └─ user_roles (organization_id)
  └─ organization_details (organization_id)
  └─ organization_financials (organization_id)
  └─ organization_members (organization_id)
  └─ organization_invite_codes (organization_id)
  └─ transport_orders (organization_id)
  └─ compliance_logs (organization_id, client_organization_id)
  └─ submitted_reports (organization_id)

transport_orders
  └─ compliance_logs (order_id)

facilities
  └─ wait_logs (facility_id)
  └─ monthly_wait_risk_reports (VIEW)
```

## 2026-10-13 の追加（適用順序: この順。**フロントのデプロイを間に挟む**）
**原則: 既存の動きを壊さない。足すものを先に入れ、既存を締める変更は、フロントの切り替えが済んでから最後に入れる。**

1. `20261013100000_register_unverified_facilities.sql` — 運送会社の管理者による施設の登録（未確認施設）と、`facilities` の可視性の絞り込み（既存施設は全て「確認済み」なので、既存の動きは変わらない）
2. `20261013100001_shared_report_unverified_facilities.sql` — 共有帳票に「位置未確認の施設」を出す
3. `20261013200000_server_side_report_totals.sql` — 日報の数値をサーバーで計算（`wait_rates`、`submit_daily_report`、月次ビューの作り直し）。**RPC を足すだけで、旧い画面の提出は引き続き動く**
4. `20261013300000_monthly_report_unverified_visits.sql` — 月次ビューに `unverified_visits`（末尾の列）を追加
5. **ここで、新しいフロントをデプロイする**（`submit_daily_report` を呼ぶ画面、施設の登録画面）
6. `20261013200001_lock_submitted_reports_direct_insert.sql` — 日報の直接 INSERT を剥奪（**フロントのデプロイ後に**。先に入れると旧い画面の提出が失敗する）

各段階のあとに `supabase/tests/security_checks.sql` と `supabase/tests/server_side_report_totals.sql` を実行し、結果の先頭に省略の警告が出ていないことを確認する
（6 を入れる前は、`server_side_report_totals.sql` に「直接INSERTの剥奪が未適用」の省略が1件出るのが正常）。
戻す手順は `supabase/rollbacks/` を参照（作成中）。
