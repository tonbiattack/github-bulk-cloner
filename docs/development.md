# 開発とテスト

## 構成

```text
extension/                 Chrome 拡張（Manifest V3）
  manifest.json
  background.js            service worker。Native Messaging を所有する
  lib/repo-url.js          URL 判定の純粋ロジック（DOM 非依存）
  content/content.js       候補抽出とチェックボックス
  content/content.css
  popup/                   一覧・保存先・実行結果
  icons/                   16 / 32 / 48 / 128 px のアイコン
  test/                    Node テストと Chrome 実機テスト
native-host/               Go ネイティブホスト
  cmd/host/main.go         プロトコルループ
  internal/protocol/       長さ付き JSON フレーム
  internal/validate/       owner/repo とパスの検証
  internal/clone/          git / gh の実行
installer/                 ビルド・登録・解除・疎通確認
tools/                     アイコン生成などの開発用スクリプト
docs/                      手順書
```

## アイコン

アイコンは `tools/make-icons.ps1` で生成します。手で描き直すのではなく、このスクリプトを編集して再生成してください。

```powershell
.\tools\make-icons.ps1
```

- 512×512 の座標系で定義し、各サイズの 4 倍で描いてから高品質に縮小するため、16px でも判読できる
- 意匠は「下向き矢印がトレイに入る」形で、clone 先フォルダへの取り込みを表す
- 背景は GitHub の緑のグラデーション。明暗どちらのツールバーでも視認できる
- `manifest.json` の `icons` と `action.default_icon` の両方に登録する
- ポップアップのヘッダーは `icons/icon-32.png` を表示する

サイズを変える場合:

```powershell
.\tools\make-icons.ps1 -Sizes 16,32,48,128,256
```

## 設計上の要点

### 責務の分離

- **content script** は DOM だけを扱う。候補抽出の判定は `lib/repo-url.js` に閉じ込め、DOM なしでテストできるようにしている。
- **service worker** が Native Messaging を所有する。ポップアップは開閉されるため、実行状態は worker 側に置き、ポップアップは購読するだけにしている。
- **Go ホスト** はプロトコル・検証・実行を別パッケージに分ける。`main` は組み立てとループだけ。

### 実行状態の保持

MV3 の service worker はアイドルで停止します。停止するとメモリ上の状態は失われるため、実行状態を `chrome.storage.session` にミラーし、次回起動時に復元します。

- 完了済みの実行は、worker が再起動してもポップアップに結果が残る
- 実行中に worker が停止した場合は `error` として復元し、再実行を促す（`running` のまま放置しない）
- 復元は初回の `gbc:getRunState` で行い、新しい実行を上書きしない

### 安全性

| 対策 | 実装 |
| --- | --- |
| 任意 URL の拒否 | `validate.RepoSpec` が `owner/repo` 以外を拒否する |
| シェルを介さない | `exec.CommandContext` に固定引数を渡す。`cmd.exe` / PowerShell を使わない |
| オプション注入の拒否 | 先頭 `-` のリポジトリ名を拒否し、`git clone --` で区切る |
| パストラバーサル | `..` を拒否し、`validate.Contains` で保存先が root 配下か確認する |
| ジャンクション / シンボリックリンク | owner ディレクトリを `EvalSymlinks` で解決し、root 外なら拒否する |
| 既存ディレクトリ | `Lstat` で存在を確認し、上書き・削除・pull をしない |
| 認証情報の漏洩 | `GIT_TERMINAL_PROMPT=0` などで対話を無効化し、出力から URL の userinfo を伏せる |
| 拡張の制限 | `allowed_origins` に当該拡張 ID のみを登録する |

### 冪等な DOM 操作

GitHub は SPA で頻繁に再描画されます。content script は次を守ります。

- 1 リポジトリにつきチェックボックスは 1 つだけ（`entries` マップで管理）
- 1 行につき候補は 1 つだけ（`primaryAnchor` が主リンクを選ぶ）
- 再描画で消えたチェックボックスは次のスキャンで作り直す
- `MutationObserver` の連続発火は `requestAnimationFrame` + 遅延でまとめる

フォークの行には「Forked from `<owner>/<repo>`」というリンクも含まれます。行単位で主リンクだけを採用することで、上流リポジトリを誤って候補にしないようにしています。

### 拡張の再読み込みへの追従

拡張を再読み込み・削除すると、**既に開いているページの content script は孤立**します。その状態で `chrome.runtime` を呼ぶと `Extension context invalidated` が同期的に投げられ、`.catch()` では捕まえられません。

そのため content script は次を行います。

- `isContextValid()` で `chrome.runtime.id` の有無を確認してから呼ぶ
- `sendMessageSafely()` が同期例外も含めて握りつぶし、無効化を検知する
- 無効化を検知したら `teardown()` でチェックボックスとツールバーを撤去し、以降のスキャンを止める

