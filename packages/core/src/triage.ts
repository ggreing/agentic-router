// Stage-1 triage (spec 3.2, decisions 104-111).
//
// The daemon calls triage() on every new user request and injects formatTriageContext() into the
// lead's context. Stage 1 is free and only settles the clear cases; it answers one of
//   direct    - a small change (level L0 or L1)
//   team      - a team is worth it (level L2)
//   uncertain - the wording does not show the size of the change (source 'default'; level L1, or L2 when
//               the presets delegate L1: see uncertainLevel, decision 121)
// Automatic triage plans at most L2 (decision 119: in the cost measurement of decision 107 the L3 team
// cost 67% more than the lead alone and won on one task of fifteen). Wording that points to L3 is kept as
// `l3Signs`; the L3 team is reached by `/router level L3` or by the lead, who is shown its call values and
// raises the request by calling it first (decision 113).
// An uncertain request starts as lead-direct with a short rubric; the lead switches to the L2 team (or,
// for a clearly larger change, the L3 team) by calling a router agent: the daemon re-plans the request
// at the first call and reads the level from that call's values (decisions 109, 113). In API-key mode the
// stage-2 judge (triage-judge.ts) decides uncertain requests instead.
// With presets that delegate L1 (an Opus- or Sonnet-class lead, decisions 117, 124) there is no lead-direct start to
// switch from: an uncertain request is planned as the L2 team and the lead calls only the roles the
// change needs (decision 121). That is the arrangement the measurement of decision 107 ran.
//
// Why so few cases are settled here: on 500 SWE-bench Verified issues neither prompt features nor
// repository signals predicted the size of the fix (AUC 0.45-0.64), so stage 1 does not guess.
import { DEFAULT_PRESETS } from './presets.ts';
import { ladderStep } from './ladder.ts';
import type { Level, Role, TaskType, TeamPreset, TriageResult } from './types.ts';

export interface TriageInput {
  prompt: string;
  cwd?: string;
  mentionedFiles?: string[];   // paths the caller extracted; otherwise counted from the prompt
  repoFileCount?: number;
}

export type TriageKind = 'direct' | 'team' | 'uncertain';

/** Numbers, flags and short category values describing a prompt. Never contains prompt text (decision 110). */
export type PromptFeatures = Record<string, number | string | boolean>;

/** Stage-1 output: a TriageResult plus the three-way answer, the deciding rule and the feature values. */
export interface Stage1Result extends TriageResult {
  kind: TriageKind;
  rule: string;                // id of the rule that decided, or 'none' when uncertain
  teamScore: number;           // 0..1, higher = more team-like. An ordering, not a calibrated probability.
  /** The wording (or the judge) points to L3. The plan is still L2 (decision 119); the brief then shows the lead how to raise it. */
  l3Signs: boolean;
  features: PromptFeatures;
}

/** Below this confidence the stage-1 result is not trusted: every uncertain result is below it. */
export const RULE_CONFIDENCE_THRESHOLD = 0.6;

/**
 * Size at which a change counts as team-sized. Used in the lead's rubric and, after the fact, to label
 * what a request really needed. Provisional until the cost measurement of decision 107 replaces it.
 */
export const TEAM_SIZE_RULE = { files: 4, dirs: 2 } as const;

/**
 * Size at which a team-sized change counts as L3 rather than L2 (decision 113). The file count is the
 * one stage 1 already uses for "many files named"; the other signs are in L3_SIGNS. Provisional like
 * TEAM_SIZE_RULE. Since decision 119 these mark a request (`l3Signs`) and word the lead's rubric; they
 * no longer plan a request at L3.
 */
export const L3_SIZE_RULE = { files: 10 } as const;
/** What makes a change L3, as the lead's rubric words it (the lead-orchestrator skill repeats this). */
export const L3_SIGNS = 'a new service or subsystem, an architecture change, a redesign that cuts across layers';
/** Starts the rationale of a request that showed L3 signs (`l3Signs`), whether stage 1 or the judge saw them. */
export const L3_PLANNED_AS_L2 = 'L3 signs, planned as L2';

interface Rule { level: Level; weight: number; why: string; re: RegExp }

// Keyword rules: Korean, Japanese, Chinese (Simplified and Traditional) and English (decision 139).
// English alternatives get word boundaries (rapid != API, prefix != fix, node_modules != module). The others
// do not: Korean particles attach directly to the word (API를, 버그가), and Japanese and Chinese are written
// without spaces, so \b says nothing there. Words that also name ordinary product features are left out or
// narrowed (a Japanese "コメント" is as often a user comment as a code comment).
const rule = (level: Level, weight: number, why: string, w: { ko: string; ja: string; zh: string; en: string }): Rule =>
  ({ level, weight, why, re: new RegExp(`${w.ko}|${w.ja}|${w.zh}|\\b(?:${w.en})\\b`, 'i') });
