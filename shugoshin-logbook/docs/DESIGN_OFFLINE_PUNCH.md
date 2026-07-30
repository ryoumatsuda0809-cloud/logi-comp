# 設計: オフライン打刻と圏外の例外救済

> **ステータス**: 決定済み。**Phase 1 実装済み（本番DB未適用）**
> **作成**: 2026-07-30 / **最終更新**: 2026-07-30
> **関連**: [`PROGRESS_LOG.md`](./PROGRESS_LOG.md) / [`CONTEXT_LEGAL_SPEC.md`](./CONTEXT_LEGAL_SPEC.md) / `src/lib/offlineQueue.ts`

---

## 0. この設計が扱う3つの課題

別々に記録されていたが、いずれも**「サーバーが検証できない打刻をどう扱うか」という単一の問題**の別の面である。個別に対処すると必ず矛盾するため、まとめて設計する。

| 出典 | 課題 |
|------|------|
| 未着手リスト | オフライン打刻の可否判断。現状は圏外で打刻ボタンを物理ロックしており、記録が一切残らない |
| 運用懸念 ①（`246ef2f`） | 圏外で打刻できなかった場合の例外申請フロー（管理者の事後承認） |
| 横展開確認 E | `compliance_logs` と `wait_logs` の二重計上リスク（現在は休眠） |

---

## 1. 前提の整理（設計に入る前の事実確認）

### 1-1. 「圏外」は「GPSが使えない」ではない

**これが設計の出発点になる。** GPS は衛星測位であり、携帯電波が届かなくても座標は取得できる。実際 `navigator.geolocation` は機内モードでも動作する（測位に時間はかかる）。

したがって圏外時に失われるのは以下の3つだけで、**位置情報そのものは失われない**。

| 失われるもの | 理由 | 事後に回復できるか |
|---|---|---|
| **時刻の信頼性** | サーバー時刻を取得できず、端末時刻は改ざん可能 | ⛔ 回復不能（後述） |
| **整理券番号** | 施設単位・日単位の採番はDBが行う | ✅ 送信時に採番可能 |
| **ジオフェンス判定** | 施設座標との距離判定はサーバー側 | ✅ 座標さえ残れば事後判定可能 |

「圏外だから何も記録できない」ではなく、**「時刻だけが検証できない」**というのが正確な問題設定である。現状の実装はこれを「全部ダメ」として扱っているため、過剰にドライバーの不利益になっている。

### 1-2. 現状のブロッカーは `trg_force_recorded_at` 系トリガー

`offlineQueue.ts` のヘッダーが警告している通り、`wait_logs` / `compliance_logs` / `waiting_evidence` はすべて **INSERT 時にサーバー時刻で時刻カラムを無条件に上書き**する（`20260414000003_force_server_timestamps.sql`）。

これは時刻偽装を防ぐ正しい設計だが、副作用としてオフラインで貯めた記録を後から送ると「朝9時の到着」が「再接続した15時の到着」として保存される。しかも**エラーにならず黙って起きる**。この上書きは外してはならない。

→ **結論: オフライン打刻を `wait_logs` にそのまま流し込む道は存在しない。** 別の受け皿が要る。

### 1-3. 主張時刻について保証できることの限界

クライアント主張時刻 `claimed_at` は原理的に検証できない。サーバーが言えるのは**上界だけ**である。

```
claimed_at  <  サーバー受信時刻（received_at）
```

「それより前に起きたと本人が言っている」以上のことは何も保証できない。端末時計を巻き戻せば任意の過去を主張できる。GPS座標があっても「その場所にいた」ことしか言えず、「その時刻にいた」ことは言えない。

→ **結論: 技術で埋められない差である。だから人間（管理者）の承認を挟む。** これは技術的敗北ではなく、証拠の性質に正直な設計である。

---

## 2. 設計原則: 証拠の等級を偽らない

CLAUDE.md および `CONTEXT_LEGAL_SPEC.md` が求める不変条件は「すべての記録が同じ強さであること」ではなく、**「記録の強さを偽らないこと」**である。したがって等級を明示的にデータモデルへ持ち込む。

| 等級 | 名称 | 意味 | 時刻の出所 | 荷主への請求 |
|:--:|---|---|---|---|
| **A** | サーバー検証済 | 現行の通常打刻。サーバー時刻＋サーバー側ジオフェンス判定 | DB `now()` | 無条件で可 |
| **B** | ドライバー申告（未承認） | 圏外で記録され、まだ誰も検証していない | 端末時刻（主張） | **不可** |
| **C** | 管理者承認済 | 等級Bを所属組織の管理者が事後承認したもの | 端末時刻（主張）＋承認記録 | 可。ただし**等級Aと区別して提示** |

