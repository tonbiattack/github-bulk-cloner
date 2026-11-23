---
title: GitHub Bulk Cloner
---

<div align="center">

<img src="https://raw.githubusercontent.com/tonbiattack/github-bulk-cloner/main/extension/icons/icon-128.png" width="96" height="96" alt="GitHub Bulk Cloner">

# GitHub Bulk Cloner

**チェックを付けるだけで、その場でローカルに clone。**

GitHub のリポジトリ一覧で欲しいリポジトリにチェックを付けると、
Windows の指定フォルダへすぐに `git clone` する Chrome 拡張です。

*Check a repository on GitHub and it is cloned into a folder on Windows immediately.*

</div>

---

## 特徴

| | |
| --- | --- |
| **チェックで即実行** | ボタンを押す手順がありません。チェックを付けた瞬間に clone します。 |
| **フォルダは自動作成** | 保存先が無ければ親フォルダごと作ります。 |
| **既存は触らない** | 同名フォルダは変更しません。別リポジトリなら衝突として明示します。 |
| **Private にも対応** | 認証済みの `gh` CLI があれば Private リポジトリも clone できます。 |
| **資格情報を扱わない** | トークンは拡張に渡しません。認証はローカルの Git / gh に委譲します。 |

## インストール

1. 拡張を入れる（Chrome Web Store、または `chrome://extensions` で `extension` フォルダを読み込み）
2. リポジトリを取得する

```powershell
git clone https://github.com/tonbiattack/github-bulk-cloner.git
cd github-bulk-cloner
```

3. セットアップを実行する（Go は不要です）

```powershell
.\installer\setup.ps1
```

## リンク

- [リポジトリ](https://github.com/tonbiattack/github-bulk-cloner)
- [セットアップ手順](https://github.com/tonbiattack/github-bulk-cloner/blob/main/docs/setup.md)
- [開発とテスト](https://github.com/tonbiattack/github-bulk-cloner/blob/main/docs/development.md)
- [リリース（ビルド済みホスト）](https://github.com/tonbiattack/github-bulk-cloner/releases)
- [プライバシーポリシー](privacy-policy.html)

## 動作環境

- Windows 10 / 11 (x64)
- Google Chrome 102 以降
- Git for Windows
- GitHub CLI（Private リポジトリを使う場合のみ）

## ライセンス

[MIT](https://github.com/tonbiattack/github-bulk-cloner/blob/main/LICENSE)
