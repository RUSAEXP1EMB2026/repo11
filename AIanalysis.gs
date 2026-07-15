/**
 * ============================================================
 * AIAnalysis.gs
 * ------------------------------------------------------------
 * 毎晩の時限トリガーで実行され、
 *   1. 翌日のカレンダー予定を取得
 *   2. 直近の睡眠履歴を取得
 *   3. OpenAI APIにアドバイス生成を依頼
 *   4. LINEで通知
 * までを一括実行する。
 * ============================================================
 */

/**
 * メインのエントリーポイント。
 * 時限式トリガー(例: 毎日20:00)から呼び出される想定。
 *
 * トリガー設定方法:
 *   GASエディタ左側の時計アイコン「トリガー」→「トリガーを追加」
 *   実行する関数: analyzeAndNotify
 *   イベントのソース: 時間主導型
 *   時間ベースのトリガーのタイプ: 日タイマー
 *   時刻: 午後8時～9時 など
 */
function analyzeAndNotify() {
  try {
    logEvent_('analyzeAndNotify 開始');

    const nextEvent = getNextCalendarEvent();
    logEvent_(`翌日の最初の予定: ${nextEvent ? nextEvent.title + ' @ ' + nextEvent.startTime : '予定なし'}`);

    const sleepHistory = getRecentSleepHistory(ANALYSIS_LOOKBACK_DAYS);
    logEvent_(`直近${ANALYSIS_LOOKBACK_DAYS}日間の睡眠履歴: ${sleepHistory.records.length}件取得`);

    const advice = generateSleepAdvice(nextEvent, sleepHistory);
    logEvent_(`生成されたアドバイス: ${advice}`);

    sendLineNotification(advice);
    logEvent_('analyzeAndNotify 完了');

  } catch (error) {
    logEvent_(`analyzeAndNotifyでエラー発生: ${error.message}`);
    // エラー時もLINEに通知することで、システム異常に気付けるようにする
    try {
      sendLineNotification(`【システムエラー】睡眠分析処理でエラーが発生しました: ${error.message}`);
    } catch (lineError) {
      logEvent_(`エラー通知のLINE送信も失敗: ${lineError.message}`);
    }
  }
}

/**
 * Googleカレンダーから「翌日の最初の予定」を取得する。
 * 終日予定は判定対象から除外する(就寝時刻の参考にならないため)。
 */
function getNextCalendarEvent() {
  const calendar = CalendarApp.getDefaultCalendar();

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const startOfTomorrow = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 0, 0, 0);
  const endOfTomorrow = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 23, 59, 59);

  const events = calendar.getEvents(startOfTomorrow, endOfTomorrow);

  // 終日予定を除外し、開始時刻が早い順にソート
  const timedEvents = events
    .filter(function (event) { return !event.isAllDayEvent(); })
    .sort(function (a, b) { return a.getStartTime().getTime() - b.getStartTime().getTime(); });

  if (timedEvents.length === 0) {
    return null;
  }

  const firstEvent = timedEvents[0];
  return {
    title: firstEvent.getTitle(),
    startTime: firstEvent.getStartTime(),
  };
}

/**
 * スプレッドシートから直近N日間の睡眠記録を取得し、
 * 平均睡眠時間や典型的な就寝時刻を算出する。
 */
function getRecentSleepHistory(lookbackDays) {
  const sheet = getSheet_();
  const lastRow = sheet.getLastRow();

  if (lastRow < 2) {
    return { records: [], averageSleepMinutes: null, averageBedtimeHour: null };
  }

  // ヘッダー行を除いた全データを取得(A:就寝時刻, B:起床時刻, C:睡眠分, D:表示用)
  const dataRange = sheet.getRange(2, 1, lastRow - 1, 4);
  const values = dataRange.getValues();

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - lookbackDays);

  const records = [];
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    const sleepTime = row[0];
    const wakeTime = row[1];
    const durationMinutes = row[2];

    // 起床時刻が未記録(現在進行中の睡眠、または異常データ)の行はスキップ
    if (!(sleepTime instanceof Date) || !(wakeTime instanceof Date) || durationMinutes === '') {
      continue;
    }
    if (sleepTime < cutoffDate) {
      continue;
    }

    records.push({
      sleepTime: sleepTime,
      wakeTime: wakeTime,
      durationMinutes: durationMinutes,
    });
  }

  if (records.length === 0) {
    return { records: [], averageSleepMinutes: null, averageBedtimeHour: null };
  }

  const totalMinutes = records.reduce(function (sum, r) { return sum + r.durationMinutes; }, 0);
  const averageSleepMinutes = Math.round(totalMinutes / records.length);

  // 就寝時刻の「時:分」を平均化する(日付をまたぐ深夜帯も考慮し、
  // 正午を基準に「前日夜」として扱うことで単純平均が破綻しないようにする)
  const averageBedtimeHour = calculateAverageBedtime(records);

  return {
    records: records,
    averageSleepMinutes: averageSleepMinutes,
    averageBedtimeHour: averageBedtimeHour,
  };
}

