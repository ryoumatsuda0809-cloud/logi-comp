# supabase/rollbacks — 「戻す SQL」

マイグレーションを本番に適用した後で、うまくいかなかったときに **適用前の状態へ戻す**ための SQL を置く場所。
`supabase/migrations/` には置かない（マイグレーションとして自動適用されてしまうため）。

| ファイル | 戻す対象 |
|------|------|
| `20261013_restore_pre_migration_state.sql` | 2026-10-13 の5本（下の表）を、すべて適用前の状態へ |

## 戻す対象の5本

| 順 | マイグレーション | やったこと |
|---|------|------|
| 1 | `20261013100000_register_unverified_facilities.sql` | 施設の「未確認」登録（`facilities` に3列、`register_facility`、`can_use_facility`、SELECT ポリシー、4関数の置き換え） |
| 2 | `20261013100001_shared_report_unverified_facilities.sql` | `get_shared_report` に `unverified_facility_names` を追加 |
| 3 | `20261013200000_server_side_report_totals.sql` | サーバー側の日報計算（`wait_rates`、`submit_daily_report` など、`submitted_reports` に2列、月次ビューの作り直し、直接 INSERT の剥奪） |
| 4 | `20261013200001_lock_submitted_reports_direct_insert.sql` | `submitted_reports` への直接 INSERT の剥奪（3の STEP 6 と同じ内容を単独で） |
| 5 | `20261013300000_monthly_report_unverified_visits.sql` | 月次ビューに `unverified_visits` 列を追加 |

## 戻す前に確認すること

1. **フロントを先に（または同時に）戻す。** 戻した後の DB には `submit_daily_report` も `unverified_facility_names` も `unverified_visits` も無い。
   新しいフロントのままだと、日報の提出・共有帳票の注記・月次レポートの注記が動かない。
   逆に、旧いフロント（`submitted_reports` へ直接 INSERT する版）は、戻した後の DB で動く。
2. **バックアップを取る**（Supabase のダッシュボードの Backups、または `pg_dump`）。ガードで止まらないデータ
   （`facilities` / `submitted_reports` / `wait_logs` の既存の行）は、この SQL では触らないが、念のため。
3. **何が適用済みかを確かめる**（読み取りのみ）。どこまで適用済みでも、この SQL は動く（無いものは飛ばす）が、状況の把握のために:

   ```sql
   select version, name from supabase_migrations.schema_migrations where version like '20261013%' order by version;
   select to_regclass('public.wait_rates') as wait_rates,
          to_regprocedure('public.submit_daily_report(date,text,text,jsonb,boolean,boolean,integer)') as submit_daily_report,
          (select count(*) from information_schema.columns
            where table_schema='public' and table_name='facilities' and column_name='verification_status') as facilities_new_col;
   ```
4. **データが有るか**（ガードに引っかかるかの事前確認。読み取りのみ。列が無い段階ではエラーになるので、その場合は不要）:

   ```sql
   -- 未確認の施設、または登録組織・登録者の記録が残った施設
   select id, name, client_name, verification_status, registered_by_organization_id, registered_by, created_at
   from public.facilities
   where verification_status <> 'verified' or registered_by_organization_id is not null or registered_by is not null;
   -- サーバー計算の内訳が入った日報
   select id, user_id, report_date from public.submitted_reports
   where server_calculation is not null or reported_wait_minutes is not null;
   -- 料率表
   select * from public.wait_rates order by vehicle_class;
   ```

## 実行方法

