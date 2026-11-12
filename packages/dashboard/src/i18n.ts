// Dashboard localization (decision 139): en, ko, ja, zh-CN. No dependency — a typed dictionary plus t().
// `en` defines the key set; the other locales are typed `Record<MessageKey, string>`, so a missing or
// extra key is a vue-tsc build error (the "fails when a key is missing" check). Default is the browser
// language with a switcher override, remembered in localStorage (wrapped in try/catch). Number, date and
// currency formatting goes through Intl with the chosen locale (see format.ts).
//
// The ja and zh-CN strings are an initial pass to review before release, like the README translations.
// Server-provided data values (ids, outcome/status/verdict enums, rule and model names) are shown as-is;
// only UI chrome is translated.
import { ref } from 'vue';

export const LOCALES = ['en', 'ko', 'ja', 'zh-CN'] as const;
export type LocaleId = typeof LOCALES[number];
export const LOCALE_NAMES: Record<LocaleId, string> = { en: 'English', ko: '한국어', ja: '日本語', 'zh-CN': '简体中文' };

const en = {
  'app.title': 'Agentic Router',
  'app.subtitle': 'read-only local dashboard · all data stays on this machine',
  'tab.overview': 'Overview', 'tab.requests': 'Requests', 'tab.learning': 'Learning', 'tab.routing': 'Routing', 'tab.now': 'Now',

  'common.refresh': 'Refresh', 'common.all': 'all', 'common.total': 'total', 'common.count': 'count',
  'common.level': 'level', 'common.status': 'status', 'common.ok': 'ok', 'common.fail': 'fail', 'common.failed': 'failed',

  'banner.loading': 'Loading…', 'banner.cantLoad': "Can't load data", 'banner.retry': 'Retry',
  'banner.daemonOff': 'The router daemon is not running. Start it with `agentic-router start`, then retry.',
  'banner.timeout': 'The daemon did not respond in time. It may be busy — retry in a moment.',
  'banner.unauthorized': 'This dashboard session has expired. Reopen it with `agentic-router dashboard`.',
  'banner.httpError': 'The daemon returned an error. Retry, and check the daemon log if it persists.',

  'ov.requests': 'Requests', 'ov.noObjection': 'No objection seen', 'ov.acceptancePending': 'verify verdict (acceptance pending)',
  'ov.unobserved': '{pct} unobserved', 'ov.costPerAccepted': 'Cost / accepted', 'ov.teamFit': 'Team fit',
  'ov.startStepFit': 'Start-step fit', 'ov.stepUpRate': 'Step-up rate', 'ov.cacheHit': 'Cache hit', 'ov.apiMode': 'API mode',
  'ov.leadVsWorkers': 'Lead vs workers', 'ov.leadVsWorkersHint': 'total lead vs subtask cost', 'ov.costByLevel': 'Cost by level',
  'ov.totalCost': 'total {usd}', 'ov.acceptance': 'Acceptance', 'ov.acceptanceNote': '“no objection seen”; the rate is an upper bound',
  'ov.accepted': 'accepted {n}', 'ov.notAccepted': 'not accepted {n}', 'ov.unobservedCount': 'unobserved {n}', 'ov.na': 'n/a {n}', 'ov.unknownCount': 'unknown {n}',
  'ov.signals': 'signals:', 'ov.subscriptionLimits': 'Subscription limits', 'ov.fiveHourUsed': '5-hour used', 'ov.sevenDayUsed': '7-day used',
  'ov.resets': 'resets {time}', 'ov.baseline': 'Baseline:', 'ov.baselinePending': 'pending (Phase 0 off-baseline not yet measured)',
  'ov.flags': 'Flags:', 'ov.estimated': '{n} estimated', 'ov.unknownCostFlag': '{n} unknown cost', 'ov.overBudget': '{n} over budget',

  'tl.level': 'Level:', 'tl.thRequest': 'request', 'tl.thOutcome': 'outcome', 'tl.thLeadWorkers': 'lead / workers',
  'tl.thFiles': 'files', 'tl.thTime': 'time', 'tl.thVerify': 'verify', 'tl.notAccepted': 'not accepted', 'tl.unobserved': 'unobserved',
  'tl.est': 'est', 'tl.over': 'over', 'tl.failN': '{n} fail', 'tl.loadMore': 'Load more', 'tl.end': 'End', 'tl.loadingMore': 'loading…',
  'tl.requestDetail': 'Request detail', 'tl.close': 'Close', 'tl.couldNotLoadDetail': 'Could not load detail: {kind}',
  'tl.signalsN': '{n} signals', 'tl.promptLabel': 'prompt:', 'tl.promptRecorded': 'recorded', 'tl.promptNot': 'not recorded',
  'tl.acceptanceLabel': 'acceptance:', 'tl.holdoutLabel': 'holdout:', 'tl.thSubtask': 'subtask', 'tl.thAttempt': 'attempt',
  'tl.thCheck': 'check', 'tl.thDetail': 'detail', 'tl.titleUserAcceptance': 'user acceptance', 'tl.titleRoutingArm': 'routing arm',
  'tl.titleContainsEstimate': 'contains an estimate', 'tl.titleSomeUnknown': 'some cost unknown',

  'lr.levelHeld': 'Level held', 'lr.triageByRule': 'Triage vs actual, by rule', 'lr.suggestionsNote': 'Suggestions are surfaced, never auto-applied.',
  'lr.thRule': 'rule', 'lr.thReinforced': 'reinforced', 'lr.thUpStreaks': 'up-streaks', 'lr.thSuggestion': 'suggestion',
  'lr.raiseLevel': 'raise level', 'lr.raiseStartStep': 'raise start step', 'lr.plannedFinal': 'Planned → final level',
  'lr.thPlanned': 'planned', 'lr.thFinal': 'final', 'lr.changed': 'changed',

  'rt.autoRelease': 'Auto-release', 'rt.modeLabel': 'mode: {mode}', 'rt.holdout': 'holdout {pct}',
  'rt.ruleText': 'release when the team costs > {x}× direct over {d}d (n ≥ {maj}/{min}); re-enable at ≤ {re}×',
  'rt.offNote': 'Auto-release is off: no holdout is taken and no comparison is shown.', 'rt.lead': '{cls} lead',
  'rt.delegatesFrom': 'delegates from {from}', 'rt.autoConfigured': '(auto, configured {from})',
  'rt.thTeamHoldout': 'team / holdout', 'rt.thNAccepted': 'n (accepted)', 'rt.thCostAccepted': 'cost / accepted', 'rt.thDecision': 'decision',
  'rt.handledDirectly': 'handled directly by configuration', 'rt.released': 'released', 'rt.candidate': 'candidate',
  'rt.notEnoughData': 'not enough data yet (team {dh}/{dn}, direct {ih}/{in})', 'rt.wouldBeReleased': 'would be released (observe mode: nothing is switched)',
  'rt.armTeam': 'team', 'rt.armProbes': 'probes', 'rt.armHoldout': 'holdout', 'rt.armReleased': 'released',
  'rt.notAvailable': 'Routing data is not available (older daemon, or routing is off).',
  'rt.actionHold': 'hold', 'rt.actionRelease': 'release', 'rt.actionReenable': 're-enable',
  'rt.reasonNoDirectCost': 'no direct cost', 'rt.reasonDelegatedDearer': 'delegated dearer', 'rt.reasonDelegatedNotDearer': 'delegated not dearer', 'rt.reasonInsideBand': 'inside band',
  'rt.decision': '{action} — {reason}', 'rt.ratioSuffix': ' · ratio {r}',

  'nw.currentRequest': 'Current request', 'nw.lead': 'lead {cls} ({model})', 'nw.unknown': 'unknown',
  'nw.cost': 'cost {cost} / budget {budget}', 'nw.estimated': 'estimated', 'nw.partlyUnknown': 'partly unknown',
  'nw.subscription': 'Subscription:', 'nw.noActive': 'No active request in this session.', 'nw.team': 'Team',
  'nw.thRole': 'role', 'nw.thSlot': 'slot', 'nw.thStep': 'step', 'nw.thModelEffort': 'model × effort', 'nw.sessionTotal': 'Session total: {usd}',
};

