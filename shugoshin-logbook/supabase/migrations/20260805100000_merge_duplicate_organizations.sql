-- =============================================================================
-- 組織の重複への対処: 統合RPC・再発防止・統合履歴の保全
--
-- 【何が起きているか】
--   本番の organizations に「下関唐戸魚市場株式会社」が2行存在する。
--   create_organization_with_admin が組織名の重複を一切チェックせず
--   INSERT INTO organizations (name) VALUES (trim(org_name)) するため、
--   同じ会社名を2人が入力すれば2組織できる。
--
-- 【なぜ実害があるか】
--   同じ会社が2つの組織レコードに分かれると、組織単位の権限判定が会社をまたげない。
--   最も直接的なのは圏外申請の承認で、approve_pending_punch は
--   has_role_in_org(admin, pending_punches.organization_id, 'admin') で判定する。
--   pending_punches.organization_id はドライバーの profiles.organization_id 由来なので、
--   ドライバーと管理者の所属が割れていると**同じ会社なのに承認できない**。
--   waiting_evidence / submitted_reports の帰属も割れ、待機料の請求主体が分裂する。
--
-- 【この migration の方針】
--   統合の実行そのものは migration に書かない。どちらを正とするかは
--   参照件数や経緯を見た人間の判断であり、誤ると証拠の帰属が壊れる。
--   代わりに「IDを明示して呼ぶ統合RPC」を用意し、実行は別操作とする。
--
--   統合しても組織レコードは削除しない。merged_into で統合先を指すのみとし、
--   「どの組織がどこへ統合されたか」の監査証跡を残す（cancel_ticket と同じ思想）。
-- =============================================================================

-- ---------------------------------------------------------------------------
-- STEP 1: 統合履歴の保持
-- ---------------------------------------------------------------------------
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS merged_into UUID REFERENCES public.organizations(id);

COMMENT ON COLUMN public.organizations.merged_into IS
  '重複組織の統合先。非NULLの行は統合済みで、参照は統合先へ付け替え済み。証拠の帰属履歴を残すため行自体は削除しない。';

CREATE INDEX IF NOT EXISTS idx_organizations_merged_into
  ON public.organizations(merged_into) WHERE merged_into IS NOT NULL;

REVOKE UPDATE (merged_into) ON public.organizations FROM authenticated;

