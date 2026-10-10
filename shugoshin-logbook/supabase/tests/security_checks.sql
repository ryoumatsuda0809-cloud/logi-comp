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
--   日報の再計算（20261007120000 の適用後。適用前に流すと「日報:」の項目は [NG] になる）:
--           端末が送った偽の数値・明細が上書きされる / 提出後は変えられない / 再計算関数は実行不可
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
  -- >>> recompute-checks:begin（20261007120000_recompute_submitted_report_numbers.sql の検査）
  -- 日報の再計算: 端末が送った数値・明細は捨てられ、wait_logs から作り直した値になる／提出後は変えられない／権限
  -- 前提: 上の正規フローで v_log（完了済みの訪問）ができていること。
  DECLARE
    v_ws timestamptz := timestamptz '2000-01-03 10:00:00+09';  -- 過去の日付で行う（実際の提出と衝突しない）
    v_moved boolean := false;
    v_cls text;
    v_forged_cls text;
    v_rate integer;
    v_date date;
    v_row public.submitted_reports%ROWTYPE;
    v_n_visits integer;
    v_n_arrival integer;
    v_other uuid;
    v_tok text;
    v_j jsonb;
    v_cnt integer;
  BEGIN
    RESET ROLE;
    -- 検査用に、この訪問を過去の日付へ動かし、到着から荷役開始まで75分にする（ロールバックされる）
    BEGIN
      UPDATE public.wait_logs
      SET arrival_time = v_ws, work_start_time = v_ws + interval '75 minutes', work_end_time = v_ws + interval '120 minutes'
      WHERE id = v_log;
      v_moved := true;
    EXCEPTION WHEN OTHERS THEN
      v_res := v_res || E'\n[--] wait_logs を検査用に動かせないため、荷待ち75分の算定は省略: ' || SQLERRM;
    END;
    SELECT COALESCE(NULLIF(p.vehicle_class, ''), '4t') INTO v_cls FROM public.profiles p WHERE p.user_id = v_uid;
    v_cls := COALESCE(v_cls, '4t');
    v_rate := CASE v_cls WHEN '2t' THEN 40 WHEN '4t' THEN 50 WHEN '10t' THEN 60 ELSE 50 END;
    v_forged_cls := CASE WHEN v_cls = '10t' THEN '2t' ELSE '10t' END;
    SELECT (arrival_time AT TIME ZONE 'Asia/Tokyo')::date INTO v_date FROM public.wait_logs WHERE id = v_log;
    SELECT count(*) INTO v_n_visits FROM public.wait_logs w
    WHERE w.user_id = v_uid AND w.status IS DISTINCT FROM 'cancelled'
      AND w.arrival_time >= (v_date::timestamp AT TIME ZONE 'Asia/Tokyo')
      AND w.arrival_time <  ((v_date + 1)::timestamp AT TIME ZONE 'Asia/Tokyo');

    -- 偽の数値・偽の明細（他の施設名・等級A・巨大な待機）を持つ提出
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      INSERT INTO public.submitted_reports
        (user_id, organization_id, report_date, vehicle_class, total_wait_minutes, estimated_wait_cost,
         has_discrepancy, timeline_snapshot, is_edited, formal_report)
      VALUES (v_uid, NULL, v_date, v_forged_cls, 9999, 999999, true,
        jsonb_build_array(jsonb_build_object('source', 'gps', 'timestamp', '2000-01-03T01:00:00Z', 'eventType', 'waiting_start',
                                             'locationName', 'FORGED-FACILITY', 'waitMinutes', 9999, 'evidenceGrade', 'A')),
        false, 'security_checks')
      RETURNING * INTO v_row;
      v_res := v_res || CASE WHEN v_row.total_wait_minutes <> 9999 AND v_row.estimated_wait_cost <> 999999
                                  AND v_row.vehicle_class = v_cls AND v_row.has_discrepancy = false
        THEN E'\n[OK] 日報: 端末が送った偽の合計・待機料・車格・差異フラグはサーバーの値で上書きされる'
        ELSE E'\n[NG] 日報: 偽の数値が残った（合計=' || v_row.total_wait_minutes || ' 待機料=' || v_row.estimated_wait_cost || ' 車格=' || v_row.vehicle_class || '）' END;
      IF v_moved THEN
        v_res := v_res || CASE WHEN v_n_visits = 1 AND v_row.total_wait_minutes = 75
                                    AND v_row.estimated_wait_cost = (75 - 30) * v_rate
          THEN E'\n[OK] 日報: wait_logs の荷待ち75分・30分控除・車格の単価で再計算される'
          ELSE E'\n[NG] 日報: 再計算が期待と違う（訪問数=' || v_n_visits || ' 合計=' || v_row.total_wait_minutes || ' 待機料=' || v_row.estimated_wait_cost || ' 期待=' || ((75 - 30) * v_rate) || '）' END;
      END IF;
      SELECT count(*) INTO v_n_arrival FROM jsonb_array_elements(v_row.timeline_snapshot) e WHERE e->>'eventType' = 'arrival';
      v_res := v_res || CASE WHEN v_row.timeline_snapshot::text NOT LIKE '%FORGED-FACILITY%' AND v_n_arrival = v_n_visits
        THEN E'\n[OK] 日報: 端末が送った偽の明細は捨てられ、明細は wait_logs の訪問と一致する'
        ELSE E'\n[NG] 日報: 偽の明細が残った、または訪問数と合わない' END;
    EXCEPTION WHEN unique_violation THEN
      v_res := v_res || E'\n[--] 日報: 同じ日付の提出が既にあるため、再計算の検査は省略';
    WHEN OTHERS THEN
      v_res := v_res || E'\n[NG] 日報の提出が失敗した（トリガーの不具合なら提出が全部止まる）: ' || SQLERRM;
    END;

    IF v_row.id IS NOT NULL THEN
      -- 提出後は変えられない（本人の UPDATE は RESTRICTIVE ポリシーで0行、DB 管理者でもトリガーが拒否）
      UPDATE public.submitted_reports SET total_wait_minutes = 0 WHERE id = v_row.id;
      GET DIAGNOSTICS v_cnt = ROW_COUNT;
      v_res := v_res || CASE WHEN v_cnt = 0 THEN E'\n[OK] 日報: 本人は提出後の数値を書き換えられない'
        ELSE E'\n[NG] 日報: 本人が提出後に UPDATE できた' END;
      RESET ROLE;
      BEGIN
        UPDATE public.submitted_reports SET total_wait_minutes = 0 WHERE id = v_row.id;
        v_res := v_res || E'\n[NG] 日報: 全ロール向けの UPDATE ブロックが効かない';
      EXCEPTION WHEN insufficient_privilege THEN
        v_res := v_res || E'\n[OK] 日報: 管理者接続でも提出後の UPDATE は拒否（法的保護トリガー）';
      END;
      -- 共有リンクは保存された（再計算後の）値を返す
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
      SET LOCAL ROLE authenticated;
      v_tok := public.create_report_share_link(v_row.id, 30);
      RESET ROLE;
      SET LOCAL ROLE anon;
      v_j := public.get_shared_report(v_tok);
      v_res := v_res || CASE WHEN (v_j->>'total_wait_minutes')::integer = v_row.total_wait_minutes
                                  AND (v_j->>'estimated_wait_cost')::integer = v_row.estimated_wait_cost
        THEN E'\n[OK] 日報: 共有リンクは再計算後の値を返す' ELSE E'\n[NG] 日報: 共有リンクの値が保存値と違う' END;
    END IF;
    RESET ROLE;

    -- 他人の打刻は数えられず、偽の明細（gps・等級A）は捨てられる
    SELECT id INTO v_other FROM auth.users WHERE id <> v_uid LIMIT 1;
    IF v_other IS NULL THEN
      v_res := v_res || E'\n[--] 別ユーザーがいないため、他人の打刻を数えない検査は省略';
    ELSE
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true);
      SET LOCAL ROLE authenticated;
      BEGIN
        INSERT INTO public.submitted_reports
          (user_id, organization_id, report_date, total_wait_minutes, estimated_wait_cost, timeline_snapshot)
        VALUES (v_other, NULL, v_date, 5000, 250000,
          jsonb_build_array(jsonb_build_object('source', 'gps', 'timestamp', '2000-01-03T01:00:00Z', 'eventType', 'arrival',
                                               'locationName', 'FORGED-FACILITY', 'evidenceGrade', 'A')))
        RETURNING * INTO v_row;
        v_res := v_res || CASE WHEN v_row.total_wait_minutes = 0 AND v_row.estimated_wait_cost = 0
                                    AND v_row.timeline_snapshot = '[]'::jsonb
          THEN E'\n[OK] 日報: 他人の打刻は数えられず、偽の明細は空になる'
          ELSE E'\n[NG] 日報: 他人の日の値が残った（合計=' || v_row.total_wait_minutes || '）' END;
      EXCEPTION WHEN unique_violation THEN
        v_res := v_res || E'\n[--] 日報: 別ユーザーの同日の提出が既にあるため省略';
      WHEN OTHERS THEN
        v_res := v_res || E'\n[NG] 日報（別ユーザー）の提出が失敗した: ' || SQLERRM;
      END;
      RESET ROLE;
    END IF;

    -- 再計算関数は直接呼べない（誰にも実行権限を与えない）
    v_res := v_res || CASE WHEN NOT has_function_privilege('anon', 'public.recompute_submitted_report_numbers()', 'EXECUTE')
                                AND NOT has_function_privilege('authenticated', 'public.recompute_submitted_report_numbers()', 'EXECUTE')
      THEN E'\n[OK] 日報: 再計算関数は anon・authenticated とも実行不可'
      ELSE E'\n[NG] 日報: 再計算関数に実行権限が付いている' END;
  END;
  -- <<< recompute-checks:end
  RESET ROLE;
  RAISE EXCEPTION 'ROLLBACK_TEST_RESULT:%', v_res;
END $$;
