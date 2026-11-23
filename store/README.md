# Chrome Web Store 公開用の資材

このディレクトリには、Chrome Web Store に公開するための素材と、申請時にそのまま貼れる文言を置いています。

## 収録物

```text
store/
  screenshots/
    01-repository-list.png     1280x800  一覧にチェックボックスが出ている状態
    02-clone-complete.png   1280x800  チェック後に clone が走った状態
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

- [x] `extension/manifest.json` の `version` を確認した
- [x] `description` が 132 文字以内
- [x] スクリーンショットが 1280x800
- [x] プロモタイル 440x280 を用意した
- [x] プライバシーポリシーを HTTPS で公開した
- [x] 権限の利用目的を説明できる
- [x] ネイティブホストが別途必要な旨を説明に書いた
- [x] スクリーンショットに個人パスが写っていない
- [ ] `installer/store-extension-id.txt` に公開後の拡張 ID を記載した
- [ ] ストアダッシュボードで申請した

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

GitHub Pages で公開しています。

```text
https://tonbiattack.github.io/github-bulk-cloner/privacy-policy.html
```

原本は [docs/privacy-policy.md](../docs/privacy-policy.md) です。内容を変えたら、このファイルを編集して push すれば Pages に反映されます（`main` ブランチの `docs/` を公開元に設定済み）。

ストア申請の「プライバシーポリシー URL」には上記 URL を入力してください。

## ストア版のインストール導線

ストア版は拡張 ID が固定なので、利用者は ID を転記しません。

1. ストアから拡張を追加する
2. [GitHub Releases](https://github.com/tonbiattack/github-bulk-cloner/releases) から `github-bulk-cloner-host-windows-amd64.exe` をダウンロードする
3. PowerShell で `installer\setup.ps1` を実行する

`setup.ps1` は次を一括で行います。

- Git for Windows の存在確認
- ビルド済みホストのダウンロードと SHA256 検証
- マニフェスト作成と HKCU 登録
- ホストへの ping による疎通確認

`-Repair` で再インストール、`-Uninstall` で登録とファイルの削除ができます。

### ストア公開後に必要な作業

`installer/store-extension-id.txt` に、公開された拡張 ID を 1 行で記載してください。`setup.ps1` はこのファイルを読んで `allowed_origins` に設定します。空のままだと「拡張 ID が分かりません」と表示して停止します。

## 審査で聞かれやすい点

**「ネイティブホストが必要」と明記する。** この拡張は単体では動きません。ストアの説明とスクリーンショットの両方で、Windows 用ホストのインストールが必要だと分かるようにしてください。審査で「動作しない」と判定されるのを避けられます。

**`nativeMessaging` の用途を具体的に書く。** 「ローカルで git clone を実行するため」と明示します。

**リモートコードを実行しないことを書く。** 拡張は同梱の JS だけを実行します。

## ストア版と開発版の共存

`allowed_origins` は 1 つの ID しか持てないため、ストア版と開発版を同じ端末で同時に使うことはできません。両方試す場合は、片方を使うときに `setup.ps1 -Dev -ExtensionId <ID>` で登録し直してください。`setup.ps1` は別の場所に登録がある場合、`-Repair` を付けない限り上書きしません。
