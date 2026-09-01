# Summary

<!-- ユーザー価値、変更内容、意図的に変えないことを簡潔に記載してください。 -->

## Source of Truth impact

このtemplateは意味的整合性を自動証明しません。実装者とreviewerがcanonical ownerとconsumerを読み、同じ現在形に整合していることを確認してください。

Repository checkはtemplate sourceのprompt存在だけを検査します。個々のPull Request本文の選択数、記入内容、承認の有効性はreviewerが確認してください。

Canonical owner:

- [文書の権威](https://github.com/fukamu/cycle/blob/main/docs/design.md#01-文書の権威)
- [更新が必要な変更](https://github.com/fukamu/cycle/blob/main/docs/design.md#523-changes-that-require-updating-this-document)
- [通常は更新不要な変更](https://github.com/fukamu/cycle/blob/main/docs/design.md#524-changes-that-normally-do-not-require-updating-this-document)
- [仕様更新手順](https://github.com/fukamu/cycle/blob/main/docs/design.md#525-specification-update-procedure)
- [Canonical ownership index](https://github.com/fukamu/cycle/blob/main/docs/design.md#542-canonical-ownership-index)

Repository enforcement mirror:

- [仕様変更と停止条件](https://github.com/fukamu/cycle/blob/main/AGENTS.md#仕様変更と停止条件)

### Specification Impact classification

次の3分類から1つだけ選択してください。

- [ ] `既存仕様内の具体化`
- [ ] `仕様変更`
- [ ] `Discoveryのみ`

- Canonical design section(s): <!-- 必須。`docs/design.md` §§...を記載。Discoveryのみの場合も、変更しない根拠と確認したsectionを記載。 -->
- Classification rationale: <!-- 既存仕様で完全に規定済みか、§52.4の非意味変更か、Product Owner承認済みの仕様変更か、Discoveryだけかを説明。 -->
- Product Owner approval: <!-- 仕様変更では、理由・影響・選択肢を含む承認証跡を記載。その他は `N/A — 理由`。 -->

### Cross-reference review

各行を必ず埋め、影響がない場合は `N/A — 理由` と記載してください。空欄または理由のない `N/A` は認めません。

| Area | Impact, canonical section, and change / explicit `N/A — 理由` |
|---|---|
| Product / UX | <!-- 必須 --> |
| Domain / state | <!-- 必須 --> |
| DB / migration | <!-- 必須 --> |
| API | <!-- 必須 --> |
| Frontend | <!-- 必須 --> |
| AI | <!-- 必須 --> |
| Security / Privacy | <!-- 必須 --> |
| Operations | <!-- 必須 --> |
| Test | <!-- 必須 --> |

### Change-control gate

- [ ] `仕様変更`はProduct Owner承認後に着手し、canonical ownerをcodeより前またはこのPull Requestで更新した。その他の分類はその根拠を上に記載した。
- [ ] DDL、API Schema、Prompt、Test等のenforcement mirrorと実装をcanonical ownerと同じ変更で整合した。該当しない場合はCross-reference reviewに理由を記載した。
- [ ] Product質問、仕様矛盾、security/data retention/auth/permission/production上の重要な判断不能、または影響範囲不明は未解決でない。発見した場合は該当変更を停止し、Product Ownerの判断を記録した。
- [ ] 仕様だけまたは実装だけが先行する一時的不整合をmainへmergeせず、Product / UX、Domain / state、DB / migration、API、Frontend、AI、Security / Privacy、Operations、Testが同じ現在形になっている。

## Verification evidence

- Commands and results: <!-- 実行commandと結果。SecretやUser Contentを記載しない。 -->
- Not run and reason: <!-- 未実行がある場合は対象と理由。なければ `N/A — 全必須check実行済み`。 -->
- Manual / staging evidence: <!-- 必要な場合のみ。その他は `N/A — 理由`。 -->
