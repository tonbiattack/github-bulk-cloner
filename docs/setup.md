# セットアップ手順（Windows）

GitHub Bulk Cloner を新しい Windows 環境で動かすまでの手順です。管理者権限は不要で、すべてユーザー単位で完結します。

導入方法は 2 つあります。

| 方法 | 対象 | Go |
| --- | --- | --- |
| [A. ストア版 / ビルド済みホスト](#a-ストア版--ビルド済みホストを使う) | 一般利用者 | 不要 |
| [B. ソースからビルド](#b-ソースからビルドする開発者向け) | 開発者 | 必要 |

## 前提条件

| ソフトウェア | バージョン | 確認コマンド |
| --- | --- | --- |
| Windows | 10 / 11 (x64) | — |
| Google Chrome | 102 以降 | `chrome://version` |
| Git for Windows | 任意の新しいもの | `git --version` |
| GitHub CLI（任意） | 2.x | `gh --version` |
| Go（方法 B のみ） | 1.24 以降 | `go version` |

`gh` は Private リポジトリの clone に使います。Public だけなら不要です。

## A. ストア版 / ビルド済みホストを使う

Go は不要です。

### 1. 拡張を入れる

Chrome Web Store から追加するか、開発版なら `chrome://extensions` で `extension` フォルダを読み込みます。

### 2. リポジトリを取得する

`setup.ps1` はリポジトリ内のスクリプトなので、先に取得します。

```powershell
git clone https://github.com/tonbiattack/github-bulk-cloner.git
cd github-bulk-cloner
```

### 3. セットアップを実行する

```powershell
.\installer\setup.ps1
```

ストア版は拡張 ID が固定なので、ID の指定は不要です。スクリプトが行うこと:

1. Git for Windows の存在確認（無ければエラーで停止）
2. GitHub Releases からビルド済みホストをダウンロード
3. `SHA256SUMS.txt` と照合してチェックサムを検証
4. ネイティブメッセージングマニフェストを作成
5. `HKCU` に登録
6. ホストへ ping を送り、pong を確認

成功すると最後に `pong を受信しました (version: 0.1.0)` と表示されます。

### 開発版の拡張を使う場合

開発版は拡張 ID が環境ごとに変わります。`chrome://extensions` で表示された ID を渡してください。

```powershell
.\installer\setup.ps1 -Dev -ExtensionId <32文字の拡張ID>
```

### オフライン / 手動でバイナリを置く場合

Releases から `github-bulk-cloner-host-windows-amd64.exe` をダウンロードしておき、パスを指定します。

```powershell
.\installer\setup.ps1 -HostPath .\github-bulk-cloner-host-windows-amd64.exe
```

### 修復とアンインストール

```powershell
# 壊れたときの再インストール
.\installer\setup.ps1 -Repair

# 登録とファイルの削除
.\installer\setup.ps1 -Uninstall
```

`setup.ps1` は、別の場所に既存の登録がある場合 `-Repair` を付けない限り上書きしません。個人用のセットアップを誤って壊さないための安全策です。

## B. ソースからビルドする（開発者向け）

### 1. リポジトリを取得する

```powershell
git clone https://github.com/tonbiattack/github-bulk-cloner.git
cd github-bulk-cloner
```

### 2. 拡張を Chrome に読み込む

1. `chrome://extensions` を開く
2. 右上の **デベロッパーモード** を有効にする
3. **パッケージ化されていない拡張機能を読み込む** を押す
4. このリポジトリの `extension` フォルダを選ぶ
5. 表示された **ID**（32文字の英字）を控える

> 拡張 ID はフォルダのパスから決まります。同じパスで読み込む限り変わりません。フォルダを移動すると ID が変わるため、その場合は手順 3 からやり直してください。

### 3. ネイティブホストをインストールする

控えた拡張 ID を `-ExtensionId` に渡します。

```powershell
.\installer\install.ps1 -ExtensionId <32文字の拡張ID>
```

スクリプトが行うこと:

1. `go` と `git` の存在確認
2. `native-host` をビルドして `%LOCALAPPDATA%\GitHubBulkCloner\github-bulk-cloner-host.exe` に配置
3. ネイティブメッセージングマニフェストを同じフォルダに作成
4. `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.tonbiattack.github_bulk_cloner` に登録
5. ホストへ ping を送り、pong が返ることを確認

成功すると最後に `pong を受信しました (version: 0.1.0)` と表示されます。

ビルド済みの exe を使う場合は `-PrebuiltExe` を渡せば Go なしで動きます。

```powershell
.\installer\install.ps1 -ExtensionId <32文字の拡張ID> `
  -PrebuiltExe .\github-bulk-cloner-host-windows-amd64.exe
```

### オプション

| オプション | 用途 |
| --- | --- |
| `-InstallDir <path>` | インストール先を変更する |
| `-SkipBuild` | ビルドを省略し、既存の exe を使う |
| `-SkipRegister` | レジストリに触らず、ビルドとマニフェスト作成だけ行う |
| `-Force` | 別のマニフェストが登録済みでも上書きする |

## 4. 拡張を再読み込みする（共通）

`chrome://extensions` で拡張の **再読み込み** ボタンを押します。マニフェストを変更したため、再読み込みしないと反映されません。

## 5. 動作確認（共通）

1. GitHub で自分のプロフィールの **Repositories** タブを開く
   （例: `https://github.com/<user>?tab=repositories`）
2. 各リポジトリの左にチェックボックスが表示される
3. 拡張アイコンを押すとポップアップが開く
4. 右上のバッジが **接続 OK** になっていることを確認する
5. 保存先フォルダを確認し、**Clone selected** を押す

成功すると `C:\apps\<repo>` に clone され、ポップアップに結果が並びます。

## チェックを付けて clone

GitHub のリポジトリ一覧ページで、欲しいリポジトリのチェックボックスにチェックを付けます。**その瞬間にそのリポジトリが clone されます。**

チェックボックスの横に状態が出ます。

| 表示 | 意味 |
| --- | --- |
| clone 中… | 実行中 |
| clone 済み | 新しく clone した |
| 既にあります | 同じリポジトリが既に clone 済みなので何もしなかった |
| 別リポジトリあり | 別のリポジトリが同じフォルダにある（衝突） |
| 失敗理由 | 認証エラーやネットワークなど |

チェックを外しても clone は走りません。選択が外れるだけです。複数チェックすれば、1 件ずつ順番に処理されます。

### 保存先フォルダ

- 保存先が無ければ**自動で作成**します（親フォルダも含む）
- clone 先は既定で `<保存先>\<repo>`（owner フォルダは作りません）
- 既に同名フォルダがある場合は**何もしません**。上書き・削除・pull はしません

### 既存フォルダの扱い

保存先に同名のフォルダがあると、そのフォルダの `origin` リモートを確認します。

| 確認結果 | 表示 | 動作 |
| --- | --- | --- |
| 同じリポジトリ | 既にあります | 何もしない |
| 別のリポジトリ | 別リポジトリあり | **何もしない**。衝突として明示する |
| リモート不明 | 既にあります | 何もしない（確認できたことにしない） |

フラット配置では `ownerA/tool` と `ownerB/tool` が同じフォルダを指します。別のリポジトリを取り違えないよう、リモートで照合して衝突を検出します。

所有者の異なる同名リポジトリを扱う場合は、ポップアップの「所有者ごとにフォルダを分ける」を有効にしてください。保存先が `<保存先>\<owner>\<repo>` になります。

更新したい場合は、そのフォルダで手動で `git pull` してください。

## 対応ページ

チェックボックスが出るのは次のページです。

- プロフィール / Organization の Repositories タブ（`?tab=repositories`）
- リポジトリ検索結果（`/search?type=repositories`）
- トピックページ（`/topics/<topic>`）
- Organization のリポジトリ一覧（`/orgs/<org>/repositories`）
- ユーザーのリポジトリ一覧（`/<user>/repositories`）

リポジトリ内のページ（`/owner/repo/issues` など）は対象外です。

## Private リポジトリを使う

`gh` にログインしておくと、Private リポジトリは自動的に `gh repo clone` で処理されます。

```powershell
gh auth login
gh auth status
```

ホストは `gh repo view` で visibility を確認し、Private / Internal なら `gh` を使います。Public の clone が認証エラーで失敗した場合も、`gh` が使えれば一度だけ再試行します。

## アンインストール

```powershell
# ストア版 / ビルド済みホスト
.\installer\setup.ps1 -Uninstall

# ソースからビルドした場合
.\installer\uninstall.ps1
```

レジストリ登録と `%LOCALAPPDATA%\GitHubBulkCloner` を削除します。ファイルを残す場合は `uninstall.ps1` に `-KeepFiles` を付けます。最後に `chrome://extensions` から拡張自体を削除してください。

## トラブルシューティング

### ポップアップのバッジが「接続 OK」にならない

バッジは状態ごとに表示が変わります。まずバッジを確認してください。

| バッジ | 意味 | 対処 |
| --- | --- | --- |
| 未登録 | ホストが未登録、またはこの拡張 ID 用に登録されていない | `setup.ps1`（開発版は `setup.ps1 -Dev -ExtensionId <ID>`）を実行する |
| Git なし | ホストは動くが Git が見つからない | Git for Windows を入れ、PATH に追加する |
| 応答なし | ホストの起動に失敗している | `setup.ps1 -Repair` で再インストールする |
| 接続エラー | その他の接続失敗 | ポップアップに出る詳細を確認する |

> Chrome は「未登録」と「ID 不一致」を同じエラーとして返します。そのためアプリ側でも区別せず、まとめて「未登録」と表示します。

ポップアップは、ホストが報告した情報（Git / gh / OS）だけを表示します。ブラウザから取得できない情報を推測して表示することはありません。

ホスト単体が応答するかは次で確認できます。

```powershell
.\installer\test-host.ps1

# レジストリの登録先を確認する
Get-ItemProperty 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.tonbiattack.github_bulk_cloner'
```

### 「Git が見つかりません」と出る

Git for Windows をインストールし、`git` が PATH に入っていることを確認してください。

```powershell
git --version
```

### 「保存先フォルダが使用できません」と出る

保存先は**絶対パス**である必要があります。存在しないフォルダは自動作成されますが、相対パスは受け付けません。

```powershell
# 絶対パスで指定する（例）
C:\apps
```

権限が無い場所（`C:\Program Files` など）を指定した場合も失敗します。`C:\apps` のような書き込める場所を指定してください。

### Private リポジトリで「リポジトリが見つかりません」と出る

`gh` が未認証か、そのリポジトリへの権限がありません。

```powershell
gh auth status
gh auth login
```

### チェックボックスが表示されない

- 対応ページか確認する（上記「対応ページ」）
- 拡張を再読み込みした直後は、ページも再読み込みする
- GitHub の DOM が変わると検出できなくなることがある。その場合は `extension/content/content.js` の `LIST_CONTAINERS` にセレクタを追加する

### ホストのログを見たい

ホストの診断ログは stderr に出ます。Chrome 経由の場合、stderr は Chrome のログに含まれます。単体で確認するときは `installer\test-clone.ps1` を使ってください。

```powershell
.\installer\test-clone.ps1 -Repositories 'octocat/Hello-World'
```
