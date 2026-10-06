# Supabase の設計（現行）

> 最終更新: 2026-10-03。実際のポリシー・権限は本番DBが正で、変更は必ず `supabase/migrations/` に残す。
> 権限の回帰テストは `supabase/tests/security_checks.sql`（適用後に毎回実行）。

## 原則
1. **証拠系テーブルへの書き込みは RPC（SECURITY DEFINER）だけ**。`authenticated` / `anon` には
   INSERT / UPDATE / DELETE の権限を与えない（RLS ではなくテーブル権限で閉じる。列単位の REVOKE は
   テーブル単位の GRANT があると効かないため使わない）。
2. **時刻はサーバーが決める**。端末の時刻を受け取る経路を作らない。
3. **確定したら変えない**。署名済み証拠は更新・削除不可。取消は状態の変更のみ（物理削除しない）。
4. **関数は既定で誰も実行できない**。新しい関数は、必要なロールにだけ明示的に `GRANT EXECUTE` する。

## 証拠系テーブル（読み取りのみ。書き込みは RPC）
| テーブル | 読める人 | 書き込みの入口 |
|---|---|---|
| `wait_logs` | 本人／施設の荷主組織の admin／ドライバー所属組織の admin | `issue_ticket`, `start_loading`, `complete_ticket`, `cancel_ticket`, `approve_pending_punch`, `shipper_advance_wait` |
| `waiting_evidence` | 本人／同じ組織のメンバー | 上記の RPC（内部で挿入・署名） |
| `pending_punches` | 本人／組織の admin | `queue_offline_punch`, `approve_pending_punch`, `reject_pending_punch` |
| `facilities` | ログイン済み全員 | なし（施設の登録は運用側のSQL） |

- 圏外の仮記録（`pending_punches`）は、管理者の承認で `wait_logs` に反映され、**等級C**になる。
  算定は申告時刻（`claimed_*`）を使い、承認した時刻は使わない。
- 荷主側の操作（`shipper_advance_wait`）は「呼出」「荷役開始」まで。**完了はドライバー側の
  `complete_ticket`（GPS・署名）だけ**が確定させる。
- `advance_wait_status` は内部用。クライアントからは実行できない。

## 組織と権限
- `organizations`（名前は正規化して一意）, `user_roles`（`admin` / `member` 等）, `profiles.organization_id`。
- 組織の作成は `create_organization_with_admin` のみ（直接 INSERT 不可）。同名は拒否。
- 参加は招待コード（`join_organization_by_invite_code`）。招待コードの発行は admin のみ。
- 施設と荷主組織の紐付けは `facilities.client_organization_id`（FK）。**権限判定は名前の文字列一致ではなくこの列で行う**。
  紐付いていない施設は、ドライバー本人にしか待機記録が見えない。

## 帳票
- `monthly_wait_risk_reports`（`security_invoker`）。見える範囲は呼び出した人の権限に従う
  （運送会社の admin は自組織のドライバー分）。
- `submitted_reports` は提出後に不変（トリガー）。ただし数値はクライアントが組み立てた値で、サーバー検証は未実装（ロードマップ）。

## 発注・招待コード・整理券
- 承認済みの発注（`transport_orders`）は、内容・納期・温度帯を変更できず、削除もできない（`guard_transport_orders` トリガー）。
  承認できるのは管理者のみで、承認の記録（日時・承認者）はサーバー側で付与する。
- 招待コードは8桁・有効期限30日・最大50回。参加の失敗は15分に5回まで。無効なコードは例外ではなく
  `NULL` を返す（失敗の記録をロールバックさせないため）。
- 整理券番号は「施設 × 日本時間の日付（`COALESCE(claimed_at, arrival_time)`）」で一意。
  `issue_ticket` は衝突時に採番をやり直す。
- `submitted_reports` は自分の所属組織名義でしか提出できない。

## 既知の未対応
- 施設の登録 UI（組織の作成 UI は `OrganizationSettings.tsx` にある）、荷主による施設の所有確認。
- `submitted_reports` の数値（待機時間・金額）のサーバー側再計算。料率と30分控除の計算が
  コード・月次ビュー・SQLに分散しないよう、料率表をDBに持たせる設計と合わせて行う。
- マイグレーション履歴の整合（本番は SQL エディタ経由で適用した分が履歴に未記録。
  `supabase db pull` でベースラインを取る）。
