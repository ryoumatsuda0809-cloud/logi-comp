-- =============================================================================
-- facilities に届出番号（7桁）を追加し、get_nearest_facility から返す
--
-- 【背景】
--   漁獲番号は「届出番号(7桁) + 譲渡日 YYMMDD(6桁) + ロット番号(3桁)」の構造を持つ。
--   このうち届出番号は荷主（施設）ごとに固定、譲渡日はアプリが保持しているため、
--   16桁のうち13桁はアプリ側で自動生成できる。
--   ドライバーに16桁すべてを手入力させる必要はなく、ロット3桁のみでよい。
--
--   詳細と設計判断は docs/CONTEXT_FISHERY_LAW.md を参照。
--
-- 【決定1】届出番号は施設ごとに固定として facilities に保存する。
--   打刻時点で施設は get_nearest_facility により特定済みのため、
--   追加の選択操作なしで自動補完できる。
--
-- 【NULL許容の理由】
--   既存の施設には届出番号が未登録である。未登録の場合はアプリ側が
--   16桁の直接入力にフォールバックするため、NOT NULL にはしない。
--   （登録が進むほど入力が楽になる、という段階的な移行を想定する）
-- =============================================================================

ALTER TABLE public.facilities
  ADD COLUMN IF NOT EXISTS notification_number TEXT;

COMMENT ON COLUMN public.facilities.notification_number IS
  '水産流通適正化法の届出番号（7桁）。漁獲番号の先頭7桁として使用する。未登録(NULL)の場合、アプリは漁獲番号の直接入力にフォールバックする。';

-- ---------------------------------------------------------------------------
-- get_nearest_facility の返却値に notification_number を追加する
-- （RETURNS TABLE の変更には DROP が必要）
--
-- 距離計算ロジック（Haversine / radius による絞り込み）は既存のまま変更しない。
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_nearest_facility(DOUBLE PRECISION, DOUBLE PRECISION);

CREATE OR REPLACE FUNCTION public.get_nearest_facility(
  user_lat DOUBLE PRECISION,
  user_lng DOUBLE PRECISION
)
RETURNS TABLE (
  id                  UUID,
  name                TEXT,
  client_name         TEXT,
  lat                 DOUBLE PRECISION,
  lng                 DOUBLE PRECISION,
  radius              INTEGER,
  notification_number TEXT,
  distance_m          DOUBLE PRECISION
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    f.id, f.name, f.client_name, f.lat, f.lng, f.radius, f.notification_number,
    6371000 * 2 * asin(sqrt(
      sin(radians(f.lat - user_lat) / 2) ^ 2 +
      cos(radians(user_lat)) * cos(radians(f.lat)) *
      sin(radians(f.lng - user_lng) / 2) ^ 2
    )) AS distance_m
  FROM facilities f
  WHERE 6371000 * 2 * asin(sqrt(
      sin(radians(f.lat - user_lat) / 2) ^ 2 +
      cos(radians(user_lat)) * cos(radians(f.lat)) *
      sin(radians(f.lng - user_lng) / 2) ^ 2
    )) <= f.radius
  ORDER BY distance_m ASC
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.get_nearest_facility(DOUBLE PRECISION, DOUBLE PRECISION) IS
  '現在地から radius(既定500m) 圏内で最も近い施設を返す。漁獲番号の組み立てに使う notification_number を含む。';
