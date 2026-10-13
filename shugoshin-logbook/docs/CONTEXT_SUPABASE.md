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
| `facilities` | 確認済みの施設は全員／**未確認の施設は、登録した組織のメンバーだけ** | `register_facility`（自組織の admin のみ。登録すると「未確認」）。確認済みにするのは運営者の SQL のみ |

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

## 施設の登録（未確認施設）
- 運送会社の管理者が、現在地で施設を登録できる（`register_facility`）。登録した施設は `verification_status='unverified'` で、
  登録した組織のメンバーだけが見えて、打刻に使える（`can_use_facility`。`get_nearest_facility` / `issue_ticket` /
  `queue_offline_punch` / `wait_logs` の INSERT トリガーが検査する）。
- 誰でも好きな座標に施設を作れると GPS の証拠の意味がなくなるため、次の制限がある: 半径は 500m 固定／組織ごとに未確認は最大20件／
  確認済みの施設から30m以内には登録できない（既存施設の脇に偽の施設を置いて打刻を横取りさせない）／届出番号は登録時に入力させない。
- **サーバーは「現在地で登録した」ことを検証できない**（座標は端末の申告）。だから「未確認」で、荷主向けの帳票には「施設の位置は未確認」と明記する
  （共有帳票・月次の警告レポート）。
- 「確認済み」にする手順（運営者の SQL）は `20261013100000_register_unverified_facilities.sql` の冒頭に書いてある。
  荷主組織に紐付けるなら `client_organization_id` も同時に設定する（未確認のままでは荷主 admin に見えない）。

## 日報の数値（サーバー計算）
- 日報は `submit_daily_report`（RPC）だけで提出する。`submitted_reports` への直接 INSERT は不可。
- 待機時間・待機料・組織・車格・提出時刻は**サーバーが `wait_logs` から決める**（引数にしない）。クライアントが渡せるのは、報告書の文面・表示用の
  タイムライン・手修正した待機分数（GPS の記録とは別に残る）だけ。適用した料率や待機ごとの内訳は `server_calculation` に残る。
- 料率は `wait_rates` が唯一のサーバー側の表（既定行は削除不可）。画面の見積もり用に `src/lib/waitCostCalc.ts` にも同じ値があり、
  変更時は両方を直す（テストが一致を検査する）。月次ビューも `wait_rates` を引く。
- 日報に含める日は `wait_logs.arrival_time` の日本時間の日付。**圏外承認（等級C）の記録は承認した日の日報に入る**（申告した日の日報は提出済みで
  変更できないため、記録が消えないようにしている）。分数は申告時刻から計算する。
- 提出できるのはサーバー時計の「今日」だけで、今日の打刻が0件なら提出できない。音声の申告は日報の合計に入らない（自己申告は証拠ではない）。
- 回帰テスト: `supabase/tests/server_side_report_totals.sql`（計算・RPC・権限・ビューの突き合わせ。期待値の表を TypeScript 側のテストも読む）。

## 既知の未対応
- 荷主による施設の所有確認（施設の登録 UI は対応済み。運営者向けの確認 UI は無く、SQL で行う）。
- 帳票の行ごとの分数・金額（`timeline_snapshot`）と文面（`formal_report`）は、まだクライアントが組み立てた表示用の値。権威ある値は
  `server_calculation.visits` にあり、帳票へ出すのは未対応（合計だけがサーバー値）。
- 夜勤で日付をまたぐ運転者が前日分を翌日に提出する経路。
- 未確認の施設を登録した組織を削除して作り直すと、未確認の上限（20件）を回避できる（運営者の確認待ちが増えるだけ）。
- マイグレーション履歴の整合（本番は SQL エディタ経由で適用した分が履歴に未記録。`supabase db pull` でベースラインを取る）。
