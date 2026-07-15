/**
 * ============================================================
 * Code.gs
 * ------------------------------------------------------------
 * 各センサー(Qwatch / Nature Remo / MacroDroid)からのWebhookを
 * 受信し、状態フラグを管理して就寝・起床を判定・記録する。
 * ============================================================
 */

/**
 * ブラウザで直接URLを開いた場合や、ヘルスチェック目的でGETアクセスされた場合に
 * 正常なレスポンスを返す。doGetが未定義だと、GASが内部的に302を返すことがあり、
 * 「動いているのかどうか」の確認がしづらくなるため、明示的に実装している。
 */
function doGet(e) {
  return createJsonResponse(200, {
    status: 'ok',
    message: 'このエンドポイントはPOSTリクエストで利用してください。',
  });
}

/**
 * Webアプリとして公開されるエンドポイント。
 * 各デバイスはこのURLに対してPOSTリクエストを送信する。
 *
 * 想定リクエスト形式 (URLクエリパラメータ or POST body の両対応):
 *   ?source=qwatch&direction=sleep&secret=xxxx
 *   ?source=remo&direction=sleep&secret=xxxx
 *   ?source=macrodroid&direction=sleep&secret=xxxx
 *   ?source=macrodroid&direction=wake&secret=xxxx  (起床トリガー)
 *
 * secret は WEBHOOK_SECRET スクリプトプロパティと一致する値を要求し、
 * 誰でも知っているWebアプリURLに対する不正なPOSTを防ぐ。
 */
function doPost(e) {
  try {
    // LINEプラットフォームからのWebhook(ユーザーがLINE公式アカウントにメッセージを送った時など)は
    // JSON bodyに "events" 配列を含む特有の構造を持つため、まずこれを判定して分岐する。
    // (センサー側のWebhookはこの構造を持たないため、誤って混線することはない)
    if (isLineWebhookRequest(e)) {
      return handleLineWebhook(e);
    }

    const params = extractParams(e);
    verifyWebhookSecret(params.secret);

    const source = params.source;       // 'qwatch' | 'remo' | 'macrodroid' | 'ios_charge' | 'ios_dnd'
    const direction = params.direction; // 'sleep' | 'wake'

    if (!source || !direction) {
      return createJsonResponse(400, { error: 'source または direction パラメータが不足しています' });
    }

    logEvent_(`Webhook受信: source=${source}, direction=${direction}`);

    if (direction === EVENT_DIRECTIONS.WAKE) {
      // 起床方向のイベント: いずれかのトリガーで即座に起床処理
      handleWakeEvent(source);
      return createJsonResponse(200, { status: 'wake_processed', source: source });
    }

    if (direction === EVENT_DIRECTIONS.SLEEP) {
      // 就寝方向のイベント: フラグを更新してAND条件を評価
      const result = handleSleepEvent(source);
      return createJsonResponse(200, result);
    }

    return createJsonResponse(400, { error: `不明なdirection: ${direction}` });

  } catch (error) {
    logEvent_(`doPostでエラー発生: ${error.message}`);
    return createJsonResponse(500, { error: error.message });
  }
}


/**
 * リクエストからパラメータを取り出す。
 * GASのWebアプリはPOST bodyとクエリパラメータの両方を e.parameter で受け取れるが、
 * デバイス側の実装によってJSON bodyで送ってくる場合もあるため両対応にする。
 */
function extractParams(e) {
  // まずクエリパラメータ/フォームパラメータを確認
  const fromQuery = e.parameter || {};

  // POST bodyがJSON形式の場合はそれも解析してマージ(クエリパラメータを優先)
  let fromBody = {};
  if (e.postData && e.postData.type === 'application/json' && e.postData.contents) {
    try {
      fromBody = JSON.parse(e.postData.contents);
    } catch (err) {
      // JSONでなければ無視 (フォームデータ送信の場合はe.parameterに入っているため問題ない)
    }
  }

  return Object.assign({}, fromBody, fromQuery);
}