**重要な不変条件**: 承認しても等級Cは等級Aにならない。管理者の承認は「会社としてこの申告を認める」という意思表示であって、サーバーがその時刻を検証した事実にはならない。この区別を消すと、荷主に対して証拠の強さを偽ることになる。

---

## 3. データモデル: staging と真実を分離する

### 3-1. 方針

オフライン打刻を `wait_logs` に**混ぜない**。新テーブル `pending_punches`（申請の受け皿）を設け、管理者承認をもって `wait_logs` へ昇格させる。

```
[オフライン打刻]                    [管理者承認]
      │                                   │
      ▼                                   ▼
pending_punches  ──── approve ────▶  wait_logs（唯一の真実）
  等級B                                等級C として記録
  ・claimed_at（端末時刻）              ・整理券番号をここで採番
  ・GPS座標                            ・ジオフェンスをここで検証
  ・待機料の集計対象外                  ・待機料の集計対象
      │
      └──── reject ────▶ 却下（行は残す＝監査証跡）
```

### 3-2. なぜ `wait_logs` に混ぜないのか

| 理由 | 内容 |
|---|---|
| **① 誤課金を構造的に防げる** | 今回修正した待機料集計は `wait_logs` を読む。未承認の申告がそこに入らなければ、集計側に条件を足さなくても請求に載らない。「集計側でフィルタし忘れる」という今回まさに踏んだ事故（取消済み打刻の混入）を再発させない |
| **② 既存の防御機構を一切壊さない** | `trg_force_wait_log_arrival`（時刻強制上書き）も `trg_enforce_wait_log_geofence`（500m判定）も、`wait_logs` INSERT 時に効いたまま維持できる。承認時のINSERTは通常の打刻と同じ検証を通る |
| **③ 採番問題が自然に解ける** | `ticket_number` は施設単位・日単位の連番。オフラインでは確定できないが、承認時にサーバーが採番すれば済む |
| **④ 二重計上の根を断てる（課題Eへの回答）** | 待機の真実を持つテーブルを `wait_logs` **1つに固定**する。二重計上は「同じ物理的待機を2つのテーブルが独立に主張する」ときに起きるので、片方を staging と定義すれば構造的に起きない |

### 3-3. `pending_punches` テーブル案

```sql
CREATE TABLE public.pending_punches (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id),
  organization_id UUID REFERENCES public.organizations(id),
  facility_id     UUID NOT NULL REFERENCES public.facilities(id),

  punch_type      TEXT NOT NULL,          -- 'arrival' | 'completion'
  -- 完了打刻の申請の場合、対象の待機ログ
  wait_log_id     UUID REFERENCES public.wait_logs(id),

  -- ★ 時刻を2つ持つ。claimed_at は絶対に上書きしない
  claimed_at      TIMESTAMPTZ NOT NULL,   -- 端末が主張する打刻時刻（未検証）
  received_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,  -- サーバー受信時刻（トリガーで強制）

  latitude        DOUBLE PRECISION NOT NULL,
  longitude       DOUBLE PRECISION NOT NULL,
  gps_accuracy_m  DOUBLE PRECISION,       -- 測位精度。承認判断の material にする
  -- 送信時にサーバーが計算した施設からの距離（承認画面に出す）
  distance_m      DOUBLE PRECISION,
  within_geofence BOOLEAN,

  driver_note     TEXT,                   -- ドライバーの申告理由（必須運用を推奨）

  review_status   TEXT NOT NULL DEFAULT 'pending',  -- 'pending'|'approved'|'rejected'
  reviewed_by     UUID REFERENCES auth.users(id),
  reviewed_at     TIMESTAMPTZ,
  review_note     TEXT,
  promoted_log_id UUID REFERENCES public.wait_logs(id),  -- 承認で生成した wait_logs 行

  created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

**設計上の要点**

- `claimed_at` は**サーバー時刻で上書きしない**。ここが既存テーブルとの決定的な違いで、「主張は主張として保存する」ことが目的。代わりに `received_at` をトリガーでサーバー時刻に強制し、両方を残す
- `distance_m` / `within_geofence` は**送信時にサーバーが計算**して保存する。座標さえ残っていれば事後にジオフェンス判定はできる（1-1参照）。承認者は「圏内だったのか」を数値で見て判断できる
- 却下しても行は削除しない。`review_status='rejected'` で残す（`cancel_ticket` と同じ、証拠隠滅防止の思想）
- RLS: SELECT はドライバー本人＋同組織管理者。UPDATE（承認）は `has_role_in_org(auth.uid(), organization_id, 'admin')` のみ。ドライバーは自分の申請を承認できない

### 3-4. `wait_logs` 側に足すもの

```sql
ALTER TABLE public.wait_logs
  ADD COLUMN evidence_grade TEXT NOT NULL DEFAULT 'A',   -- 'A' | 'C'
  ADD COLUMN claimed_at     TIMESTAMPTZ,                 -- 等級Cのときのみ非NULL
  ADD COLUMN approved_by    UUID REFERENCES auth.users(id),
  ADD COLUMN source_punch_id UUID REFERENCES public.pending_punches(id);
