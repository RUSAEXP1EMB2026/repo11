function sendLineNotification(message) {
  const accessToken = getRequiredProperty('LINE_CHANNEL_ACCESS_TOKEN');
  const userId = getRequiredProperty('LINE_USER_ID');

  // LINEのテキストメッセージは1メッセージあたり5000文字までの制限があるため、
  // 念のため安全マージンを取って切り詰める
  const MAX_MESSAGE_LENGTH = 4900;
  const trimmedMessage = message.length > MAX_MESSAGE_LENGTH
    ? message.substring(0, MAX_MESSAGE_LENGTH) + '...(以下省略)'
    : message;

  const payload = {
    to: userId,
    messages: [
      {
        type: 'text',
        text: trimmedMessage,
      },
    ],
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  const response = UrlFetchApp.fetch(LINE_CONFIG.PUSH_API_URL, options);
  const responseCode = response.getResponseCode();

  if (responseCode !== 200) {
    throw new Error(`LINE通知の送信失敗 (HTTP ${responseCode}): ${response.getContentText()}`);
  }

  logEvent_('LINE通知を送信しました');
}

/**
 * 動作確認用のテスト関数。
 * GASエディタから直接実行して、固定メッセージが送信できるか確認する。
 */
function testLineSend() {
  sendLineNotification('【テスト通知】システムからの接続確認メッセージです。');
}

/**
 * ============================================================
 * 以下、LINEユーザーIDを確認するための仕組み。
 * ------------------------------------------------------------
 * LINEには「自分のユーザーIDを確認する」専用の画面が用意されていないため、
 * 一度だけ自分のLINE公式アカウントにメッセージを送り、
 * その内容に含まれるユーザーIDをログで確認する、という手順を踏む。
 *
 * 使い方:
 *   1. このスクリプトをWebアプリとして「デプロイ」する(していない場合は先に行う)
 *   2. LINE Developersコンソール →対象チャネル→「Messaging API設定」タブ
 *      →「Webhook URL」にこのWebアプリのURLを貼り付け、「検証」→「更新」する
 *      →「Webhookの利用」をオンにする
 *   3. 自分のLINE公式アカウントを友だち追加し、何かメッセージを送る(「こんにちは」等)
 *   4. GASエディタの「実行数」(左側の時計とは別の、実行ログのアイコン)を開き、
 *      最新の doPost 実行ログを確認する。
 *      "受信したユーザーID: Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" という行が出力されているので、
 *      この "U" から始まる文字列をコピーし、スクリプトプロパティの LINE_USER_ID に設定する。
 *   5. 確認が終わったら、Webhook URLの設定は外してもよい(本システムは送信専用のため)。
 * ============================================================
 */

/**
 * 受信したリクエストがLINEプラットフォームからのWebhookかどうかを判定する。
 * LINEのWebhookは必ずJSON形式のbodyに "events" 配列を持つため、これを目印にする。
 */
function isLineWebhookRequest(e) {
  if (!e.postData || !e.postData.contents) {
    return false;
  }
  try {
    const body = JSON.parse(e.postData.contents);
    return Array.isArray(body.events);
  } catch (err) {
    return false;
  }
}

/**
 * LINEからのWebhookを処理する。
 * 現在の用途は「ユーザーIDの確認」のみなので、受信した内容をログに出すだけで、
 * 特に何かを記録したり返信したりはしない。
 */
function handleLineWebhook(e) {
  const body = JSON.parse(e.postData.contents);

  body.events.forEach(function (event) {
    const userId = event.source && event.source.userId;
    const messageText = event.message && event.message.text;
    logEvent_(`受信したユーザーID: ${userId}`);
    if (messageText) {
      logEvent_(`受信したメッセージ内容: ${messageText}`);
    }
  });

  // LINE Platformへは200 OKを返す必要がある(返さないとリトライが繰り返される)
  return ContentService.createTextOutput(JSON.stringify({ status: 'ok' }))
    .setMimeType(ContentService.MimeType.JSON);
}