const RULES: Rule[] = [
  rule('L0', 0.8, 'typo/lint/format', {
    ko: '오타|오탈자|철자|린트|포맷|들여쓰기|주석|import ?정리',
    ja: '誤字|脱字|タイポ|スペルミス|綴り|リント|整形|フォーマッタ|コードフォーマット|インデント|コメントアウト|コメント(?:を|の)(?:修正|削除|追記|直)|注釈|未使用(?:の)? ?import|import ?(?:の|を)?整理',
    zh: '错别字|錯別字|错字|錯字|拼写|拼寫|笔误|筆誤|格式化|缩进|縮進|縮排|注释|註釋|註解|未使用的? ?import|没用到的 ?import|整理 ?import',
    en: 'typos?|misspell(?:ed|ing|ings)?|lint|format(?:ting)?|indent(?:ation)?|comments?|unused imports?',
  }),
  rule('L0', 0.6, 'single constant/default/message', {
    ko: '기본값|상수|메시지|문구|오프 ?바이 ?원|export 누락',
    ja: 'デフォルト値|既定値|初期値|定数|メッセージ|文言|オフバイワン|export ?(?:漏れ|忘れ|が抜け)',
    zh: '默认值|預設值|缺省值|常量|常數|消息|訊息|提示语|提示語|文案|措辞|措辭|差一错误|差一錯誤|漏了? ?export|缺少 ?export|少了 ?export',
    en: 'default values?|constants?|message text|off[- ]by[- ]one|missing exports?',
  }),
  rule('L1', 0.6, 'bug fix', {
    ko: '버그|고쳐|수정해|에러|오류|예외|안 ?돼|안 ?됨|깨져',
    ja: 'バグ|不具合|直して|直す|修正して|修正する|修正を|エラー|例外|動かない|動きません|動作しない|壊れ|クラッシュ',
    zh: '缺陷|修复|修復|修一下|修好|错误|錯誤|报错|報錯|异常|異常|崩溃|崩潰|不工作|不能用|坏了|壞了|出错|出錯',
    en: 'bugs?|fix(?:es|ed|ing)?|errors?|exceptions?|broken|fail(?:s|ed|ing)?|crash(?:es|ed|ing)?',
  }),
  rule('L1', 0.5, 'small feature/option', {
    ko: '옵션|파라미터|인자|엣지 ?케이스|유니코드|테스트 추가',
    ja: 'オプション|パラメータ|パラメーター|引数|エッジケース|境界ケース|ユニコード|テスト(?:を|の)?追加',
    zh: '选项|選項|参数|參數|边界情况|邊界情況|边缘情况|邊緣情況|(?:添加|增加|新增|补充|補充|加(?:个|個)?)测试|(?:添加|增加|新增|補充|加個?)測試',
    en: 'options?|parameters?|arguments?|edge cases?|unicode|add (?:a )?tests?',
  }),
  rule('L2', 0.7, 'module-level change', {
    ko: '리팩터|리팩토|모듈|계층|페이지네이션|필터링|스키마|검증 ?로직|감사 ?로그|이력|마이그레이션',
    ja: 'リファクタ|モジュール|レイヤ|階層|層|ページネーション|フィルタリング|絞り込み|スキーマ|バリデーション ?ロジック|検証ロジック|監査ログ|履歴|マイグレーション|移行',
    zh: '重构|重構|模块|模組|模塊|层|層|分页|分頁|过滤|過濾|筛选|篩選|校验逻辑|校驗邏輯|验证逻辑|驗證邏輯|审计日志|審計日誌|稽核日誌|稽核紀錄|变更历史|變更歷史|变更记录|變更記錄|历史记录|歷史記錄|迁移|遷移',
    en: 'refactor(?:s|ed|ing)?|modules?|layers?|pagination|filtering|schemas?|validation|audit(?:s|ing| log)?|history|migrations?',
  }),
  rule('L2', 0.5, 'new API/endpoint/feature', {
    ko: '엔드포인트|기능을? 추가|구현해',
    ja: 'エンドポイント|機能(?:を|の)?追加|実装して|実装する|実装を',
    zh: '端点|端點|(?:添加|新增|增加|加上?)(?:一?(?:个|個|项|項))?(?:新)?功能|(?:实现|實現|實作)(?![在位是见見放于於])',
    en: 'APIs?|endpoints?|add (?:a )?feature|implement(?:s|ed|ing)?',
  }),
  rule('L3', 0.9, 'new service/architecture', {
    ko: '신규 서비스|새 서비스|아키텍처|처음부터|재설계|전면|프레임워크 (?:교체|전환)|시스템 전체|마이크로서비스',
    ja: '新規サービス|新しいサービス|新サービス|アーキテクチャ|ゼロから|一から|再設計|全面的|全面(?:刷新|改修|書き換え)|フレームワーク(?:を|の)?(?:置き換え|移行|切り替え|変更)|システム全体|マイクロサービス|作り直し|書き直し',
    zh: '新(?:的)?服务|新(?:的)?服務|全新(?:的)?服[务務]|架构|架構|从零|從零|从头(?:开始)?(?:写|做|设计|构建|搭建|开发|实现|重写)|從頭(?:開始)?(?:寫|做|設計|構建|搭建|開發|實現|實作|重寫)|重新设计|重新設計|全面|框架(?:的)?(?:替换|替換|迁移|遷移|切换|切換)|整个系统|整個系統|微服务|微服務|重写|重寫|推倒重来|推倒重來',
    en: 'new service|architecture|from scratch|redesign|overhaul|rewrite|whole system|microservices?',
  }),
];