/**
 * Webhookのシークレット検証。
 * 一致しない場合は例外を投げてdoPost側でエラーレスポンスを返す。
 */
function verifyWebhookSecret(providedSecret) {
  const expectedSecret = getRequiredProperty('WEBHOOK_SECRET');
  if (providedSecret !== expectedSecret) {
    throw new Error('Webhookシークレットが一致しません。不正なリクエストの可能性があります。');
  }
}

/**
 * 就寝方向のイベントを処理する中核ロジック。
 *
 * 処理の流れ:
 *   1. 受信したsourceに対応するフラグだけをtrueにする
 *   2. 3つのフラグすべてがtrueになっているか確認する
 *   3. すべて揃っていて、かつまだ今夜分を記録していなければ、就寝時刻を記録する
 *
 * 重要: ここでPropertiesServiceを使うことで、関数呼び出しをまたいで
 * 状態を保持できる。GASの各doPost呼び出しは独立した実行のため、
 * 通常の変数では前回の呼び出しの結果を覚えていられない。
 */
function handleSleepEvent(source) {
  const flagKey = mapSourceToFlagKey(source);
  if (!flagKey) {
    throw new Error(`未知のsource: ${source}`);
  }

  setFlag(flagKey, true);
  logEvent_(`フラグ更新: ${flagKey} = true`);

  const allConditionsMet = checkAllSleepConditionsMet();
  const alreadyRecorded = getFlag(FLAG_KEYS.SLEEP_RECORDED);

  if (allConditionsMet && !alreadyRecorded) {
    const sleepTime = new Date();
    recordSleepTime(sleepTime);
    setFlag(FLAG_KEYS.SLEEP_RECORDED, true);
    PropertiesService.getScriptProperties().setProperty(
      FLAG_KEYS.LAST_SLEEP_TIMESTAMP,
      sleepTime.toISOString()
    );
    logEvent_(`就寝時刻を記録: ${sleepTime.toISOString()}`);
    return { status: 'sleep_recorded', timestamp: sleepTime.toISOString() };
  }

  return {
    status: 'flag_updated',
    flags: buildFlagStatusSnapshot(),
  };
}

/** 現在アクティブな就寝条件フラグの状態一覧をオブジェクトとして返す(レスポンス確認用) */
function buildFlagStatusSnapshot() {
  const snapshot = {};
  ACTIVE_SLEEP_CONDITIONS.forEach(function (flagKey) {
    snapshot[flagKey] = getFlag(flagKey);
  });
  return snapshot;
}

/**
 * 起床方向のイベントを処理する。
 * どのセンサーから来たかは問わず(いずれか1つでトリガー)、
 * 起床時刻を記録し、睡眠時間を計算してから全フラグをリセットする。
 */
function handleWakeEvent(source) {
  const lastSleepIso = PropertiesService.getScriptProperties().getProperty(
    FLAG_KEYS.LAST_SLEEP_TIMESTAMP
  );

  if (!lastSleepIso) {
    // 就寝記録がない状態で起床イベントが来た場合(誤検知や手動テストなど)。
    // 記録は行わずログだけ残し、フラグのリセットのみ行う。
    logEvent_(`就寝記録が存在しないため起床記録をスキップ (source=${source})`);
    resetAllSleepFlags();
    return;
  }

  const wakeTime = new Date();
  const sleepTime = new Date(lastSleepIso);
  const duration = calculateSleepDuration(sleepTime, wakeTime);

  recordWakeTime(wakeTime, duration);
  logEvent_(`起床時刻を記録: ${wakeTime.toISOString()}, 睡眠時間: ${duration.formatted}`);

  resetAllSleepFlags();
}

/** sourceパラメータを対応するフラグキーにマッピングする */
function mapSourceToFlagKey(source) {
  return SOURCE_TO_FLAG_MAP.hasOwnProperty(source) ? SOURCE_TO_FLAG_MAP[source] : null;
}

