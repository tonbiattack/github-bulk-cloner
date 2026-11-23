# 競合調査: Quick Clone

調査日: 2026-11-23

## 対象
- 名称: **Quick Clone**（開発元: better0027）
- Chrome Web Store: https://chromewebstore.google.com/detail/quick-clone/ldioniplnonmligcnajkanmnpmcankna
- 外部掲載情報: https://chrome-stats.com/d/ldioniplnonmligcnajkanmnpmcankna

## 調査で確認できたこと
| 項目 | 内容 | 根拠 |
|---|---|---|
| 対応サービス | GitHub / GitLab | Chrome Web Store の説明 |
| 基本用途 | Web上からワンクリックで選択したローカルフォルダに git clone（ターミナル操作不要と説明） | Chrome Web Store の説明 |
| 開発元 | better0027 | Chrome Web Store |
| バージョン | 1.1.5 | Chrome Web Store 掲載時点 |
| 最終更新 | 2026-09-12 | Chrome Web Store 掲載時点 |
| 評価 | 評価なし | Chrome Web Store 掲載時点 |
| 利用者数 | 10人（2026-10-05時点の第三者集計） | Chrome-Stats |
| 拡張権限 | `storage`, `activeTab`, `nativeMessaging` | Chrome-Stats |

### 調査の限界
- ストアで公開されている説明と第三者サイトの権限情報を確認した。**拡張のインストール・ソースコード・通信処理の実機検証はしていない**。
- `nativeMessaging` 権限が掲載されているが、実際のクローンが Native Messaging 経由か、別のローカル通信経由かは未確認。
- リポジトリ一覧上のチェックボックス、複数選択、一括クローン、Private リポジトリ対応、既存フォルダ時の挙動は未確認。
- 調査範囲では公式の公開ソースリポジトリを特定できなかった。「非公開である」と断定はしない。
- 第三者サイトのセキュリティスコアは独自評価であり、悪意ある拡張と断定する根拠にはならない。
- 利用者数・バージョン・権限などは変化し得る。再調査時は一次情報を優先する。

## 自作 github-bulk-cloner との差別化
| 項目 | Quick Clone | 本プロジェクトのMVP |
|---|---|---|
| GitHub Webからclone | ストア説明上対応 | 対応 |
| 保存先の指定 | ストア説明上対応 | 対応 |
| GitHub一覧ページ内で複数選択 | 未確認 | **対応予定** |
| 選択対象を一括clone | 未確認 | **対応予定** |
| 成功・失敗・既存skipを個別表示 | 未確認 | **対応予定** |
| Goによるローカル処理 | 実装不明 | **Go Native Host** |
| ソースの確認・改造 | 公開元未確認 | **公開リポジトリ** |

## 開発方針への示唆
Quick Clone が提供する「単独リポジトリをワンクリックでclone」は既存機能と重なる。したがって本プロジェクトでは **GitHubのリポジトリ一覧を見ながら複数選び、まとめて安全にcloneできる操作性** に集中する。

### 今後確認したいこと
1. Quick Clone を隔離した検証用Chromeプロファイルでインストールし、UIとNative Hostの導入手順を確認する。
2. GitHubプロフィールのRepositories一覧で、複数選択または一括cloneに対応するかを試す。
3. Private リポジトリ、既存ディレクトリ、失敗時の結果表示を確認する。
4. 公開されたコードや実装ドキュメントがあれば、Native Messagingの設計を参考にする（ライセンスを確認）。

## 参考情報
- Chrome Web Store（一次情報）: https://chromewebstore.google.com/detail/quick-clone/ldioniplnonmligcnajkanmnpmcankna
- Chrome-Stats（第三者情報）: https://chrome-stats.com/d/ldioniplnonmligcnajkanmnpmcankna
- Native Messaging 公式ドキュメント: https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
