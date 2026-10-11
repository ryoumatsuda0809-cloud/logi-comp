# logi-comp

このリポジトリの主題は **[`shugoshin-logbook/`](./shugoshin-logbook/README.md)**（守護神）です。
トラックドライバーの荷待ち時間を、改ざんしにくい形で記録して待機料の根拠にする Web アプリで、設計判断・構成図・テストと CI・既知の課題は `shugoshin-logbook/README.md` にまとめています。

公開デモ（ログイン不要・架空データ）: <https://shugoshin-logbook.vercel.app/demo>

[![CI](https://github.com/ryoumatsuda0809-cloud/logi-comp/actions/workflows/shugoshin-ci.yml/badge.svg)](https://github.com/ryoumatsuda0809-cloud/logi-comp/actions/workflows/shugoshin-ci.yml)

CI: [`.github/workflows/shugoshin-ci.yml`](./.github/workflows/shugoshin-ci.yml)（型チェック・テスト・ビルド）。

## 読む順番

1. **デモ**: 上の公開デモ。ログイン不要で、打刻から日報・発注書までの流れを触れます。
2. **設計判断**: [`shugoshin-logbook/README.md`](./shugoshin-logbook/README.md) の「設計判断と理由」と「既知の課題」。
3. **DB の設計**: [`shugoshin-logbook/supabase/migrations/`](./shugoshin-logbook/supabase/migrations/)（RLS・トリガー・RPC）。

`shugoshin-logbook/STATUS.md` は開発中の作業メモです。経緯の記録なので、読む必要はありません。
