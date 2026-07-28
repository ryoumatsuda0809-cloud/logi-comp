-- =============================================================================
-- cancel_ticket: 到着打刻の取り消し（DBステータスを 'cancelled' に確定する）
--
-- 【問題】
--   フロントの「打刻を取り消す」ボタンは clearResult() で React state を
--   クリアするだけで、DB の wait_logs.status は 'waiting' のまま残っていた。
--   そのため次回アプリ起動時の状態復元で同じ待機ログが再び読み込まれ、
--   ドライバーには古い打刻を消す手段が事実上存在しなかった。
--
--   さらに UI は到着時刻を「時:分」のみで表示していたため、数日〜数ヶ月前の
--   打刻でも当日のものと区別がつかず、そのまま「作業完了」を押すと
--   待機時間が異常な値（実測で 157078.2 分 = 109日）で法的記録として
--   保存されてしまう状態だった。取適法上の待機料請求根拠として明らかに誤りであり、
--   荷主へ提示した場合に証拠全体の信頼性を損なう。
--
-- 【設計方針】
--   - 証拠隠滅を防ぐため、レコードの物理削除は一切行わない。
--     status を 'cancelled' に更新するのみとし、wait_logs 行と
--     （存在すれば）arrival の waiting_evidence 行はそのまま保全する。
--     これにより「取り消された打刻がいつ・どこで発生したか」の監査証跡が残る。
--   - 既に completed / cancelled のログは再取り消しできない。
--   - 署名済み（is_signed = true）のエビデンスを持つログは、完了処理が
--     確定しているため取り消しを禁止する。
-- =============================================================================

CREATE OR REPLACE FUNCTION public.cancel_ticket(
  p_log_id UUID
)
RETURNS TABLE (
  log_id       UUID,
  cancelled_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_current_status TEXT;
  v_signed_count   INTEGER;
BEGIN
  -- ① 対象レコードを SELECT FOR UPDATE（同時更新防止・本人確認）
  SELECT wl.status
  INTO v_current_status
  FROM public.wait_logs wl
  WHERE wl.id = p_log_id
    AND wl.user_id = auth.uid()
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION '待機ログが見つからないか、操作権限がありません。 (log_id: %)', p_log_id
      USING ERRCODE = 'no_data_found';
  END IF;

  -- ② ステータス検証（既に completed / cancelled の場合は拒否）
  IF v_current_status NOT IN ('waiting', 'called', 'working') THEN
    RAISE EXCEPTION '打刻取消エラー: ステータス "%" の待機ログは取り消せません。 (log_id: %)',
      v_current_status, p_log_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- ③ [法的保護] 署名済みエビデンスを持つログは取り消し不可
  SELECT COUNT(*)
  INTO v_signed_count
  FROM public.waiting_evidence we
  WHERE we.wait_log_id = p_log_id
    AND we.is_signed = true;

  IF v_signed_count > 0 THEN
    RAISE EXCEPTION '[法的保護] 署名済みエビデンスが存在するため、この打刻は取り消せません。 (log_id: %)', p_log_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- ④ status を 'cancelled' に更新（物理削除はしない＝監査証跡を保全）
  UPDATE public.wait_logs
  SET status = 'cancelled'
  WHERE id = p_log_id
    AND user_id = auth.uid();

  RETURN QUERY
  SELECT
    p_log_id           AS log_id,
    CURRENT_TIMESTAMP  AS cancelled_at;
END;
$$;

COMMENT ON FUNCTION public.cancel_ticket(UUID) IS
  '取適法: 到着打刻を取り消し、wait_logs.status を cancelled に確定する。証拠隠滅防止のためレコードの物理削除は行わず、署名済みエビデンスを持つログは取り消しを拒否する。';
