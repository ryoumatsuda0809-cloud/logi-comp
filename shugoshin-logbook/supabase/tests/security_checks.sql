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


  -- 招待コード: 無効なコードは NULL、5回失敗するとロックされる（所属のないユーザーで確認）
  DECLARE
    v_free uuid;
    v_i integer;
    v_all_null boolean := true;
  BEGIN
    RESET ROLE;  -- 直前の未ログインのテストで anon になっているため、auth.users を読む前に戻す
    SELECT u.id INTO v_free FROM auth.users u
    WHERE NOT EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = u.id)
    LIMIT 1;
    IF v_free IS NULL THEN
      v_res := v_res || E'\n[--] 所属なしのユーザーがいないため、招待コードのテストは省略';
    ELSE
      RESET ROLE;
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_free, 'role', 'authenticated')::text, true);
      SET LOCAL ROLE authenticated;
      FOR v_i IN 1..5 LOOP
        IF public.join_organization_by_invite_code('ZZZZZZZZ') IS NOT NULL THEN v_all_null := false; END IF;
      END LOOP;
      v_res := v_res || CASE WHEN v_all_null THEN E'\n[OK] 無効な招待コードは NULL を返す' ELSE E'\n[NG] 無効なコードで参加できた' END;
      BEGIN
        PERFORM public.join_organization_by_invite_code('ZZZZZZZZ');
        v_res := v_res || E'\n[NG] 5回失敗してもロックされない';
      EXCEPTION WHEN OTHERS THEN v_res := v_res || E'\n[OK] 5回失敗するとロックされる';
      END;
      RESET ROLE;
    END IF;
  END;
  -- 共有リンク: 他人は発行できない／持ち主は発行できる／未ログインは取得でき内部IDを返さない／失効後は取得できない
  DECLARE
    v_rep record;
    v_other uuid;
    v_tok text;
    v_j jsonb;
  BEGIN
    RESET ROLE;
    SELECT * INTO v_rep FROM public.submitted_reports ORDER BY submitted_at DESC LIMIT 1;
    SELECT id INTO v_other FROM auth.users WHERE id <> v_rep.user_id LIMIT 1;
    IF v_rep.id IS NULL OR v_other IS NULL THEN
      v_res := v_res || E'\n[--] 提出済み日報または別ユーザーがいないため、共有リンクのテストは省略';
    ELSE
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true);
      SET LOCAL ROLE authenticated;
      BEGIN
        PERFORM public.create_report_share_link(v_rep.id, 30);
        v_res := v_res || E'\n[NG] 他人の日報の共有リンクを発行できた';
      EXCEPTION WHEN no_data_found THEN v_res := v_res || E'\n[OK] 他人の日報の共有リンクは発行拒否';
      END;
      RESET ROLE;
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rep.user_id, 'role', 'authenticated')::text, true);
      SET LOCAL ROLE authenticated;
      v_tok := public.create_report_share_link(v_rep.id, 30);
      RESET ROLE;
      SET LOCAL ROLE anon;
      v_j := public.get_shared_report(v_tok);
      v_res := v_res || CASE WHEN v_j IS NOT NULL AND NOT (v_j ? 'user_id') AND NOT (v_j ? 'organization_id')
        THEN E'\n[OK] 未ログインで共有リンクを開け、内部IDは含まれない' ELSE E'\n[NG] 共有リンクの取得または項目' END;
      RESET ROLE;
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_rep.user_id, 'role', 'authenticated')::text, true);
      SET LOCAL ROLE authenticated;
      PERFORM public.revoke_report_share_links(v_rep.id);
      RESET ROLE;
      SET LOCAL ROLE anon;
      v_res := v_res || CASE WHEN public.get_shared_report(v_tok) IS NULL
        THEN E'\n[OK] 失効後の共有リンクは取得できない' ELSE E'\n[NG] 失効が効かない' END;
      RESET ROLE;
    END IF;
  END;
  RESET ROLE;
  RAISE EXCEPTION 'ROLLBACK_TEST_RESULT:%', v_res;
END $$;