-- ---------------------------------------------------------------------------
-- STEP 2: 再発防止 — 組織名の重複作成を拒否する
--
--   既存の重複が解消されるまで UNIQUE 制約は張れないため、まず関数側で止める。
--   （UNIQUE 制約の追加は重複解消後の別 migration で行う）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_organization_with_admin(org_name text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_org_id uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION '既に組織に所属しています';
  END IF;

  IF org_name IS NULL OR trim(org_name) = '' THEN
    RAISE EXCEPTION '組織名を入力してください';
  END IF;

  -- 同名の組織が既にある場合は作らせない。
  -- 重複すると組織単位の権限判定が会社をまたげなくなり、圏外申請の承認や
  -- 待機料の帰属が分裂する。同じ会社に参加する場合は招待コードを使う。
  IF EXISTS (
    SELECT 1 FROM organizations o
    WHERE lower(trim(o.name)) = lower(trim(org_name))
      AND o.merged_into IS NULL
  ) THEN
    RAISE EXCEPTION '同名の組織が既に存在します。同じ会社に参加する場合は、管理者から招待コードを受け取ってください。 (org_name: %)', trim(org_name)
      USING ERRCODE = 'unique_violation';
  END IF;

  INSERT INTO organizations (name)
  VALUES (trim(org_name))
  RETURNING id INTO new_org_id;

  INSERT INTO user_roles (user_id, organization_id, role)
  VALUES (auth.uid(), new_org_id, 'admin');

  UPDATE profiles
  SET organization_id = new_org_id
  WHERE user_id = auth.uid();

  RETURN new_org_id;
END;
$$;

COMMENT ON FUNCTION public.create_organization_with_admin(text) IS
  '組織を新規作成し、作成者を管理者にする。同名の組織が既に存在する場合は拒否する（重複すると組織単位の権限判定が会社をまたげなくなるため）。';

-- ---------------------------------------------------------------------------
-- STEP 3: merge_organizations
--
--   重複した組織を統合する。参照元テーブルは information_schema から動的に
--   洗い出すため、将来テーブルが増えても取りこぼさない。
--
--   一意制約に衝突した場合（例: organization_settings.organization_id は UNIQUE、
--   user_roles は (user_id, organization_id, role) が UNIQUE）は、その表を
--   スキップして報告する。**衝突行を削除するような破壊的な解決はしない。**
--   どちらを残すかは業務判断であり、黙って消すと復元できない。
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.merge_organizations(
  p_from UUID,
  p_into UUID
)
RETURNS TABLE (
  table_name   TEXT,
  column_name  TEXT,
  moved_rows   INTEGER,
  skipped      BOOLEAN,
  note         TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_admin_id   UUID := auth.uid();
  v_from_name  TEXT;
  v_into_name  TEXT;
  v_from_merged UUID;
  r            RECORD;
  v_count      INTEGER;
BEGIN
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'ログインが必要です。' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_from = p_into THEN
    RAISE EXCEPTION '統合元と統合先が同じです。' USING ERRCODE = 'check_violation';
  END IF;

  SELECT o.name, o.merged_into INTO v_from_name, v_from_merged
  FROM public.organizations o WHERE o.id = p_from;
  IF NOT FOUND THEN
    RAISE EXCEPTION '統合元の組織が見つかりません。 (id: %)', p_from
      USING ERRCODE = 'no_data_found';
  END IF;

  SELECT o.name INTO v_into_name
  FROM public.organizations o WHERE o.id = p_into;
  IF NOT FOUND THEN
    RAISE EXCEPTION '統合先の組織が見つかりません。 (id: %)', p_into
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_from_merged IS NOT NULL THEN
    RAISE EXCEPTION 'この組織は既に統合済みです。 (merged_into: %)', v_from_merged
      USING ERRCODE = 'check_violation';
  END IF;

  -- 権限: 統合先の管理者であること。
  IF NOT public.has_role_in_org(v_admin_id, p_into, 'admin') THEN
    RAISE EXCEPTION '[法的保護] 統合先組織の管理者のみ実行できます。'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- 安全弁: 名称が一致する組織どうしに限る。
  -- 無関係な組織を誤って統合すると、待機記録の帰属が壊れて復元できない。
  -- 表記ゆれのある重複（「A」と「A株式会社」等）は、この関数では扱わず
  -- 個別に検討すること。
  IF lower(trim(v_from_name)) <> lower(trim(v_into_name)) THEN
    RAISE EXCEPTION '[法的保護] 名称が一致しない組織は統合できません。（% / %）誤統合を防ぐための制限です。',
      v_from_name, v_into_name
      USING ERRCODE = 'check_violation';
  END IF;

  -- organizations を参照している全FK列を洗い出して付け替える。
  -- organizations 自身（merged_into）は対象外。
  FOR r IN
    SELECT tc.table_name AS tbl, kcu.column_name AS col
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
     AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name
     AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
      AND ccu.table_name = 'organizations'
      AND ccu.column_name = 'id'
      AND tc.table_name <> 'organizations'
    ORDER BY tc.table_name, kcu.column_name
  LOOP
    BEGIN
      EXECUTE format(
        'UPDATE public.%I SET %I = $1 WHERE %I = $2',
        r.tbl, r.col, r.col
      ) USING p_into, p_from;
      GET DIAGNOSTICS v_count = ROW_COUNT;

      table_name  := r.tbl;
      column_name := r.col;
      moved_rows  := v_count;
      skipped     := false;
      note        := NULL;
      RETURN NEXT;

    EXCEPTION WHEN unique_violation THEN
      -- 統合先に既に対応する行がある。どちらを残すかは業務判断のため
      -- 破壊的な解決はせず、要手当てとして報告する。
      table_name  := r.tbl;
      column_name := r.col;
      moved_rows  := 0;
      skipped     := true;
      note        := '一意制約に衝突したため付け替えていません。統合先に既存の行があります。手動で確認してください。';
      RETURN NEXT;
    END;
  END LOOP;

  -- 統合済みとして記録する。行は削除しない（帰属履歴の保全）。
  UPDATE public.organizations
  SET merged_into = p_into
  WHERE id = p_from;

  table_name  := 'organizations';
  column_name := 'merged_into';
  moved_rows  := 1;
  skipped     := false;
  note        := format('%s を %s へ統合済みとして記録しました（行は削除していません）。', p_from, p_into);
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.merge_organizations(UUID, UUID) IS
  '重複した組織を統合する。organizations を参照する全FK列を動的に洗い出して付け替え、統合元は merged_into で統合先を指す（削除はしない）。統合先の管理者のみ実行可能で、名称が一致する組織どうしに限る。一意制約に衝突した表は破壊的に解決せずスキップして報告する。';

REVOKE ALL ON FUNCTION public.merge_organizations FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.merge_organizations TO authenticated;