これにより、再読み込み後に古いタブが残っていてもエラーが出ず、死んだ UI も残りません。ページを再読み込みすれば新しい content script が入ります。

## テスト

### Go

```powershell
cd native-host
go vet ./...
go test ./... -short        # ネットワーク不要
go test ./...               # 実クローンを含む
```

`-short` を付けると `TestCloneRealRepository` をスキップします。このテストは `octocat/Hello-World` を実際に clone し、2 回目が skip になることまで確認します。ネットワークが無い環境では自動的に skip されます。

主なテスト:

| ファイル | 対象 |
| --- | --- |
| `internal/protocol/protocol_test.go` | フレームの読み書き、長さ上限、切り詰め、並行書き込み |
| `internal/validate/validate_test.go` | `owner/repo` の許可・拒否、root 検証、パス封じ込め、ジャンクション逸脱 |
| `internal/clone/runner_test.go` | 不正入力の事前拒否、既存 skip、認証エラー判定、メッセージ整形、実クローン |
| `internal/clone/conflict_test.go` | 同名リポジトリの衝突検出、リモート不明時の扱い、owner 配置 |
| `internal/validate/remote_test.go` | GitHub リモート URL の解析、レイアウト別の保存先 |
| `cmd/host/main_test.go` | ping、未対応種別、入力検証、重複排除、失敗後も継続、EOF |
| `cmd/host/conflict_test.go` | 衝突の summary、レイアウト指定、ping の capabilities |

### 拡張（Node）

```powershell
node --test extension/test/
```

`lib/repo-url.js` の判定を 17 ケースで検証します。DOM は使いません。

### 拡張（実機 Chrome）

実際の Chrome に拡張を読み込み、GitHub の実ページで動作を確認します。Chrome 130 以降は `--load-extension` が無効なため、CDP の `Extensions.loadUnpacked` を使います。

```powershell
# 1. 検証用プロファイルで Chrome を起動する
$profile = Join-Path $env:TEMP 'gbc-chrome-test'
& 'C:\Program Files\Google\Chrome\Application\chrome.exe' `
  "--user-data-dir=$profile" --remote-debugging-port=9335 about:blank

# 2. 拡張を読み込み、ID を取得する
$env:CDP_PORT = '9335'
node extension/test/cdp-load.js extension
# => extensionId=<32文字>

# 3. その ID でネイティブホストを登録する
.\installer\install.ps1 -ExtensionId <32文字> -InstallDir (Join-Path $env:TEMP 'gbc-live')

# 4. 実機テストを実行する
$cloneRoot = Join-Path $env:TEMP 'gbc-e2e'
New-Item -ItemType Directory -Path $cloneRoot -Force | Out-Null
node extension/test/cdp-e2e.js <32文字> $cloneRoot
```

`cdp-e2e.js` が確認する内容:

- マニフェスト名、保存先の読み書き
- ネイティブホストの ping/pong
- 実ページでの候補抽出、チェックボックス数、行あたりの重複なし
- フォークの上流リンクを候補にしないこと
- 全選択・全解除・再スキャンでの重複なし
- 実際の clone と結果表示、秘密情報が混ざらないこと

チェック時の自動 clone は別スクリプトで確認します。保存先を存在しないパスにして、フォルダ作成まで検証します。

```powershell
$env:CDP_PORT = '9339'
node extension/test/cdp-autoclone-e2e.js <32文字> (Join-Path $env:TEMP 'gbc-autoclone-scratch')
```

`cdp-autoclone-e2e.js` が確認する内容:

- チェックを付けたリポジトリだけが clone される
- 保存先フォルダが無ければ作成される
- clone 先が `<root>/<repo>` で、owner フォルダが作られない
- 行に状態バッジが出て、最終結果（clone 済み / 既にあります / 失敗）に変わる
- 既にあるリポジトリを再チェックすると `skipped` になる

拡張の再読み込みで content script が孤立したときの挙動は別スクリプトで確認します。

```powershell
$env:CDP_PORT = '9339'
node extension/test/cdp-invalidate-e2e.js <32文字>
```

`cdp-invalidate-e2e.js` が確認する内容:

- ページを開いたまま拡張を再読み込みしても `Extension context invalidated` が出ない
- 孤立したチェックボックスとツールバーが撤去される

このテストは修正前のコードに対して実行すると失敗する（例外が出て UI も残る）ため、回帰検出に使えます。

GitHub Repo Sorter との併用は別スクリプトで確認します。両方の拡張を同じ Chrome に読み込んでから実行します。

```powershell
# 1. 並べ替え拡張と一緒に Chrome を起動する
$profile = Join-Path $env:TEMP 'gbc-compat'
$sorter = 'C:\apps\github-repo-sorter\dist'
$cloner = (Resolve-Path extension).Path
& 'C:\Program Files\Google\Chrome\Application\chrome.exe' `
  "--user-data-dir=$profile" --remote-debugging-port=9337 `
  "--disable-extensions-except=$sorter,$cloner" "--load-extension=$sorter,$cloner" about:blank

