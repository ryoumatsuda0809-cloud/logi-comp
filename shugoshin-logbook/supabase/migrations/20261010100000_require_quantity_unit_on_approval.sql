-- =============================================================================
-- 数量が「数字＋単位」でない発注を、DB でも承認させない
--
-- 承認した発注は 4条書面として確定し、後から変更も削除もできない
-- （20260806170000_freeze_approved_orders）。2026-10-10 に、数量が「12」（単位なし）
-- の発注が本番で承認され、書面にそのまま「12」と出た。画面側では #36 から
-- 承認前に止めている（src/lib/orderContent.ts の checkQuantity）が、画面のチェックは
-- 古い画面（開きっぱなしのタブ、service worker に残った旧版）や、画面を通らない
-- 入力に対しては働かない。端末を信用しない原則に合わせて、DB でも同じ規則で止める。
--
-- 規則は checkQuantity と同じ（直さない。読めなければ拒否する）:
--   ・全角を半角にそろえる（NFKC）。先頭の「約」「およそ」と丸括弧は無視する
--   ・「数字＋単位」が1つ以上あり、そのほかは区切り（空白 , 、 ・ / + × *）だけ
--   ・数字は 0 より大きい
--   ・単位は kg キロ g t トン 箱 ケース パレット 匹 尾 枚 個 本 袋 缶（英字は大文字小文字を区別しない）
-- 単位の一覧を変えるときは、src/lib/orderContent.ts の QUANTITY_UNITS と、この関数の
-- 2か所（INSERT で承認／下書きから承認）をそろえる。
--
-- 検査するのは「approved にする時」だけ。下書きは途中の入力を許す。承認済みの行は
-- 内容を変えられないので、すでにある行（単位なしの「12」など）は変わらない。
--
-- guard_transport_orders の中身は 20261004100000 と同じで、
-- 「数量の形の確認」だけを足している。このトリガー関数は呼び出したユーザーの
-- 権限で動くので、確認は別関数に切り出さず中に書く（EXECUTE 権限を増やさない）。
--
-- 戻すとき: 20261004100000_require_order_fields_on_approval.sql の関数を
-- もう一度 CREATE OR REPLACE する（データの変更は無い）。
-- =============================================================================