**Supabase の SQL エディタに全文を貼って実行する**、または psql で:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/rollbacks/20261013_restore_pre_migration_state.sql
```

* **`apply_migration`（MCP）や `supabase db push` では実行しない。** これはマイグレーションではない（適用記録を残さない・二重に BEGIN しない）。
* ファイル全体が `BEGIN` 〜 `COMMIT` の1トランザクション。**途中で1か所でも失敗すれば、何も変わらない。**
* 最初に `lock_timeout = 15s` を設定してある。ロックが取れずに失敗したら、アクセスの少ない時間にやり直す。
* 最後に自己検査（STEP 8）がある。食い違いがあれば例外で全体が戻る。
* 何度実行しても同じ結果になる（適用していない・戻し済みの状態でも成功する）。

## 戻すと失われるもの

| 失われるもの | 備考 |
|------|------|
| 未確認の施設の登録機能（`register_facility`、`can_use_facility`、`facilities` の3列） | 未確認の施設や登録者の記録が1件でもあれば中断（ガード） |
| サーバー側の日報計算（`submit_daily_report`、`calc_daily_wait_totals`、`wait_yen_per_minute`、`protect_default_wait_rate`、`wait_rates`、`submitted_reports` の2列） | 2列にデータが有る日報が1件でもあれば中断。料率表が初期値から変わっていても中断 |
| 月次ビューの `unverified_visits` 列と、料率の DB 管理 | 元の CASE 直書きに戻る |
| 共有帳票の `unverified_facility_names` | |
| `supabase_migrations.schema_migrations` の5本の記録 | 消さないと、後で再適用されない |

### 戻した後に「元どおり」になる、セキュリティ上の弱点（意識しておくこと）

* **`submitted_reports` への直接 INSERT が `anon` / `authenticated` に戻る。** クライアントが計算した待機分数・待機料を、そのまま保存できる元の状態。
  （UPDATE / DELETE は、RESTRICTIVE ポリシーとトリガーで引き続き禁止。）これを避けたいなら、戻さずに前へ直す（roll forward）ことを検討する。
* `facilities` の SELECT は「`authenticated` は全件」に戻る。

## ガードで中断したとき

メッセージに「中断:」と出る。**何も変更されていない**（トランザクション全体が戻っている）。

* **未確認の施設が有る場合**: 列を落とすと、その施設が「確認済み」扱いになって全組織に見え、打刻に使えてしまう。
  選択肢は (a) 戻さずに前へ直す、(b) 運営者が対象の施設を確認して整理する（`wait_logs` が参照している施設は削除できない）。
  それでも列を落としたいと人が判断した場合は、**先に対象の施設の処遇を決めてから**、`STEP 0` の (a) と、その結果を前提にした `STEP 3` の
  `DROP COLUMN`、`STEP 8` の検査を編集する。自動では進めない。
* **`server_calculation` / `reported_wait_minutes` の入った日報が有る場合**: 日報は不変の証拠で、内訳を捨てることになる。
  列を残したまま関数・ビュー・権限だけ戻したいなら、`STEP 5` の `ALTER TABLE ... DROP COLUMN` と `STEP 0` の (b)、
  `STEP 8` の「足した列が残っていないか」の検査を外して実行する（列は残る。害はない）。
  この編集をしたファイルは、ローカルで検証していない。
* **料率表が初期値から変わっている場合**: `wait_rates` の内容を控えてから（変更した履歴は他に残らない）、`STEP 0` の (c) を外す。

## 戻した後の確認（読み取りのみ）

次の関数・ビューの定義は、本番から取得した適用前の定義と **md5 まで一致する**はず（2026-10-13 に本番で取得した値。PostgreSQL 17.6）:

```sql
select p.oid::regprocedure::text as sig, md5(pg_get_functiondef(p.oid)) as md5
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('enforce_wait_log_geofence','get_nearest_facility','get_shared_report',
                    'issue_ticket','queue_offline_punch','verify_company_name')
order by 1;
-- enforce_wait_log_geofence()  7c7355567339e61567ece04d0ee24c38
-- get_nearest_facility(...)    6a9780cc2c217af4710bd38c33d2f302
-- get_shared_report(text)      f444c4d499b288204f6e85731c5de58f
-- issue_ticket(...)            6cb03bb90a0eaede063f27c607e5bbf6
-- queue_offline_punch(...)     4f43fcaf250ece8b3aa5df4054f44061
-- verify_company_name(text)    dca51d6767e463662161534f4f806875