/**
 * 就寝条件フラグ(ACTIVE_SLEEP_CONDITIONSで定義したもの)が
 * すべてtrueかどうかを確認する。
 * 条件の数や種類はConfig.gsのACTIVE_SLEEP_CONDITIONSを変更するだけで調整できる。
 */
function checkAllSleepConditionsMet() {
  return ACTIVE_SLEEP_CONDITIONS.every(function (flagKey) {
    return getFlag(flagKey);
  });
}

/** フラグをセットする (PropertiesServiceは文字列しか保存できないため'true'/'false'で管理) */
function setFlag(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, value ? 'true' : 'false');
}

/** フラグを取得する */
function getFlag(key) {
  return PropertiesService.getScriptProperties().getProperty(key) === 'true';
}

/** 就寝関連の全フラグをリセットする(起床時に呼ばれる) */
function resetAllSleepFlags() {
  ACTIVE_SLEEP_CONDITIONS.forEach(function (flagKey) {
    setFlag(flagKey, false);
  });
  setFlag(FLAG_KEYS.SLEEP_RECORDED, false);
  PropertiesService.getScriptProperties().deleteProperty(FLAG_KEYS.LAST_SLEEP_TIMESTAMP);
  logEvent_('全フラグをリセットしました');
}

/**
 * 睡眠時間を計算する。日付をまたぐケース(23:30就寝→翌7:00起床)も
 * Dateオブジェクトの差分計算なので自動的に正しく処理される。
 */
function calculateSleepDuration(sleepTime, wakeTime) {
  const diffMs = wakeTime.getTime() - sleepTime.getTime();
  const diffMinutes = Math.round(diffMs / 1000 / 60);
  const hours = Math.floor(diffMinutes / 60);
  const minutes = diffMinutes % 60;
  return {
    totalMinutes: diffMinutes,
    hours: hours,
    minutes: minutes,
    formatted: `${hours}時間${minutes}分`,
  };
}

/**
 * スプレッドシートに就寝時刻を記録する。
 * 起床時刻が未確定のため、新しい行を追加する形で記録する。
 */
function recordSleepTime(sleepTime) {
  const sheet = getSheet_();
  sheet.appendRow([
    sleepTime,           // A列: 就寝時刻
    '',                   // B列: 起床時刻(未確定、後で埋める)
    '',                   // C列: 睡眠時間(分)
    '',                   // D列: 睡眠時間(表示用)
  ]);
}

/**
 * スプレッドシートに起床時刻と睡眠時間を記録する。
 * 直前にrecordSleepTimeで追加された行(B列が空の最新行)を探して更新する。
 */
function recordWakeTime(wakeTime, duration) {
  const sheet = getSheet_();
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    logEvent_('記録対象の行が見つかりません(就寝記録がない状態)');
    return;
  }

  // 最終行のB列(起床時刻)が空であることを確認してから書き込む
  const wakeTimeCell = sheet.getRange(lastRow, 2);
  if (wakeTimeCell.getValue() !== '') {
    logEvent_(`警告: 最終行(${lastRow})の起床時刻が既に記録済みです。新しい行として追記します。`);
    sheet.appendRow(['', wakeTime, duration.totalMinutes, duration.formatted]);
    return;
  }

  sheet.getRange(lastRow, 2).setValue(wakeTime);
  sheet.getRange(lastRow, 3).setValue(duration.totalMinutes);
  sheet.getRange(lastRow, 4).setValue(duration.formatted);
}

/** スプレッドシートのシートオブジェクトを取得する(なければヘッダー付きで新規作成) */
function getSheet_() {
  const spreadsheetId = getRequiredProperty('SPREADSHEET_ID');
  const spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  let sheet = spreadsheet.getSheetByName(SHEET_NAME);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(SHEET_NAME);
    sheet.appendRow(['就寝時刻', '起床時刻', '睡眠時間(分)', '睡眠時間(表示)']);
    sheet.getRange(1, 1, 1, 4).setFontWeight('bold');
  }

  return sheet;
}

