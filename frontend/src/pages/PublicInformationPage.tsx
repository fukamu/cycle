import { useRef } from "react";
import { Link } from "react-router-dom";

import { useRouteHeadingFocusTarget } from "../app/RouteHeadingFocus";
import { readPublicInformationConfiguration } from "../features/public-information/config";

export function PublicInformationPage() {
  const configuration = readPublicInformationConfiguration();
  const mainContent = useRef<HTMLElement>(null);
  useRouteHeadingFocusTarget(mainContent);

  return (
    <div className="public-information-shell">
      <a className="skip-link" href="#public-information-content">
        本文へ移動
      </a>
      <header className="app-header public-information-header">
        <span className="wordmark" aria-label="FUKAMU Cycle">
          <span className="wordmark__name">FUKAMU</span>
          <span className="wordmark__suffix">Cycle</span>
        </span>
        {configuration !== undefined && (
          <Link className="touch-target public-information-app-link" to="/">
            アプリを開く
          </Link>
        )}
      </header>
      <main
        ref={mainContent}
        className="page public-information-page"
        id="public-information-content"
      >
        <header className="page-heading">
          <p className="eyebrow">PRIVACY &amp; SUPPORT</p>
          <h1>データの取扱いとお問い合わせ</h1>
          <p>
            FUKAMU
            Cycleを利用する前に、取得・保存する情報とその目的を確認できます。このページを開くだけでは匿名アカウントを作成せず、Google認証、AI処理、問い合わせ送信も行いません。
          </p>
        </header>

        {configuration === undefined ? (
          <section className="public-information-block public-information-block--warning">
            <h2>公開情報の設定が完了していません</h2>
            <p>
              正式な運営者名、問い合わせ先、バックアップの最大保持期間のいずれかが未設定または不正です。この環境では外部利用を開始しないでください。仮の名称、連絡先、期間は表示していません。
            </p>
          </section>
        ) : (
          <section
            className="public-information-block"
            aria-labelledby="operator-heading"
          >
            <h2 id="operator-heading">運営者・お問い合わせ</h2>
            <dl className="public-information-definition-list">
              <div>
                <dt>運営者</dt>
                <dd>{configuration.operatorName}</dd>
              </div>
              <div>
                <dt>問い合わせ、開示・訂正・削除等の請求</dt>
                <dd>
                  <a href={configuration.contactUrl}>公開問い合わせ窓口</a>
                </dd>
              </div>
            </dl>
          </section>
        )}

        <section
          className="public-information-block"
          aria-labelledby="data-heading"
        >
          <h2 id="data-heading">取り扱う情報と利用目的</h2>
          <div className="public-information-table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">場面</th>
                  <th scope="col">主な情報</th>
                  <th scope="col">利用目的・取扱い</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">匿名利用・セッション</th>
                  <td>
                    匿名ユーザー識別子、セッションCookie、起動用識別子、リクエストに伴う情報
                  </td>
                  <td>
                    利用者ごとのデータ分離、セッション維持、不正利用防止、セキュリティ確認のために使用します。匿名利用開始時はCloudflare
                    Turnstileによる確認を行います。
                  </td>
                </tr>
                <tr>
                  <th scope="row">任意のGoogle連携</th>
                  <td>
                    Googleの利用者識別子、メールアドレスとGoogleが返す検証状態
                  </td>
                  <td>
                    同じFUKAMU
                    Cycleアカウントへのログインと、匿名アカウントへの本人の認証手段の追加に使用します。連携時のメールアドレスと検証状態を保存し、設定画面では検証済みの場合だけメールアドレスを表示します。Google連携は任意です。
                  </td>
                </tr>
                <tr>
                  <th scope="row">目標・PDCA</th>
                  <td>
                    目標、達成の目安、P/D/C/A、下書き、見直し内容、作成・更新日時
                  </td>
                  <td>
                    入力の保存・同期、履歴表示、Goal
                    Review、削除など、Cycleの機能提供に使用します。健康、仕事、家庭などの情報を入力すると、その内容も保存対象になります。
                  </td>
                </tr>
                <tr>
                  <th scope="row">任意のAI機能</th>
                  <td>
                    操作に必要な現在の目標・下書き・P/D/C/Aと、同じ目標の過去サイクルの一部
                  </td>
                  <td>
                    OpenAIのResponses
                    APIへ送信し、目標の推敲またはActionの生成・推敲に使用します。Googleメール、セッション値、他の目標は送りません。AIは任意で、提案を採用するかは利用者が決めます。
                  </td>
                </tr>
                <tr>
                  <th scope="row">ブラウザ内の一時保存</th>
                  <td>未保存の入力差分と、サーバー保存済み画面の一時コピー</td>
                  <td>
                    通信失敗からの回復と再表示のため、利用中のブラウザのIndexedDBへ最大24時間保存します。認証情報の代わりには使用しません。
                  </td>
                </tr>
                <tr>
                  <th scope="row">運用・障害調査</th>
                  <td>
                    リクエスト経路、結果、処理時間、リクエストID、トレースID等
                  </td>
                  <td>
                    安定運用、障害調査、不正利用防止に使用します。入力本文、認証トークン、安定した利用者識別子を観測データへ記録しない設計です。
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section
          className="public-information-block"
          aria-labelledby="providers-heading"
        >
          <h2 id="providers-heading">外部サービス</h2>
          <ul>
            <li>Cloudflare: 配信、リクエスト中継、不正利用確認</li>
            <li>Google: 利用者が選択した場合の認証</li>
            <li>
              Google Cloud KMS:
              保存時暗号化を有効にした環境で、目標本文そのものではなく、データ鍵と利用者単位の鍵スコープ情報を保護
            </li>
            <li>OpenAI: 利用者が選択した場合のAI処理</li>
            <li>運営環境で設定されたPostgreSQL・監視基盤: 保存と運用監視</li>
          </ul>
          <p>
            実際の契約主体、保存・アクセス国、再委託先、外国での取扱いの根拠、各サービス側の保持条件は、運営環境の契約と設定の確認が必要です。コードだけでは確定できないため、外部利用開始前に運営者が確認し、必要な情報をこのページまたは問い合わせ窓口で案内します。
          </p>
        </section>

        <section
          className="public-information-block"
          id="account-deletion"
          aria-labelledby="deletion-heading"
        >
          <h2 id="deletion-heading">削除と保存期間</h2>
          <ul>
            <li>
              アカウント削除では、運用中のデータベースにあるアカウント、Google連携、セッション、目標、下書き、Goal
              Version、PDCA、AI処理内容・利用記録を削除します。削除後は取り出せません。
            </li>
            <li>
              個人へ再関連付けできない月次の費用・運用集計は、アカウント削除後も保持する場合があります。
            </li>
            <li>
              運用・障害調査の観測データはアカウント削除処理の個別削除対象ではありません。入力本文、認証トークン、安定した利用者識別子を記録しない設計ですが、実際の保持期間は監視基盤の設定確認が必要です。
            </li>
            <li>
              このブラウザの下書きと一時表示データは、サーバー削除成功後に削除します。別の端末では24時間で利用対象外になりますが、その端末で次にサイトを開くまで物理削除されない場合があります。
            </li>
            <li>
              {configuration === undefined
                ? "バックアップの最大保持期間は未設定です。この状態では外部利用を開始できません。"
                : `バックアップには削除前の複製が最長${configuration.accountDeletionBackupMaxDays}日残る場合があります。保持期間の経過後に失効させ、削除済みアカウントを通常の運用環境へ個別復元しません。`}
            </li>
          </ul>
        </section>

        <section
          className="public-information-block"
          aria-labelledby="security-heading"
        >
          <h2 id="security-heading">暗号化・AIについての範囲</h2>
          <p>
            サポート対象の公開環境では、ブラウザから公開URLへの通信にHTTPS/TLSを使用する方針です。データベース接続を含む実際の通信経路のTLS設定は、外部利用開始前の確認が必要です。通信中の保護は保存時暗号化やE2EEとは別で、サーバーや、利用者が選択した外部サービスでの処理を妨げるものではありません。
          </p>
          <p>
            運営環境でFUKAMU
            Cycleの保存時暗号化を有効にしている場合も、サーバーが復号できる方式であり、E2EE（エンドツーエンド暗号化）や、運営者が内容を読めない方式ではありません。AI機能で送る内容は、データベースの保存時暗号化を有効にしていてもその境界外で処理されます。
          </p>
          <p>
            現在配信中の環境の証明書・各通信経路のTLS設定、暗号化mode、既存データを含む移行完了は、このページやコードだけでは確認できません。運営者は実際の稼働設定と移行結果を外部利用開始前に確認します。
          </p>
          <p>
            AIリクエストでは <code>store=false</code>
            を指定しますが、これだけで学習への不使用や保存期間ゼロを保証しません。運営者は実際の契約・プロジェクト設定と保持条件を外部利用開始前に確認します。
          </p>
        </section>

        <section
          className="public-information-block"
          aria-labelledby="service-heading"
        >
          <h2 id="service-heading">現在のサービス条件</h2>
          <p>
            現在のFUKAMU
            Cycleには、利用者向けの有料プラン、決済、課金解約の機能はありません。他製品の料金、無料期間、契約条件はFUKAMU
            Cycleには適用されません。
          </p>
        </section>
      </main>
    </div>
  );
}