// The user says the change is wide. This is the one wording signal that states size directly.
const BREADTH = new RegExp([
  '여러 (?:개의 )?(?:파일|모듈|패키지|서비스)', '모듈 단위', '전 계층', '계층별', '코드베이스 전체', '프로젝트 전체', '저장소 전체',
  '모든 (?:핸들러|모듈|파일|엔드포인트|서비스|컴포넌트|화면|테이블|호출부)',
  // Japanese
  '複数(?:の)?(?:ファイル|モジュール|パッケージ|サービス|レイヤー?|層)', 'モジュール単位', '全(?:レイヤー?|層|階層)', '(?:レイヤー?|層|階層)(?:ごと|別)',
  '(?:コードベース|プロジェクト|リポジトリ)全体',
  '(?:すべて|全て|全部)の(?:ハンドラー?|モジュール|ファイル|エンドポイント|サービス|コンポーネント|画面|テーブル|呼び出し(?:元|箇所|側))',
  '全(?:ハンドラー?|モジュール|ファイル|エンドポイント|サービス|コンポーネント|画面|テーブル)',
  // Chinese, Simplified and Traditional
  '(?:多个|多個|若干|好几个|好幾個)(?:文件|檔案|模块|模組|模塊|包|套件|服务|服務|层|層)', '按模块|按模組|以模[块組]为单位',
  '(?:所有|各|每一?)(?:个|個)?(?:层|層)', '按层|按層|逐层|逐層',
  '整个(?:代码库|代码仓库|项目|仓库|工程)|整個(?:程式碼庫|代碼庫|專案|項目|倉庫)',
  '(?:所有|全部)(?:的)?(?:处理器|處理器|处理函数|處理函式|handler|模块|模組|模塊|文件|檔案|端点|端點|接口|服务|服務|组件|元件|組件|页面|頁面|表|调用处|调用方|調用處|呼叫端)',
  // 'each file' describes a loop as often as a wide change, so 每个 counts with a code unit only, as English each/every does
  '(?:每个|每個|每一个|每一個)(?:处理器|處理器|处理函数|處理函式|handler|模块|模組|模塊|端点|端點|服务|服務|组件|元件|組件)',
  '\\b(?:multiple|several|many) (?:files|modules|packages|services|layers)\\b',
  '\\bacross (?:the )?(?:whole |entire )?(?:codebase|code base|project|repo(?:sitory)?|modules|layers|packages|services|files|multiple \\w+)\\b',
  '\\b(?:every|each) (?:handler|module|endpoint|service|component|layer|package)\\b',
  '\\ball (?:the )?(?:handlers|modules|endpoints|services|components|call sites|callers|layers|packages)\\b',
  '\\b(?:codebase|project|repo)-wide\\b',
].join('|'), 'gi');

// "All of them", "everywhere": the request may be small per place but it is not one place. Such a
// request is never settled as direct by stage 1, whatever else it says.
// (English "all" and "every" alone are too common to mean anything, so they count only with a noun for code places.)
const PLACES = 'files?|messages?|strings?|handlers?|modules?|endpoints?|services?|components?|places?|occurrences?|usages?|call sites?|callers?|errors?|tests?|pages?|screens?|tables?|queries|query';
const QUANTIFIER = new RegExp(`전부|모두|일괄|전체|곳곳|싹 다|全部|すべて|全て|一括|全体|あちこち|至る所|いたるところ|所有|一律|批量|整体|整體|到处|到處|各处|各處|统统|統統|全都|\\b(?:everywhere|throughout|(?:all|every|each)(?: of)?(?: the| our)? (?:\\w+ )?(?:${PLACES})|entire (?:codebase|project|repo(?:sitory)?|app(?:lication)?))\\b`, 'i');