/**
 * 就寝時刻の平均を計算する。
 * 23:30や1:00のような「日付をまたぐ可能性がある時刻」を平均すると、
 * 単純な時刻の数値平均では破綻する(23時と1時の平均が12時になってしまう等)。
 * これを避けるため、正午(12:00)を基準にした相対分数で平均してから戻す。
 */
function calculateAverageBedtime(records) {
  const minutesFromNoon = records.map(function (r) {
    const sleepTime = r.sleepTime;
    let minutesOfDay = sleepTime.getHours() * 60 + sleepTime.getMinutes();
    // 正午より前(0:00～11:59)の時刻は「前日の続き」とみなし、24時間分を加算する
    if (minutesOfDay < 12 * 60) {
      minutesOfDay += 24 * 60;
    }
    return minutesOfDay - 12 * 60; // 正午を0とした相対値
  });

  const avgMinutesFromNoon = minutesFromNoon.reduce(function (sum, m) { return sum + m; }, 0) / minutesFromNoon.length;
  let avgMinutesOfDay = (avgMinutesFromNoon + 12 * 60) % (24 * 60);
  if (avgMinutesOfDay < 0) {
    avgMinutesOfDay += 24 * 60;
  }

  const hours = Math.floor(avgMinutesOfDay / 60);
  const minutes = Math.round(avgMinutesOfDay % 60);
  return { hours: hours, minutes: minutes };
}

/**
 * OpenAI APIを呼び出し、就寝推奨アドバイスを生成する。
 */
function generateSleepAdvice(nextEvent, sleepHistory) {
  const apiKey = getRequiredProperty('OPENAI_API_KEY');
  const prompt = buildAdvicePrompt(nextEvent, sleepHistory);

  const payload = {
    model: OPENAI_CONFIG.MODEL,
    messages: [
      {
        role: 'system',
        content: 'あなたは睡眠改善をサポートするアシスタントです。データに基づいて、具体的で実行しやすい就寝推奨アドバイスを150字程度の自然な日本語で作成してください。',
      },
      { role: 'user', content: prompt },
    ],
    max_tokens: OPENAI_CONFIG.MAX_TOKENS,
    temperature: OPENAI_CONFIG.TEMPERATURE,
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true, // エラー時もレスポンス内容を確認できるようにする
  };

  const response = UrlFetchApp.fetch(OPENAI_CONFIG.API_URL, options);
  const responseCode = response.getResponseCode();
  const responseText = response.getContentText();

  if (responseCode !== 200) {
    throw new Error(`OpenAI API呼び出し失敗 (HTTP ${responseCode}): ${responseText}`);
  }

  const json = JSON.parse(responseText);

  if (!json.choices || json.choices.length === 0) {
    throw new Error(`OpenAI APIの応答に choices が含まれていません: ${responseText}`);
  }

  return json.choices[0].message.content.trim();
}

/** OpenAIに渡すプロンプトを組み立てる */
function buildAdvicePrompt(nextEvent, sleepHistory) {
  const lines = [];

  if (nextEvent) {
    const eventTimeStr = formatTime_(nextEvent.startTime);
    lines.push(`明日の最初の予定: 「${nextEvent.title}」 開始時刻 ${eventTimeStr}`);
  } else {
    lines.push('明日は時刻指定の予定が登録されていません。');
  }

  if (sleepHistory.averageSleepMinutes !== null) {
    const avgHours = Math.floor(sleepHistory.averageSleepMinutes / 60);
    const avgMinutes = sleepHistory.averageSleepMinutes % 60;
    lines.push(`直近${ANALYSIS_LOOKBACK_DAYS}日間の平均睡眠時間: ${avgHours}時間${avgMinutes}分`);

    const bedtime = sleepHistory.averageBedtimeHour;
    const bedtimeHourDisplay = bedtime.hours % 24;
    lines.push(`直近の平均的な就寝時刻: ${String(bedtimeHourDisplay).padStart(2, '0')}:${String(bedtime.minutes).padStart(2, '0')}頃`);
  } else {
    lines.push('睡眠記録がまだ十分にありません。');
  }

  lines.push('');
  lines.push('上記を踏まえ、今日の推奨就寝時刻と、その理由を簡潔にアドバイスしてください。');

  return lines.join('\n');
}

/** Dateオブジェクトを "HH:mm" 形式の文字列にフォーマットする */
function formatTime_(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'HH:mm');
}

