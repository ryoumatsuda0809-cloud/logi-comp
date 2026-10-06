# 守護神 — 実装要約ドキュメント

> **対象読者**: 本プロジェクトに新たに参加する開発者、またはコア機能を変更する前に設計意図を確認したい担当者  
> **最終更新**: 2026-10-06（取適法の名称、距離計算の方式、テスト件数、打刻RPCの現行定義に合わせて訂正）  
> **ステータス**: 本番デプロイ済み（Vercel + Supabase）

---

## 目次

1. [セキュアな認証ステート管理（useAuth）](#1-セキュアな認証ステート管理useauth)
2. [取適法準拠エビデンスUI と GPS ジオフェンス物理ロック](#2-取適法準拠エビデンスui-と-gps-ジオフェンス物理ロック)
3. [改ざん防止データ送信アーキテクチャ（Supabase RPC）](#3-改ざん防止データ送信アーキテクチャsupabase-rpc)
4. [Vitest 結合テスト網羅状況](#4-vitest-結合テスト網羅状況)

---

## 1. セキュアな認証ステート管理（useAuth）

### なぜ実装したか

初期実装では `getSession()` を先に呼び出し、その後 `onAuthStateChange` をセットアップする順序になっていた。この順序だと、セッション取得の非同期完了タイミングとリスナー登録の競合により、ログイン直後に `loading` フラグが `true` → `false` → `true` と不規則に変化し、**無限リダイレクトループ**（ログインページとダッシュボード間を往復し続ける）が発生した。

### どう実装したか

`src/hooks/useAuth.tsx` において、**`onAuthStateChange` リスナーを唯一の信頼できるステート更新源** とし、`getSession()` の独立呼び出しを排除した。

```
useEffect(() => {
  // ① リスナーを先に登録: Auth イベントが唯一のステート更新源となる
  const { data: { subscription } } = supabase.auth.onAuthStateChange(
    (_event, session) => {
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);   // ← リスナー内でのみ loading を解除
    }
  );
  return () => subscription.unsubscribe();
  // ② getSession() の独立呼び出しはない
}, []);
```

**重要な設計不変条件**:

- `onAuthStateChange` は登録直後に現在のセッション状態を即時発火する。これにより初回マウント時も `getSession()` なしで正しい状態が得られる。
- この順序を変更すると競合状態が再発する。`useAuth.tsx` は `getSession()` を呼ばない現在の形を保つこと。

---

## 2. 取適法準拠エビデンスUI と GPS ジオフェンス物理ロック

### なぜ実装したか

取適法（正式名称: 製造委託等に係る中小受託事業者に対する代金の支払の遅延等の防止に関する法律、通称 中小受託取引適正化法。旧 下請法。2026-01-01 施行。詳細は `docs/CONTEXT_LEGAL_SPEC.md`）を背景に、運送業者が荷主に待機料を確実に請求できるよう、荷主施設での待機時間を法的に有効なエビデンスとして自動生成する。本プロジェクトでは GPS 位置情報を伴わない打刻を証拠として扱わない設計とし、**GPSが取得できない状態での打刻操作を物理的に不可能にする**フェイルセーフを置いた。

### どう実装したか

#### フック層: `src/hooks/useEvidence.ts`

`navigator.geolocation.watchPosition()` で GPS を継続監視し、GPS まわりでは以下の2つの状態を管理する。

| 状態 | 説明 |
|------|------|
| `position: GpsPosition \| null` | GPS座標。未取得時は `null` |
| `gpsError: string \| null` | エラー種別ごとの日本語メッセージ |

GPS エラーはエラーコードで分岐し、ドライバーが対処できる具体的な日本語メッセージに変換する（許可拒否 / 位置取得不可 / タイムアウト）。

#### UIコンポーネント層: `src/components/evidence/EvidenceCollector.tsx`

```typescript
const isGpsReady = position !== null && !gpsError;
const isButtonLocked = !isGpsReady || isSubmitting || !isOnline;  // 物理ロック条件
```

| 条件 | UIの状態 |
|------|----------|
| GPS取得中（`position === null`） | ボタン `disabled`、レーダーアニメーション表示 |
| GPS エラー（`gpsError !== null`） | ボタン `disabled`、`<Alert variant="destructive">` で日本語エラー表示 |
| 送信中（`isSubmitting === true`） | ボタン `disabled`、ローダー表示 |
| オフライン（`isOnline === false`） | ボタン `disabled`、オフラインである旨の Alert を表示 |
| GPS取得済み・エラーなし | ボタン enabled「到着打刻」 |

**フェイルセーフの二重構造**:

1. **フロント層**: `disabled` による物理ロック（クリック不可）
2. **バックエンド層**: `wait_logs` の BEFORE INSERT トリガー `trg_enforce_wait_log_geofence`（`enforce_wait_log_geofence()`）が、Haversine 式（SQL の自前計算。PostGIS は使っていない）で施設までの距離を求め、施設の `radius`（既定500m）を超えると `RAISE EXCEPTION`（ERRCODE `check_violation`）で INSERT を拒否する。`issue_ticket` 経由か直接 INSERT かを問わず効く

フロント側の無効化を意図的に回避されても、バックエンドが必ず弾く設計になっている。

---

## 3. 改ざん防止データ送信アーキテクチャ（Supabase RPC）

### なぜ実装したか

打刻データ（到着時刻・GPS座標・整理券番号）は待機料の算定根拠となる法的証拠であり、**クライアントから直接 `insert()` するとタイムスタンプや座標の偽装が可能**になる。フロントエンドは信頼できない実行環境であるため、証拠の生成・検証をすべてサーバーサイドに委ねる必要があった。

### どう実装したか

#### データフロー

```
[フロントエンド]
  緯度・経度のみ送信
        │
        ▼
[RPC: get_nearest_facility]
  Haversine 式（SQL）で施設の radius（既定500m）圏内の最寄り施設を検索
  圏外の場合は空配列を返す（フロントがエラー表示）
        │
        ▼
[RPC: issue_ticket]
  wait_logs を INSERT（arrival_time は DB サーバー時刻）
  同じトランザクションで waiting_evidence（arrival）も INSERT
  整理券番号を自動採番（施設 × 日本時間の日付ごとの連番。
    同時到着で衝突したら最大5回やり直す）
  500m 圏外の場合は trg_enforce_wait_log_geofence が
    RAISE EXCEPTION（check_violation）で拒否
        │
        ▼
[フロントエンド]
  log_id / ticket_number / arrival_time を受け取り表示
```

フロントエンドが送信するのは、`get_nearest_facility` へ `user_lat` / `user_lng`、`issue_ticket` へ `p_facility_id` / `p_latitude` / `p_longitude` のみ。**時刻の付与・ジオフェンス判定・整理券採番はすべてDBが行う**。

#### DBレベルの改ざん防止（`supabase/migrations/`）

| 仕組み | 対象テーブル | 効果 |
|--------|-------------|------|
| `trg_force_wait_log_arrival` | `wait_logs` | INSERT 時に `arrival_time` / `created_at` をDBサーバー時刻で強制上書き |
| `trg_enforce_wait_log_geofence` | `wait_logs` | INSERT 時に施設との距離（Haversine）が `radius`（既定500m）を超えると拒否 |
| `trg_force_recorded_at` | `compliance_logs` | INSERT 時に `recorded_at` をDBサーバー時刻で強制上書き |
| `trg_force_waiting_evidence_timestamps` | `waiting_evidence` | INSERT 時に `recorded_at` / `created_at` をDBサーバー時刻で強制上書き |
| `trg_guard_waiting_evidence_update` | `waiting_evidence` | `is_signed = true` の行への UPDATE を全ロールで禁止（署名の瞬間に `signed_at` をサーバー時刻で記録） |
| `trg_block_waiting_evidence_delete` | `waiting_evidence` | DELETE を全ロールで禁止（署名の有無を問わない。service_role 含む） |
| `trg_block_waiting_evidence_truncate` | `waiting_evidence` | TRUNCATE を全ロールで禁止 |

RLS ポリシーに加えて `SECURITY DEFINER` トリガーによる二重防御を採用しているため、service_role を使った管理操作でも署名済みエビデンスの改ざんは不可能。

---

## 4. Vitest 結合テスト網羅状況

### テストファイル構成

| ファイル | テスト対象 | テスト数 |
|--------|-----------|---------|
| `src/hooks/useEvidence.test.ts` | バックエンド通信ロジック（RPC呼び出し） | 8 |
| `src/components/evidence/EvidenceCollector.test.tsx` | GPS状態・オフライン状態によるUI物理ロック | 7 |

### `useEvidence.test.ts` — バックエンド通信結合テスト（8件）

```
describe: useEvidence — バックエンド送信の結合テスト（4件）
describe: useEvidence.completeTicket — 作業完了打刻の結合テスト（4件）
```

| テストケース | 検証内容 |
|------------|---------|
| 正常系: GPS→RPC正常 | `get_nearest_facility` に正しい緯度経度が渡されること / `issue_ticket` に施設IDと緯度経度が渡されること / `lastResult` が正しくマッピングされること |
| 届出番号の引き継ぎ | 施設に届出番号が登録されていれば `lastResult` に引き継がれること（漁獲番号の自動組み立てに使う） |
| 異常系: ネットワークエラー | `get_nearest_facility` 失敗時に `submitError` に日本語メッセージが伝播し、後続の `issue_ticket` が呼ばれないこと |
| 異常系: 500m圏外/ジオフェンス | `issue_ticket` がジオフェンスエラーを返した場合に圏外エラーメッセージが正しく表示されること |
| 作業完了: GPS座標の送信 | 作業完了操作その場のGPS座標が `p_latitude` / `p_longitude` として `complete_ticket` に渡ること |
| 取消: 成功 | `cancel_ticket` RPC が呼ばれ、成功時に `lastResult` がクリアされること |
| 取消: 署名済みで拒否 | 署名済みで取消が拒否されたとき、`lastResult` を消さずエラーを表示すること |
| 異常系: GPS座標必須エラー | DBが GPS座標必須の `[法的保護]` エラーを返した場合、日本語メッセージに変換されること |

### `EvidenceCollector.test.tsx` — UIフェイルセーフ結合テスト（7件）

```
describe: EvidenceCollector — GPS 状態によるUIフェイルセーフ検証（4件）
describe: EvidenceCollector — オフライン時のフェイルセーフ（3件）
```

| テストケース | 検証内容 |
|------------|---------|
| 正常系: GPS取得済み | 打刻ボタンが `enabled` になること |
| 異常系: 許可拒否 (PERMISSION_DENIED) | `<Alert variant="destructive">` が表示され、ボタンが `disabled` であること |
| 再取得ボタン | ページを再読み込みせず（`window.location.reload` を呼ばず）、GPS監視だけをやり直すこと |
| 異常系: 位置取得失敗 (POSITION_UNAVAILABLE) | `<Alert>` が表示され、ボタンが `disabled` であること |
| オフライン: ボタンロック | オフライン時は GPS取得済みでも打刻ボタンがロックされること |
| オフライン: 説明 | オフライン時は理由を説明する Alert が表示されること |
| オンライン復帰 | オンラインに復帰すると打刻ボタンが再び押せるようになること |

### モック戦略

- `supabase` クライアントを `vi.mock` で完全モック化し、実ネットワーク接続なしでRPCのレスポンスを制御。
- `navigator.geolocation` は jsdom に存在しないため、テストごとに `Object.defineProperty` で差し込む（オフライン状態は `navigator.onLine` を同様に差し替える）。
- `useAuth` をモックして認証状態を固定し、Auth フローとテスト対象ロジックを分離。

---

## アーキテクチャ図（概要）

```
┌─────────────────────────────────────┐
│  React フロントエンド（Vite）         │
│                                     │
│  useAuth.tsx                        │
│  └─ onAuthStateChange（先行登録）   │
│                                     │
│  EvidenceCollector.tsx              │
│  └─ isButtonLocked（物理ロック）    │
│       ├─ GPS未取得 → disabled       │
│       └─ GPSエラー → disabled +     │
│             Alert Destructive       │
│                                     │
│  useEvidence.ts                     │
│  └─ submitEvidence()               │
│       ├─ RPC: get_nearest_facility  │
│       └─ RPC: issue_ticket         │
└───────────────┬─────────────────────┘
                │ HTTPS / Supabase SDK
┌───────────────▼─────────────────────┐
│  Supabase（PostgreSQL）             │
│                                     │
│  get_nearest_facility RPC           │
│  └─ 500m 圏内施設を Haversine で検索│
│                                     │
│  issue_ticket RPC                   │
│  ├─ wait_logs INSERT                │
│  ├─ arrival_time = DB サーバー時刻  │
│  └─ 500m 圏外は wait_logs の        │
│     ジオフェンストリガーが拒否      │
│                                     │
│  DBトリガー（改ざん防止）           │
│  ├─ タイムスタンプ強制上書き        │
│  ├─ 署名済み行の変更禁止            │
│  └─ DELETE / TRUNCATE 禁止         │
└─────────────────────────────────────┘
```

---

> **次のステップ**: 待機料自動計算ロジック（`wait_logs` の `work_end_time` 確定時のトリガー）および荷主向けダッシュボード表示の実装へ。