select md5(pg_get_viewdef('public.monthly_wait_risk_reports'::regclass, true)) as view_pretty_md5;
-- 362765b59eacd780de16c29bf6baf63a
select relacl::text, reloptions::text from pg_class where oid = 'public.monthly_wait_risk_reports'::regclass;
-- {postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}  {security_invoker=true}
select relacl::text from pg_class where oid = 'public.submitted_reports'::regclass;
-- {postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}
select tablename, policyname from pg_policies where schemaname='public' and tablename in ('facilities','submitted_reports') order by 1,2;
-- facilities: authenticated_can_select / submitted_reports: Immutable: no deletes allowed, Immutable: no updates allowed, Users can insert own report, Users can view own reports
```

md5 が合わない場合、**その後に別のマイグレーションが入った**か、この SQL の転記が誤っている。後者は検証済みなので、まず前者を疑う。

## 戻した後に、もう一度マイグレーションを適用できるか

できる（ローカルで、戻す → 5本を再適用 → 状態が最初の適用後と一致、を確認済み）。`schema_migrations` の記録も消してあるので、`supabase db push` で再適用される。

## ローカル検証の範囲と限界

使い捨ての PostgreSQL 16 に、Supabase 風の最小スタブ（`auth.uid()`、`anon` / `authenticated` / `service_role`、既定権限、
`profiles` / `organizations` / `user_roles` / `facilities` / `wait_logs` / `submitted_reports` など）を作って検証した。確認したこと:

* 本番から読み取りで取得した適用前の定義（関数6本、ビュー、ポリシー、権限）で適用前の状態を作り、5本を順に適用し、戻す SQL を実行して、
  関数の `pg_get_functiondef` 全文・`proacl`・コメント、ビューの定義・`reloptions`・`relacl`・コメント、ポリシー、表の権限、列、制約、索引、トリガーが
  **適用前と完全に一致**することを、カタログのダンプの差分で確認した。
* 取り出した定義の md5 は、本番で取得した md5 と一致する（関数6本、ビュー）。
* 戻す → 再適用 → 再度戻す、戻し済みの状態で再実行、いずれも成功。
* 途中までしか適用していない状態（1のみ / 1-2 / 1-3 / 1-4 / 何も無し）からも戻せる。
* ガード（未確認の施設、`registered_by*`、`server_calculation`、`reported_wait_minutes`、料率の変更・追加）で中断し、状態が変わらない。
* 途中で失敗（列に依存するビューが有る）したとき、全体が元に戻る。
* 適用後は `authenticated` / `anon` の直接 INSERT が拒否され、戻した後は適用前と同じく通る。

限界（**確認していないこと**）:

* **本番では実行していない。**（本番へは読み取りクエリしか発行していない。）
* スタブは本番の写しではない。次のものは本物でなく簡易版: `profiles` / `organizations` / `user_roles` の制約・トリガー・RLS、
  `is_member_of_org` / `has_role_in_org` の本体、不変トリガー（`block_submitted_reports_*`）や `force_submitted_at_*` の本体、`wait_logs` の他のポリシー、
  `waiting_evidence.evidence_type`（本番は enum）。これらをこの SQL は変更しないが、本番の実物との相互作用は確かめていない。
* ローカルは PostgreSQL 16、本番は 17.6。17 だけの権限 `MAINTAIN`（`m`）は、`GRANT ALL` で付く想定だが、PG17 では実行していない
  （本番の `relacl` は `arwdDxtm` と確認済み）。関数定義の整形（`pg_get_functiondef`）は、同じ PostgreSQL の出力どうしで比べた md5 が本番と一致した。
* 本番の実データ（`facilities` 88件 / `submitted_reports` 5件 / `wait_logs` 10件、取得時）での実行はしていない。ガードの判定は、5本の適用後に新しい列がすべて初期値のままなら通る想定。
* Supabase の SQL エディタが、スクリプト内の `BEGIN` / `COMMIT` をどう扱うかは、実機で確認していない（psql では確認済み）。
* `supabase_migrations.schema_migrations` の列構成（`version` / `name`）は、本番の `list_migrations` の出力から推定した。
* 4本目のファイル（`20261013200001_lock_submitted_reports_direct_insert.sql`）は、この作業ブランチ（`claude/charming-ramanujan-y0hfn0` の `f9e5fe8`）には無く、
  メインのチェックアウトに未追跡で在るものを使って検証した。
