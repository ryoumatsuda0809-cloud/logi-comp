-- =============================================================================
-- 招待コードの強化: 有効期限・使用回数・総当たり対策
--
-- 招待コードで参加すると、その組織の記録・帳票・発注を閲覧できる。
-- これまでは6桁の16進数（24ビット）で、有効期限も使用回数の上限も、試行の制限もなかった。
--
-- 方針:
--   - 新しいコードは8桁（uuid の乱数由来）。既存の6桁コードも引き続き使える。
--   - 有効期限（既定30日）と最大使用回数（既定50回）。
--   - 失敗は 15分あたり5回まで（ユーザー単位）。超えたら参加を拒否する。
--   - 失敗の記録は例外を投げるとロールバックで消えるため、コードが無効な場合は
--     例外ではなく NULL を返し、フロントが「見つからない」と表示する。
-- =============================================================================

ALTER TABLE public.organization_invite_codes
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS max_uses   integer,
  ADD COLUMN IF NOT EXISTS use_count  integer NOT NULL DEFAULT 0;

-- 既存の有効なコードにも期限と上限を付ける
UPDATE public.organization_invite_codes
SET expires_at = COALESCE(expires_at, now() + interval '30 days'),
    max_uses   = COALESCE(max_uses, 50)
WHERE is_active = true;

-- 失敗した試行の記録（RPC からのみ読み書きする）
CREATE TABLE IF NOT EXISTS public.invite_code_attempts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.invite_code_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.invite_code_attempts FROM anon, authenticated;
CREATE INDEX IF NOT EXISTS idx_invite_code_attempts_user_time
  ON public.invite_code_attempts (user_id, attempted_at DESC);

-- 発行: 8桁、期限30日、上限50回
CREATE OR REPLACE FUNCTION public.create_invite_code(_org_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  new_code text;
  v_try    integer := 0;
BEGIN
  IF NOT has_role_in_org(auth.uid(), _org_id, 'admin') THEN
    RAISE EXCEPTION '管理者権限が必要です';
  END IF;

  LOOP
    v_try := v_try + 1;
    new_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    BEGIN
      INSERT INTO organization_invite_codes (organization_id, code, expires_at, max_uses)
      VALUES (_org_id, new_code, now() + interval '30 days', 50);
      RETURN new_code;
    EXCEPTION WHEN unique_violation THEN
      IF v_try >= 5 THEN
        RAISE EXCEPTION '招待コードを発行できませんでした。もう一度お試しください。';
      END IF;
    END;
  END LOOP;
END;
$$;

-- 参加: 期限・使用回数・失敗回数を検証する。無効なコードは NULL を返す。
CREATE OR REPLACE FUNCTION public.join_organization_by_invite_code(_code text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  target_org_id uuid;
  v_code_id     uuid;
  v_failures    integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'ログインが必要です。' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION '既に組織に所属しています';
  END IF;

  SELECT count(*) INTO v_failures
  FROM invite_code_attempts
  WHERE user_id = auth.uid() AND attempted_at > now() - interval '15 minutes';

  IF v_failures >= 5 THEN
    RAISE EXCEPTION '試行回数が多すぎます。15分ほど待ってから、もう一度お試しください。'
      USING ERRCODE = 'P0001';
  END IF;

  IF _code IS NOT NULL AND length(trim(_code)) >= 4 THEN
    SELECT c.id, c.organization_id INTO v_code_id, target_org_id
    FROM organization_invite_codes c
    WHERE c.code = upper(trim(_code))
      AND c.is_active = true
      AND (c.expires_at IS NULL OR c.expires_at > now())
      AND (c.max_uses IS NULL OR c.use_count < c.max_uses)
    FOR UPDATE;
  END IF;

  IF target_org_id IS NULL THEN
    INSERT INTO invite_code_attempts (user_id) VALUES (auth.uid());
    RETURN NULL;  -- 例外にするとこの記録がロールバックされるため、NULL で知らせる
  END IF;

  UPDATE organization_invite_codes SET use_count = use_count + 1 WHERE id = v_code_id;

  INSERT INTO organization_members (user_id, organization_id, role)
  VALUES (auth.uid(), target_org_id, 'driver');

  INSERT INTO user_roles (user_id, organization_id, role)
  VALUES (auth.uid(), target_org_id, 'driver');

  UPDATE profiles SET organization_id = target_org_id WHERE user_id = auth.uid();

  RETURN target_org_id;
END;
$$;