```

既存行はすべて `evidence_grade='A'`（デフォルト）となり、後方互換が保たれる。

**`arrival_time` の扱い（要判断・後述）**: 等級Cの行で `arrival_time` に何を入れるかは決めきれていない。`claimed_at` を入れると待機時間が実態に合うが、`trg_force_wait_log_arrival` がサーバー時刻で上書きするため、承認RPC専用の例外経路が要る。詳細は §8。

---

## 4. フロー

### 4-1. 圏外での到着打刻

```
1. ドライバーが圏外の現場に到着。通信なし
2. アプリは GPS 測位を試みる（衛星測位なので圏外でも成功しうる）
   ├─ 座標が取れた  → 「オフライン記録」ボタンを提示。押すと localStorage に保存
   └─ 座標も取れない → 従来通り物理ロック。位置の裏付けが皆無な記録は作らない
3. 画面には「これは仮記録であり、まだ待機料の請求根拠になっていない」と明示
4. 通信復帰 → queue_offline_punch RPC で送信 → pending_punches に等級Bで着地
5. ドライバーの画面に「承認待ち」バッジ。管理者に通知
6. 管理者が承認画面で claimed_at / received_at / 距離 / 精度 / 申告理由を見て判断
   ├─ 承認 → wait_logs に等級Cで昇格。ここで整理券番号を採番
   └─ 却下 → 行は残り、ドライバーに理由が表示される
