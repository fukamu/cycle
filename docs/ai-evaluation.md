# AI quality evaluation

AI qualityの基準、5つのcase group、rubric、release gateは [`design.md`](design.md) §49を唯一のSource of Truthとします。この文書はRepository内の実行手順だけを定義します。

## Deterministic checks

次のBackend checkは、version指定が中央Prompt Registryで解決できること、Promptのoperation boundary、5つのfixture groupが存在し有効なJSONLであることを検証します。

```bash
./scripts/check.sh --scope backend
```

Fixture corpusは`backend/testdata/ai_eval`にあり、`internal/ai/prompts`のtest runnerが全case groupを明示的に列挙して発見します。物理Pathやfile名を変更する場合は、同じ変更でrunnerを更新してください。

## Candidate model evaluation

ModelまたはPrompt Versionを変更する前に、次を行います。

1. 変更対象のPrompt assetを新しいimmutable versionとして中央Registryへ追加し、旧versionを上書きしない。
2. 対象modelと単価を固定し、§49の全fixtureをStaging用credentialで実行する。Production dataや実User本文は使用しない。
3. Structured Output、文字数、Action件数、禁止された捏造patternを自動確認する。
4. 人間reviewerが§49のrubricで採点し、critical failureが0件であることを確認する。
5. Model、Prompt Version、実行日、latency、token、cost、採点結果をPull Requestへ添付する。SecretやProvider response内の不要なUser dataは添付しない。

外部Credentialがないlocal/CIではProvider quality判定を行わず、Fake Adapter、schema validation、context isolation、quota/budget、error pathのdeterministic checksを実行します。
