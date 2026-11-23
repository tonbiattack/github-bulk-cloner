# セットアップ手順（Windows）

GitHub Bulk Cloner を新しい Windows 環境で動かすまでの手順です。管理者権限は不要で、すべてユーザー単位で完結します。

## 前提条件

| ソフトウェア | バージョン | 確認コマンド |
| --- | --- | --- |
| Windows | 10 / 11 | — |
| Google Chrome | 102 以降 | `chrome://version` |
| Go | 1.24 以降 | `go version` |
| Git for Windows | 任意の新しいもの | `git --version` |
| GitHub CLI（任意） | 2.x | `gh --version` |

`gh` は Private リポジトリの clone に使います。Public だけなら不要です。

## 1. リポジトリを取得する

```powershell
git clone https://github.com/tonbiattack/github-bulk-cloner.git
cd github-bulk-cloner
```

## 2. 拡張を Chrome に読み込む

1. `chrome://extensions` を開く
2. 右上の **デベロッパーモード** を有効にする
3. **パッケージ化されていない拡張機能を読み込む** を押す
4. このリポジトリの `extension` フォルダを選ぶ
5. 表示された **ID**（32文字の英字）を控える

> 拡張 ID はフォルダのパスから決まります。同じパスで読み込む限り変わりません。フォルダを移動すると ID が変わるため、その場合は手順 3 からやり直してください。

## 3. ネイティブホストをインストールする

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

### オプション

| オプション | 用途 |
| --- | --- |
| `-InstallDir <path>` | インストール先を変更する |
| `-SkipBuild` | ビルドを省略し、既存の exe を使う |
| `-SkipRegister` | レジストリに触らず、ビルドとマニフェスト作成だけ行う |
| `-Force` | 別のマニフェストが登録済みでも上書きする |

## 4. 拡張を再読み込みする

`chrome://extensions` で拡張の **再読み込み** ボタンを押します。マニフェストを変更したため、再読み込みしないと反映されません。

## 5. 動作確認

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
| 既にあります | 保存先に同名フォルダがあったので何もしなかった |
| 失敗理由 | 認証エラーやネットワークなど |

チェックを外しても clone は走りません。選択が外れるだけです。複数チェックすれば、1 件ずつ順番に処理されます。

### 保存先フォルダ

- 保存先が無ければ**自動で作成**します（親フォルダも含む）
- clone 先は `<保存先>\<repo>`。owner フォルダは作りません
- 既に同名フォルダがある場合は**何もしません**。上書き・削除・pull はしません

### 既存フォルダの扱い

保存先に同名のフォルダがあると `既にあります` になります。中身が Git リポジトリかどうかも結果に含まれます。更新したい場合は、そのフォルダで手動で `git pull` してください。

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
.\installer\uninstall.ps1
```

レジストリ登録と `%LOCALAPPDATA%\GitHubBulkCloner` を削除します。ファイルを残す場合は `-KeepFiles` を付けます。最後に `chrome://extensions` から拡張自体を削除してください。

## トラブルシューティング

### ポップアップのバッジが「未接続」になる

| 原因 | 確認方法 | 対処 |
| --- | --- | --- |
| ホストが未登録 | `Get-ItemProperty 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.tonbiattack.github_bulk_cloner'` | `install.ps1` を実行する |
| 拡張 ID の不一致 | マニフェストの `allowed_origins` と `chrome://extensions` の ID を比べる | 正しい ID で `install.ps1 -Force` を実行する |
| マニフェストのパス誤り | マニフェストの `path` が実在するか確認する | `install.ps1` を再実行する |
| 拡張の再読み込み忘れ | — | `chrome://extensions` で再読み込みする |

ホスト単体が応答するかは次で確認できます。

```powershell
.\installer\test-host.ps1
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
