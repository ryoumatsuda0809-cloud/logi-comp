# 守護神 — 進行状況・設計方針ログ

> **対象読者**: 進行中の修正・設計判断の背景を追いたい担当者
> **最終更新**: 2026-07-27
> **関連ドキュメント**: [`IMPLEMENTATION_SUMMARY.md`](./IMPLEMENTATION_SUMMARY.md)（実装済み機能のベースライン）

---

## 目次

1. [進行中の修正 #1: complete_ticket の GPS 座標詰みバグ](#進行中の修正-1-complete_ticket-の-gps-座標詰みバグ)
2. [進行中の修正 #2: 待機料の過大計算バグ](#進行中の修正-2-待機料の過大計算バグ)
3. [進行中の修正 #3: Rule 1 の DB レベル強制 と waiting_evidence 署名確定](#進行中の修正-3-rule-1-の-db-レベル強制-と-waiting_evidence-署名確定)
4. [コミット・適用状況（2026-07-27時点）](#コミット適用状況2026-07-27時点)
5. [未着手・要検討事項](#未着手要検討事項)

---

## 進行中の修正 #1: complete_ticket の GPS 座標詰みバグ

### 何が起きていたか

`complete_ticket` RPC が `wait_logs.latitude` / `wait_logs.longitude`（到着時保存値）を読み取って `waiting_evidence` に INSERT していたが、`issue_ticket` 経由で作成された `wait_logs` 行がこの2カラムに NULL を持つケースがあり、`waiting_evidence` の NOT NULL 制約に違反して INSERT が失敗していた。

結果として「作業完了（出発）」操作が 500 エラーで失敗し、該当の待機ログが `status='waiting'` のまま永久に残留 → ドライバーが新しい到着打刻もできなくなる詰み状態が発生していた。

### 方針

出発時の GPS 座標は「到着時座標の再利用」ではなく、**作業完了操作その場でドライバー端末から再取得した座標**を証拠として記録するのが本来の意味的に正しい設計。そのため `wait_logs` 側の値には一切依存せず、`p_latitude` / `p_longitude` を必須引数として受け取る形に変更する。

### 変更点

| ファイル | 内容 |
|---------|------|
| `supabase/migrations/20260720120000_fix_complete_ticket_gps_coords.sql` | `complete_ticket(p_log_id, p_latitude, p_longitude, p_fishery_data)` に signature 変更。座標 NULL 時は `[法的保護]` エラーで拒否（Rule 2 のフロント物理ロックに対するDB側二重防御） |
| `src/hooks/useEvidence.ts` | `completeTicket()` 内で `navigator.geolocation.getCurrentPosition()` を高精度オプションで再取得。取得失敗時は `watchPosition` の最終値にフォールバック。`position` が null の場合はRPC呼び出し自体をブロック |
| `src/integrations/supabase/types.ts` | `complete_ticket` の `Args` 型を新シグネチャに追随 |
| `src/hooks/useEvidence.test.ts` | 正常系（座標がRPCに正しく渡る）・異常系（DBの`[法的保護]`エラーが日本語メッセージに変換される）の結合テストを追加 |

### ステータス

未コミット（作業ツリー上）。`npm run build` / `tsc --noEmit` および migration の実DB適用は未実施。

---

## 進行中の修正 #2: 待機料の過大計算バグ

### 何が起きていたか

`convertWaitLogsToTimeline`（`src/lib/waitLogToTimeline.ts`）が `departure` イベントに `waitMinutes: workMins`（作業時間）を設定していた。これを `useDailyTimeline.ts` の `totalWaitMinutes` / `totalWaitCost` 集計がフィルタなしで合算していたため、**荷役作業時間が待機料の対象時間に混入し、待機料が過大計算**されていた。

取適法上、待機料（待機料）は署名後不可変（CLAUDE.md 記載）の法的データであるため、算定ロジックの誤りは重大な法的リスクとなる。

### 方針

- `departure` イベントは「作業終了」を表すイベントであり、待機時間ではないため `waitMinutes` を持たせない。
- 待機料集計の対象イベントを `waiting_start`（GPS由来の荷待ち）と `voice_report`（音声申告の荷待ち）のみに限定する。

### 変更点

| ファイル | 内容 |
|---------|------|
| `src/lib/waitLogToTimeline.ts` | `departure` エントリ生成時に `waitMinutes: workMins ?? undefined` の行を削除 |
| `src/hooks/useDailyTimeline.ts` | `isWaitEligible()` ヘルパーを追加し、`totalWaitMinutes` / `totalWaitCost` の `.filter()` に適用 |
| `src/lib/waitLogToTimeline.test.ts`（新規） | 作業時間120分を含むログで `departure.waitMinutes` が `undefined` であること、`totalWaitMinutes` が荷待ち分のみになることを検証する回帰テスト |

### ステータス

コミット済み（[#4](#コミット適用状況2026-07-27時点)参照）。既存の `waitLogToTimeline` / `useDailyTimeline` を利用する他画面（ダッシュボード集計等）への影響範囲は未確認。

---

## 進行中の修正 #3: Rule 1 の DB レベル強制 と waiting_evidence 署名確定

修正 #1 の作業と並行して、以下2件のmigrationが追加された。

### `20260720130000_enforce_wait_log_geofence_rls.sql`

CLAUDE.md Rule 1（RPCチェーン必須）はこれまでコード規約のみで守られており、DBレベルでは強制されていなかった。`wait_logs` の RLS ポリシーが `WITH CHECK (user_id = auth.uid())` のみだったため、`facility_id` / `latitude` / `longitude` / `ticket_number` / `status` を authenticated ロールが自由な値で直接 INSERT でき、500m ジオフェンス判定（Rule 2 のフェイルセーフ）を完全にバイパスできる状態だった。

対策として `wait_logs` に BEFORE INSERT トリガー (`enforce_wait_log_geofence`) を追加し、`get_nearest_facility` と同じ Haversine 式で施設からの距離を計算、`radius` 超過時は INSERT 自体を拒否する。さらに `issue_ticket` が `SECURITY DEFINER` であることを自己検証した上で、直接INSERTを許可する既存RLSポリシーを削除する（`issue_ticket` の実装が変わっていた場合は安全側に倒してスキップし、NOTICEで通知）。

### `20260720140000_sign_waiting_evidence_on_complete.sql`

`waiting_evidence` は `is_signed = true` の行の変更・削除を全ロールで禁止する改ざん防止トリガーを備えていたが、**`is_signed` を true にセットするコードがアプリ全体に一つも存在しなかった**。そのため全ての証拠行が永久に `is_signed = false` のままで、ドライバー本人がRLS経由で自分のGPS座標・水産物情報をいつでも書き換えられる状態だった（CLAUDE.md/CONTEXT_LEGAL_SPEC.md が要求する不変性が実質無効化されていた）。

対策として `complete_ticket`（修正#1の版をベースに再定義）が、完了処理の最後に同一 `wait_log_id` に紐づく到着・出発両方の `waiting_evidence` 行を `is_signed = true` に更新し、以後の改ざんを不可能にする。

### ステータス

コミット済み（[#4](#コミット適用状況2026-07-27時点)参照）。DB未検証（後述）。

---

## コミット・適用状況（2026-07-27時点）

| 項目 | 状態 |
|------|------|
| `tsc --noEmit` | ✅ エラーなし |
| `vitest run` | ✅ `useEvidence.test.ts`(5)・`waitLogToTimeline.test.ts`(2)は全通過。`EvidenceCollector.test.tsx`(3)は失敗するが、`git stash`で確認済みの通り**今回の変更と無関係の既存バグ**（修正前のコミットでも同じ理由で失敗） |
| ローカルコミット | ✅ `34080ee` "Fix complete_ticket GPS deadlock and waiting-fee overbilling"（修正#1〜#3 + 本ドキュメント + 回帰テストをまとめて1コミット） |
| Supabaseへのmigration適用 | ⛔ **保留中**。理由は下記 |
| リモートpush | 未実施 |

### ブロッカー: Supabase MCP接続先プロジェクトの不一致

migration適用を試みる前に `mcp__claude_ai_Supabase__list_projects` で確認したところ、MCP経由で見えるプロジェクトは **`Bloomers Project`**（id: `cpvuugafgabiqekvbiiy`, org: `smnpzpiqeqnmltultqtu`）の1件のみだった。一方、このリポジトリの `supabase/config.toml` は `project_id = "qojhncmwmsqzycxrfezv"` を指しており、**一致していない**。

誤ったプロジェクトへDDLを適用する事故を避けるため、適用は中止した。ユーザーに確認したところ「適用を中止する」を選択（正しいプロジェクトへの接続切り替えが必要という認識）。

**再開時に必要な作業**:
1. Supabase MCPの認証を `qojhncmwmsqzycxrfezv` が属する正しい組織/アカウントで再接続する、または
2. `supabase` CLI（本マシンには未インストール）を導入し `supabase login` → `supabase link --project-ref qojhncmwmsqzycxrfezv` → `supabase db push` で適用する
3. 上記いずれかで接続確認後、未適用のmigration3件（`20260720120000` / `20260720130000` / `20260720140000`）を本番に適用する

---

> **注記（2026-07-29）**: 上記のMCPブロッカーは解消済み。Supabase CLI を `npx supabase` で
> 利用し、アクセストークン経由で `qojhncmwmsqzycxrfezv` にリンクして適用済み。
> 最新の状況は下記「本番反映状況」を参照。

---

## 本番反映状況（2026-07-29時点）

### ⚠️ DBとフロントエンドの状態が一致していない

| 対象 | 状態 |
|------|------|
| Supabase（本番DB） | ✅ migration 8件すべて適用済み |
| フロントエンド（GitHub / Vercel） | ⛔ **6コミットがローカルのみ。push未実施＝未デプロイ** |

**影響**: RPCの引数を変更し旧定義を DROP したため、デプロイ済みの旧フロントからの
呼び出しは本番で404（`PGRST202 function not found`）になる。実測で確認済み:

```
issue_ticket(p_facility_id のみ)             → 404 PGRST202
complete_ticket(p_log_id, p_fishery_data)   → 404 PGRST202
```

ただし**動作していた機能を壊したわけではない**。到着打刻は `enforce_gps_not_null`
トリガー導入（2026-04-14）以降ずっと失敗しており、作業完了も NULL 座標で500エラー
だった。エラーの出方が変わっただけで、いずれも元から機能していない。

とはいえ今回の修正がユーザーに届いていない状態であり、早期にpushして揃えるべき。

### ブロッカー: GitHubの権限

`git push` が 403 で拒否される。

- リポジトリ所有者: `ryoumatsuda0809-cloud/logi-comp`
- 認証中のアカウント: **`knacit-cloud`**（トークンスコープ `repo` は保有）
- SSH鍵は未設定のためSSH経由も不可

**解消方法（いずれか）**:
1. `knacit-cloud` をリポジトリのコラボレーターに追加する
2. `gh auth login` で `ryoumatsuda0809-cloud` として認証し直す
3. 権限のある環境で `git push origin main` を実行する

### 適用済みmigration（本番DB）

| ファイル | 内容 |
|---------|------|
| `20260720120000` | complete_ticket のGPS座標詰みバグ修正 |
| `20260720130000` | Rule 1 のDBレベル強制（ジオフェンストリガー + RLSロックダウン） |
| `20260720140000` | waiting_evidence の署名確定（改ざん防止の実効化） |
| `20260728100000` | cancel_ticket RPC（打刻取消） |
| `20260728110000` | wait_logs.status に 'cancelled' を許可 |
| `20260728120000` | 調査用の一時関数（次のmigrationで削除済み） |
| `20260728130000` | **issue_ticket のGPS座標記録**（到着打刻が4月から停止していた原因） |
| `20260728140000` | facilities.notification_number 追加（漁獲番号の自動組み立て用） |

---

## Vercel接続先の是正（2026-07-29）

本番URL（shugoshin-logbook.vercel.app）は、実は`logi-comp`ではなく**別の非公開リポジトリ
`ryoumatsuda0809-cloud/shugoshin-logbook`**（Lovable製、2026-04-19で更新停止）に接続されて
いたことが判明した。テナントオンボーディング等の未使用機能が本番に残っていたのはこのため。

同一Supabaseプロジェクト（`qojhncmwmsqzycxrfezv`）を参照していたため、DB側の作業に無駄は
なかった。VercelのGit接続先を`ryoumatsuda0809-cloud/logi-comp`（Root Directory:
`shugoshin-logbook`）に切り替え済み。旧リポジトリは削除せずそのまま残置（アーカイブ用途）。

切替に伴い、旧リポジトリに直接コミットされていた`.env`（anon keyのみ、深刻度は低い）が
Vercel側の環境変数として設定されていなかったため、`VITE_SUPABASE_URL` /
`VITE_SUPABASE_PUBLISHABLE_KEY` をVercelのEnvironment Variablesに追加して解消した。

あわせてモノレポルートに残っていた陳腐化した重複（`CLAUDE.md`、`docs/CONTEXT_LEGAL_SPEC.md`、
`docs/CONTEXT_SUPABASE.md`、git追跡されていた`supabase/.temp/`）を削除済み
（`shugoshin-logbook/`側が上位互換のため実害なし）。

## 未着手・要検討事項

- [ ] 施設ごとの届出番号（7桁）をDBに登録する。未登録の間は漁獲番号が16桁の直接入力にフォールバックする
- [ ] オフライン打刻の可否判断。現状は打刻ボタンを物理ロックしており、圏外では記録が残らない。
      弱い証拠として残すなら、クライアント主張時刻とサーバー受信時刻を別カラムで保持し、
      証拠の強さを偽らない設計が必要（`src/lib/offlineQueue.ts` のヘッダー参照）
- [ ] 待機料自動計算ロジックまわりの他の集計箇所（荷主向けダッシュボード等、`IMPLEMENTATION_SUMMARY.md` の「次のステップ」参照）に同様の混入バグがないかの横展開確認
- [ ] 水産流通適正化法の未解決照会5件（`CONTEXT_FISHERY_LAW.md` 参照）。特に運送業者が「取扱事業者」に該当するかの確認
