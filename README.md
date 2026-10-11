# logi-comp

[![shugoshin-logbook CI](https://github.com/ryoumatsuda0809-cloud/logi-comp/actions/workflows/shugoshin-ci.yml/badge.svg?branch=main)](https://github.com/ryoumatsuda0809-cloud/logi-comp/actions/workflows/shugoshin-ci.yml)

読む順番:
1. まず [公開デモ](https://shugoshin-logbook.vercel.app/demo) を触る（ログイン不要・架空データ）。
2. 次に [設計判断と理由](./shugoshin-logbook/README.md#設計判断と理由) を読む。
3. 最後に [`supabase/migrations/`](./shugoshin-logbook/supabase/migrations/README.md) で、その判断が DB にどう入っているかを見る。

このリポジトリの主題は **[`shugoshin-logbook/`](./shugoshin-logbook/README.md)**（守護神）です。
トラックドライバーの荷待ち時間を、改ざんしにくい形で記録して待機料の根拠にする Web アプリで、設計判断・構成図・テストと CI・既知の課題は `shugoshin-logbook/README.md` にまとめています。

公開デモ（ログイン不要・架空データ）: <https://shugoshin-logbook.vercel.app/demo>

CI: [`.github/workflows/shugoshin-ci.yml`](./.github/workflows/shugoshin-ci.yml)（型チェック・テスト・ビルド）。