// A question: it opens with a question word, or ends as one. Japanese and Chinese questions often end
// without a question mark (ですか。 / 吗。), so the sentence-final particle counts too.
const QUESTION = new RegExp([
  '^\\s*(?:왜|어떻게|무엇|뭐|뭘|설명|알려|what\\b|why\\b|how\\b|explain\\b|is there\\b|can you explain\\b',
  'なぜ|なんで|どうして|どうやって|どのように|何が|何を|これは何|説明して|教えて',
  '为什么|為什麼|怎么|怎麼|如何|什么是|什麼是|这是什么|這是什麼|请解释|請解釋|解释一下|解釋一下|说明一下|說明一下|请问|請問)',
  '[?？]\\s*$', '(?:ですか|ますか|でしょうか|のか)[。.]?\\s*$', '[吗嗎呢][。.]?\\s*$',
  '(?:教えて|説明して)(?:ください|下さい|ほしい)?[。.]?\\s*$', '(?:解释|解釋|说明|說明)一下[。.]?\\s*$',
].join('|'), 'i');
const EDIT_VERB = new RegExp([
  '고쳐|수정|바꿔|추가|구현|만들어|작성해|넣어',
  '直して|直す|修正|変えて|変更して|追加|実装|作って|作成して|書いて|入れて',
  '修复|修復|修正|修改|改成|改为|改為|添加|新增|增加|加上|实现|實現|實作|创建|創建|建立|编写|編寫|撰寫',
  '\\b(?:fix|change|add|implement|create|write|refactor|update)\\b',
].join('|'), 'i');
// A question about something failing is a debugging task, not a question.
const FAILURE = new RegExp([
  '실패|에러|오류|안 ?돼|안 ?됨|깨져',
  '失敗|エラー|動かない|動きません|動作しない|壊れ|落ち(?:る|ます|た)|クラッシュ',
  '失败|错误|錯誤|报错|報錯|不工作|不能用|坏了|壞了|崩溃|崩潰|出错|出錯',
  "\\b(?:fail(?:s|ed|ing)?|errors?|crash(?:es|ed|ing)?|broken|exceptions?|(?:doesn'?t|does not|won'?t|not) work(?:ing)?)\\b",
].join('|'), 'i');
const DEBUG = /디버그|원인|왜 .*(안|실패)|デバッグ|原因|なぜ.*(?:ない|失敗)|スタックトレース|调试|調試|除錯|为什么.*(?:不|失败)|為什麼.*(?:不|失敗)|堆栈|堆疊|\b(?:debug(?:ging)?|root cause|stack ?trace|traceback)\b/i;
const DESIGN = /설계|아키텍처|設計|アーキテクチャ|设计|架构|架構|\b(?:design|architecture)\b/i;
const REFACTOR = /리팩터|리팩토|リファクタ|重构|重構|\brefactor/i;
const FEATURE = /추가|구현|만들어|새 |追加|実装|作って|作成|新しい|新規|添加|新增|增加|实现|實現|實作|创建|創建|新建|\b(?:new|add|implement|create)\b/i;
// A path or file name in prose. Japanese and Chinese text runs straight into it and uses full-width
// punctuation and brackets, so kana, Han characters and those marks end a name like a space does.
const CJK_EDGE = '\\u3040-\\u30ff\\u3400-\\u9fff\\u3000-\\u303f\\uff00-\\uffef';
const FILE_REF = new RegExp(`(?:^|[\\s\`'"(${CJK_EDGE}])((?:[\\w.-]+\\/)+[\\w.-]+\\.\\w{1,5}|[\\w-]+\\.(?:ts|tsx|js|mjs|py|go|rs|java|kt|rb|php|cs|vue|css|scss|json|ya?ml|md|sql))(?=$|[\\s\`'"),:${CJK_EDGE}])`, 'g');
// Lists and sections as Japanese and Chinese write them: "・" bullets, "1、" / "（1）" / "①" numbers (often
// with no space after), "【...】" and "■" section lines. Added to the Markdown forms, not instead of them.
const CJK_BULLET = /^[ \t\u3000]*[・•‧◦][ \t\u3000]*\S/gm;
const CJK_NUMBERED = /^[ \t\u3000]*(?:[0-9０-９]{1,2}[、．）]|[（(][0-9０-９]{1,2}[）)]|[①-⑳])[ \t\u3000]*\S/gm;
const CJK_HEADING = /^[ \t\u3000]*(?:【[^】\n]{1,40}】|[■◆▼●][ \t\u3000]*\S.{0,40})[ \t\u3000]*$/gm;

// Pasted material. Stack-trace / traceback lines are removed before keywords, length and file
// counting (a 10-frame trace is not a 10-file change) and count as a separate "log attached"
// signal. Fenced code blocks drop out of the file count and of the prose length; a type or
// signature declared inside one counts as part of a written specification.
const FENCE = /```[\s\S]*?(?:```|$)/g;
const TRACE_LINE = /^\s*(?:at .+[:(]\d+(?::\d+)?\)?|File ".+", line \d+.*|Traceback \(most recent call last\):|\w+(?:Error|Exception): .*)\s*$/gm;
const TYPE_DECL = /^\s*(?:export\s+)?(?:declare\s+)?(?:interface|type|enum|class|struct|def|func|fn|function)\s+[A-Za-z_]\w*/gm;

