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
  test/                    Node テストと Chrome 実機テスト
native-host/               Go ネイティブホスト
  cmd/host/main.go         プロトコルループ
  internal/protocol/       長さ付き JSON フレーム
  internal/validate/       owner/repo とパスの検証
  internal/clone/          git / gh の実行
installer/                 ビルド・登録・解除・疎通確認
docs/                      手順書
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
| `cmd/host/main_test.go` | ping、未対応種別、入力検証、重複排除、失敗後も継続、EOF |

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

### ホスト単体

Chrome を介さず、プロトコルを直接叩いて確認できます。

```powershell
.\installer\test-host.ps1                              # ping のみ
.\installer\test-clone.ps1 -Repositories 'octocat/Hello-World'   # 実クローン
```

## メッセージ仕様

拡張 → ホスト:

```json
{"type":"clone","requestId":"...","root":"C:\\apps","repositories":["owner/repo"]}
```

ホスト → 拡張（リポジトリ単位）:

```json
{"type":"result","requestId":"...","repository":"owner/repo","status":"success","path":"C:\\apps\\owner\\repo","method":"git"}
```

`status` は `success` / `skipped` / `failed`。`skipped` のときは `existingGitRepo` が付きます。

ホスト → 拡張（完了）:

```json
{"type":"done","requestId":"...","summary":{"success":1,"skipped":0,"failed":0}}
```

ホスト → 拡張（要求単位のエラー）:

```json
{"type":"error","requestId":"...","code":"invalid_root","message":"..."}
```

`code` は `invalid_request` / `invalid_root` / `git_missing` / `too_many_repositories` / `unsupported_type` / `cancelled`。

`ping` には `{"type":"pong","version":"0.1.0"}` が返ります。

## 制約

- 同時実行は 1 リクエスト。リポジトリは順番に処理する。
- 1 リクエストあたり最大 200 リポジトリ。
- 1 リポジトリあたりのタイムアウトは 10 分。
- 保存先 root は事前に存在している必要がある（ホストは作らない）。
- フラット保存（`<root>/<repo>`）は未対応。常に `<root>/<owner>/<repo>`。