# 2. 互換テストを実行する
$env:CDP_PORT = '9337'
node extension/test/cdp-sorter-compat.js
```

`cdp-sorter-compat.js` が確認する内容:

- 並べ替え中は `#user-repositories-list` が非表示でも、見えている `[data-grs-list]` にチェックボックスが付く
- 非表示の一覧にはチェックボックスが残らない（クリックできない場所に付けない）
- 標準表示に切り替えるとネイティブ一覧側へ移り、独自ソートへ戻すと重複せず戻る
- チェックで行が選択され、ページ送り後も 1 行 1 チェックボックスを保つ

診断表示と衝突判定は別スクリプトで確認します。

```powershell
$env:CDP_PORT = '9339'
node extension/test/cdp-diagnostics-e2e.js <32文字> (Join-Path $env:TEMP 'gbc-diag-scratch')
```

`cdp-diagnostics-e2e.js` が確認する内容:

- 正常なホストが `ok` と capabilities（git / OS）を返す
- ポップアップが「接続 OK」を表示し、セットアップ案内を隠す
- 別 owner の同名リポジトリが `conflict` になり、既存リポジトリ名を含む
- 衝突が `skipped` に数えられない
- 同じリポジトリは従来どおり `skipped` になる
- owner 配置が入れ子のパスを指し、衝突しない
- レイアウト設定が保存・復元される

異常系（ホスト未登録など）は手動で確認します。

```powershell
# ホストを一時的に登録解除して、バッジが「未登録」になり
# セットアップ案内が出ることを確認する
Remove-Item 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.tonbiattack.github_bulk_cloner' -Recurse
# 確認後に戻す
.\installer\setup.ps1 -Repair
```

### ホスト単体

Chrome を介さず、プロトコルを直接叩いて確認できます。

```powershell
.\installer\test-host.ps1                              # ping のみ
.\installer\test-clone.ps1 -Repositories 'octocat/Hello-World'   # 実クローン
```

## メッセージ仕様

拡張 → ホスト（clone）:

```json
{"type":"clone","requestId":"...","root":"C:\\apps","repositories":["owner/repo"]}
```

ホスト → 拡張（リポジトリ単位）:

```json
{"type":"result","requestId":"...","repository":"owner/repo","status":"success","path":"C:\\apps\\repo","method":"git"}
```

`status` は `success` / `skipped` / `conflict` / `failed`。`skipped` のときは `existingGitRepo` が付きます。`conflict` のときは `existingRepository` に占有している `owner/repo` が入ります。

ホスト → 拡張（完了）:

```json
{"type":"done","requestId":"...","summary":{"success":1,"skipped":0,"failed":0}}
```

ホスト → 拡張（要求単位のエラー）:

```json
{"type":"error","requestId":"...","code":"invalid_root","message":"..."}
```

`code` は `invalid_request` / `invalid_root` / `invalid_layout` / `git_missing` / `too_many_repositories` / `unsupported_type` / `cancelled`。

`ping` には `{"type":"pong","version":"0.1.0","capabilities":{...}}` が返ります。`capabilities` の内容は「ホスト診断」を参照してください。

## チェック時の自動 clone

チェックボックスにチェックを付けると、そのリポジトリを**その場で clone** します。GitHub のページを開いたまま実行できます。

- チェックを付けた瞬間に、そのリポジトリだけを clone する
- 行のチェックボックス横に状態を表示する（`clone 中…` / `clone 済み` / `既にあります` / `別リポジトリあり` / 失敗理由）
- **チェックを外しても clone はしない**。選択が外れるだけ
- 連続でチェックしても「すでに実行中」にならないよう、service worker 側でキューに積んで 1 件ずつ処理する

### 保存先の扱い

| 状況 | 挙動 |
| --- | --- |
| 保存先フォルダが無い | 親フォルダごと自動作成する |
| 保存先が相対パス | `invalid_root` で拒否する |
| 保存先がファイル | `invalid_root` で拒否する |
| 保存先に同名フォルダがある | 変更しない。下記の衝突判定を行う |
| 保存先が書き込めない | 作成に失敗し `invalid_root` を返す |

### 同名リポジトリの衝突判定

フラット配置では `ownerA/tool` と `ownerB/tool` が同じ `<root>/tool` を指します。取り違えを防ぐため、既存フォルダの `origin` リモートを読んで照合します。