```

**重要**: ステップ2で座標も取れない場合は記録を作らない。位置の裏付けがない申告は「ドライバーがそう言っている」以上の情報を1ビットも含まず、承認者が判断する材料がない。等級Bにすらならない。

### 4-2. 圏外での作業完了打刻

到着が等級A（オンラインで正常に打刻済み）で、完了打刻だけ圏外というケースが実務では最も多いと予想される。この場合も `pending_punches` に `punch_type='completion'` + `wait_log_id` で申請する。承認時は `wait_logs` の `work_end_time` を更新する。

**注意**: 完了打刻の承認は `waiting_evidence` の署名確定（`is_signed=true`）を伴う。署名すると以後変更不可になるため、承認は取り消せない。承認画面でこれを明示すること。

---

## 5. RPC 設計

Rule 1（RPCチェーン必須）に従い、`pending_punches` への直接 INSERT/UPDATE は RLS で禁止し、以下3つの `SECURITY DEFINER` 関数のみを入口とする。

| RPC | 呼び出し元 | 責務 |
|---|---|---|
| `queue_offline_punch(p_facility_id, p_punch_type, p_claimed_at, p_latitude, p_longitude, p_accuracy, p_note, p_wait_log_id)` | ドライバー | ① `claimed_at > now()` を拒否（未来時刻の主張を弾く）<br>② 施設からの距離を計算し `distance_m` / `within_geofence` を確定<br>③ `pending_punches` に `review_status='pending'` で INSERT |
| `approve_pending_punch(p_punch_id, p_review_note)` | 管理者のみ | ① `has_role_in_org` で権限検証<br>② 自分の申請は承認不可（自己承認の禁止）<br>③ 到着申請 → `wait_logs` に等級Cで INSERT・採番。完了申請 → `work_end_time` 更新＋`waiting_evidence` 署名<br>④ `pending_punches` を `approved` にし `promoted_log_id` を記録 |
| `reject_pending_punch(p_punch_id, p_review_note)` | 管理者のみ | 却下理由を必須で記録。行は残す |

**`queue_offline_punch` で弾くべき入力**

- `claimed_at` が未来 → 拒否（「まだ起きていないこと」を主張している）
- `claimed_at` が `received_at` から極端に古い（例: 30日超）→ 拒否または要強警告。運用で決める
- 座標が NULL → 拒否（§4-1 の通り、位置の裏付けがない申告は受けない）
- 同一ドライバー・同一施設・近接した `claimed_at` の重複申請 → 冪等キーで弾く（オフラインキューの再送で二重申請が起きるため。§7参照）

---

## 6. 荷主への提示方法

等級Cを等級Aと同じ見た目で出すと、証拠の強さを偽ることになる。`SharedReportView` / 提出済み日報 / 法定乗務記録テキストのすべてで区別する。

- 等級Cの行には注記を付す。例:
  `※ 通信圏外のため端末に記録され、2026-07-30 に運行管理者が承認した記録です（サーバー時刻による自動検証は行われていません）`
- 待機料の内訳を「サーバー検証済分」と「管理者承認分」に分けて小計を出す
- 荷主が等級C分のみを争えるようにする。これは不利な仕様ではなく、**等級A分の信頼性を守るための切り分け**である。全部が同じ強さだと主張すると、1件崩れたときに全体の信頼性が崩れる

---

## 7. 二重計上の封じ込め（課題 E への回答）

現状 `useDailyTimeline` は `compliance_logs` + `daily_reports` + `wait_logs` の3ソースをマージしており、同一の物理的待機が複数ソースに入ると二重計上になる。今は `compliance_logs` への書き込み口が `offlineQueue.ts`（未使用）だけなので休眠しているが、**オフライン打刻を実装する今こそ顕在化する条件が揃う**。

**決定事項として提案する:**

1. **`compliance_logs` を待機料の算定ソースから外す。** 現行フローから書き込まれておらず、`monthly_wait_risk_reports` VIEW 以外に用途がない（そのVIEWも課題Dで単価不一致を抱えている）。待機料の真実は `wait_logs` 1本にする
2. **`offlineQueue.ts` は削除する。** 新しい `pending_punches` 経路で置き換えられ、残しておくと「使える実装がある」と誤読される危険がある。ヘッダーの警告は本設計書に引き継ぐ
3. **待機の真実は `wait_logs` のみ**という不変条件を CLAUDE.md に明記し、集計を書く人が迷わないようにする

これにより、オフライン打刻を追加しても集計ソースは1つのままになる。

---

## 8. 決定事項（2026-07-30 確定）

| # | 論点 | 決定 | 理由 |
|---|---|---|---|
| **①** | 等級Cの `arrival_time` に何を入れるか | **(b) サーバー時刻のまま入れ、`claimed_at` は別カラムで保持。待機時間の算定側が `claimed_at` を参照する** | 時刻強制上書きトリガーに承認RPC用の例外を開けると、そこが将来の偽装経路になる。トリガーを無傷のまま残すほうが安全 |
| **②** | 承認の期限 | **申請は30日、承認は無期限** | 30日を超える過去の打刻は証拠として態をなさないため申請時に拒否する。一方、届いた申請の承認に期限を設けると、管理者の見落としでドライバーが救済されなくなる |
| **③** | 自己承認の禁止を貫くか | **禁止せず、`self_approved` フラグで記録する** | 一人親方・小規模事業者では管理者＝ドライバーになるため、禁止すると圏外救済そのものが機能しない。荷主向けの提示でも自己承認である旨を明示し、証拠の強さを偽らない |
| **④** | 却下された申請の再申請 | **可。却下→再申請の履歴は残す** | 却下理由が「申告理由の記載不足」等であれば再申請は正当。履歴が残るため濫用は追跡できる |
| **⑤** | iOS PWA でのバックグラウンド送信 | **オンライン復帰イベント＋次回アプリ起動時の送信で妥協** | Service Worker の Background Sync は iOS Safari 非対応。技術的に他の選択肢がない |

### 実装時に判明した設計の修正点

| 項目 | 当初案 | 実装 | 理由 |
|---|---|---|---|
| 施設の特定 | `facility_id NOT NULL`（端末が指定） | **サーバーが座標から最寄り施設を解決。`facility_id` は NULL 許容** | 端末は施設マスタを持たないため、オフラインでは施設を指定できない。施設リストをキャッシュする案もあるが、座標さえあればサーバーが解決できるので不要。近傍に施設がない場合も申請自体は受け付け、距離を添えて管理者の判断に委ねる |
| オフライン判定 | `navigator.onLine` のみ | **`navigator.onLine` に加え、打刻RPCの通信失敗も条件にする** | `useOnlineStatus` のヘッダーが警告している通り、`navigator.onLine` は「圏外ギリギリで接続はあるが通信が通らない」状態を true のまま返す。これだけに頼ると実質圏外のドライバーに仮記録の導線を出せない |
| 水産物情報 | 言及なし | **`fishery_data JSONB` カラムを先に用意（Phase 1 では常に NULL）** | 完了打刻の申請には水産流通適正化法の要求項目が必要。Phase 2 でカラム追加のmigrationを重ねずに済むよう先に作る |

---

## 9. 段階的な実装計画

一度に全部作らない。Phase 1 だけでもドライバーの不利益は大きく減る。

| Phase | 内容 | 判断材料 |
|---|---|---|
| **1** | `pending_punches` テーブル + `queue_offline_punch` + ドライバー側の申請UI（承認機能なし＝申請は溜まるだけ） | まず「記録が残らない」問題だけを解消する。承認UIがなくても、記録が存在すれば後から手当てできる。逆は不可能 |
| **2** | 管理者の承認/却下UI + `approve_pending_punch` / `reject_pending_punch` + `wait_logs` への等級カラム追加 | Phase 1 で実際にどんな申請がどれだけ来るかを見てから、承認画面に出す情報を決められる |
| **3** | 荷主向け提示での等級の区別（§6）+ `compliance_logs` の算定ソースからの除外（§7）+ `offlineQueue.ts` 削除 | 等級Cが実際に発生してから対応すればよい。Phase 2 完了まで等級Cの行は存在しない |

---

## 11. Phase 1 の実装状況（2026-07-30）

### 実装したもの

| ファイル | 内容 |
|---|---|
| `supabase/migrations/20260730100000_create_pending_punches.sql` | `pending_punches` テーブル、`received_at`/`created_at` のサーバー時刻強制トリガー、審査済み申請の書き換え禁止トリガー、DELETE 全面禁止トリガー、RLS（SELECT のみ。INSERT はRPC経由に限定）、`queue_offline_punch` RPC |
| `src/lib/offlinePunchQueue.ts` | 端末側の仮記録キュー。冪等キーの発番、送信、恒久拒否と通信エラーの振り分け |
| `src/hooks/useOfflinePunch.ts` | キューの状態管理とオンライン復帰時の自動送信 |
| `src/hooks/useEvidence.ts` | `submitFailedOffline` を追加（`navigator.onLine` が当てにならないケースの検出） |
| `src/components/evidence/EvidenceCollector.tsx` | 圏外時の「到着を仮記録する」導線、未送信件数、恒久拒否の理由表示 |
| `src/lib/offlinePunchQueue.test.ts` | 冪等キー・再送・恒久拒否の振り分けの回帰テスト7件 |

### Phase 1 で意図的にやっていないこと

- **完了打刻の圏外申請**。RPC とテーブルは `punch_type='completion'` を受けられるが、UI は到着打刻のみ。完了打刻には水産物情報（魚種・重量・漁獲番号）が伴い、これを圏外でどう入力させるかの検討が要るため Phase 2 に回す
- **承認/却下**。`approve_pending_punch` / `reject_pending_punch` と管理者UIは Phase 2。現状、申請は溜まるだけで `wait_logs` へは昇格しない
- **`wait_logs` への等級カラム追加**。昇格が実装されるまで等級Cの行は存在しないため不要

### 適用順序の注意

フロントエンドは `queue_offline_punch` RPC を呼ぶため、**migration の本番適用を先に行うこと**。
逆順にすると、圏外で仮記録したドライバーの送信が `PGRST202 function not found` で失敗する。
この失敗は通信エラーとして扱われキューに残るため記録自体は失われないが、
migration が適用されるまで送信され続ける。

---

## 10. この設計が意図的に採用しなかった案

| 案 | 不採用の理由 |
|---|---|
| オフライン打刻をそのまま `wait_logs` に入れ、フラグで区別する | 集計側で毎回フィルタする必要があり、今回の「取消済み打刻の混入」と同じ事故を必ず繰り返す。フィルタし忘れが即座に誤課金になる |
| サーバー時刻の上書きトリガーを緩め、クライアント時刻を受け入れる | 時刻偽装への唯一の防御を失う。等級Aの記録まで信頼性が落ちる |
| 管理者承認を挟まず、GPS座標が圏内なら自動承認する | 座標は「その場所にいた」ことしか示さず「その時刻にいた」ことを示さない。前日に同じ場所にいた記録でも通ってしまう |
| 圏外時も従来通り一切記録しない（現状維持） | ドライバーが正当な待機料を請求できない。「記録がない」ことは荷主に有利に働くため、放置は運送業者側の一方的な不利益になる |
