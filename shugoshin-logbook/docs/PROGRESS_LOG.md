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

## 待機料集計の横展開確認（2026-07-29）

修正#2（作業時間が待機料に混入していたバグ）と同種の誤りが他の集計経路に残っていないかを、
待機料を算出している**4経路すべて**について確認した。

| # | 経路 | 用途 | 結果 |
|---|------|------|------|
| 1 | `useDailyTimeline` | ドライバーの日報確認 → `submitted_reports` に保存 | 30分控除の単位は正（要リファクタのみ） |
| 2 | `SharedReportView`（liveパス） | **荷主向け**の当日レポート | ⛔ 過大計算バグ |
| 3 | `DailyReportConfirm`（snapshot生成） | 提出済み日報のタイムライン保全 | ⛔ 取消済み打刻が混入 |
| 4 | `monthly_wait_risk_reports` VIEW | `Report.tsx` の月次帳票 | ⚠️ 単価・控除がフロントと不一致（未修正） |

### 修正した不整合 A: 取消済み(cancelled)の打刻が待機料・法定乗務記録に計上されていた

`cancel_ticket` は証拠隠滅を防ぐためレコードを物理削除せず `status='cancelled'` に
更新するのみだが、`convertWaitLogsToTimeline` は `WaitLogRow.status` を受け取りながら
**一度も参照していなかった**。`wait_logs` を素朴にSELECTしている経路（上表 1・2・3）すべてで
取消済みの行が集計対象になっていた。

`cancel_ticket` は `status` が `'called'` / `'working'` の行も取消可能なため、
`called_time` が入った行＝待機時間が算出できる行がそのまま課金対象に混入する。
取り消したはずの打刻が荷主向けの請求根拠および法定乗務記録テキストに載る状態だった。

対策として `isBillableWaitLog()` を追加し、`convertWaitLogsToTimeline` と
`generateFormalReportFromWaitLogs` の両方で取消済み行を除外する。3経路すべてがこの
2関数を経由するため、単一箇所の修正で横展開できる。監査証跡はDB側に行が残ることで担保される。

### 修正した不整合 B: 30分控除の適用単位が画面ごとに違い、荷主向けが過大だった

- `useDailyTimeline`: 待機1回ごとに `calcWaitCost()` を適用して合算（正）
- `SharedReportView`: **日次合計に対して `calcWaitCost()` を1回だけ適用**（誤）

同じ日・同じデータでもドライバーの確認画面と荷主向けレポートで金額が食い違い、
荷主向けのほうが常に過大になる。

```
40分待機 × 2回、4t車（50円/分）
  正: (40-30)*50 * 2 = 1,000円
  誤: (80-30)*50     = 2,500円
20分待機 × 3回（各回とも30分以下＝課金対象外）
  正: 0円
  誤: (60-30)*50     = 1,500円   ← 課金対象でない待機に課金
```

**採用した解釈**: 30分の控除は「待機1回ごと」に適用する。標準貨物自動車運送約款の
待機時間料が集貨地・配達地ごとの待機について算定されるため。したがって
`SharedReportView` 側が誤りであり、こちらを是正した。

対策として `sumWaitCost(waitMinutesList, vehicleClass)` を `waitCostCalc.ts` に追加し、
集計側は `calcWaitCost()` を直接呼ばずこの関数を経由する形に統一した。
`convertWaitLogsToTimeline` は待機1回ごとの分数を `waitMinutesPerEvent` として返す。

### 変更点

| ファイル | 内容 |
|---------|------|
| `src/lib/waitCostCalc.ts` | `sumWaitCost()` を追加（30分控除は待機1回ごと、という規則を単一箇所に集約） |
| `src/lib/waitLogToTimeline.ts` | `isBillableWaitLog()` を追加し取消済み行を除外。`WaitLogSummary.waitMinutesPerEvent` を追加 |
| `src/pages/SharedReportView.tsx` | 日次合計への `calcWaitCost` を `sumWaitCost(waitMinutesPerEvent)` に置換 |
| `src/hooks/useDailyTimeline.ts` | 同値だが `sumWaitCost()` 経由に統一（再発防止） |
| `src/lib/waitLogToTimeline.test.ts` | 取消済み打刻の除外3件・30分控除の適用単位3件の回帰テストを追加 |

### 検証

| 項目 | 結果 |
|------|------|
| `tsc --noEmit` | ✅ エラーなし |
| `npm run build` | ✅ 成功 |
| `vitest run` | ✅ 6ファイル / 41テスト通過（36→41）。Unhandled Errors 8件は `git stash` で確認済みの通り**変更前から同数**で、`useEvidence.test.ts` のモック未整備に起因する既存の問題 |
| 本番デプロイの世代一致 | ✅ 配信中バンドルに `p_latitude` / `cancel_ticket` / `notification_number` を確認（DBとフロントの世代が一致） |

### 未修正（要判断）

- **C: 集計対象のデータソースが画面で不一致**。`SharedReportView` のliveパスは `wait_logs` のみを
  読むが、`useDailyTimeline` は `compliance_logs` + `daily_reports`（音声申告）+ `wait_logs` を
  マージする。そのため音声申告の待機が荷主向けliveレポートから欠落する。
  過小側なので緊急度は低いが、そもそも自己申告の待機を荷主向け証拠に載せるべきかという
  設計判断を含むため保留。
- **D: `monthly_wait_risk_reports` VIEW の算定がフロントと不一致**。30分控除が一切なく、
  単価も `10t` が70円（フロントは60円）、`trailer` が90円（フロントには定義がなく50円扱い）。
  `Report.tsx` はこの帳票を「法的な支払督促の根拠資料として有効」と明記しているため、
  数字の食い違いは是正すべき。ただしVIEWの元テーブル `compliance_logs` は現行フローから
  書き込まれていないため実データは空とみられ、緊急度は低い。修正にはmigrationが必要。