/** JSON形式のレスポンスを生成する */
function createJsonResponse(statusCode, body) {
  // GASのWebアプリはHTTPステータスコードを自由に設定できないため、
  // ステータス情報はbody内に含める形にしている。
  const responseBody = Object.assign({ httpStatusHint: statusCode }, body);
  return ContentService
    .createTextOutput(JSON.stringify(responseBody))
    .setMimeType(ContentService.MimeType.JSON);
}

/** デバッグ用ログ出力(GASのログ画面で確認できる) */
function logEvent_(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

/**
 * 動作確認用のテスト関数。GASエディタから直接実行して、
 * Webhookを送らずにロジックの挙動を確認できる。
 * ACTIVE_SLEEP_CONDITIONSをiOS構成(4条件)にしている場合の例。
 */
function testSleepFlow() {
  resetAllSleepFlags();
  console.log('--- テスト開始: 4条件を順番に満たす(iOS構成) ---');
  console.log(handleSleepEvent(SOURCE_TYPES.QWATCH));
  console.log(handleSleepEvent(SOURCE_TYPES.REMO));
  console.log(handleSleepEvent(SOURCE_TYPES.IOS_CHARGE));
  console.log(handleSleepEvent(SOURCE_TYPES.IOS_DND)); // ここで就寝記録されるはず

  Utilities.sleep(2000); // 2秒待ってから起床処理(動作確認用)

  console.log('--- 起床処理 ---');
  handleWakeEvent(SOURCE_TYPES.IOS_CHARGE);
}

function helloTest() {
  console.log('テスト実行: これが表示されればログは機能しています');
}

function testOpenAI() {
  const apiKey = getRequiredProperty('OPENAI_API_KEY');
  const response = UrlFetchApp.fetch('https://api.openai.com/v1/chat/completions', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: `Bearer ${apiKey}` },
    payload: JSON.stringify({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'こんにちは。一言で返答してください。' }],
      max_tokens: 50,
    }),
    muteHttpExceptions: true,
  });
  console.log(`HTTPステータス: ${response.getResponseCode()}`);
  console.log(`レスポンス: ${response.getContentText()}`);
}

function checkCurrentFlags() {
  const flags = {
    qwatch: getFlag(SLEEP_CONDITION_FLAGS.QWATCH_MOTION),
    remo: getFlag(SLEEP_CONDITION_FLAGS.REMO_DARK),
    ios_charge: getFlag(SLEEP_CONDITION_FLAGS.IOS_CHARGE_START),
    ios_dnd: getFlag(SLEEP_CONDITION_FLAGS.IOS_DND_ON),
    sleep_recorded: getFlag(FLAG_KEYS.SLEEP_RECORDED),
    last_sleep_timestamp: PropertiesService.getScriptProperties()
                          .getProperty(FLAG_KEYS.LAST_SLEEP_TIMESTAMP),
  };
  console.log('現在のフラグ状態:');
  console.log(JSON.stringify(flags, null, 2));
}

function testFlagsStepByStep() {
  // まずリセット
  resetAllSleepFlags();
  console.log('--- リセット完了 ---');

  // 1つ目: Qwatch
  const r1 = handleSleepEvent('qwatch');
  console.log('Qwatch後:', JSON.stringify(r1));
  checkCurrentFlags();

  // 2つ目: ios_charge
  const r2 = handleSleepEvent('ios_charge');
  console.log('ios_charge後:', JSON.stringify(r2));
  checkCurrentFlags();

  // 3つ目: remo (Remoのフラグはポーリングで立つが、ここでは直接テスト)
  const r3 = handleSleepEvent('remo');
  console.log('remo後:', JSON.stringify(r3));
  checkCurrentFlags();

  // 4つ目: ios_dnd → ここで就寝記録されるはず
  const r4 = handleSleepEvent('ios_dnd');
  console.log('ios_dnd後:', JSON.stringify(r4));
  checkCurrentFlags();
}

function testWakeEvent() {
  handleWakeEvent('ios_dnd');
  console.log('起床処理完了');
  checkCurrentFlags();
}
