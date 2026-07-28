-- =============================================================================
-- wait_logs.status に 'cancelled' を許可する
--
-- 【問題】
--   cancel_ticket RPC（20260728100000）が status を 'cancelled' に更新しようとすると
--   CHECK制約違反（SQLSTATE 23514, constraint "wait_logs_status_check"）で失敗する。
--   この制約はマイグレーション管理外（Supabaseコンソール側）で作成されており、
--   許可値に 'cancelled' が含まれていなかった。
--
--   結果として、打刻取消がDBに永続化されず、ドライバーは古い打刻を消せないままだった。
--   実測では113日前（4月6日）の打刻が取り消せずに残り続け、これを完了させると
--   待機時間が「113日」として法的記録に保存されてしまう状態だった。
--
-- 【対策】
--   status の許可値をアプリケーションの状態遷移に合わせて明示的に定義し直す。
--   許可値: waiting → called → working → completed（正常系）、cancelled（取消）
--
--   既存行に想定外の status 値が残っている可能性があるため NOT VALID を付与する。
--   NOT VALID は「既存行の再検証をスキップする」だけで、以後の INSERT / UPDATE には
--   制約が通常どおり適用されるため、新規データの整合性は担保される。
-- =============================================================================

ALTER TABLE public.wait_logs
  DROP CONSTRAINT IF EXISTS wait_logs_status_check;

ALTER TABLE public.wait_logs
  ADD CONSTRAINT wait_logs_status_check
  CHECK (status IN ('waiting', 'called', 'working', 'completed', 'cancelled'))
  NOT VALID;

COMMENT ON CONSTRAINT wait_logs_status_check ON public.wait_logs IS
  '待機セッションの状態遷移: waiting → called → working → completed。cancelled は打刻取消（cancel_ticket RPC）で設定され、レコードは削除せず監査証跡として保全される。';
