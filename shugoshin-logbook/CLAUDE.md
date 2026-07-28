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
1. **DB変更の禁止**: コンソールからの直接編集やクライアントからの安易な`insert/update`を避け、必ずSupabase Migration (`supabase migration new`) と RPC を経由すること。
2. **型安全性の担保**: 変更後は必ず `npm run build` または `tsc --noEmit` で型エラーがないことを確認する。
3. **コンテキストの参照**: 
   - データベース設計・RLSについては `@docs/CONTEXT_SUPABASE.md` を参照。
   - 取適法のビジネスロジックについては `@docs/CONTEXT_LEGAL_SPEC.md` を参照。
   - 水産流通適正化法（漁獲番号・対象魚種）については `@docs/CONTEXT_FISHERY_LAW.md` を参照。水産物情報の入力まわりを変更する前に必ず読むこと。
