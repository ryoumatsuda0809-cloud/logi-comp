-- =============================================================================
-- transport_orders の TRUNCATE を塞ぐ
--
-- 背景:
--   transport_orders に anon / authenticated の TRUNCATE 権限が付いていた（STATUS.md）。
--   行トリガー trg_guard_transport_orders は TRUNCATE では動かず、RLS も TRUNCATE には効かない。
--   Supabase の REST API は TRUNCATE を発行できないが、DB に直接つなげる経路があれば
--   承認済みの発注が一括で消せてしまう。submitted_reports / waiting_evidence と同じ扱いにそろえる。
--
-- 二重防御:
--   Layer 1 (権限)     : anon / authenticated から TRUNCATE を REVOKE
--   Layer 2 (Trigger)  : service_role・DB 管理者を含む全ロールの TRUNCATE を拒否
--
-- 注意: 意図して全消去する必要が出たときは、このトリガーを DROP してから行うこと
--       （開発用 DB のリセットなど。本番では行わない）。
-- =============================================================================

REVOKE TRUNCATE ON public.transport_orders FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.block_transport_orders_truncate()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION
    '[法的保護] transport_orders の TRUNCATE は禁止されています。'
    '承認済みの発注は取引の証拠として一括削除できません。'
  USING ERRCODE = 'insufficient_privilege';
END;
$$;

COMMENT ON FUNCTION public.block_transport_orders_truncate() IS
  'transport_orders への TRUNCATE を全ロールで禁止する。';

DROP TRIGGER IF EXISTS trg_block_transport_orders_truncate ON public.transport_orders;
CREATE TRIGGER trg_block_transport_orders_truncate
  BEFORE TRUNCATE ON public.transport_orders
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.block_transport_orders_truncate();

-- トリガー関数は直接呼ばせない（20260806110000 の方針）
REVOKE EXECUTE ON FUNCTION public.block_transport_orders_truncate() FROM PUBLIC, anon, authenticated;
