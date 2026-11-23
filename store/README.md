# Chrome Web Store 公開用の資材

このディレクトリには、Chrome Web Store に公開するための素材と、申請時にそのまま貼れる文言を置いています。

## 収録物

```text
store/
  screenshots/
    01-repository-list.png     1280x800  一覧にチェックボックスが出ている状態
    02-clone-in-progress.png   1280x800  チェック後に clone が走った状態
    03-popup-results.png       1280x800  ポップアップと実行結果
  promo/
    small-440x280.png          440x280   小さいプロモーションタイル
    marquee-1400x560.png       1400x560  マーキータイル
    popup-closeup.png          380x可変  ポップアップ単体（素材用）
  listing.md                   ストアに貼る文言
```

## 素材の再生成

スクリーンショットとプロモ画像はスクリプトで生成します。手で撮り直す必要はありません。

```powershell
# 1. 検証用プロファイルで Chrome を起動する
$profile = Join-Path $env:TEMP 'gbc-store-shots'
& 'C:\Program Files\Google\Chrome\Application\chrome.exe' `
  "--user-data-dir=$profile" --remote-debugging-port=9350 about:blank

# 2. 拡張を読み込む
$env:CDP_PORT = '9350'
node extension/test/cdp-load.js extension
# => extensionId=<32文字>

# 3. その ID でネイティブホストを登録する
.\installer\install.ps1 -ExtensionId <32文字> -InstallDir (Join-Path $env:TEMP 'gbc-store-host')

# 4. 素材を撮影する
$cloneRoot = Join-Path $env:TEMP 'gbc-store-clones'
New-Item -ItemType Directory -Path $cloneRoot -Force | Out-Null
node tools/capture-store-assets.js <32文字> $cloneRoot
```

スクリーンショットには実際の GitHub ページと実データが写ります。公開前に、写り込んだリポジトリ名やパスに問題がないか確認してください。

## 提出前チェックリスト

- [ ] `extension/manifest.json` の `version` を上げた
- [ ] `description` が 132 文字以内
- [ ] スクリーンショットが 1280x800（または 640x400）
- [ ] プロモタイル 440x280 を用意した（任意だが推奨）
- [ ] プライバシーポリシーを用意した（下記）
- [ ] 権限の利用目的を説明できる（下記）
- [ ] ネイティブホストが別途必要な旨を説明に書いた

## 権限の正当性

ストアの審査では、各権限の利用目的を聞かれます。以下をそのまま使えます。

| 権限 | 用途 |
| --- | --- |
| `storage` | 保存先フォルダの設定を保持するため |
| `nativeMessaging` | ローカルの Go ホストと通信し、`git clone` を実行するため |
| `tabs` | ポップアップから現在のタブの選択状態を取得するため |
| `host_permissions: https://github.com/*` | リポジトリ一覧のリンクを検出し、チェックボックスを表示するため |

リモートコードは実行しません。外部サーバーへの送信も行いません。

## プライバシーポリシー

ストアはプライバシーポリシーの URL を要求します。以下をそのまま HTML として公開してください（GitHub Pages など）。

```markdown
# プライバシーポリシー — GitHub Bulk Cloner

最終更新: 2026-11-23

## 収集する情報

本拡張は、いかなる個人情報も収集・送信しません。

## 取り扱うデータ

- 保存先フォルダのパス: ブラウザ内（chrome.storage.local）にのみ保存します。
- 選択したリポジトリ名: ローカルのネイティブホストに渡し、git clone の実行にのみ使用します。

いずれも外部サーバーへ送信しません。

## 権限の用途

- storage: 保存先フォルダの設定を保持するため
- nativeMessaging: ローカルの Go ホストと通信するため
- tabs: 現在のタブの選択状態を取得するため
- https://github.com/*: リポジトリ一覧にチェックボックスを表示するため

## 第三者提供

行いません。解析ツールも組み込んでいません。

## 変更

本ポリシーを変更する場合は、このページを更新します。

## 連絡先

GitHub リポジトリの Issue までお願いします。
```

## 審査で聞かれやすい点

**「ネイティブホストが必要」と明記する。** この拡張は単体では動きません。ストアの説明とスクリーンショットの両方で、Windows 用ホストのインストールが必要だと分かるようにしてください。審査で「動作しない」と判定されるのを避けられます。

**`nativeMessaging` の用途を具体的に書く。** 「ローカルで git clone を実行するため」と明示します。

**リモートコードを実行しないことを書く。** 拡張は同梱の JS だけを実行します。