CREATE OR REPLACE FUNCTION public.guard_transport_orders()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_is_admin boolean;
  v_key      text;
  v_val      text;
  v_missing  text[] := ARRAY[]::text[];
  v_labels   jsonb := '{"item_name":"品名","quantity":"数量","price":"運賃","origin":"出発地","destination":"到着地"}';
  -- 数量の形の確認
  v_qty_raw  text;
  v_qty      text;
  v_rest     text;
  v_m        text[];
  v_found    int;
  v_reason   text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('approved', 'delivered') THEN
      RAISE EXCEPTION '承認済みの発注は削除できません。'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;

  v_is_admin := public.has_role_in_org(auth.uid(), NEW.organization_id, 'admin'::public.app_role);

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' AND NOT v_is_admin THEN
      RAISE EXCEPTION '承認できるのは管理者のみです。'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.status = 'approved' THEN
      -- 承認の必須項目
      FOREACH v_key IN ARRAY ARRAY['item_name', 'quantity', 'price', 'origin', 'destination'] LOOP
        v_val := lower(btrim(coalesce(NEW.content_json::jsonb ->> v_key, '')));
        IF v_val IN ('', 'null', 'undefined', 'none', 'n/a', 'nan', '0', '０',
                     '不明', '未入力', '(未入力)', '（未入力）', '未設定', 'なし', '-', '—', 'ー') THEN
          v_missing := v_missing || (v_labels ->> v_key);
        END IF;
      END LOOP;
      IF NEW.delivery_due_date IS NULL THEN
        v_missing := v_missing || '納品日'::text;
      END IF;
      IF array_length(v_missing, 1) > 0 THEN
        RAISE EXCEPTION '承認できません。%が入っていません。', array_to_string(v_missing, '・')
          USING ERRCODE = 'check_violation';
      END IF;

      -- 数量は「数字＋単位」
      v_reason := NULL;
      v_qty_raw := btrim(NEW.content_json::jsonb ->> 'quantity');
      v_qty := regexp_replace(normalize(v_qty_raw, NFKC), '約|およそ|[()]', ' ', 'g');
      SELECT count(*) INTO v_found
        FROM regexp_matches(v_qty, '([0-9][0-9,]*(?:\.[0-9]+)?)\s*([^0-9\s,、・/+×*().]+)', 'g');
      v_rest := regexp_replace(
        regexp_replace(v_qty, '([0-9][0-9,]*(?:\.[0-9]+)?)\s*([^0-9\s,、・/+×*().]+)', ' ', 'g'),
        '[\s,、・/+×*]', '', 'g');
      IF v_found = 0 THEN
        v_reason := '数量は「数字＋単位」で入れてください（' || v_qty_raw || '）';
      ELSIF v_rest <> '' THEN
        v_reason := '数量の書き方を確認してください（' || v_qty_raw || '）';
      ELSE
        FOR v_m IN
          SELECT m FROM regexp_matches(v_qty, '([0-9][0-9,]*(?:\.[0-9]+)?)\s*([^0-9\s,、・/+×*().]+)', 'g') AS m
        LOOP
          IF replace(v_m[1], ',', '')::numeric <= 0 THEN
            v_reason := '数量は0より大きい数にしてください（' || v_qty_raw || '）';
            EXIT;
          ELSIF lower(v_m[2]) NOT IN ('kg', 'キロ', 'g', 't', 'トン', '箱', 'ケース', 'パレット', '匹', '尾', '枚', '個', '本', '袋', '缶') THEN
            v_reason := '数量の単位が読み取れません（' || v_m[2] || '）。kg・箱・ケースなどで入れてください';
            EXIT;
          END IF;
        END LOOP;
      END IF;
      IF v_reason IS NOT NULL THEN
        RAISE EXCEPTION '承認できません。%', v_reason
          USING ERRCODE = 'check_violation';
      END IF;

      NEW.approved_at := now();
      NEW.approved_by := auth.uid();
    ELSIF NEW.status = 'draft' THEN
      NEW.approved_at := NULL;
      NEW.approved_by := NULL;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF OLD.status IN ('approved', 'delivered') THEN
    IF NEW.content_json       IS DISTINCT FROM OLD.content_json
       OR NEW.delivery_due_date IS DISTINCT FROM OLD.delivery_due_date
       OR NEW.temperature_zone  IS DISTINCT FROM OLD.temperature_zone
       OR NEW.organization_id   IS DISTINCT FROM OLD.organization_id
       OR NEW.created_by        IS DISTINCT FROM OLD.created_by
       OR NEW.approved_at       IS DISTINCT FROM OLD.approved_at
       OR NEW.approved_by       IS DISTINCT FROM OLD.approved_by THEN
      RAISE EXCEPTION '承認済みの発注は変更できません。'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status
       AND NOT (OLD.status = 'approved' AND NEW.status = 'delivered') THEN
      RAISE EXCEPTION '承認済みの発注の状態は、配達済みにのみ変更できます。'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  -- draft → approved は管理者のみ。承認の記録はサーバー側で付与する。
  IF NEW.status = 'approved' THEN
    IF NOT v_is_admin THEN
      RAISE EXCEPTION '承認できるのは管理者のみです。'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- 承認の必須項目
    FOREACH v_key IN ARRAY ARRAY['item_name', 'quantity', 'price', 'origin', 'destination'] LOOP
      v_val := lower(btrim(coalesce(NEW.content_json::jsonb ->> v_key, '')));
      IF v_val IN ('', 'null', 'undefined', 'none', 'n/a', 'nan', '0', '０',
                   '不明', '未入力', '(未入力)', '（未入力）', '未設定', 'なし', '-', '—', 'ー') THEN
        v_missing := v_missing || (v_labels ->> v_key);
      END IF;
    END LOOP;
    IF NEW.delivery_due_date IS NULL THEN
      v_missing := v_missing || '納品日'::text;
    END IF;
    IF array_length(v_missing, 1) > 0 THEN
      RAISE EXCEPTION '承認できません。%が入っていません。', array_to_string(v_missing, '・')
        USING ERRCODE = 'check_violation';
    END IF;

    -- 数量は「数字＋単位」（INSERT で承認する上の枝と同じ確認）
    v_reason := NULL;
    v_qty_raw := btrim(NEW.content_json::jsonb ->> 'quantity');
    v_qty := regexp_replace(normalize(v_qty_raw, NFKC), '約|およそ|[()]', ' ', 'g');
    SELECT count(*) INTO v_found
      FROM regexp_matches(v_qty, '([0-9][0-9,]*(?:\.[0-9]+)?)\s*([^0-9\s,、・/+×*().]+)', 'g');
    v_rest := regexp_replace(
      regexp_replace(v_qty, '([0-9][0-9,]*(?:\.[0-9]+)?)\s*([^0-9\s,、・/+×*().]+)', ' ', 'g'),
      '[\s,、・/+×*]', '', 'g');
    IF v_found = 0 THEN
      v_reason := '数量は「数字＋単位」で入れてください（' || v_qty_raw || '）';
    ELSIF v_rest <> '' THEN
      v_reason := '数量の書き方を確認してください（' || v_qty_raw || '）';
    ELSE
      FOR v_m IN
        SELECT m FROM regexp_matches(v_qty, '([0-9][0-9,]*(?:\.[0-9]+)?)\s*([^0-9\s,、・/+×*().]+)', 'g') AS m
      LOOP
        IF replace(v_m[1], ',', '')::numeric <= 0 THEN
          v_reason := '数量は0より大きい数にしてください（' || v_qty_raw || '）';
          EXIT;
        ELSIF lower(v_m[2]) NOT IN ('kg', 'キロ', 'g', 't', 'トン', '箱', 'ケース', 'パレット', '匹', '尾', '枚', '個', '本', '袋', '缶') THEN
          v_reason := '数量の単位が読み取れません（' || v_m[2] || '）。kg・箱・ケースなどで入れてください';
          EXIT;
        END IF;
      END LOOP;
    END IF;
    IF v_reason IS NOT NULL THEN
      RAISE EXCEPTION '承認できません。%', v_reason
        USING ERRCODE = 'check_violation';
    END IF;

    NEW.approved_at := now();
    NEW.approved_by := auth.uid();
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.guard_transport_orders() FROM PUBLIC, anon, authenticated;
