-- =============================================================================
-- 書き込み経路・権限の回帰テスト
--
-- 使い方: Supabase の SQL Editor（または psql）にそのまま貼って実行する。
--   結果は例外メッセージとして返り、**必ずロールバックされる**（データは残らない）。
--   `[OK]` 以外（[NG] / [??]）が1つでもあれば、権限設計が崩れている。
--
-- 確認すること:
--   正常系: 到着 → 荷役開始 → 完了（正規の RPC フロー）が通る
--   拒否系: 直接 INSERT での記録偽装 / 証拠の直接 INSERT / 状態の巻き戻し /
--           権限のない荷主操作 / 未ログインでの RPC 実行
--
-- 前提: public.facilities に1件以上あり、public.profiles に1件以上ユーザーがいること。
-- =============================================================================
DO $$
DECLARE
  v_uid uuid;
  v_fac record;
  v_log uuid;
  v_res text := '';
BEGIN
  SELECT user_id INTO v_uid FROM public.profiles ORDER BY created_at LIMIT 1;
  SELECT id, lat, lng INTO v_fac FROM public.facilities ORDER BY created_at LIMIT 1;
  IF v_uid IS NULL OR v_fac.id IS NULL THEN
    RAISE EXCEPTION 'テストの前提が足りません（profiles / facilities が空です）';
  END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  -- 正常系
  BEGIN
    SELECT t.log_id INTO v_log FROM public.issue_ticket(v_fac.id, v_fac.lat, v_fac.lng) t;
    v_res := v_res || E'\n[OK] issue_ticket';
    PERFORM public.start_loading(v_log, v_fac.lat, v_fac.lng);
    v_res := v_res || E'\n[OK] start_loading';
    PERFORM public.complete_ticket(v_log, v_fac.lat, v_fac.lng, NULL);
    v_res := v_res || E'\n[OK] complete_ticket';
  EXCEPTION WHEN OTHERS THEN v_res := v_res || E'\n[NG] 正規フロー: ' || SQLERRM;
  END;

  -- 偽装: 完了済みの記録を直接 INSERT
  BEGIN
    INSERT INTO public.wait_logs (facility_id, user_id, ticket_number, status, arrival_time, latitude, longitude)
    VALUES (v_fac.id, v_uid, 999, 'completed', now(), v_fac.lat, v_fac.lng);
    v_res := v_res || E'\n[NG] wait_logs の直接INSERTが通った';
  EXCEPTION WHEN insufficient_privilege THEN v_res := v_res || E'\n[OK] wait_logs の直接INSERTは拒否';
  WHEN OTHERS THEN v_res := v_res || E'\n[??] wait_logs INSERT: ' || SQLERRM;
  END;

  -- 偽装: 証拠の直接 INSERT
  BEGIN
    INSERT INTO public.waiting_evidence (user_id, wait_log_id, evidence_type, latitude, longitude)
    VALUES (v_uid, v_log, 'arrival', v_fac.lat, v_fac.lng);
    v_res := v_res || E'\n[NG] waiting_evidence の直接INSERTが通った';
  EXCEPTION WHEN insufficient_privilege THEN v_res := v_res || E'\n[OK] waiting_evidence の直接INSERTは拒否';
  WHEN OTHERS THEN v_res := v_res || E'\n[??] waiting_evidence INSERT: ' || SQLERRM;
  END;

  -- 偽装: 状態の巻き戻し
  BEGIN
    PERFORM public.advance_wait_status(v_log, 'waiting');
    v_res := v_res || E'\n[NG] advance_wait_status が通った';
  EXCEPTION WHEN insufficient_privilege THEN v_res := v_res || E'\n[OK] advance_wait_status は拒否';
  WHEN OTHERS THEN v_res := v_res || E'\n[??] advance_wait_status: ' || SQLERRM;
  END;

  -- 荷主用 RPC: 権限のない人は拒否される
  BEGIN
    PERFORM public.shipper_advance_wait(v_log, 'called');
    v_res := v_res || E'\n[NG] 権限のない荷主操作が通った';
  EXCEPTION WHEN OTHERS THEN v_res := v_res || E'\n[OK] 権限のない荷主操作は拒否';
  END;

  -- 未ログイン
  RESET ROLE;
  SET LOCAL ROLE anon;
  BEGIN
    PERFORM public.issue_ticket(v_fac.id, v_fac.lat, v_fac.lng);
    v_res := v_res || E'\n[NG] 未ログインで issue_ticket を実行できた';
  EXCEPTION WHEN insufficient_privilege THEN v_res := v_res || E'\n[OK] 未ログインの RPC は拒否';
  WHEN OTHERS THEN v_res := v_res || E'\n[??] 未ログイン: ' || SQLERRM;
  END;

  RESET ROLE;
  RAISE EXCEPTION 'ROLLBACK_TEST_RESULT:%', v_res;
END $$;
