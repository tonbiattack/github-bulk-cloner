# github-bulk-cloner

GitHub のリポジトリ一覧ページ上で対象を選び、Windows PC の指定フォルダに一括 `git clone` する Chrome 拡張 + Go Native Messaging ホスト。

## 目的
GitHub の Web ページからリポジトリ URL を一件ずつコピーして手動で clone する手間をなくす。普段は GitHub 上でチェックを付けて「Clone selected」を押すだけ。

## MVP ユーザーフロー
1. Windows に Go ネイティブホストをインストール・登録（初回のみ）。Git と、Private リポジトリには認証済み `gh` CLI を利用する。
2. Chrome 拡張を導入し、GitHub のプロフィールの Repositories タブ、検索結果などの対応ページを開く。
3. Content script がリポジトリへのリンクだけを検出し、各候補にチェックボックスを表示する。別途ポップアップに検出一覧と選択状態を出す。
4. クローン先のルートディレクトリを指定（既定値 `C:\apps`、変更値を保存）。
5. 「Clone selected」を押すと、拡張が Native Messaging を通じて Go ホストに `owner/repo` の一覧を送る。
6. Go ホストが順番にクローンし、成功・失敗・既存の各結果を返す。拡張で進捗と終了結果を表示する。

## 機能要件
- リポジトリ URL は `https://github.com/<owner>/<repo>` の形式だけを採用。リンク末尾の `.git`、クエリや末尾スラッシュを正規化し、重複排除する。
- `github.com/topics/*`、GitHub の機能ページ、リポジトリ内の `issues` や `tree` へのリンクをリポジトリ候補として誤検知しない。GitHub の対応画面では既知の DOM コンテナ内のリポジトリリンクを優先して抽出する。
- 個別選択・全選択・全解除。候補ゼロ件ではクローン操作不可。
- 同名リポジトリの衝突を回避できるよう、保存先は既定で `<root>/<owner>/<repo>` とする（例: `C:\apps\tonbiattack\zip-scope`）。将来フラット保存を設定で追加可能。
- 既存ディレクトリには上書き・削除・自動 pull をしない。対象が既存なら skip。既存が Git リポジトリかどうかを結果に示す。
- Public は `git clone`、Private は認証済みの `gh repo clone` で対応。資格情報やトークンを拡張から送らない。
- 処理結果は各リポジトリについて `success | skipped | failed`、保存先、短いエラーメッセージで表示。個別失敗しても残りを続ける。
- 対応 OS はまず Windows。Chrome Manifest V3 を使用。

## アーキテクチャ
```text
GitHub Web ページ
  └─ Chrome Extension (Manifest V3)
       ├─ content script: 候補抽出とチェックボックス
       ├─ popup: 一覧・保存先・実行結果
       └─ service worker: chrome.runtime.connectNative
            └─ Go Native Messaging Host (Windows)
                 └─ git / gh コマンドを固定引数で実行
                      └─ C:\apps\<owner>\<repo>
```

### メッセージ例
拡張 → ホスト:
```json
{"type":"clone","requestId":"example-001","root":"C:\\apps","repositories":["tonbiattack/zip-scope","tonbiattack/archive-extract-cleaner"]}
```

ホスト → 拡張（リポジトリ単位）:
```json
{"type":"result","requestId":"example-001","repository":"tonbiattack/zip-scope","status":"success","path":"C:\\apps\\tonbiattack\\zip-scope"}
```

ホスト → 拡張（完了）:
```json
{"type":"done","requestId":"example-001"}
```

Native Messaging の標準入出力は 4-byte little-endian 長 + JSON UTF-8 メッセージ。stdout はプロトコル専用、診断ログは stderr。

## セキュリティ
- Native Host の `allowed_origins` に当該拡張 ID のみを登録する。
- ホストで `owner/repo` を厳格に検証。任意 URL、シェルコマンド、Git オプション、相対パス（`..`）は受け付けない。
- `exec.CommandContext` で直接 git/gh を呼ぶ。cmd.exe や PowerShell で受信文字列を評価しない。
- クローン先はユーザーが設定したルート配下のみに限定。既存ファイルを上書きせず、シンボリックリンク／ジャンクションを使った逸脱を防ぐ。
- Git 認証はローカルの Git Credential Manager / gh に委譲。アクセストークンは保存・ログ出力しない。
- 拡張は `github.com` のみを対象とし、必要最小限の権限にする。
- 同時実行数とタイムアウトを制限。エラーメッセージに機密情報を出さない。

## 推奨ディレクトリ
```text
extension/          # manifest, content script, popup, service worker
native-host/        # Go CLI host, protocol, clone runner
installer/          # Windows 登録/解除スクリプト
docs/               # 開発・導入・テスト手順
```

## 完了条件（MVP）
- GitHub のプロフィール上で複数リポジトリを選択できる。
- 実行ボタンで `C:\apps\<owner>\<repo>` に実際に clone される。
- 未認証 Private / 既存ディレクトリ / 不正 URL で安全に失敗またはスキップする。
- 拡張をリロードしても保存先設定が残る。
- Windows で Native Host の登録・解除と Chrome 拡張の手動導入手順が再現できる。

## 開発順序
Issue を参照。初回はローカル動作・手動インストールを優先し、Chrome Web Store 公開や自動アップデートは後続対応とする。
