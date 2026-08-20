# Infrastructure improvement review prompt

[`infrastructure-review-context.md`](infrastructure-review-context.md)をChatGPTへ添付または本文として渡したうえで、次のpromptを使用してください。実測値や運用要件が分かる場合は、末尾の入力欄を埋めると提案の精度が上がります。

## コピペ用prompt

```text
あなたは、Cloud architecture、platform engineering、SRE、Web application performance、security、FinOpsに詳しいSenior Architectです。

添付した「Infrastructure review context」は、対象システムの現在構成をまとめたレビュー用スナップショットです。この資料を根拠として、現在構成を維持した改善案と、必要に応じた代替architecture案を比較・提案してください。

目的:
- Userが体感する初期表示、画面遷移、API、AI処理のlatencyを改善する。
- 可用性、拡張性、security、deploy safety、observability、障害復旧性を改善する。
- 小規模な現在のtrafficと運用体制に対して、過剰構成や不要な固定費を避ける。
- Production構築前に、後戻りが高コストになる判断を明らかにする。

重要な進め方:
1. 添付資料の「確認済み事実」「未実装」「未決」「未計測」を区別してください。
2. 数値がない性能問題を断定せず、事実、仮説、確認方法を分けてください。
3. まず、code/config/query/CDN設定など既存component内で実施できる改善を検討してください。
4. Redis、queue、別compute、別database、追加observability SaaSなど新componentは、具体的なbottleneckを解決し、追加の運用負荷とfailure modeを上回る効果がある場合だけ提案してください。
5. 新componentごとに、用途、data分類、cache key、TTL/invalidation、consistency、security、可用性、cost、運用owner、migration、rollback/撤去方法を示してください。
6. 「現状維持 + 最小改善」を必ず比較対象に含めてください。全面移行を前提にしないでください。
7. Product仕様、認証・認可、delete/data retention semantics、migration-first、expand/contract、secret境界を変更しないでください。
8. Stagingの検証用値をProductionの推奨値として流用しないでください。不明なcapacity、backup、RTO/RPO、budget、alert値を捏造しないでください。
9. Cloudflare、Neon、GitHub Actions、OpenAI等の最新仕様・制限・価格に依存する主張は、公式一次情報をWebで確認し、確認日と出典URLを付けてください。価格は地域、plan、使用量により変わる前提で変数として扱ってください。
10. 添付資料同士の矛盾や、security/data lossにつながる判断不能点があれば、推測で埋めず最初に指摘してください。

必須の分析観点:
- Browser、Cloudflare edge、Worker、Container、Neon、外部providerごとのlatency要因
- Containerのsingleton、max instances 1、idle sleep 10分、region配置のtrade-off
- DB connection budget、query round trip、index、pool、Neonとのnetwork距離
- Static/browser/server/distributed cacheの適用可否と、staleness/invalidation/data leakage
- AI requestの同期処理、timeout/retry/lease、rate/budget control
- Single point of failure、backpressure、rate limiting、graceful degradation
- Metrics、tracing、logging、SLO、alert、synthetic monitoring
- CI/CD、migration、rollback、Terraform/Wrangler ownership
- Secret、personal data、providerへのdata送信、environment isolation
- 構築費だけでなく、月額費用、運用負荷、障害時の複雑さ、vendor lock-in

次の順序で回答してください:

1. Executive summary
   - 推奨方針を3～5項目で示す。
   - 今すぐ必要なことと、規模拡大まで不要なことを分ける。

2. 現状評価
   - 強み、risk、bottleneck候補を列挙する。
   - 各項目を「確認済み」「仮説」「不足情報」に分類する。

3. 先に行う計測
   - metric、計測地点、集計単位、判断に使うthresholdの決め方を示す。
   - p50/p95/p99、error rate、cold start、DB/provider latency、connection、costを含める。

4. 新component不要の改善案
   - 優先度、期待効果、実装難易度、risk、検証方法、rollback方法を表にする。
   - code/query/config/CDN/CI/CDのどこを変えるか明示する。

5. Architecture option比較
   - 少なくとも「現状維持 + 最小改善」「現行platformを拡張」「有力な代替architecture」を比較する。
   - 性能、可用性、security、運用負荷、概算cost変数、lock-in、migration riskを同じ尺度で評価する。
   - 採用しない案についても、不採用理由と再検討条件を示す。

6. 推奨target architecture
   - Mermaid構成図を付ける。
   - resource ownership、data flow、trust boundary、cache/queueがあればその責務を示す。

7. 段階的な実行計画
   - Phase 0（計測）、Phase 1（低risk改善）、Phase 2（必要性を実測後に判断）、Production readinessに分ける。
   - 各phaseに開始条件、完了条件、test、observability、rollbackを示す。

8. 意思決定表
   - 「観測値がXならA、YならB」のように、component追加や移行の判断基準を示す。

9. 未回答の質問
   - 結論を変え得る質問だけを、重要度順に最大10件挙げる。

回答は日本語で、固有名詞とcode/config名は必要に応じて英語のままにしてください。提案を実行したふりをせず、今回は分析と計画だけを提示してください。

追加の実測・運用情報（空欄は不明として扱う）:
- 主なuser地域:
- DAU / MAU:
- peak request per second / concurrent users:
- 現在のp50 / p95 / p99 latency:
- Container cold-start時間と発生率:
- route/query/provider別latency:
- 月額費用と上限:
- Production availability目標:
- RTO / RPO:
- 許容するdata staleness:
- 運用人数 / on-call体制:
- 6～12か月のtraffic予測:
```

## 使い方

1. [`infrastructure-review-context.md`](infrastructure-review-context.md)のsnapshot dateと実装が一致しているか確認する。
2. Secretや実dataを追加せず、分かる範囲でprompt末尾の実測・運用情報を埋める。
3. Context文書を添付し、promptを送る。
4. 提案内の最新仕様・価格には公式一次情報のURLと確認日があるか確認する。
5. 採用候補をRepositoryへ反映する前に、Source of Truthとの整合、migration、security、cost、rollbackを個別にreviewする。

性能測定値がまだない場合は、architecture移行案を先に選ばず、回答の「Phase 0」と「意思決定表」を使って計測から始めます。