export type MessageKey = keyof typeof en;
type Dict = Record<MessageKey, string>;

const ko: Dict = {
  'app.title': 'Agentic Router',
  'app.subtitle': '읽기 전용 로컬 대시보드 · 모든 데이터는 이 기기에만 남습니다',
  'tab.overview': '개요', 'tab.requests': '요청', 'tab.learning': '학습', 'tab.routing': '라우팅', 'tab.now': '현재',

  'common.refresh': '새로고침', 'common.all': '전체', 'common.total': '합계', 'common.count': '건수',
  'common.level': '레벨', 'common.status': '상태', 'common.ok': 'ok', 'common.fail': '실패', 'common.failed': '실패',

  'banner.loading': '불러오는 중…', 'banner.cantLoad': '데이터를 불러올 수 없습니다', 'banner.retry': '다시 시도',
  'banner.daemonOff': '라우터 데몬이 실행 중이 아닙니다. `agentic-router start`로 시작한 뒤 다시 시도하세요.',
  'banner.timeout': '데몬이 제때 응답하지 않았습니다. 바쁠 수 있으니 잠시 후 다시 시도하세요.',
  'banner.unauthorized': '대시보드 세션이 만료되었습니다. `agentic-router dashboard`로 다시 여세요.',
  'banner.httpError': '데몬이 오류를 반환했습니다. 다시 시도하고, 계속되면 데몬 로그를 확인하세요.',

  'ov.requests': '요청', 'ov.noObjection': '이의 없음', 'ov.acceptancePending': 'verify 판정 (수용 집계 준비 중)',
  'ov.unobserved': '미관측 {pct}', 'ov.costPerAccepted': '수용 작업당 비용', 'ov.teamFit': '팀 적합도',
  'ov.startStepFit': '시작 단계 적합도', 'ov.stepUpRate': '상승률', 'ov.cacheHit': '캐시 적중', 'ov.apiMode': 'API 모드',
  'ov.leadVsWorkers': '총괄 대 작업자', 'ov.leadVsWorkersHint': '총괄 대 하위작업 비용 합계', 'ov.costByLevel': '레벨별 비용',
  'ov.totalCost': '합계 {usd}', 'ov.acceptance': '수용', 'ov.acceptanceNote': '“이의 없음” — 비율은 상한값입니다',
  'ov.accepted': '수용 {n}', 'ov.notAccepted': '미수용 {n}', 'ov.unobservedCount': '미관측 {n}', 'ov.na': '해당 없음 {n}', 'ov.unknownCount': '알 수 없음 {n}',
  'ov.signals': '신호:', 'ov.subscriptionLimits': '구독 한도', 'ov.fiveHourUsed': '5시간 사용', 'ov.sevenDayUsed': '7일 사용',
  'ov.resets': '{time} 초기화', 'ov.baseline': '기준선:', 'ov.baselinePending': '대기 중 (Phase 0 라우터 OFF 기준선 미측정)',
  'ov.flags': '플래그:', 'ov.estimated': '추정 {n}', 'ov.unknownCostFlag': '비용 불명 {n}', 'ov.overBudget': '예산 초과 {n}',

  'tl.level': '레벨:', 'tl.thRequest': '요청', 'tl.thOutcome': '결과', 'tl.thLeadWorkers': '총괄 / 작업자',
  'tl.thFiles': '파일', 'tl.thTime': '시간', 'tl.thVerify': '검증', 'tl.notAccepted': '미수용', 'tl.unobserved': '미관측',
  'tl.est': '추정', 'tl.over': '초과', 'tl.failN': '실패 {n}', 'tl.loadMore': '더 보기', 'tl.end': '끝', 'tl.loadingMore': '불러오는 중…',
  'tl.requestDetail': '요청 상세', 'tl.close': '닫기', 'tl.couldNotLoadDetail': '상세를 불러올 수 없습니다: {kind}',
  'tl.signalsN': '신호 {n}개', 'tl.promptLabel': '프롬프트:', 'tl.promptRecorded': '기록됨', 'tl.promptNot': '기록 안 됨',
  'tl.acceptanceLabel': '수용:', 'tl.holdoutLabel': '홀드아웃:', 'tl.thSubtask': '하위작업', 'tl.thAttempt': '시도',
  'tl.thCheck': '검사', 'tl.thDetail': '상세', 'tl.titleUserAcceptance': '사용자 수용', 'tl.titleRoutingArm': '라우팅 아암',
  'tl.titleContainsEstimate': '추정값 포함', 'tl.titleSomeUnknown': '일부 비용 불명',

  'lr.levelHeld': '레벨 유지', 'lr.triageByRule': '판정 대 실제 (규칙별)', 'lr.suggestionsNote': '제안은 보여주기만 하며 자동 적용되지 않습니다.',
  'lr.thRule': '규칙', 'lr.thReinforced': '증원', 'lr.thUpStreaks': '상승', 'lr.thSuggestion': '제안',
  'lr.raiseLevel': '레벨 올림', 'lr.raiseStartStep': '시작 단계 올림', 'lr.plannedFinal': '판정 → 최종 레벨',
  'lr.thPlanned': '판정', 'lr.thFinal': '최종', 'lr.changed': '변경됨',

  'rt.autoRelease': '자동 해제', 'rt.modeLabel': '모드: {mode}', 'rt.holdout': '홀드아웃 {pct}',
  'rt.ruleText': '팀 비용이 직접 처리의 {x}배를 넘으면 해제(최근 {d}일, n ≥ {maj}/{min}); {re}배 이하로 돌아오면 재활성',
  'rt.offNote': '자동 해제가 꺼져 있습니다: 홀드아웃을 두지 않고 비교도 표시하지 않습니다.', 'rt.lead': '{cls} 총괄',
  'rt.delegatesFrom': '{from}부터 위임', 'rt.autoConfigured': '(자동, 설정값 {from})',
  'rt.thTeamHoldout': '팀 / 홀드아웃', 'rt.thNAccepted': 'n (수용)', 'rt.thCostAccepted': '수용당 비용', 'rt.thDecision': '판단',
  'rt.handledDirectly': '설정에 따라 직접 처리', 'rt.released': '해제됨', 'rt.candidate': '후보',
  'rt.notEnoughData': '데이터 부족 (팀 {dh}/{dn}, 직접 {ih}/{in})', 'rt.wouldBeReleased': '해제 대상 (관찰 모드: 전환은 없음)',
  'rt.armTeam': '팀', 'rt.armProbes': '탐침', 'rt.armHoldout': '홀드아웃', 'rt.armReleased': '해제됨',
  'rt.notAvailable': '라우팅 데이터를 쓸 수 없습니다 (구버전 데몬이거나 라우팅이 꺼짐).',
  'rt.actionHold': '유지', 'rt.actionRelease': '해제', 'rt.actionReenable': '재활성',
  'rt.reasonNoDirectCost': '직접 처리 비용 없음', 'rt.reasonDelegatedDearer': '위임이 더 비쌈', 'rt.reasonDelegatedNotDearer': '위임이 비싸지 않음', 'rt.reasonInsideBand': '밴드 이내',
  'rt.decision': '{action} — {reason}', 'rt.ratioSuffix': ' · 비율 {r}',

  'nw.currentRequest': '현재 요청', 'nw.lead': '총괄 {cls} ({model})', 'nw.unknown': '알 수 없음',
  'nw.cost': '비용 {cost} / 예산 {budget}', 'nw.estimated': '추정', 'nw.partlyUnknown': '일부 불명',
  'nw.subscription': '구독:', 'nw.noActive': '이 세션에 진행 중인 요청이 없습니다.', 'nw.team': '팀',
  'nw.thRole': '역할', 'nw.thSlot': '슬롯', 'nw.thStep': '단계', 'nw.thModelEffort': '모델 × effort', 'nw.sessionTotal': '세션 합계: {usd}',
};

