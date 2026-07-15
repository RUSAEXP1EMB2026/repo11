/**
 * ============================================================
 * Config.gs
 * ------------------------------------------------------------
 * システム全体の設定値を集約するファイル。
 * APIキーやシークレット情報は「スクリプトプロパティ」に保存し、
 * このファイルに直接書き込まないこと。
 *
 * 設定方法:
 *   GASエディタ → 左側「プロジェクトの設定」(歯車アイコン)
 *   → 「スクリプト プロパティ」 に以下のキーを追加する
 *
 *   OPENAI_API_KEY         : OpenAIのAPIキー
 *   LINE_CHANNEL_ACCESS_TOKEN : LINE Messaging APIのチャンネルアクセストークン
 *   LINE_USER_ID            : 通知を送りたいユーザーのLINE ID
 *   SPREADSHEET_ID           : データ記録先のスプレッドシートID
 *   WEBHOOK_SECRET            : Webhook認証用の共通シークレット(後述)
 * ============================================================
 */

// スプレッドシートのシート名
const SHEET_NAME = 'SleepLog';

// 就寝条件を構成する各フラグの管理キー。
// ここに列を追加・削除するだけで、AND条件の数を増減できる汎用設計にしている。
// (例: Android構成なら3つ、iOS構成に切り替える場合は4つ、など環境に応じて調整可能)
const SLEEP_CONDITION_FLAGS = {
  QWATCH_MOTION: 'flag_qwatch_motion',                       // Qwatch: 就寝時の動き検知
  REMO_DARK: 'flag_remo_dark',                               // Nature Remo: 消灯(暗)検知
  MACRODROID_CHARGE_SCREENOFF: 'flag_macrodroid_charge_screenoff', // MacroDroid: 充電+画面OFF (Android構成)
  IOS_CHARGE_START: 'flag_ios_charge_start',                 // iOS: 充電開始 (iOS構成)
  IOS_DND_ON: 'flag_ios_dnd_on',                              // iOS: おやすみモードON (iOS構成)
};

// 管理用の付随フラグ(就寝条件ではない)
const FLAG_KEYS = {
  SLEEP_RECORDED: 'flag_sleep_recorded',         // 当夜分の就寝記録済みフラグ(重複記録防止)
  LAST_SLEEP_TIMESTAMP: 'last_sleep_timestamp',  // 直近の就寝時刻(起床時の睡眠時間計算に使用)
};

// 各Webhook送信元を識別するための「source」パラメータの値
// (各デバイス/アプリのWebhook送信設定で ?source=qwatch のように指定する想定)
const SOURCE_TYPES = {
  QWATCH: 'qwatch',
  REMO: 'remo',
  MACRODROID: 'macrodroid',
  IOS_CHARGE: 'ios_charge',   // iOS: 充電開始オートメーション
  IOS_DND: 'ios_dnd',         // iOS: おやすみモードONオートメーション
};

// sourceとフラグキーのマッピング。新しいデバイス/sourceを追加する際はここに1行追加するだけでよい。
const SOURCE_TO_FLAG_MAP = {
  qwatch: SLEEP_CONDITION_FLAGS.QWATCH_MOTION,
  remo: SLEEP_CONDITION_FLAGS.REMO_DARK,
  macrodroid: SLEEP_CONDITION_FLAGS.MACRODROID_CHARGE_SCREENOFF,
  ios_charge: SLEEP_CONDITION_FLAGS.IOS_CHARGE_START,
  ios_dnd: SLEEP_CONDITION_FLAGS.IOS_DND_ON,
};

/**
 * 実際にAND判定で使う条件フラグの一覧。
 * 運用する構成(Android版/iOS版/混在)に応じて、ここで使うフラグだけを選択する。
 *
 * 例1: Qwatch + Remo + MacroDroid (Android構成、3条件)
 *   const ACTIVE_SLEEP_CONDITIONS = [
 *     SLEEP_CONDITION_FLAGS.QWATCH_MOTION,
 *     SLEEP_CONDITION_FLAGS.REMO_DARK,
 *     SLEEP_CONDITION_FLAGS.MACRODROID_CHARGE_SCREENOFF,
 *   ];
 *
 * 例2: Qwatch + Remo + iOS充電開始 + iOSおやすみモード (iOS構成、4条件)
 *   const ACTIVE_SLEEP_CONDITIONS = [
 *     SLEEP_CONDITION_FLAGS.QWATCH_MOTION,
 *     SLEEP_CONDITION_FLAGS.REMO_DARK,
 *     SLEEP_CONDITION_FLAGS.IOS_CHARGE_START,
 *     SLEEP_CONDITION_FLAGS.IOS_DND_ON,
 *   ];
 */
const ACTIVE_SLEEP_CONDITIONS = [
  SLEEP_CONDITION_FLAGS.QWATCH_MOTION,
  SLEEP_CONDITION_FLAGS.REMO_DARK,
  SLEEP_CONDITION_FLAGS.IOS_CHARGE_START,
  SLEEP_CONDITION_FLAGS.IOS_DND_ON,
];

// MacroDroidやRemoは複数のイベント種別を送ってくる可能性があるため、
// 「就寝方向」のイベントか「起床方向」のイベントかを区別するパラメータ
const EVENT_DIRECTIONS = {
  SLEEP: 'sleep',   // 就寝条件を構成するイベント (検知/消灯/充電開始など)
  WAKE: 'wake',     // 起床条件を構成するイベント (画面ON/点灯/朝の動きなど)
};

// OpenAI APIの設定
const OPENAI_CONFIG = {
  MODEL: 'gpt-4o',
  API_URL: 'https://api.openai.com/v1/chat/completions',
  MAX_TOKENS: 500,
  TEMPERATURE: 0.7,
};

// LINE Messaging APIの設定
const LINE_CONFIG = {
  PUSH_API_URL: 'https://api.line.me/v2/bot/message/push',
};

// Nature Remo Cloud APIの設定
const NATURE_REMO_CONFIG = {
  API_URL: 'https://api.nature.global/1/devices',
  // 照度センサー(il)の「暗い」と判断する閾値。
  // 0が真っ暗、値が大きいほど明るい。部屋の照明を消した直後の値を実測して調整する。
  // 一般的に10以下が消灯後の暗さに相当することが多いが、部屋や設置場所によって異なる。
  DARKNESS_THRESHOLD: 10,
};

// 過去何日分の睡眠データを分析に使うか
const ANALYSIS_LOOKBACK_DAYS = 7;

/**
 * スクリプトプロパティから設定値を取得する共通関数。
 * 値が存在しない場合は例外を投げ、設定漏れに早期に気付けるようにする。
 */
function getRequiredProperty(key) {
  const value = PropertiesService.getScriptProperties().getProperty(key);
  if (!value) {
    throw new Error(
      `スクリプトプロパティ "${key}" が設定されていません。` +
      `GASエディタの「プロジェクトの設定」→「スクリプト プロパティ」で設定してください。`
    );
  }
  return value;
}