const count = (text: string, re: RegExp): number => (text.match(re) ?? []).length;
const distinct = (text: string, re: RegExp, group = 0): number => new Set([...text.matchAll(re)].map(m => m[group])).size;
const round2 = (x: number) => Math.round(x * 100) / 100;

interface Parsed { text: string; prose: string; fences: string[]; traceLines: number }

function parse(prompt: string): Parsed {
  const raw = prompt.trim();
  const traceLines = count(raw, TRACE_LINE);
  const text = raw.replace(TRACE_LINE, '').replace(/\n{3,}/g, '\n\n').trim();
  return { text, prose: text.replace(FENCE, ' '), fences: text.match(FENCE) ?? [], traceLines };
}

function taskTypeOf(text: string, isQuestion: boolean, attached: boolean): TaskType {
  if (isQuestion) return 'question';
  if (DEBUG.test(text) || (QUESTION.test(text) && FAILURE.test(text)) || attached) return 'debug';
  if (REFACTOR.test(text)) return 'refactor';
  if (DESIGN.test(text)) return 'design';
  if (FEATURE.test(text)) return 'feature';
  return 'edit';
}

function ruleScores(text: string): { score: Record<Level, number>; why: string[] } {
  const score: Record<Level, number> = { L0: 0, L1: 0, L2: 0, L3: 0 };
  const why: string[] = [];
  for (const r of RULES) if (r.re.test(text)) { score[r.level] += r.weight; why.push(r.why); }
  return { score, why };
}

