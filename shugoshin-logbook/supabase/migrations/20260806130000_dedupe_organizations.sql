-- =============================================================================
-- 組織名の重複を解消し、再発を防ぐ
--
-- 経緯:
--   同名の組織が2行存在した。調べると、新しい方は全テーブルから1件も参照されておらず
--   （ユーザー・施設・証拠・日報・招待コードなどが無い）、統合ではなく
--   「空の重複行の削除」で足りる。古い方を正とする。
--   （以前の統合関数 merge_organizations は不要になったため作らない。）
--
-- 内容:
--   1. 同名（正規化後）の組織のうち、古い方を残し、新しい方は「どこからも参照されて
--      いない場合に限り」削除する。参照が1件でもあれば削除せず NOTICE を出す。
--   2. 正規化名の UNIQUE インデックスを張る（全角半角・大文字小文字・前後空白を同一視）。
--   3. 組織作成 RPC に重複チェックを追加し、分かりやすい日本語で拒否する。
-- =============================================================================

-- 1. 空の重複行の削除（参照が無い場合のみ）
DO $$
DECLARE
  d record;
  r record;
  v_refs bigint;
  v_total bigint;
BEGIN
  FOR d IN
    SELECT o.id, o.name
    FROM public.organizations o
    WHERE EXISTS (
      SELECT 1 FROM public.organizations o2
      WHERE lower(btrim(normalize(o2.name, NFKC))) = lower(btrim(normalize(o.name, NFKC)))
        AND (o2.created_at, o2.id) < (o.created_at, o.id)
    )
  LOOP
    v_total := 0;
    FOR r IN
      SELECT c.conrelid::regclass AS tbl, a.attname AS col
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.contype = 'f' AND c.confrelid = 'public.organizations'::regclass
    LOOP
      EXECUTE format('SELECT count(*) FROM %s WHERE %I = $1', r.tbl, r.col) INTO v_refs USING d.id;
      v_total := v_total + v_refs;
    END LOOP;

    IF v_total = 0 THEN
      DELETE FROM public.organizations WHERE id = d.id;
      RAISE NOTICE '空の重複組織を削除しました: % (%)', d.name, d.id;
    ELSE
      RAISE NOTICE '参照があるため削除していません: % (%) 参照件数=%', d.name, d.id, v_total;
    END IF;
  END LOOP;
END $$;

-- 2. 正規化名の一意制約
CREATE UNIQUE INDEX IF NOT EXISTS organizations_name_normalized_uidx
  ON public.organizations (lower(btrim(normalize(name, NFKC))));

-- 3. 組織作成 RPC（重複を拒否）
CREATE OR REPLACE FUNCTION public.create_organization_with_admin(org_name text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  new_org_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'ログインが必要です。' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- 既に組織に所属しているユーザーは作成不可（二重作成を防ぐ）
  IF EXISTS (SELECT 1 FROM user_roles WHERE user_id = auth.uid()) THEN
    RAISE EXCEPTION '既に組織に所属しています';
  END IF;

  IF org_name IS NULL OR btrim(org_name) = '' THEN
    RAISE EXCEPTION '組織名を入力してください';
  END IF;

  -- 同名の組織があれば作らせない。同じ会社に入る場合は招待コードを使う。
  IF EXISTS (
    SELECT 1 FROM organizations o
    WHERE lower(btrim(normalize(o.name, NFKC))) = lower(btrim(normalize(org_name, NFKC)))
  ) THEN
    RAISE EXCEPTION '同名の組織が既に存在します。同じ会社に参加する場合は、管理者から招待コードを受け取ってください。'
      USING ERRCODE = 'unique_violation';
  END IF;

  INSERT INTO organizations (name) VALUES (btrim(org_name)) RETURNING id INTO new_org_id;

  INSERT INTO user_roles (user_id, organization_id, role)
  VALUES (auth.uid(), new_org_id, 'admin');

  UPDATE profiles SET organization_id = new_org_id WHERE user_id = auth.uid();

  RETURN new_org_id;
EXCEPTION
  -- 同時作成の競合は一意インデックスが検出する。同じ案内に揃える。
  WHEN unique_violation THEN
    RAISE EXCEPTION '同名の組織が既に存在します。同じ会社に参加する場合は、管理者から招待コードを受け取ってください。'
      USING ERRCODE = 'unique_violation';
END;
$$;