/**
 * ============================================================
 * Nature Remo 照度ポーリング
 * ------------------------------------------------------------
 * GASの時限トリガーで数分おきに呼び出し、照度センサーの値を確認する。
 * 暗い(消灯)と判断したら REMO_DARK フラグを立て、
 * 明るい(点灯)と判断したらフラグを倒すとともに起床トリガーとして処理する。
 *
 * トリガー設定方法(就寝時間帯に絞って実行する):
 *   GASエディタ「トリガー」→「トリガーを追加」
 *   実行する関数: checkRemoLightLevel
 *   イベントのソース: 時間主導型
 *   タイプ: 分ベースのタイマー → 毎5分 (または毎10分)
 *
 *   ただし24時間ずっと動かすとAPIのレートリミット(1時間30回)に引っかかる可能性があるため、
 *   就寝前後の時間帯(例: 21時〜翌8時)だけ動かすよう、関数内で時刻チェックを行っている。
 * ============================================================
 */
function checkRemoLightLevel() {
  // 就寝前後の時間帯(21時〜翌8時)以外は実行しない
  // これによりAPI呼び出し回数を抑え、レートリミットを避ける
  const now = new Date();
  const hour = now.getHours();
  const isActiveHour = hour >= 21 || hour < 8;
  if (!isActiveHour) {
    return;
  }

  const accessToken = getRequiredProperty('NATURE_REMO_ACCESS_TOKEN');

  const options = {
    method: 'get',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    muteHttpExceptions: true,
  };

  const response = UrlFetchApp.fetch(NATURE_REMO_CONFIG.API_URL, options);
  const responseCode = response.getResponseCode();

  if (responseCode !== 200) {
    logEvent_(`Nature Remo API呼び出し失敗 (HTTP ${responseCode}): ${response.getContentText()}`);
    return;
  }

  const devices = JSON.parse(response.getContentText());

  if (!devices || devices.length === 0) {
    logEvent_('Nature Remoデバイスが見つかりませんでした');
    return;
  }

  // 複数台ある場合は最初のデバイスを使用する。
  // 特定のデバイスを指定したい場合は devices.find(d => d.name === 'デバイス名') で絞り込む。
  const device = devices[0];
  const newestEvents = device.newest_events;

  if (!newestEvents || !newestEvents.il) {
    logEvent_(`照度センサー(il)のデータが見つかりません。デバイス名: ${device.name}`);
    return;
  }

  const illuminance = newestEvents.il.val;
  const isDark = illuminance <= NATURE_REMO_CONFIG.DARKNESS_THRESHOLD;

  logEvent_(`Nature Remo照度: ${illuminance} (閾値: ${NATURE_REMO_CONFIG.DARKNESS_THRESHOLD}, 暗い: ${isDark})`);

  const currentFlag = getFlag(SLEEP_CONDITION_FLAGS.REMO_DARK);

  if (isDark && !currentFlag) {
    // 新たに暗くなった → 就寝フラグを立てる
    setFlag(SLEEP_CONDITION_FLAGS.REMO_DARK, true);
    logEvent_('消灯を検知: REMO_DARKフラグをONにしました');

    // フラグを立てた後、AND条件全体を再評価する
    // (他の条件がすでに揃っていた場合に就寝記録が走るよう、handleSleepEventと同じ評価ロジックを呼ぶ)
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
      logEvent_(`就寝時刻を記録(Remoトリガー): ${sleepTime.toISOString()}`);
    }

  } else if (!isDark && currentFlag) {
    // 明るくなった(点灯) → 起床トリガーとして処理する
    logEvent_('点灯を検知: 起床処理を開始します');
    handleWakeEvent('remo');
  }
}

/**
 * 照度の閾値を調整するためのテスト用関数。
 * GASエディタから手動実行すると、現在の照度値をログに表示する。
 * 消灯直後に実行して表示された値を参考に、DARKNESS_THRESHOLDを設定してください。
 */
function checkCurrentIlluminance() {
  const accessToken = getRequiredProperty('NATURE_REMO_ACCESS_TOKEN');
  const options = {
    method: 'get',
    headers: { Authorization: `Bearer ${accessToken}` },
    muteHttpExceptions: true,
  };
  const response = UrlFetchApp.fetch(NATURE_REMO_CONFIG.API_URL, options);
  const devices = JSON.parse(response.getContentText());
  const device = devices[0];
  const il = device.newest_events.il;
  console.log(`デバイス名: ${device.name}`);
  console.log(`現在の照度(il.val): ${il.val}`);
  console.log(`最終更新時刻: ${il.created_at}`);
  console.log(`現在の閾値(DARKNESS_THRESHOLD): ${NATURE_REMO_CONFIG.DARKNESS_THRESHOLD}`);
  console.log(`現在の設定では「${il.val <= NATURE_REMO_CONFIG.DARKNESS_THRESHOLD ? '暗い(フラグON)' : '明るい(フラグOFF)'}」と判定されます`);
}