function featuresOf(p: Parsed, raw: string, mentionedFiles?: string[]): PromptFeatures {
  const { text, prose, fences } = p;
  // Script mix (decision 139): which writing systems the prose is in. Han characters are shared by Chinese
  // and Japanese, so kana is what tells Japanese apart.
  const hangul = count(prose, /[가-힣]/g);
  const kana = count(prose, /[\u3040-\u30ff]/g);
  const han = count(prose, /[\u3400-\u9fff]/g);
  const latin = count(prose, /[A-Za-z]/g);
  const letters = hangul + kana + han + latin;
  const share = (n: number) => (letters ? round2(n / letters) : 0);
  const isQuestion = QUESTION.test(text) && !EDIT_VERB.test(text) && !FAILURE.test(text);
  const { score } = ruleScores(text);
  return {
    chars: raw.length,
    proseChars: prose.trim().length,
    lines: raw ? raw.split(/\r?\n/).length : 0,
    words: prose.split(/\s+/).filter(Boolean).length,
    headings: count(prose, /^#{1,6}\s+\S/gm) + count(prose, CJK_HEADING),
    bullets: count(prose, /^\s*[-*+]\s+\S/gm) + count(prose, CJK_BULLET),
    numberedItems: count(prose, /^\s*\d+[.)]\s+\S/gm) + count(prose, CJK_NUMBERED),
    codeFences: fences.length,
    fencedChars: fences.reduce((a, f) => a + f.length, 0),
    inlineCode: count(prose, /`[^`\n]+`/g),
    filePaths: mentionedFiles ? new Set(mentionedFiles).size : distinct(prose, FILE_REF, 1),
    identifiers: distinct(prose, /`([A-Za-z_][\w.]*)(?:\([^`\n]*\))?`/g, 1),
    urls: count(raw, /https?:\/\//g),
    hangulRatio: share(hangul), kanaRatio: share(kana), hanRatio: share(han), latinRatio: share(latin),
    script: kana / (letters || 1) >= 0.05 ? 'ja' : hangul / (letters || 1) >= 0.2 ? 'ko' : han / (letters || 1) >= 0.2 ? 'zh' : 'latin',
    questions: count(prose, /[?？]/g),
    traceLines: p.traceLines,
    typeDecls: fences.reduce((a, f) => a + count(f, TYPE_DECL), 0),
    breadthWords: count(prose, BREADTH),
    taskType: taskTypeOf(text, isQuestion, p.traceLines > 0),
    ruleL0: round2(score.L0), ruleL1: round2(score.L1), ruleL2: round2(score.L2), ruleL3: round2(score.L3),
  };
}

/** Feature values of a prompt for the request record (decision 110). The same object triage() returns as `features`. */
export function promptFeatures(prompt: string, mentionedFiles?: string[]): PromptFeatures {
  return featuresOf(parse(prompt), prompt.trim(), mentionedFiles);
}

// Thresholds of the stage-1 rules. A written specification: long prose with sections or declared types
// and many requirement items. A small request: short prose, few items, no sections.
const SPEC_PROSE = 900;
const SPEC_ITEMS = 8;
const SMALL_PROSE = 700;
const SMALL_ITEMS = 3;
// Files named in the prose. Naming a file is not changing it (tests, helpers and references are named
// too): on SWE-bench issues that named four or more files, the fix still touched one. So only a long
// list settles the answer; a shorter one moves the score.
const SOME_FILES = 4;
const MANY_FILES = 6;
const HUGE_FILES = L3_SIZE_RULE.files;

const num = (f: PromptFeatures, k: string): number => Number(f[k] ?? 0);

export function triage(input: TriageInput, presets: Record<Level, TeamPreset> = DEFAULT_PRESETS): Stage1Result {
  const raw = input.prompt.trim();
  const p = parse(raw);
  const f = featuresOf(p, raw, input.mentionedFiles);
  const taskType = f.taskType as TaskType;
  const { why } = ruleScores(p.text);
  const items = num(f, 'bullets') + num(f, 'numberedItems');
  const files = num(f, 'filePaths');
  const attached = p.traceLines > 0;
  if (attached) why.push('log attached');
  if (files >= 2) why.push(`${files} files`);

  const breadth = num(f, 'breadthWords') > 0;
  const spec = num(f, 'proseChars') >= SPEC_PROSE && items >= SPEC_ITEMS && (num(f, 'headings') >= 2 || num(f, 'typeDecls') >= 1) && !attached;
  const l3 = num(f, 'ruleL3') > 0;
  const l2 = num(f, 'ruleL2') > 0;
  const small = num(f, 'proseChars') < SMALL_PROSE && items <= SMALL_ITEMS && num(f, 'headings') === 0 && files < SOME_FILES;
  const everywhere = QUANTIFIER.test(p.prose);

  const done = (kind: TriageKind, level: Level, ruleId: string, confidence: number, teamScore: number, note?: string, l3Signs = false): Stage1Result => {
    const preset = presets[level];
    const reasons = [...(note ? [note] : []), ...why];
    return {
      level, confidence: round2(confidence), source: kind === 'uncertain' ? 'default' : 'rule', taskType, preset: preset.id, budgetUsd: preset.budgetUsd,
      rationale: kind === 'uncertain'
        ? `size not clear from the wording${reasons.length ? ` (${reasons.join(', ')})` : ''} -> ${preset.leadDirect ? `start as ${level}, the lead decides` : `${level} team, the lead picks the roles`}`
        : reasons.join(', ') || 'default rules',
      kind, rule: ruleId, teamScore: round2(teamScore), l3Signs, features: f,
    };
  };

  // ---- team: the request states or shows that the change is wide
  // Decision 119: L3 wording plans L2 and is kept as a mark; only the lead or the user raises a request to L3.
  if (l3 && !attached && taskType !== 'question') return done('team', 'L2', 'l3-keyword', 0.85, 0.95, L3_PLANNED_AS_L2, true);
  if (files >= HUGE_FILES) return done('team', 'L2', 'many-files', 0.8, 0.95, L3_PLANNED_AS_L2, true);
  if (files >= MANY_FILES) return done('team', 'L2', 'many-files', 0.75, 0.85);
  if (breadth && taskType !== 'question') return done('team', 'L2', 'stated-breadth', 0.8, 0.85, 'the request says it spans several files or modules');
  if (spec) return done('team', 'L2', 'written-spec', 0.75, 0.8, 'a written specification with sections and many requirements');

  // ---- direct: a question, or a small change with nothing that points to a team
  if (taskType === 'question') return done('direct', 'L0', 'question', 0.85, 0.05, 'question');
  if (small && !l2 && !everywhere) {
    if (num(f, 'ruleL0') > 0 && num(f, 'ruleL0') >= num(f, 'ruleL1')) return done('direct', 'L0', 'l0-keyword', 0.85, 0.05);
    if (attached) return done('direct', 'L1', 'debug-with-log', 0.7, 0.15);
    if (num(f, 'ruleL1') > 0 || num(f, 'ruleL0') > 0) return done('direct', 'L1', 'small-fix', 0.75, 0.15);
  }

  // ---- uncertain: weak signals only move the score, never the answer
  let score = 0.45;
  if (l2) score += 0.1;
  if (everywhere || files >= SOME_FILES) score += 0.1;
  if (items >= SPEC_ITEMS || num(f, 'proseChars') >= SPEC_PROSE) score += 0.1;
  if (num(f, 'headings') >= 2 || num(f, 'typeDecls') >= 1) score += 0.05;
  if (small) score -= 0.1;
  if (attached) score -= 0.1;
  const teamScore = Math.min(0.7, Math.max(0.3, score));
  // The confidence that "L1, direct" is right falls as the request looks more team-like.
  return done('uncertain', uncertainLevel(presets), 'none', Math.min(RULE_CONFIDENCE_THRESHOLD - 0.01, 0.95 - teamScore), teamScore);
}

/**
 * The level an uncertain request is planned at (decision 121). L1 while L1 is lead-direct: the lead
 * starts the change and may switch to a team. When the presets delegate L1 (an Opus-class lead after
 * withLeadModel, or `lead_direct: false` in teams.yaml), the one-coder L1 team would leave a team-sized
 * request without a reviewer or tester and with no way to add them, so the request gets the L2 team and
 * the lead calls only the roles it needs. The one-coder team is for requests settled as small.
 */
export function uncertainLevel(presets: Record<Level, TeamPreset>): Level {
  return presets.L1.leadDirect || presets.L2.leadDirect ? 'L1' : 'L2';
}

const agentCalls = (preset: TeamPreset): string[] => preset.roles.map(r => {
  const s = ladderStep(r.start);
  return `   - ${r.role}${r.count > 1 ? ` (up to ${r.count} in parallel, one subtask each)` : ''}: subagent_type "agentic-router:${r.role}", model "${s.alias}", effort "${s.effort}"`;
});

/** The teams an uncertain lead-direct request can switch to. A `Record<Level, TeamPreset>` fits. */
export interface EscalationTeams { L2: TeamPreset; L3?: TeamPreset }

/**
 * Roles whose first call tells the router "L3" (decision 113): in both teams, and started at a
 * different step in L3 than in L2. A role the two teams start at the same step, or one only the L3
 * team has, cannot signal the level, so the brief never asks the lead to begin with it.
 */
export function l3SignalRoles(l2: TeamPreset, l3: TeamPreset): Role[] {
  const start = (p: TeamPreset, role: Role) => p.roles.find(r => r.role === role && r.count > 0)?.start;
  return l3.roles.filter(r => r.count > 0 && start(l2, r.role) !== undefined && start(l2, r.role) !== r.start).map(r => r.role);
}

const orList = (xs: string[]): string => xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`;

const PROMPT_SHAPE ='   The prompt\'s first line is "[subtask:<ID>]", the second "[scope: <comma-separated globs this subtask may write>]", then the spec (goal, files, acceptance check).';

// The router's MCP tools are not named here (decision 145): a line at the end of the first brief was read a turn
// before it mattered and was never acted on. The daemon names the one tool that applies on the task
// notification, and reads a reviewer's or tester's verdict from its report itself.

/**
 * Brief for the lead: level, team with per-role start step (model alias + effort), budget, and the
 * exact Agent call shape. Phase 1 e2e round 1 showed a soft "follow the skill" line is ignored for
 * small tasks (decision 81), so the brief is directive and spells out the call.
 *
 * `escalation` names the teams an uncertain lead-direct request can switch to (decisions 109, 113):
 * pass the session's presets (teams.yaml applied) so the call values are the ones the router checks.
 * A single preset is taken as the L2 team, and the brief then offers no L3 path.
 * The L3 team appears only as something the lead may choose (decision 119): in the uncertain brief, and
 * in a team brief whose triage has `l3Signs`. In both the lead raises the request by making its first
 * call a role of l3SignalRoles(<the request's team>, L3) at that role's L3 start step.
 */
export function formatTriageContext(t: TriageResult, preset: TeamPreset, escalation: TeamPreset | EscalationTeams = DEFAULT_PRESETS): string {
  const l2 = 'roles' in escalation ? escalation : escalation.L2;
  const l3 = 'roles' in escalation ? undefined : escalation.L3;
  const team = preset.roles.map(r => {
    const s = ladderStep(r.start);
    return `${r.role} x${r.count} @${r.start} (model=${s.alias}, effort=${s.effort})`;
  }).join('; ');
  // Decision 83: a single writer works in the user's working tree (no merge step); only writers that
  // run at the same time get their own worktree, and the lead merges those branches.
  const parallel = preset.roles.some(r => r.count > 1);
  const head = `[agentic-router] level ${t.level} (source=${t.source}, confidence=${t.confidence.toFixed(2)}): ${t.rationale}`;
  if (preset.leadDirect) {
    // Decision 87: for the smallest changes the lead's own per-call overhead dominates, so a team costs more.
    if ((t as Partial<Stage1Result>).kind === 'uncertain' && !l2.leadDirect) {
      // Decisions 104, 105, 109: the wording did not show the size, so the lead judges after a first look.
      const direct = `Level ${t.level} is handled by you directly (team preset lead_direct): start the change yourself, without subagents.`;
      const rubric = `The router could not tell the size of this request from its wording. Switch to the team only if, after a first look, the change needs edits in ${TEAM_SIZE_RULE.files} or more files, or in ${TEAM_SIZE_RULE.dirs} or more modules or layers, or a design decision first (a new public API, schema or data model). Do not switch for a change you can finish in a few edits, and do not explore just to decide.`;
      const signal = l3 && !l3.leadDirect ? l3SignalRoles(l2, l3) : [];
      if (!l3 || !signal.length) {
        return [
          head, direct, rubric,
          `To switch, call the Agent tool once per subtask with exactly these parameters (team preset ${l2.id}); the router re-plans this request as ${l2.level} at your first call, and from then on you delegate as the lead-orchestrator skill describes:`,
          ...agentCalls(l2),
          PROMPT_SHAPE,
        ].join('\n');
      }
      // Decision 113: the lead may also pick the L3 team; the router reads the level from the first call.
      return [
        head, direct, rubric,
        `Which team: the ${l2.level} team, unless the change is clearly beyond it: ${L3_SIGNS}, or edits in ${L3_SIZE_RULE.files} or more files. Only then use the ${l3.level} team. When unsure between the two, use ${l2.level}.`,
        `To switch, call the Agent tool once per subtask with exactly the parameters of the team you chose. The router re-plans this request at your first call: as ${l3.level} when that call is the ${l3.level} team's ${orList(signal)} with the ${l3.level} values below, as ${l2.level} for any other call. From then on you delegate as the lead-orchestrator skill describes.`,
        `${l2.level} team (team preset ${l2.id}):`,
        ...agentCalls(l2),
        `${l3.level} team (team preset ${l3.id}); make your first call the ${signal[0]}:`,
        ...agentCalls(l3),
        PROMPT_SHAPE,
      ].join('\n');
    }
    return [
      head,
      `Level ${t.level} is handled by you directly (team preset lead_direct): make the change yourself, without subagents. Keep the edit minimal and do not explore beyond what the change needs.`,
      'The router only records this request. (If the user asks for a team, follow the lead-orchestrator skill.)',
    ].join('\n');
  }
  // Decision 119: a request with L3 signs is planned at L2; the L3 team is shown only as the lead's own way up.
  const raiseBy = (t as Partial<Stage1Result>).l3Signs && l3 && !l3.leadDirect && preset.level !== l3.level ? l3SignalRoles(preset, l3) : [];
  const raise = l3 && raiseBy.length ? [
    `Larger team: the router plans up to ${preset.level} on its own, and this request shows signs of a larger change. If it is clearly beyond this team (${L3_SIGNS}, or edits in ${L3_SIZE_RULE.files} or more files), use the ${l3.level} team instead: make your first Agent call the ${l3.level} team's ${raiseBy[0]} with the ${l3.level} values below, and the router re-plans this request as ${l3.level}. When unsure, stay with this team.`,
    `${l3.level} team (team preset ${l3.id}):`,
    ...agentCalls(l3),
  ] : [];
  // Decision 121: an uncertain request on a delegating team. The lead staffs it; a small change is one coder.
  const staffing = (t as Partial<Stage1Result>).kind === 'uncertain' && preset.roles.filter(r => r.count > 0).length > 1
    ? [`The router could not tell the size of this request from its wording, so the staffing is yours: call only the roles the change needs. One coder subtask alone is right for a small change (fewer than ${TEAM_SIZE_RULE.files} files, one module). Use the rest of the team only when the change needs edits in ${TEAM_SIZE_RULE.files} or more files, or in ${TEAM_SIZE_RULE.dirs} or more modules or layers, or a design decision first (a new public API, schema or data model).`]
    : [];
  return [
    head,
    `team preset ${preset.id}: ${team}. budget $${t.budgetUsd}.`,
    'Routing is ON for this request. You are the lead: delegate, and keep your own work small (every call you make re-reads your whole context at the lead model\'s price).',
    ...staffing,
    'Do not edit or write files yourself (unless the user explicitly asks you to); the team below does the changes.',
    'Do not open or read source files to plan: hand the user\'s request, with the files and symbols it names, to the worker as the spec; the worker reads and investigates the code. Use at most one quick search only if you cannot tell which files are involved.',
    '1. Split the request into subtasks A, B, ... (a single subtask A is fine for a small change).',
    '2. Call the Agent tool once per subtask with exactly these parameters:',
    ...agentCalls(preset),
    PROMPT_SHAPE,
    parallel
      ? '   Only when two or more writers run at the same time, also pass isolation "worktree" to each of them (then merge their branches, see the skill). A writer that runs alone gets no isolation and edits the working tree directly.'
      : '   Do not pass isolation: the subagent edits the working tree directly.',
    '3. Agent calls finish in the background: wait for every subtask\'s <task-notification>. The router has already run build, typecheck, lint and tests for each subtask and adds the result to that notification; do not re-run them. Check with git diff --stat that the changes are in the working tree, then answer the user. For verify blocks, step changes and HITL, follow the lead-orchestrator skill.',
    ...raise,
  ].join('\n');
}
