# ストア掲載文言

Chrome Web Store の各入力欄にそのまま貼れる文言です。文字数制限に収まるよう調整済みです。

---

## GitHub リポジトリの About

ストアとは別に、GitHub リポジトリ側の About も同じ内容で揃えてあります。設定済みの値は次のとおりです。

### Description（350 文字以内）

```text
GitHub のリポジトリ一覧で欲しいものにチェックを付けるだけで、Windows の指定フォルダへその場で git clone する Chrome 拡張。Go 製ネイティブホストで動作し、保存先フォルダは自動作成します。
```

### Website

```text
https://tonbiattack.github.io/github-bulk-cloner/
```

### Topics

```text
chrome-extension clone developer-tools git github golang manifest-v3 native-messaging productivity windows
```

設定コマンド:

```powershell
gh repo edit tonbiattack/github-bulk-cloner `
  --description "GitHub のリポジトリ一覧で欲しいものにチェックを付けるだけで、Windows の指定フォルダへその場で git clone する Chrome 拡張。Go 製ネイティブホストで動作し、保存先フォルダは自動作成します。" `
  --homepage "https://tonbiattack.github.io/github-bulk-cloner/"

gh api -X PUT repos/tonbiattack/github-bulk-cloner/topics --input topics.json
# topics.json: {"names":["chrome-extension","git","clone","github","golang","native-messaging","windows","manifest-v3","developer-tools","productivity"]}
```

> ソーシャルプレビュー画像は REST API で設定できません。必要なら GitHub のリポジトリ設定画面から手動でアップロードしてください。

---

## 名前（45 文字以内）

```text
GitHub Bulk Cloner
```

## 短い説明（132 文字以内）

```text
GitHub のリポジトリ一覧で欲しいものにチェックを付けるだけで、Windows の指定フォルダへその場で git clone します。保存先フォルダは自動作成、既存フォルダは変更しません。
```

## 詳細説明

```text
GitHub のリポジトリ一覧で、欲しいリポジトリのチェックボックスにチェックを付けるだけ。その瞬間に、Windows の指定フォルダへ git clone します。

URL を一件ずつコピーして、ターミナルに貼り付けて clone する——その繰り返しがなくなります。

■ 主な特徴

・チェックで即実行
ボタンを押す手順はありません。チェックを付けた瞬間に clone が走ります。

・フォルダは自動作成
保存先フォルダが無ければ、親フォルダごと自動で作ります。事前の準備は不要です。

・既存フォルダは触らない
同名のフォルダが既にある場合はスキップします。上書き・削除・pull は一切しません。

・Private リポジトリにも対応
認証済みの GitHub CLI（gh）があれば、Private リポジトリも clone できます。

・資格情報を扱わない
アクセストークンは拡張に渡しません。認証はローカルの Git / gh に委譲します。

・シェルを介さない
ローカルの Go ホストが固定引数で git / gh を直接実行します。受け取った文字列をシェルで評価しません。

■ 使い方

1. GitHub で自分のプロフィールの Repositories タブを開く
2. 欲しいリポジトリのチェックボックスにチェックを付ける
3. 行に「clone 済み」「既にあります」などの状態が表示される

clone 先は「保存先フォルダ\リポジトリ名」です。保存先は拡張のポップアップから変更できます（既定: C:\apps）。

■ 対応ページ

・プロフィール / Organization の Repositories タブ
・リポジトリ検索結果
・トピックページ
・Organization のリポジトリ一覧
・ユーザーのリポジトリ一覧

リポジトリ内のページ（issues や tree など）は対象外です。

■ 重要: 別途インストールが必要です

この拡張は単体では動作しません。git clone を実行するために、Windows 用のネイティブホストを別途インストールする必要があります。

インストールは 3 ステップです。Go のインストールは不要です。

1. GitHub Releases から github-bulk-cloner-host-windows-amd64.exe をダウンロードする
2. リポジトリを取得し、PowerShell で installer\setup.ps1 を実行する
3. chrome://extensions で拡張を再読み込みする

セットアップ手順の詳細:
https://github.com/tonbiattack/github-bulk-cloner

■ 動作環境

・Windows 10 / 11 (x64)
・Google Chrome 102 以降
・Git for Windows
・GitHub CLI（Private リポジトリを使う場合のみ）

■ 保存先の構成

既定では「保存先\リポジトリ名」に clone します。所有者の異なる同名リポジトリを扱う場合は、ポップアップの設定で「所有者ごとにフォルダを分ける」を有効にすると「保存先\所有者\リポジトリ名」になります。

既に同名フォルダがある場合、それが別のリポジトリなら「衝突」として表示し、上書きも削除もしません。

■ プライバシー

個人情報を収集しません。外部サーバーへの送信も行いません。保存先の設定はブラウザ内にのみ保存されます。

■ ライセンス

MIT
```

## カテゴリ

```text
開発者ツール
```

## 言語

```text
日本語
```

## 連絡先メールアドレス

GitHub アカウントの連絡先メールアドレスを入力してください。

## プライバシーポリシー URL

```text
https://tonbiattack.github.io/github-bulk-cloner/privacy-policy.html
```

## スクリーンショット

`store/screenshots/` の 3 枚を、この順でアップロードしてください。

| ファイル | 内容 |
| --- | --- |
| `01-repository-list.png` | 一覧にチェックボックスが表示されている状態 |
| `02-clone-complete.png` | チェック後に clone が実行された状態 |
| `03-popup-results.png` | ポップアップと実行結果 |

## プロモーション画像

| ファイル | 用途 |
| --- | --- |
| `promo/small-440x280.png` | 小さいプロモーションタイル（任意） |
| `promo/marquee-1400x560.png` | マーキータイル（任意） |

## 単一目的の説明

```text
GitHub のリポジトリ一覧から選択したリポジトリを、ユーザーが指定したローカルフォルダへ git clone する。
```

## 権限の正当性

```text
storage: 保存先フォルダの設定を保持するため。
nativeMessaging: ローカルの Go ホストと通信し、git clone を実行するため。
tabs: ポップアップから現在のタブの選択状態を取得するため。
host_permissions (https://github.com/*): リポジトリ一覧のリンクを検出し、チェックボックスを表示するため。
```

## リモートコードの使用

```text
使用していません。拡張に同梱した JavaScript のみを実行します。
```

## データ使用の申告

| 項目 | 回答 |
| --- | --- |
| 個人を特定できる情報を収集する | いいえ |
| 健康に関する情報を収集する | いいえ |
| 金融情報を収集する | いいえ |
| 認証情報を収集する | いいえ |
| 個人的な通信を収集する | いいえ |
| 位置情報を収集する | いいえ |
| ウェブ閲覧履歴を収集する | いいえ |
| ユーザー活動を収集する | いいえ |
| ウェブサイトのコンテンツを収集する | いいえ |

上記はいずれも「いいえ」です。拡張は外部へデータを送信しません。

## 審査担当者向けの補足

```text
この拡張は、ローカルのネイティブホスト（Go 製）と連携して git clone を実行します。ホストは別リポジトリの installer で登録する必要があり、未登録の場合はポップアップに「ネイティブホストが登録されていません」と表示されます。これは想定された動作です。

ホストのソースと導入手順:
https://github.com/tonbiattack/github-bulk-cloner

拡張単体では、GitHub のリポジトリ一覧にチェックボックスを表示するところまで動作します。
```
