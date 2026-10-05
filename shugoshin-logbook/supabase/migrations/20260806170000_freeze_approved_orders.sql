-- =============================================================================
-- 承認済みの発注（4条書面）を確定させる
--
-- 承認された発注は、取引条件を書面で示した記録になる。承認後に内容や金額を
-- 書き換えられたり、削除されたりしないよう、トリガーで固定する。
--
--   INSERT: 管理者以外は draft でしか作れない。承認の記録（approved_at/by）は
--           サーバー側で付与し、クライアントの値は使わない。
--   UPDATE: draft → approved は管理者のみ。承認済み・配達済みの内容
--           （content_json / 納期 / 温度帯 / 所属 / 作成者）は変更不可。
--           状態は approved → delivered のみ許可。
--   DELETE: 承認済み・配達済みは削除不可。
-- =============================================================================

CREATE OR REPLACE FUNCTION public.guard_transport_orders()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_is_admin boolean;
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
    NEW.approved_at := now();
    NEW.approved_by := auth.uid();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_transport_orders ON public.transport_orders;
CREATE TRIGGER trg_guard_transport_orders
  BEFORE INSERT OR UPDATE OR DELETE ON public.transport_orders
  FOR EACH ROW EXECUTE FUNCTION public.guard_transport_orders();

-- トリガー関数は直接呼ばせない
REVOKE EXECUTE ON FUNCTION public.guard_transport_orders() FROM PUBLIC, anon, authenticated;