- **E（休眠）: `compliance_logs` と `wait_logs` の二重計上リスク**。`useDailyTimeline` は
  両者をマージするため、同一の物理的な待機が両方に記録されると二重計上になる。
  現状 `compliance_logs` への書き込み口は `src/lib/offlineQueue.ts` のみで、これは
  どこからも呼ばれていない（ヘッダーコメント参照）ため顕在化していない。
  オフライン打刻を実装する際に必ず再検討すること。

---

## 未着手・要検討事項

- [ ] 施設ごとの届出番号（7桁）をDBに登録する。未登録の間は漁獲番号が16桁の直接入力にフォールバックする
- [ ] オフライン打刻の可否判断。現状は打刻ボタンを物理ロックしており、圏外では記録が残らない。
      弱い証拠として残すなら、クライアント主張時刻とサーバー受信時刻を別カラムで保持し、
      証拠の強さを偽らない設計が必要（`src/lib/offlineQueue.ts` のヘッダー参照）
      → **設計確定・Phase 1 実装済み（2026-07-30）。** [`DESIGN_OFFLINE_PUNCH.md`](./DESIGN_OFFLINE_PUNCH.md) 参照。
      運用懸念①（圏外の例外申請フロー）と横展開確認E（二重計上リスク）を同一の設計問題として統合した。
      **本番DBへの migration 適用は未実施**（`20260730100000_create_pending_punches.sql`）。
      Phase 2（管理者の承認/却下）と Phase 3（荷主向けの等級区別）は未着手
- [x] 待機料自動計算ロジックまわりの他の集計箇所に同様の混入バグがないかの横展開確認
      → 完了（上記「待機料集計の横展開確認」参照）。不整合A・Bを修正、C・D・Eは要判断で保留
- [ ] 水産流通適正化法の未解決照会5件（`CONTEXT_FISHERY_LAW.md` 参照）。特に運送業者が「取扱事業者」に該当するかの確認

## 運用開始後に直面する4つの実務上の懸念（2026-07-29 ユーザー指摘）

コードの穴ではなく、実運用に入った際に必ず出てくる業務プロセス上の課題として記録する。

### ① GPS圏外・電波なしのエッジケース救済

現状は物理ロック（打刻ボタンを押せなくする）のみで、「本当に到着しているのに電波のせいで
打刻できず、待機料を請求できない」というドライバー側の不満が起きうる。

検討中の対策候補:
- 電波復帰時に送信する「保留データ」オフラインキャッシュ（既存の`offlineQueue.ts`は
  そのままでは使えない。ヘッダーコメントに記載の設計要件を参照）
- **圏外で打刻できなかった場合の例外申請フロー**（管理者が事後承認する仕組み）。
  これは「サーバーが自動的にクライアント主張データを信用する」設計ではなく、
  「人間の管理者が事後に判断する」形にすることで、証拠の信頼性を保ったまま
  救済できる可能性がある。既存の`is_signed`（署名確定）の仕組みと組み合わせ、
  管理者承認をもって署名する、という流れが自然か検討する。

→ **設計完了（2026-07-30）**: [`DESIGN_OFFLINE_PUNCH.md`](./DESIGN_OFFLINE_PUNCH.md) 参照。
  例外申請フロー案を採用し、オフラインキャッシュと統合した。要点は
  「圏外＝GPS不可ではない（失われるのは時刻の信頼性だけ）」という前提の整理と、
  申請の受け皿 `pending_punches` を `wait_logs` から分離して誤課金を構造的に防ぐ方針。

### ② 荷主側の受領・納得プロセス

技術的に正しい証拠があっても、荷主が「休憩していただろう」「到着連絡を受けていない」と
争ってくるケースが想定される。

検討中の対策候補:
- 到着打刻のタイミングで荷主担当者へ自動通知（メール/LINE/SMS）を送り、
  「知らなかった」を防ぐ。現状、facilitiesテーブルに荷主担当者の連絡先・通知設定は存在しない。
- 請求データのPDF出力時に、改ざん不可の証跡（サーバー時刻・署名済みであること等）が
  読み手に分かりやすい見た目で表示されているか確認する。

### ③ 作業完了打刻の押し忘れ対策の強化

到着打刻は「待たされている」ので能動的に押すが、作業完了は「解放された瞬間に急いで
次へ向かう」ため押し忘れやすい。現状は`staleTicket.ts`で16時間超過時に警告を出し、
`cancel_ticket`で取り消せる形にしてあるが、これは**次にアプリを開いたときの事後警告**でしかない。

検討中の対策候補:
- 500m圏外に出た瞬間（ジオフェンス離脱）に「作業完了ボタンを押していませんか？」と
  プッシュ通知する仕組み。技術的な制約として、PWAはiOSでのバックグラウンド位置情報取得に
  厳しい制限があるため、実現性はネイティブアプリ化やWeb Push +定期同期の検証が必要。

### ④ 水産流通適正化法の対象魚種マスタの柔軟性

現状、対象魚種と閾値（`src/lib/fisheryLaw.ts`の`TARGET_SPECIES`）は**コード内にハードコード**
されており、追加・変更にはコード修正とデプロイが必要。過去にシラスウナギ（2025-12〜）・
太平洋クロマグロ（2026-04〜）と法改正で対象が実際に拡大した実績があるため、
今後も同様の拡大が続く前提で、DBマスタ化して管理画面から更新できるようにするかを検討する。
現時点では意図的にシンプルな実装（コード内定数）にとどめているが、
拡大ペースが今後も続くようであれば見直し対象。
