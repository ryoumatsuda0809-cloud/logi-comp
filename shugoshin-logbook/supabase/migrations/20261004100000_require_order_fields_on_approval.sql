-- =============================================================================
-- 空の発注を承認させない
--
-- 承認した発注は 4条書面として確定し、後から変更も削除もできない
-- （20260806170000_freeze_approved_orders）。それなのに、品名も数量も運賃も
-- 空の発注が承認済みになっていた。承認の時点で、書面に要る項目がそろって
-- いるかをサーバー側で確かめる。画面側でも同じ確認をしている
-- （src/lib/orderContent.ts の missingForApproval）。
--
-- AI解析は入力に無い項目を "null" や "不明" で埋めることがあるので、
-- それらも未入力として扱う。運賃は「空・0」を弾き、「3万円」のような書き方の
-- 読み取りと数値としての妥当性は画面側で確かめる。
--
-- guard_transport_orders の中身は 20260806170000 と同じで、
-- 「approved にする時の必須項目チェック」だけを足している。
-- このトリガー関数は呼び出したユーザーの権限で動くので、チェックは別関数に
-- 切り出さず中に書く（切り出すと、その関数の EXECUTE 権限が別途要る）。
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
    NEW.approved_at := now();
    NEW.approved_by := auth.uid();
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.guard_transport_orders() FROM PUBLIC, anon, authenticated;