| 既存フォルダの状態 | status | 意味 |
| --- | --- | --- |
| 同じ `owner/repo` | `skipped` | 既に clone 済み |
| 別の `owner/repo` | `conflict` | 別リポジトリが占有している。**上書きしない** |
| リモート不明 / GitHub 以外 | `skipped` | 確認できていないので、一致したとは言わない |
| Git リポジトリでない | `skipped` | 判定材料が無いので触らない |

`conflict` は `skipped` と別の status です。「既に clone 済み」と誤って伝えないために分けています。`summary` にも `conflict` として別に数えます。

衝突を避けたい場合は、ポップアップの「所有者ごとにフォルダを分ける」を有効にすると `<root>/<owner>/<repo>` に保存します。要求には `layout` として渡します。

```json
{"type":"clone","requestId":"...","root":"C:\\apps","layout":"owner","repositories":["owner/repo"]}
```

`layout` は `flat`（既定）または `owner`。それ以外は `invalid_layout` で拒否します。

### ホスト診断

ポップアップのバッジは、ホストが実際に報告した内容だけを表示します。ブラウザから観測できない Windows / Git / gh の状態を推測して表示することはありません。

`ping` の応答に `capabilities` が含まれます。

```json
{"type":"pong","version":"0.1.0","capabilities":{
  "gitAvailable":true,"ghAvailable":true,"ghAuthenticated":true,
  "os":"windows","arch":"amd64"}}
```

| 状態 | バッジ | 意味 |
| --- | --- | --- |
| `ok` | 接続 OK | 疎通し、Git も使える |
| `not-registered` | 未登録 | 未登録、またはこの拡張 ID 用に登録されていない |
| `git-missing` | Git なし | ホストは動くが Git が見つからない |
| `unresponsive` | 応答なし | ping に応答しない |
| `error` | 接続エラー | その他の接続失敗 |

**Chrome は「未登録」と「ID 不一致」を同じエラーとして返します。** そのため区別せず `not-registered` にまとめ、対処方法を併記します。区別できるかのように表示してはいけません。

## リリース

ネイティブホストのビルド済みバイナリは GitHub Actions が作ります。利用者は Go を入れずに済みます。

### 手順

1. `extension/manifest.json` の `version` を上げる
2. タグを push する

```powershell
git tag v0.2.0
git push origin v0.2.0
```

[`.github/workflows/release.yml`](../.github/workflows/release.yml) が次を行います。

- `go vet` と `go test -short`
- Windows amd64 向けのビルド（`CGO_ENABLED=0`、`-trimpath`、バージョンを ldflags で埋め込み）
- `SHA256SUMS.txt` の生成
- 拡張の zip 作成（`tools/package-extension.ps1`）
- GitHub Release の作成と添付

### リリースに含まれるもの

| ファイル | 用途 |
| --- | --- |
| `github-bulk-cloner-host-windows-amd64.exe` | ネイティブホスト本体 |
| `github-bulk-cloner-host.exe` | インストーラが参照する安定名（同一バイナリ） |
| `SHA256SUMS.txt` | チェックサム |
| `github-bulk-cloner-<version>.zip` | ストア提出用の拡張パッケージ |

### ローカルでの確認

CI と同じビルドを手元で再現できます。

```powershell
cd native-host
$env:GOOS='windows'; $env:GOARCH='amd64'; $env:CGO_ENABLED='0'
go build -trimpath -ldflags "-s -w -X main.version=0.2.0" `
  -o github-bulk-cloner-host-windows-amd64.exe ./cmd/host
Get-FileHash .\github-bulk-cloner-host-windows-amd64.exe -Algorithm SHA256
```

`tools/package-extension.ps1` はマニフェストを検証し、参照ファイルの存在を確認してから zip を作ります。

## ストア公開

`store/` に掲載文言・スクリーンショット・プロモ画像があります。手順は [store/README.md](../store/README.md) を参照してください。

公開後は `installer/store-extension-id.txt` に拡張 ID を記載します。`installer/setup.ps1` がこのファイルを読んで `allowed_origins` に設定します。

現在のストア版拡張 ID:

```text
gnahjocpcgihifhdgoabhednldpcdpgg
```

ID を確認するには、`chrome://extensions` でストア版の「ID」を見るか、次のコマンドでマニフェストを確認します。

```powershell
# setup.ps1 が読み取る ID
Get-Content .\installer\store-extension-id.txt | Where-Object { $_ -and -not $_.StartsWith('#') }
```

## 制約

- 同時実行は 1 リクエスト。リポジトリは順番に処理する。
- 1 リクエストあたり最大 200 リポジトリ。
- 1 リポジトリあたりのタイムアウトは 10 分。
- 保存先は既定で `<root>/<repo>` のフラット配置。`layout: "owner"` で `<root>/<owner>/<repo>` になる。
- 保存先フォルダが無ければ自動作成する。相対パスとファイルは拒否する。
- ストア版と開発版は同時に使えない（`allowed_origins` は 1 つの ID のみ）。
