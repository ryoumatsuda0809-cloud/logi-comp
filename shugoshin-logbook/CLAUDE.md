# Logi-Comp Project Rules
## Technical Stack
- Frontend: React (Vite), TypeScript, Tailwind CSS, Shadcn UI
- Backend: Supabase (Auth, DB, Functions, Storage)
- Environment: Ubuntu Linux (Case-sensitive file paths) - パスやインポートの大文字・小文字を厳格に区別すること。
## Build & Test Commands
- Install: npm install
- Dev: npm run dev
- Build: npm run build
## Coding Guidelines
- **Linux Case-Sensitivity**: Imports must exactly match filename casing.
- **Supabase RLS-First**: All database changes must include RLS policies.
- **Legal Compliance**: Data impacting "Waiting Fees" (待機料) must be immutable once signed.

## 📌 Architecture Baseline (Save Point)

- **Before starting any new feature design or implementation (Plan Mode)**, always load `@docs/IMPLEMENTATION_SUMMARY.md` as context to understand the current baseline, existing components, and implemented logic — this prevents duplicate implementations and unintended regressions.
## Development Rules
1. **DB操作の方針（2026-10-04 改定）**: このSupabaseプロジェクト（`qojhncmwmsqzycxrfezv`）は**デモ・開発用**として扱う（本番の個人情報は入れない）。
   - データの追加・更新（デモデータの投入、修正）は、Supabase MCP から直接実行してよい。確認は不要。
   - スキーマ変更（テーブル・列・RLS・RPC）は、直接実行しても、必ず `supabase/migrations/` にも同じ内容のファイルを残す（履歴と再現性のため）。RLS-First は維持する。
   - クライアントコードからの安易な`insert/update`は引き続き避け、RPC を経由する。
   - 証拠系テーブル（`wait_logs` / `waiting_evidence` / `pending_punches`）は、デモ用でも下の2に従い、直接書き込まない。
   - **削除（`DELETE` / `DROP` / `TRUNCATE` / 列や制約の削除）は下記「削除の手順」を必ず通す。**

### 削除の手順（省略不可）
不要なものの削除は許可されている。ただし実行前に、次の4つをユーザーに見せて、最終確認の返事を得てから実行する。
1. **対象**: 何を消すか（テーブル名・条件・件数・代表行）。
2. **影響調査**: 外部キー参照、ビュー、RPC・トリガー、RLSポリシー、アプリ側のコード参照（`grep`）を洗い出し、「消すと何が壊れるか」を具体的に書く。壊れるものが無ければ「無い」と根拠つきで書く。
3. **退避**: 削除前に対象行（または定義）をローカルのJSON/SQLに書き出しておく（置き場所はスクラッチパッド）。戻す手順も添える。
4. **判定**: 「消してよい」か「消すと悪い方向に行く」かを、理由つきで明示する。悪い方向（待機料の署名済みデータ、証拠の改ざん防止、他の機能が依存している等）なら、実行せず代替案を出す。
- 待機料の署名済みデータ（`is_signed`）と、`waiting_evidence` は、デモ用でも削除しない（法的な不変性の要件）。
- 全件削除（`WHERE` なし）、`DROP SCHEMA`、`db reset` は、ユーザーが明示的に指示した場合でも、もう一度確認してから実行する。
2. **証拠系テーブルへの書き込み**: `wait_logs` / `waiting_evidence` / `pending_punches` は直接書き込み不可。必ず SECURITY DEFINER の RPC を入口にする。新しい関数は既定で誰も実行できないので、必要なロールにだけ `GRANT EXECUTE` する。DB変更の後は `supabase/tests/security_checks.sql` を実行する。
3. **型安全性の担保**: 変更後は必ず `npx tsc -p tsconfig.app.json --noEmit` で型エラーがないことを確認する。
   ルートの `tsconfig.json` は `files: []` なので `tsc --noEmit` だけでは何も検査されず、`npm run build`（`vite build`）も型を検査しない。
4. **コンテキストの参照**: 
   - データベース設計・RLSについては `@docs/CONTEXT_SUPABASE.md` を参照。
   - 取適法のビジネスロジックについては `@docs/CONTEXT_LEGAL_SPEC.md` を参照。
   - 水産流通適正化法（漁獲番号・対象魚種）については `@docs/CONTEXT_FISHERY_LAW.md` を参照。水産物情報の入力まわりを変更する前に必ず読むこと。
