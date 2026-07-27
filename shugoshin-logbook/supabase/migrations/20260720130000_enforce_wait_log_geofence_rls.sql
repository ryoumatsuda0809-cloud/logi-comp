-- =============================================================================
-- Rule 1（RPCチェーン必須）の実効化: wait_logs の直接INSERTバイパス対策
--
-- 【問題】
--   CLAUDE.md Rule 1 は「打刻エビデンスの記録はフロントエンドから直接 insert() する
--   ことを禁止し、get_nearest_facility → issue_ticket のRPCチェーンを必ず経由する」
--   ことを求めているが、これはこれまでコード規約としてのみ守られており、
--   DBレベルでは強制されていなかった。
--
--   実際、public.wait_logs の RLS ポリシー "Users can insert own wait logs" は
--   WITH CHECK (user_id = auth.uid()) のみで、facility_id・latitude/longitude・
--   ticket_number・status を含め、あらゆる値を authenticated ロールが自由に
--   INSERT できてしまう。これは以下を意味する:
--
--     - 500m ジオフェンス判定（issue_ticket 内のロジック）を完全にスキップし、
--       施設から離れた場所にいても打刻レコードを作成できる
--       （Rule 2 のフェイルセーフの法的実効性が失われる）。
--     - ticket_number や status を任意の値で偽装できる。
--
-- 【対策】
--   1. wait_logs に BEFORE INSERT トリガーを追加し、facility_id が指す施設と
--      latitude/longitude の距離を get_nearest_facility と同じ Haversine 式で
--      計算し、facility.radius（既定500m）を超える場合は INSERT 自体を拒否する。
--      これは INSERT 経路（直接INSERTかRPC経由か）を問わず効くため、
--      issue_ticket の実装詳細に依存しない安全な多重防御になる。
--
--   2. issue_ticket が SECURITY DEFINER として定義されている場合に限り
--      （= RLSをバイパスしてINSERTできる場合に限り）、authenticated ロールの
--      直接INSERTを許可する現行RLSポリシーを削除し、RPC経由のみに限定する。
--      issue_ticket がSECURITY DEFINERでない場合、このポリシー削除を実行すると
--      到着打刻そのものが機能しなくなるため、その場合は安全のためスキップし
--      NOTICEで管理者に通知する（DO ブロックで自己検証する）。
-- =============================================================================

-- ---------------------------------------------------------------------------
-- STEP A: ジオフェンス強制トリガー（INSERT経路を問わず有効な多重防御）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_wait_log_geofence()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_facility_lat    DOUBLE PRECISION;
  v_facility_lng    DOUBLE PRECISION;
  v_facility_radius INTEGER;
  v_distance_m      DOUBLE PRECISION;
BEGIN
  SELECT f.lat, f.lng, f.radius
  INTO v_facility_lat, v_facility_lng, v_facility_radius
  FROM public.facilities f
  WHERE f.id = NEW.facility_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION '[法的保護] 指定された施設が見つかりません。 (facility_id: %)', NEW.facility_id
      USING ERRCODE = 'check_violation';
  END IF;

  -- get_nearest_facility と同一の Haversine 式で距離(m)を算出する
  v_distance_m := 6371000 * 2 * asin(sqrt(
    sin(radians(v_facility_lat - NEW.latitude) / 2) ^ 2 +
    cos(radians(NEW.latitude)) * cos(radians(v_facility_lat)) *
    sin(radians(v_facility_lng - NEW.longitude) / 2) ^ 2
  ));

  IF v_distance_m > v_facility_radius THEN
    RAISE EXCEPTION '[法的保護] 500m圏外のため打刻できません。（施設からの距離: 約%m）',
      ROUND(v_distance_m::numeric)
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.enforce_wait_log_geofence() IS
  '法的保護: wait_logs へのINSERT時、facility_idの施設からlatitude/longitudeが radius(既定500m) を超える場合はINSERTを拒否する。直接INSERT・RPC経由を問わず効く多重防御。';

DROP TRIGGER IF EXISTS trg_enforce_wait_log_geofence ON public.wait_logs;
CREATE TRIGGER trg_enforce_wait_log_geofence
  BEFORE INSERT ON public.wait_logs
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_wait_log_geofence();

-- ---------------------------------------------------------------------------
-- STEP B: 直接INSERTの禁止（issue_ticketがSECURITY DEFINERの場合のみ実行）
--
--   issue_ticket が SECURITY DEFINER でない環境でこのポリシーを削除すると
--   到着打刻機能そのものが破壊されるため、自己検証してから実行する。
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_is_security_definer BOOLEAN;
BEGIN
  SELECT p.prosecdef
  INTO v_is_security_definer
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'issue_ticket'
  LIMIT 1;

  IF v_is_security_definer IS TRUE THEN
    DROP POLICY IF EXISTS "Users can insert own wait logs" ON public.wait_logs;
    RAISE NOTICE '[Rule1適用] issue_ticket は SECURITY DEFINER のため、wait_logs への直接INSERTを禁止しました。今後は issue_ticket RPC経由のみでレコードが作成されます。';
  ELSE
    RAISE NOTICE '[Rule1未適用/要確認] issue_ticket が見つからないか SECURITY DEFINER ではないため、wait_logs の直接INSERT禁止ポリシーはスキップしました。issue_ticket の定義を確認のうえ、必要であれば "Users can insert own wait logs" ポリシーを手動で削除してください（先にジオフェンストリガーが有効なため、500m圏外の偽装は既に防がれています）。';
  END IF;
END $$;