const ja: Dict = {
  'app.title': 'Agentic Router',
  'app.subtitle': '読み取り専用のローカルダッシュボード · すべてのデータはこの端末内に留まります',
  'tab.overview': '概要', 'tab.requests': 'リクエスト', 'tab.learning': '学習', 'tab.routing': 'ルーティング', 'tab.now': '現在',

  'common.refresh': '更新', 'common.all': 'すべて', 'common.total': '合計', 'common.count': '件数',
  'common.level': 'レベル', 'common.status': '状態', 'common.ok': 'ok', 'common.fail': '失敗', 'common.failed': '失敗',

  'banner.loading': '読み込み中…', 'banner.cantLoad': 'データを読み込めません', 'banner.retry': '再試行',
  'banner.daemonOff': 'ルーターデーモンが起動していません。`agentic-router start` で起動してから再試行してください。',
  'banner.timeout': 'デーモンが時間内に応答しませんでした。混み合っている可能性があります。少し待って再試行してください。',
  'banner.unauthorized': 'このダッシュボードのセッションは期限切れです。`agentic-router dashboard` で開き直してください。',
  'banner.httpError': 'デーモンがエラーを返しました。再試行し、続く場合はデーモンのログを確認してください。',

  'ov.requests': 'リクエスト', 'ov.noObjection': '異議なし', 'ov.acceptancePending': 'verify 判定（受容集計は準備中）',
  'ov.unobserved': '未観測 {pct}', 'ov.costPerAccepted': '受容タスクあたり費用', 'ov.teamFit': 'チーム適合度',
  'ov.startStepFit': '開始ステップ適合度', 'ov.stepUpRate': '上昇率', 'ov.cacheHit': 'キャッシュヒット', 'ov.apiMode': 'API モード',
  'ov.leadVsWorkers': 'リード対ワーカー', 'ov.leadVsWorkersHint': 'リード対サブタスク費用の合計', 'ov.costByLevel': 'レベル別費用',
  'ov.totalCost': '合計 {usd}', 'ov.acceptance': '受容', 'ov.acceptanceNote': '「異議なし」— この割合は上限値です',
  'ov.accepted': '受容 {n}', 'ov.notAccepted': '非受容 {n}', 'ov.unobservedCount': '未観測 {n}', 'ov.na': '該当なし {n}', 'ov.unknownCount': '不明 {n}',
  'ov.signals': 'シグナル:', 'ov.subscriptionLimits': 'サブスク上限', 'ov.fiveHourUsed': '5時間使用', 'ov.sevenDayUsed': '7日使用',
  'ov.resets': '{time} にリセット', 'ov.baseline': 'ベースライン:', 'ov.baselinePending': '保留（Phase 0 のルーター OFF ベースライン未測定）',
  'ov.flags': 'フラグ:', 'ov.estimated': '推定 {n}', 'ov.unknownCostFlag': '費用不明 {n}', 'ov.overBudget': '予算超過 {n}',

  'tl.level': 'レベル:', 'tl.thRequest': 'リクエスト', 'tl.thOutcome': '結果', 'tl.thLeadWorkers': 'リード / ワーカー',
  'tl.thFiles': 'ファイル', 'tl.thTime': '時間', 'tl.thVerify': '検証', 'tl.notAccepted': '非受容', 'tl.unobserved': '未観測',
  'tl.est': '推定', 'tl.over': '超過', 'tl.failN': '失敗 {n}', 'tl.loadMore': 'さらに表示', 'tl.end': '終わり', 'tl.loadingMore': '読み込み中…',
  'tl.requestDetail': 'リクエスト詳細', 'tl.close': '閉じる', 'tl.couldNotLoadDetail': '詳細を読み込めませんでした: {kind}',
  'tl.signalsN': 'シグナル {n} 件', 'tl.promptLabel': 'プロンプト:', 'tl.promptRecorded': '記録あり', 'tl.promptNot': '記録なし',
  'tl.acceptanceLabel': '受容:', 'tl.holdoutLabel': 'ホールドアウト:', 'tl.thSubtask': 'サブタスク', 'tl.thAttempt': '試行',
  'tl.thCheck': 'チェック', 'tl.thDetail': '詳細', 'tl.titleUserAcceptance': 'ユーザー受容', 'tl.titleRoutingArm': 'ルーティングアーム',
  'tl.titleContainsEstimate': '推定値を含む', 'tl.titleSomeUnknown': '一部の費用が不明',

  'lr.levelHeld': 'レベル維持', 'lr.triageByRule': '判定対実績（ルール別）', 'lr.suggestionsNote': '提案は表示のみで、自動適用はされません。',
  'lr.thRule': 'ルール', 'lr.thReinforced': '増員', 'lr.thUpStreaks': '上昇', 'lr.thSuggestion': '提案',
  'lr.raiseLevel': 'レベルを上げる', 'lr.raiseStartStep': '開始ステップを上げる', 'lr.plannedFinal': '判定 → 最終レベル',
  'lr.thPlanned': '判定', 'lr.thFinal': '最終', 'lr.changed': '変更',

  'rt.autoRelease': '自動解除', 'rt.modeLabel': 'モード: {mode}', 'rt.holdout': 'ホールドアウト {pct}',
  'rt.ruleText': 'チーム費用が直接処理の {x} 倍を超えたら解除（直近 {d} 日, n ≥ {maj}/{min}）; {re} 倍以下で再有効化',
  'rt.offNote': '自動解除はオフです: ホールドアウトを取らず、比較も表示しません。', 'rt.lead': '{cls} リード',
  'rt.delegatesFrom': '{from} から委任', 'rt.autoConfigured': '（自動, 設定値 {from}）',
  'rt.thTeamHoldout': 'チーム / ホールドアウト', 'rt.thNAccepted': 'n（受容）', 'rt.thCostAccepted': '受容あたり費用', 'rt.thDecision': '判断',
  'rt.handledDirectly': '設定により直接処理', 'rt.released': '解除済み', 'rt.candidate': '候補',
  'rt.notEnoughData': 'データ不足（チーム {dh}/{dn}, 直接 {ih}/{in}）', 'rt.wouldBeReleased': '解除対象（観察モード: 切り替えは行いません）',
  'rt.armTeam': 'チーム', 'rt.armProbes': '探針', 'rt.armHoldout': 'ホールドアウト', 'rt.armReleased': '解除済み',
  'rt.notAvailable': 'ルーティングデータは利用できません（旧バージョンのデーモン、またはルーティングがオフ）。',
  'rt.actionHold': '維持', 'rt.actionRelease': '解除', 'rt.actionReenable': '再有効化',
  'rt.reasonNoDirectCost': '直接処理の費用なし', 'rt.reasonDelegatedDearer': '委任の方が高い', 'rt.reasonDelegatedNotDearer': '委任は高くない', 'rt.reasonInsideBand': 'バンド内',
  'rt.decision': '{action} — {reason}', 'rt.ratioSuffix': ' · 比率 {r}',

  'nw.currentRequest': '現在のリクエスト', 'nw.lead': 'リード {cls}（{model}）', 'nw.unknown': '不明',
  'nw.cost': '費用 {cost} / 予算 {budget}', 'nw.estimated': '推定', 'nw.partlyUnknown': '一部不明',
  'nw.subscription': 'サブスク:', 'nw.noActive': 'このセッションに進行中のリクエストはありません。', 'nw.team': 'チーム',
  'nw.thRole': '役割', 'nw.thSlot': 'スロット', 'nw.thStep': 'ステップ', 'nw.thModelEffort': 'モデル × effort', 'nw.sessionTotal': 'セッション合計: {usd}',
};

