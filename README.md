<div align="center">

<img src="extension/icons/icon-128.png" width="96" height="96" alt="GitHub Bulk Cloner">

# GitHub Bulk Cloner

**チェックを付けるだけで、その場でローカルに clone。**

GitHub のリポジトリ一覧で欲しいリポジトリにチェックを付けると、
Windows の指定フォルダへすぐに `git clone` する Chrome 拡張です。

[![Chrome](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)](#)
[![Windows](https://img.shields.io/badge/Windows-10%20%7C%2011-0078D4?logo=windows&logoColor=white)](#)
[![Go](https://img.shields.io/badge/Go-1.24%2B-00ADD8?logo=go&logoColor=white)](#)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

[セットアップ](docs/setup.md) · [開発](docs/development.md) · [Chrome Web Store 公開](store/README.md)

</div>

---

## これは何か

GitHub の Web ページからリポジトリ URL を一件ずつコピーして、ターミナルで `git clone` する——この繰り返しをなくすためのツールです。

リポジトリ一覧のチェックボックスにチェックを付けた**その瞬間**に clone が走ります。保存先フォルダが無ければ自動で作られ、既にあるフォルダは変更しません。

```text
GitHub の一覧ページ
  └─ ☑ にチェック  →  その場で clone  →  C:\apps\<repo>
```

## 特徴

| | |
| --- | --- |
| **チェックで即実行** | ボタンを押す手順がありません。チェックを付けた瞬間に clone します。 |
| **フォルダは自動作成** | 保存先が無ければ親フォルダごと作ります。Owner ごとに分ける設定もあります。 |
| **既存は触らない** | 同名フォルダは変更しません。別リポジトリなら衝突として明示します。 |
| **Private にも対応** | 認証済みの `gh` CLI があれば Private リポジトリも clone できます。 |
| **資格情報を扱わない** | トークンは拡張に渡しません。認証はローカルの Git / gh に委譲します。 |
| **シェルを介さない** | Go ホストが固定引数で `git` / `gh` を直接実行します。 |

## 動作環境

- Windows 10 / 11 (x64)
- Google Chrome 102 以降
- [Git for Windows](https://git-scm.com/download/win)
- [GitHub CLI](https://cli.github.com/)（Private リポジトリを使う場合のみ）

Go は不要です。ネイティブホストは [GitHub Releases](https://github.com/tonbiattack/github-bulk-cloner/releases) でビルド済みのバイナリを配布しています。

## インストール

一般利用者は 3 ステップです。Go のインストールは不要です。

**1. 拡張を入れる** — Chrome Web Store から追加します（開発版は `chrome://extensions` で `extension` フォルダを読み込みます）。

**2. リポジトリを取得する** — `setup.ps1` はリポジトリ内のスクリプトです。

```powershell
git clone https://github.com/tonbiattack/github-bulk-cloner.git
cd github-bulk-cloner
```

**3. セットアップを実行する**

```powershell
.\installer\setup.ps1
```

Git の確認、ビルド済みホストのダウンロードと SHA256 検証、マニフェスト作成、HKCU 登録、疎通確認までを一括で行います。管理者権限は不要です。

- 開発版の拡張を使う場合: `.\installer\setup.ps1 -Dev -ExtensionId <拡張ID>`
- オフライン / 手動でバイナリを置く場合: `.\installer\setup.ps1 -HostPath .\github-bulk-cloner-host-windows-amd64.exe`
- 修復: `.\installer\setup.ps1 -Repair`
- アンインストール: `.\installer\setup.ps1 -Uninstall`

詳しい手順とトラブルシューティングは [docs/setup.md](docs/setup.md) を参照してください。

### 配布バイナリの出所と検証

`github-bulk-cloner-host-windows-amd64.exe` は GitHub Actions（[`.github/workflows/release.yml`](.github/workflows/release.yml)）が `native-host/` からビルドしたものです。タグを push するとビルドと Release 作成が走ります。

チェックサムは同じ Release の `SHA256SUMS.txt` にあります。手元で確認するには:

```powershell
Get-FileHash .\github-bulk-cloner-host-windows-amd64.exe -Algorithm SHA256
```

`setup.ps1` はダウンロード時にこのチェックサムを自動で照合します。ローカルで同じバイナリを作るには:

```powershell
cd native-host
go build -trimpath -ldflags "-s -w -X main.version=0.1.0" -o github-bulk-cloner-host.exe ./cmd/host
```

## 使い方

1. GitHub で自分のプロフィールの **Repositories** タブを開く
2. 欲しいリポジトリのチェックボックスにチェックを付ける
3. 行に状態が出る

| 表示 | 意味 |
| --- | --- |
| `clone 中…` | 実行中 |
| `clone 済み` | 新しく clone した |
| `既にあります` | 同名フォルダがあったので何もしなかった |
| 失敗理由 | 認証エラーやネットワークなど |

clone 先は `<保存先>\<repo>` です（既定 `C:\apps`）。保存先はポップアップで変更できます。

### 対応ページ

- プロフィール / Organization の Repositories タブ（`?tab=repositories`）
- リポジトリ検索結果（`/search?type=repositories`）
- トピックページ（`/topics/<topic>`）
- Organization のリポジトリ一覧（`/orgs/<org>/repositories`）
- ユーザーのリポジトリ一覧（`/<user>/repositories`）

リポジトリ内のページ（`/owner/repo/issues` など）は対象外です。

## 仕組み

```text
GitHub Web ページ
  └─ Chrome Extension (Manifest V3)
       ├─ content script : 候補抽出とチェックボックス
       ├─ popup          : 保存先・選択一覧・実行結果
       └─ service worker : chrome.runtime.connectNative
            └─ Go Native Messaging Host (Windows)
                 └─ git / gh を固定引数で実行
                      └─ C:\apps\<repo>
```

拡張はリポジトリの `owner/repo` だけを送ります。ホストが検証し、`git clone`（Private は `gh repo clone`）を実行して、リポジトリ単位で結果を返します。

### メッセージ

拡張 → ホスト:

```json
{"type":"clone","requestId":"example-001","root":"C:\\apps","repositories":["owner/repo"]}
```

ホスト → 拡張（リポジトリ単位）:

```json
{"type":"result","requestId":"example-001","repository":"owner/repo","status":"success","path":"C:\\apps\\repo","method":"git"}
```

ホスト → 拡張（完了）:

```json
{"type":"done","requestId":"example-001","summary":{"success":1,"skipped":0,"failed":0}}
```

`status` は `success` / `skipped` / `failed`。Native Messaging の標準入出力は 4-byte little-endian 長 + JSON UTF-8 で、stdout はプロトコル専用、診断ログは stderr に出します。

## セキュリティ

- ネイティブホストの `allowed_origins` に当該拡張 ID のみを登録
- `owner/repo` を厳格に検証し、任意 URL・シェル断片・Git オプション・相対パスを拒否
- `exec.CommandContext` で直接 `git` / `gh` を呼び、`cmd.exe` や PowerShell で文字列を評価しない
- clone 先は設定したルート配下に限定し、シンボリックリンク／ジャンクションによる逸脱を防ぐ
- 既存ファイルを上書き・削除しない
- 認証はローカルの Git Credential Manager / gh に委譲し、トークンを保存・ログ出力しない
- 拡張は `github.com` のみを対象とし、権限は `storage` / `nativeMessaging` / `tabs` に限定

## 開発

```powershell
# Go ホスト
cd native-host
go vet ./...
go test ./... -short     # ネットワーク不要
go test ./...            # 実クローンを含む

# 拡張のロジック
node --test extension/test/

# アイコンの再生成
.\tools\make-icons.ps1
```

実機 Chrome での確認手順は [docs/development.md](docs/development.md) にまとめています。

### ディレクトリ構成

```text
extension/       Chrome 拡張（Manifest V3）
  lib/           URL 判定の純粋ロジック（DOM 非依存）
  content/       候補抽出とチェックボックス
  popup/         保存先・選択一覧・実行結果
  icons/         16 / 32 / 48 / 128 px
  test/          Node テストと Chrome 実機テスト
native-host/     Go ネイティブホスト
  cmd/host/      プロトコルループ
  internal/      protocol / validate / clone
installer/       ビルド・登録・解除・疎通確認
tools/           アイコン生成・ストア素材の撮影
store/           Chrome Web Store 公開用の資材
docs/            セットアップと開発の手順書
```

## 制約

- 同時実行は 1 リクエスト。リポジトリは順番に処理します
- 1 リクエストあたり最大 200 リポジトリ、1 リポジトリあたり 10 分でタイムアウト
- 保存先は既定で `<root>/<repo>` のフラット配置。所有者ごとに分ける設定もあります
- 既存フォルダの更新（pull）は行いません。手動で `git pull` してください
- 対応 OS は Windows のみ（x64）
- ストア版と開発版は同じ端末で同時に使えません（`allowed_origins` は 1 つの ID のみ）

### 既知の制限

- **ネイティブホストが必須**: 拡張単体では clone できません
- **Go は不要**: Releases のビルド済みバイナリを使います
- **`gh` 未認証**: Private リポジトリは clone できません。`gh auth login` が必要です
- **同名リポジトリの衝突**: フラット配置では別 owner の同名 repo が同じフォルダを指します。衝突として検出し、上書きはしません。所有者ごとのフォルダ設定で回避できます
- **ネイティブホストのエラーは Chrome では区別できない**: 「未登録」と「ID 不一致」は同じエラーとして返るため、アプリ側でもまとめて表示します

## コントリビュート

Issue と Pull Request を歓迎します。変更を送る前に、上記のテストが通ることを確認してください。

## ライセンス

[MIT](LICENSE)

## プライバシーポリシー

[docs/privacy-policy.md](docs/privacy-policy.md) / [公開ページ](https://tonbiattack.github.io/github-bulk-cloner/privacy-policy.html)

## 謝辞

アイコンとストア素材は `tools/` のスクリプトで生成しています。
