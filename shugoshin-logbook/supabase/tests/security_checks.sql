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
           AND (v_j ? 'unverified_facility_names')
        THEN E'\n[OK] 未ログインで共有リンクを開け、内部IDは含まれず、未確認の施設の欄がある' ELSE E'\n[NG] 共有リンクの取得または項目' END;
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
  -- 施設の登録（20261013100000_register_unverified_facilities.sql / 20261013100001）:
  --   一般メンバー・未ログインは登録できない／自組織の管理者は未確認として登録できる（半径500m固定）／
  --   不正な座標・長すぎる名前・重複・確認済み施設の30m以内・21件目は拒否／
  --   クライアントから verification_status を書き換えられない・can_use_facility を呼べない／
  --   未確認の施設は他組織に見えず、get_nearest_facility・issue_ticket・queue_offline_punch・
  --   wait_logs の INSERT トリガーで使えない／verify_company_name は確認済みの施設だけ返す／
  --   共有帳票に未確認の施設名が載る／運営者が確認済みにすれば他組織にも見える。
  -- 前提: それぞれ admin が1人以上いる組織が2つ以上あること（無ければ省略）。
  --   一般メンバーは不要。「一般メンバーは登録できない」は、組織Bの管理者を一時的に
  --   driver に降格して検査する（トランザクション内なのでロールバックされる）。
  DECLARE
    v_orgA uuid; v_adminA uuid; v_orgB uuid; v_adminB uuid;
    v_new uuid; v_n integer; v_i integer; v_txt text;
    v_row record; v_name text; v_vf record; v_vlat double precision;
    v_rep_id uuid; v_tok text; v_j jsonb;
    v_test_lat constant double precision := 0.5;     -- 外洋上（既存の施設から十分に離れた座標）
    v_test_lng constant double precision := -170.0;
    v_client constant text := 'ZZ検査用荷主ZZ';
  BEGIN
    RESET ROLE;
    SELECT ur.user_id, ur.organization_id INTO v_adminA, v_orgA
    FROM public.user_roles ur
    JOIN public.profiles p ON p.user_id = ur.user_id AND p.organization_id = ur.organization_id
    WHERE ur.role = 'admin'
      AND EXISTS (SELECT 1 FROM public.user_roles b JOIN public.profiles pb
                    ON pb.user_id = b.user_id AND pb.organization_id = b.organization_id
                  WHERE b.role = 'admin' AND b.organization_id <> ur.organization_id)
    LIMIT 1;
    SELECT b.user_id, b.organization_id INTO v_adminB, v_orgB
    FROM public.user_roles b JOIN public.profiles pb ON pb.user_id = b.user_id AND pb.organization_id = b.organization_id
    WHERE b.role = 'admin' AND b.organization_id <> v_orgA LIMIT 1;
    SELECT f.id, f.lat, f.lng INTO v_vf FROM public.facilities f WHERE f.verification_status = 'verified' LIMIT 1;

    IF v_adminA IS NULL OR v_adminB IS NULL OR v_vf.id IS NULL THEN
      v_res := v_res || E'\n[--] 管理者のいる組織が2つ（と確認済みの施設）そろわないため、施設登録のテストは省略';
    ELSE
      -- 一般メンバーは登録できない: 組織Bの管理者を一時的に driver に降格して検査する
      BEGIN
        UPDATE public.user_roles SET role = 'driver'
          WHERE user_id = v_adminB AND organization_id = v_orgB AND role = 'admin';
        PERFORM set_config('request.jwt.claims', json_build_object('sub', v_adminB, 'role', 'authenticated')::text, true);
        SET LOCAL ROLE authenticated;
        BEGIN
          PERFORM public.register_facility('検査用施設', v_client, v_test_lat, v_test_lng);
          v_res := v_res || E'\n[NG] 一般メンバー（降格した管理者）が施設を登録できた';
        EXCEPTION WHEN insufficient_privilege THEN v_res := v_res || E'\n[OK] 一般メンバーの施設登録は拒否';
        WHEN OTHERS THEN v_res := v_res || E'\n[??] 一般メンバーの施設登録: ' || SQLERRM;
        END;
      EXCEPTION WHEN OTHERS THEN v_res := v_res || E'\n[??] 管理者の降格に失敗（一般メンバーのテスト）: ' || SQLERRM;
      END;
      RESET ROLE;
      UPDATE public.user_roles SET role = 'admin'
        WHERE user_id = v_adminB AND organization_id = v_orgB AND role = 'driver';

      -- 未ログインは登録できない
      SET LOCAL ROLE anon;
      BEGIN
        PERFORM public.register_facility('検査用施設', v_client, v_test_lat, v_test_lng);
        v_res := v_res || E'\n[NG] 未ログインで施設を登録できた';
      EXCEPTION WHEN insufficient_privilege THEN v_res := v_res || E'\n[OK] 未ログインの施設登録は拒否';
      WHEN OTHERS THEN v_res := v_res || E'\n[??] 未ログインの施設登録: ' || SQLERRM;
      END;

      -- 内部用の can_use_facility は、ログイン済みでも直接呼べない（42501）
      RESET ROLE;
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_adminA, 'role', 'authenticated')::text, true);
      SET LOCAL ROLE authenticated;
      BEGIN
        PERFORM public.can_use_facility(v_adminA, v_vf.id);
        v_res := v_res || E'\n[NG] authenticated が can_use_facility を直接呼べた';
      EXCEPTION WHEN insufficient_privilege THEN v_res := v_res || E'\n[OK] can_use_facility は直接呼べない';
      WHEN OTHERS THEN v_res := v_res || E'\n[??] can_use_facility: ' || SQLERRM;
      END;

      -- 自組織の管理者は、未確認として登録できる
      BEGIN
        v_new := public.register_facility('検査用施設', v_client, v_test_lat, v_test_lng, '検査用住所');
        v_res := v_res || E'\n[OK] 自組織の管理者は施設を登録できる';
      EXCEPTION WHEN OTHERS THEN v_res := v_res || E'\n[NG] 管理者の施設登録: ' || SQLERRM;
      END;

      IF v_new IS NOT NULL THEN
        RESET ROLE;
        SELECT * INTO v_row FROM public.facilities WHERE id = v_new;
        v_res := v_res || CASE
          WHEN v_row.verification_status = 'unverified' AND v_row.radius = 500
               AND v_row.registered_by_organization_id = v_orgA AND v_row.registered_by = v_adminA
               AND v_row.client_organization_id IS NULL AND v_row.notification_number IS NULL
          THEN E'\n[OK] 登録した施設は未確認・半径500m・登録組織つき・荷主組織と届出番号は未設定'
          ELSE E'\n[NG] 登録した施設の状態が想定と違う' END;

        -- 不正な入力は拒否（管理者Aとして）
        PERFORM set_config('request.jwt.claims', json_build_object('sub', v_adminA, 'role', 'authenticated')::text, true);
        SET LOCAL ROLE authenticated;
        BEGIN
          PERFORM public.register_facility('検査用施設', v_client, v_test_lat + 0.0001, v_test_lng);
          v_res := v_res || E'\n[NG] 同名・50m以内の重複登録が通った';
        EXCEPTION WHEN unique_violation THEN v_res := v_res || E'\n[OK] 同名・50m以内の重複登録は拒否';
        WHEN OTHERS THEN v_res := v_res || E'\n[??] 重複登録: ' || SQLERRM;
        END;
        -- 確認済みの施設の30m以内（約11m）は、他組織が登録していても拒否。施設名は出さない
        v_vlat := CASE WHEN v_vf.lat + 0.0001 <= 90 THEN v_vf.lat + 0.0001 ELSE v_vf.lat - 0.0001 END;
        BEGIN
          PERFORM public.register_facility('近接検査', v_client, v_vlat, v_vf.lng);
          v_res := v_res || E'\n[NG] 確認済みの施設の30m以内への登録が通った';
        EXCEPTION WHEN check_violation THEN
          v_res := v_res || CASE WHEN SQLERRM LIKE '既に登録されている施設の近くです%'
            THEN E'\n[OK] 確認済みの施設の30m以内への登録は拒否' ELSE E'\n[??] 近接拒否のメッセージ: ' || SQLERRM END;
        WHEN OTHERS THEN v_res := v_res || E'\n[??] 近接検査: ' || SQLERRM;
        END;
        BEGIN
          PERFORM public.register_facility('検査用施設', v_client, 91, v_test_lng);
          v_res := v_res || E'\n[NG] 緯度91の登録が通った';
        EXCEPTION WHEN check_violation THEN v_res := v_res || E'\n[OK] 範囲外の緯度は拒否';
        WHEN OTHERS THEN v_res := v_res || E'\n[??] 緯度91: ' || SQLERRM;
        END;
        BEGIN
          PERFORM public.register_facility('検査用施設B', v_client, v_test_lat, -181);
          v_res := v_res || E'\n[NG] 経度-181の登録が通った';
        EXCEPTION WHEN check_violation THEN v_res := v_res || E'\n[OK] 範囲外の経度は拒否';
        WHEN OTHERS THEN v_res := v_res || E'\n[??] 経度-181: ' || SQLERRM;
        END;
        BEGIN
          PERFORM public.register_facility('検査用施設B', v_client, 'NaN'::double precision, v_test_lng);
          v_res := v_res || E'\n[NG] NaN の座標の登録が通った';
        EXCEPTION WHEN check_violation THEN v_res := v_res || E'\n[OK] NaN の座標は拒否';
        WHEN OTHERS THEN v_res := v_res || E'\n[??] NaN: ' || SQLERRM;
        END;
        BEGIN
          PERFORM public.register_facility(repeat('あ', 101), v_client, v_test_lat + 1, v_test_lng);
          v_res := v_res || E'\n[NG] 101文字の施設名の登録が通った';
        EXCEPTION WHEN check_violation THEN v_res := v_res || E'\n[OK] 長すぎる施設名は拒否';
        WHEN OTHERS THEN v_res := v_res || E'\n[??] 長い名前: ' || SQLERRM;
        END;

        -- クライアントから、確認状態・登録組織を書き換えられない／直接 INSERT・DELETE もできない
        BEGIN
          UPDATE public.facilities SET verification_status = 'verified' WHERE id = v_new;
          v_res := v_res || E'\n[NG] クライアントが verification_status を更新できた';
        EXCEPTION WHEN insufficient_privilege THEN v_res := v_res || E'\n[OK] verification_status のクライアント更新は拒否';
        WHEN OTHERS THEN v_res := v_res || E'\n[??] verification_status 更新: ' || SQLERRM;
        END;
        BEGIN
          UPDATE public.facilities SET registered_by_organization_id = NULL WHERE id = v_new;
          v_res := v_res || E'\n[NG] クライアントが registered_by_organization_id を更新できた';
        EXCEPTION WHEN insufficient_privilege THEN v_res := v_res || E'\n[OK] registered_by_organization_id のクライアント更新は拒否';
        WHEN OTHERS THEN v_res := v_res || E'\n[??] registered_by_organization_id 更新: ' || SQLERRM;
        END;
        BEGIN
          INSERT INTO public.facilities (name, client_name, lat, lng, verification_status)
          VALUES ('直接INSERT', v_client, v_test_lat, v_test_lng, 'verified');
          v_res := v_res || E'\n[NG] facilities の直接INSERTが通った';
        EXCEPTION WHEN insufficient_privilege THEN v_res := v_res || E'\n[OK] facilities の直接INSERTは拒否';
        WHEN OTHERS THEN v_res := v_res || E'\n[??] facilities INSERT: ' || SQLERRM;
        END;
        BEGIN
          DELETE FROM public.facilities WHERE id = v_new;
          v_res := v_res || E'\n[NG] facilities の直接DELETEが通った';
        EXCEPTION WHEN insufficient_privilege THEN v_res := v_res || E'\n[OK] facilities の直接DELETEは拒否';
        WHEN OTHERS THEN v_res := v_res || E'\n[??] facilities DELETE: ' || SQLERRM;
        END;

        -- 可視性: 登録組織（管理者A）には見えて使え、他組織（管理者B）には見えず使えない
        SELECT count(*) INTO v_n FROM public.facilities WHERE id = v_new;
        v_res := v_res || CASE WHEN v_n = 1 THEN E'\n[OK] 未確認の施設は登録組織のメンバーに見える'
                               ELSE E'\n[NG] 未確認の施設が登録組織のメンバーに見えない' END;
        SELECT count(*) INTO v_n FROM public.get_nearest_facility(v_test_lat, v_test_lng) g WHERE g.id = v_new;
        v_res := v_res || CASE WHEN v_n = 1 THEN E'\n[OK] get_nearest_facility は登録組織のメンバーに未確認の施設を返す'
                               ELSE E'\n[NG] get_nearest_facility が登録組織のメンバーに未確認の施設を返さない' END;
        SELECT count(*) INTO v_n FROM public.verify_company_name(v_client);
        v_res := v_res || CASE WHEN v_n = 0 THEN E'\n[OK] verify_company_name は自組織の未確認施設も候補に出さない'
                               ELSE E'\n[NG] verify_company_name が未確認の施設を返した（登録組織）' END;
        v_name := NULL;
        SELECT q.facility_name INTO v_name
        FROM public.queue_offline_punch(now(), v_test_lat, v_test_lng, gen_random_uuid(), 'arrival') q;
        v_res := v_res || CASE WHEN v_name = '検査用施設'
                               THEN E'\n[OK] queue_offline_punch は登録組織のメンバーに未確認の施設を最寄りとして返す'
                               ELSE E'\n[NG] queue_offline_punch が登録組織のメンバーに未確認の施設を返さない' END;
        BEGIN
          PERFORM public.issue_ticket(v_new, v_test_lat, v_test_lng);
          v_res := v_res || E'\n[OK] 登録組織のメンバーは未確認の施設で打刻できる';
        EXCEPTION WHEN OTHERS THEN v_res := v_res || E'\n[NG] 登録組織のメンバーが未確認の施設で打刻できない: ' || SQLERRM;
        END;

        -- 共有帳票: 未確認の施設で打刻した日の日報に、施設名が入る（キーの有無ではなく中身を見る）
        RESET ROLE;
        BEGIN
          INSERT INTO public.submitted_reports (user_id, organization_id, report_date)
          VALUES (v_adminA, v_orgA, (now() AT TIME ZONE 'Asia/Tokyo')::date)
          RETURNING id INTO v_rep_id;
          PERFORM set_config('request.jwt.claims', json_build_object('sub', v_adminA, 'role', 'authenticated')::text, true);
          SET LOCAL ROLE authenticated;
          v_tok := public.create_report_share_link(v_rep_id, 30);
          RESET ROLE;
          SET LOCAL ROLE anon;
          v_j := public.get_shared_report(v_tok);
          RESET ROLE;
          v_res := v_res || CASE
            WHEN v_j IS NOT NULL AND (v_j -> 'unverified_facility_names') ? '検査用施設'
            THEN E'\n[OK] 共有帳票の unverified_facility_names に未確認の施設名が入る'
            ELSE E'\n[NG] 共有帳票に未確認の施設名が入らない: ' || COALESCE((v_j -> 'unverified_facility_names')::text, 'NULL') END;
        EXCEPTION WHEN OTHERS THEN v_res := v_res || E'\n[??] 共有帳票の未確認施設の検査: ' || SQLERRM;
        END;
        RESET ROLE;

        PERFORM set_config('request.jwt.claims', json_build_object('sub', v_adminB, 'role', 'authenticated')::text, true);
        SET LOCAL ROLE authenticated;
        SELECT count(*) INTO v_n FROM public.facilities WHERE id = v_new;
        v_res := v_res || CASE WHEN v_n = 0 THEN E'\n[OK] 未確認の施設は他組織に見えない'
                               ELSE E'\n[NG] 未確認の施設が他組織に見える' END;
        SELECT count(*) INTO v_n FROM public.get_nearest_facility(v_test_lat, v_test_lng) g WHERE g.id = v_new;
        v_res := v_res || CASE WHEN v_n = 0 THEN E'\n[OK] get_nearest_facility は他組織に未確認の施設を返さない'
                               ELSE E'\n[NG] get_nearest_facility が他組織に未確認の施設を返した' END;
        SELECT count(*) INTO v_n FROM public.verify_company_name(v_client);
        v_res := v_res || CASE WHEN v_n = 0 THEN E'\n[OK] verify_company_name は他組織に未確認の施設を返さない'
                               ELSE E'\n[NG] verify_company_name が他組織に未確認の施設を返した' END;
        BEGIN
          PERFORM public.issue_ticket(v_new, v_test_lat, v_test_lng);
          v_res := v_res || E'\n[NG] 他組織が未確認の施設で打刻できた';
        EXCEPTION WHEN insufficient_privilege THEN v_res := v_res || E'\n[OK] 他組織の未確認の施設での打刻は拒否';
        WHEN OTHERS THEN v_res := v_res || E'\n[??] 他組織の打刻: ' || SQLERRM;
        END;
        v_name := NULL;
        SELECT q.facility_name INTO v_name
        FROM public.queue_offline_punch(now(), v_test_lat, v_test_lng, gen_random_uuid(), 'arrival') q;
        v_res := v_res || CASE WHEN v_name IS DISTINCT FROM '検査用施設'
                               THEN E'\n[OK] queue_offline_punch は他組織の未確認の施設を最寄りに選ばない'
                               ELSE E'\n[NG] queue_offline_punch が他組織の未確認の施設を選んだ' END;
        -- 他組織のユーザーの記録は、wait_logs の INSERT トリガーが未確認施設への記録を止める（最後の砦）
        RESET ROLE;
        BEGIN
          INSERT INTO public.wait_logs (facility_id, user_id, ticket_number, status, arrival_time, latitude, longitude)
          VALUES (v_new, v_adminB, 998, 'waiting', now(), v_test_lat, v_test_lng);
          v_res := v_res || E'\n[NG] 他組織のユーザーの wait_logs が未確認の施設に入った（トリガーが効いていない）';
        EXCEPTION WHEN check_violation THEN v_res := v_res || E'\n[OK] wait_logs の INSERT トリガーは他組織の未確認施設への記録を拒否';
        WHEN OTHERS THEN v_res := v_res || E'\n[??] wait_logs トリガー: ' || SQLERRM;
        END;

        -- 運営者が確認済みにすれば、他組織にも見えて、組織名の候補にも出る（RPC は無く、SQL だけ）
        UPDATE public.facilities SET verification_status = 'verified' WHERE id = v_new;
        PERFORM set_config('request.jwt.claims', json_build_object('sub', v_adminB, 'role', 'authenticated')::text, true);
        SET LOCAL ROLE authenticated;
        SELECT count(*) INTO v_n FROM public.facilities WHERE id = v_new;
        v_res := v_res || CASE WHEN v_n = 1 THEN E'\n[OK] 確認済みにした施設は他組織にも見える'
                               ELSE E'\n[NG] 確認済みにしても他組織に見えない' END;
        SELECT count(*) INTO v_n FROM public.verify_company_name(v_client);
        v_res := v_res || CASE WHEN v_n = 1 THEN E'\n[OK] 確認済みにした施設は verify_company_name の候補に出る'
                               ELSE E'\n[NG] 確認済みにしても verify_company_name の候補に出ない' END;
        RESET ROLE;
        SET LOCAL ROLE anon;
        v_j := public.get_shared_report(v_tok);
        RESET ROLE;
        v_res := v_res || CASE
          WHEN v_j IS NOT NULL AND jsonb_array_length(v_j -> 'unverified_facility_names') = 0
          THEN E'\n[OK] 確認済みにすると共有帳票の未確認の注記は消える'
          ELSE E'\n[NG] 確認済みにしても共有帳票に未確認の施設名が残る' END;
        UPDATE public.facilities SET verification_status = 'unverified' WHERE id = v_new;
      END IF;

      -- 未確認は組織ごとに最大20件（20件に達すると次の登録が拒否される。25回試して、件数が20で止まること）
      RESET ROLE;
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_adminA, 'role', 'authenticated')::text, true);
      SET LOCAL ROLE authenticated;
      FOR v_i IN 1..25 LOOP
        BEGIN
          PERFORM public.register_facility('上限検査' || v_i, v_client, v_test_lat + 10 + v_i * 0.01, v_test_lng);
        EXCEPTION WHEN check_violation THEN EXIT;
        WHEN OTHERS THEN v_res := v_res || E'\n[??] 上限検査: ' || SQLERRM; EXIT;
        END;
      END LOOP;
      RESET ROLE;
      SELECT count(*) INTO v_n FROM public.facilities
        WHERE registered_by_organization_id = v_orgA AND verification_status = 'unverified';
      v_res := v_res || CASE WHEN v_n = 20 THEN E'\n[OK] 未確認の施設は組織ごとに最大20件で止まる'
                             ELSE E'\n[NG] 未確認の施設の上限が効かない（件数: ' || v_n || E'）' END;
    END IF;
  END;
  -- 省略した項目があれば、結果の先頭に目立つ形で出す（省略は「検査していない」であり、合格ではない）
  DECLARE
    v_skipped integer := (length(v_res) - length(replace(v_res, '[--]', ''))) / 4;
  BEGIN
    IF v_skipped > 0 THEN
      v_res := E'\n⚠⚠⚠ 省略 ' || v_skipped || E' 件: 本番では何も検証されていません ⚠⚠⚠' || v_res;
    END IF;
  END;
  RESET ROLE;
  RAISE EXCEPTION 'ROLLBACK_TEST_RESULT:%', v_res;
END $$;