const zhCN: Dict = {
  'app.title': 'Agentic Router',
  'app.subtitle': '只读本地仪表板 · 所有数据都留在本机',
  'tab.overview': '概览', 'tab.requests': '请求', 'tab.learning': '学习', 'tab.routing': '路由', 'tab.now': '当前',

  'common.refresh': '刷新', 'common.all': '全部', 'common.total': '合计', 'common.count': '数量',
  'common.level': '级别', 'common.status': '状态', 'common.ok': 'ok', 'common.fail': '失败', 'common.failed': '失败',

  'banner.loading': '加载中…', 'banner.cantLoad': '无法加载数据', 'banner.retry': '重试',
  'banner.daemonOff': '路由守护进程未运行。请用 `agentic-router start` 启动后重试。',
  'banner.timeout': '守护进程未在限定时间内响应。可能正忙，请稍后重试。',
  'banner.unauthorized': '此仪表板会话已过期。请用 `agentic-router dashboard` 重新打开。',
  'banner.httpError': '守护进程返回了错误。请重试；若持续出现，请查看守护进程日志。',

  'ov.requests': '请求', 'ov.noObjection': '未见异议', 'ov.acceptancePending': 'verify 判定（受理统计准备中）',
  'ov.unobserved': '未观测 {pct}', 'ov.costPerAccepted': '每个受理任务成本', 'ov.teamFit': '团队契合度',
  'ov.startStepFit': '起始档位契合度', 'ov.stepUpRate': '升档率', 'ov.cacheHit': '缓存命中', 'ov.apiMode': 'API 模式',
  'ov.leadVsWorkers': '主控 对 工作者', 'ov.leadVsWorkersHint': '主控与子任务成本合计', 'ov.costByLevel': '按级别的成本',
  'ov.totalCost': '合计 {usd}', 'ov.acceptance': '受理', 'ov.acceptanceNote': '“未见异议”——该比率为上限值',
  'ov.accepted': '受理 {n}', 'ov.notAccepted': '未受理 {n}', 'ov.unobservedCount': '未观测 {n}', 'ov.na': '不适用 {n}', 'ov.unknownCount': '未知 {n}',
  'ov.signals': '信号:', 'ov.subscriptionLimits': '订阅额度', 'ov.fiveHourUsed': '5 小时已用', 'ov.sevenDayUsed': '7 天已用',
  'ov.resets': '{time} 重置', 'ov.baseline': '基线:', 'ov.baselinePending': '待定（Phase 0 路由关闭基线尚未测量）',
  'ov.flags': '标记:', 'ov.estimated': '估算 {n}', 'ov.unknownCostFlag': '成本未知 {n}', 'ov.overBudget': '超预算 {n}',

  'tl.level': '级别:', 'tl.thRequest': '请求', 'tl.thOutcome': '结果', 'tl.thLeadWorkers': '主控 / 工作者',
  'tl.thFiles': '文件', 'tl.thTime': '时间', 'tl.thVerify': '验证', 'tl.notAccepted': '未受理', 'tl.unobserved': '未观测',
  'tl.est': '估算', 'tl.over': '超出', 'tl.failN': '失败 {n}', 'tl.loadMore': '加载更多', 'tl.end': '到底', 'tl.loadingMore': '加载中…',
  'tl.requestDetail': '请求详情', 'tl.close': '关闭', 'tl.couldNotLoadDetail': '无法加载详情: {kind}',
  'tl.signalsN': '{n} 条信号', 'tl.promptLabel': '提示词:', 'tl.promptRecorded': '已记录', 'tl.promptNot': '未记录',
  'tl.acceptanceLabel': '受理:', 'tl.holdoutLabel': '留出组:', 'tl.thSubtask': '子任务', 'tl.thAttempt': '尝试',
  'tl.thCheck': '检查', 'tl.thDetail': '详情', 'tl.titleUserAcceptance': '用户受理', 'tl.titleRoutingArm': '路由分支',
  'tl.titleContainsEstimate': '含估算值', 'tl.titleSomeUnknown': '部分成本未知',

  'lr.levelHeld': '级别保持', 'lr.triageByRule': '判定对实际（按规则）', 'lr.suggestionsNote': '建议仅作展示，不会自动应用。',
  'lr.thRule': '规则', 'lr.thReinforced': '增援', 'lr.thUpStreaks': '升档', 'lr.thSuggestion': '建议',
  'lr.raiseLevel': '提升级别', 'lr.raiseStartStep': '提升起始档位', 'lr.plannedFinal': '判定 → 最终级别',
  'lr.thPlanned': '判定', 'lr.thFinal': '最终', 'lr.changed': '已变更',

  'rt.autoRelease': '自动解除', 'rt.modeLabel': '模式: {mode}', 'rt.holdout': '留出 {pct}',
  'rt.ruleText': '当团队成本超过直接处理的 {x} 倍时解除（最近 {d} 天, n ≥ {maj}/{min}）; 回落到 {re} 倍及以下时重新启用',
  'rt.offNote': '自动解除已关闭: 不设留出组，也不展示对比。', 'rt.lead': '{cls} 主控',
  'rt.delegatesFrom': '从 {from} 起委派', 'rt.autoConfigured': '（自动, 配置为 {from}）',
  'rt.thTeamHoldout': '团队 / 留出', 'rt.thNAccepted': 'n（受理）', 'rt.thCostAccepted': '每受理成本', 'rt.thDecision': '判定',
  'rt.handledDirectly': '按配置直接处理', 'rt.released': '已解除', 'rt.candidate': '候选',
  'rt.notEnoughData': '数据不足（团队 {dh}/{dn}, 直接 {ih}/{in}）', 'rt.wouldBeReleased': '将被解除（观察模式: 不做切换）',
  'rt.armTeam': '团队', 'rt.armProbes': '探针', 'rt.armHoldout': '留出', 'rt.armReleased': '已解除',
  'rt.notAvailable': '路由数据不可用（守护进程版本较旧，或路由已关闭）。',
  'rt.actionHold': '保持', 'rt.actionRelease': '解除', 'rt.actionReenable': '重新启用',
  'rt.reasonNoDirectCost': '无直接处理成本', 'rt.reasonDelegatedDearer': '委派更贵', 'rt.reasonDelegatedNotDearer': '委派不更贵', 'rt.reasonInsideBand': '在区间内',
  'rt.decision': '{action} — {reason}', 'rt.ratioSuffix': ' · 比率 {r}',

  'nw.currentRequest': '当前请求', 'nw.lead': '主控 {cls}（{model}）', 'nw.unknown': '未知',
  'nw.cost': '成本 {cost} / 预算 {budget}', 'nw.estimated': '估算', 'nw.partlyUnknown': '部分未知',
  'nw.subscription': '订阅:', 'nw.noActive': '此会话没有进行中的请求。', 'nw.team': '团队',
  'nw.thRole': '角色', 'nw.thSlot': '槽位', 'nw.thStep': '档位', 'nw.thModelEffort': '模型 × effort', 'nw.sessionTotal': '会话合计: {usd}',
};

const DICTS: Record<LocaleId, Dict> = { en, ko, ja, 'zh-CN': zhCN };
const STORAGE_KEY = 'ar_dash_locale';

function detect(): LocaleId {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && (LOCALES as readonly string[]).includes(stored)) return stored as LocaleId;
  } catch { /* storage blocked */ }
  const nav = (typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en').toLowerCase();
  if (nav.startsWith('ko')) return 'ko';
  if (nav.startsWith('ja')) return 'ja';
  if (nav.startsWith('zh')) return 'zh-CN';
  return 'en';
}

export const locale = ref<LocaleId>(detect());

export function setLocale(id: LocaleId): void {
  locale.value = id;
  try { localStorage.setItem(STORAGE_KEY, id); } catch { /* storage blocked: honor it for this session only */ }
}

/** Translate a key, substituting {name} placeholders. Reads `locale` so templates re-render on change. */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const template = DICTS[locale.value][key] ?? en[key];
  return params ? template.replace(/\{(\w+)\}/g, (_, k) => (k in params ? String(params[k]) : `{${k}}`)) : template;
}
