// Japanese and Chinese (Simplified and Traditional) in stage-1 triage and in the acceptance phrases (decision 139).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dissatisfactionRule, isReask, promptSimilarity } from '../src/acceptance.ts';
import { languageAgreement, loadPromptSet, scoreSet, type Classifier } from '../src/triage-eval.ts';
import { promptFeatures, triage } from '../src/triage.ts';

const fixture = (name: string) => fs.readFileSync(fileURLToPath(new URL(`./fixtures/triage/${name}`, import.meta.url)), 'utf8');
const stage1: Classifier = p => { const t = triage({ prompt: p.prompt }); return { kind: t.kind, level: t.level, teamScore: t.teamScore }; };
const answer = (prompt: string) => { const t = triage({ prompt }); return [t.kind, t.level, t.rule]; };

test('small requests are settled as direct in each language', () => {
  const cases: Array<[string, string, string]> = [
    // typo / message: L0
    ['README の誤字を直して', 'L0', 'l0-keyword'],
    ['エラーメッセージの文言を変えて', 'L0', 'l0-keyword'],
    ['把 README 里的错别字改掉', 'L0', 'l0-keyword'],
    ['把 README 裡的錯別字改掉', 'L0', 'l0-keyword'],
    ['這個預設值不對，改成 60', 'L0', 'l0-keyword'],
    // bug fix / option: L1
    ['parseDate が 2 月 29 日を拒否するバグを直して', 'L1', 'small-fix'],
    ['sync コマンドに --dry-run オプションを追加して', 'L1', 'small-fix'],
    ['parseDate 拒绝 2 月 29 日，修复这个 bug', 'L1', 'small-fix'],
    ['parseDate 拒絕 2 月 29 日，修復這個錯誤', 'L1', 'small-fix'],
    ['给 sync 命令加一个 --dry-run 选项', 'L1', 'small-fix'],
  ];
  for (const [prompt, level, rule] of cases) assert.deepEqual(answer(prompt), ['direct', level, rule], prompt);
});

test('questions, with and without a question mark', () => {
  for (const prompt of [
    'この正規表現は何にマッチするの？', 'この関数は何を返しますか。', 'なぜここで await が必要なのでしょうか', 'この設定の意味を教えて',
    '这个正则匹配的是什么？', '这个函数会返回 null 吗。', '为什么这里需要 await', '請問這個設定是什麼意思', '這個函式會回傳 null 嗎',
  ]) assert.deepEqual(answer(prompt), ['direct', 'L0', 'question'], prompt);
  // a request to change something is not a question, however it ends
  assert.notEqual(triage({ prompt: 'このバグを直してもらえますか？' }).rule, 'question');
  assert.notEqual(triage({ prompt: '能帮我修复这个问题吗？' }).rule, 'question');
  // a question about a failure is a debugging task
  assert.equal(triage({ prompt: 'なぜこのテストは失敗するのですか？' }).taskType, 'debug');
  assert.equal(triage({ prompt: '为什么这个测试会失败？' }).taskType, 'debug');
});

test('stated breadth and L3 wording send a request to the team', () => {
  const team: Array<[string, string]> = [
    ['すべてのハンドラーに権限チェックを付けて', 'stated-breadth'],
    ['複数のモジュールにまたがるログ出力を統一して', 'stated-breadth'],
    ['コードベース全体で古い API の呼び出しを置き換えて', 'stated-breadth'],
    ['给所有处理器加上权限检查', 'stated-breadth'],
    ['把多个模块里的日志输出统一起来', 'stated-breadth'],
    ['在整个代码库里替换掉旧 API 的调用', 'stated-breadth'],
    ['給所有處理器加上權限檢查', 'stated-breadth'],
    ['在整個程式碼庫裡替換掉舊 API 的呼叫', 'stated-breadth'],
    ['決済を担当する新規サービスをゼロから設計して実装して', 'l3-keyword'],
    ['認証まわりを全面的に再設計したい', 'l3-keyword'],
    ['从零开始设计并实现一个负责支付的新服务', 'l3-keyword'],
    ['把订单流程迁到事件驱动架构上', 'l3-keyword'],
    ['從零開始設計並實作一個負責支付的新服務', 'l3-keyword'],
    ['把訂單流程遷到事件驅動架構上', 'l3-keyword'],
  ];
  for (const [prompt, rule] of team) {
    const t = triage({ prompt });
    assert.deepEqual([t.kind, t.level, t.rule], ['team', 'L2', rule], prompt);
    assert.equal(t.l3Signs, rule === 'l3-keyword', prompt);
  }
});

test('words that only look like a keyword do not settle a request', () => {
  // a comment feature is not a code-comment fix; "each file" in a loop is not a wide change; "from the start" is not "from scratch"
  assert.equal(triage({ prompt: 'タスクにコメント機能を入れて' }).kind, 'uncertain');
  assert.equal(triage({ prompt: '给任务加上评论功能' }).kind, 'uncertain');
  assert.notEqual(triage({ prompt: '把每个文件和远端列表比较，只上传有变化的，并加一个 --dry-run 选项' }).kind, 'team');
  assert.notEqual(triage({ prompt: '把长单词从头开始按每 4 个字符切开，修复这个 bug' }).rule, 'l3-keyword');
  // "all of them" keeps a request from being settled as direct, as in Korean and English
  for (const prompt of ['エラーメッセージを全部メッセージキーに置き換えて', '把错误信息全部换成消息键', '把錯誤訊息全部換成訊息鍵']) {
    assert.equal(triage({ prompt }).kind, 'uncertain', prompt);
  }
});

test('lists, sections and file names as Japanese and Chinese text writes them', () => {
  const ja = promptFeatures('【概要】\n設定の読み込みを直す。\n■ やること\n・src/config/load.tsを読む\n・test/config/load.test.tsにケースを足す\n１．既定値\n２．検証\n（3）エラー表示\n①最後に確認');
  assert.deepEqual([ja.headings, ja.bullets, ja.numberedItems, ja.filePaths], [2, 2, 4, 2]);
  const zh = promptFeatures('【背景】\n修改配置加载。\n1、改src/config/load.ts里的默认值；\n2、在test/config/load.test.ts（已有）里加用例。\n• 不要动 schema.json。');
  assert.deepEqual([zh.headings, zh.bullets, zh.numberedItems, zh.filePaths], [1, 1, 2, 3]);
  // Markdown forms still count once
  const md = promptFeatures('## 目标\n- 第一项\n- 第二项\n1. 步骤一\n2. 步骤二');
  assert.deepEqual([md.headings, md.bullets, md.numberedItems], [1, 2, 2]);
  // many files named in running text reach the many-files rule
  const many = 'src/a.ts、src/b.ts、src/c.ts、src/d.ts、src/e.ts、src/f.tsの import を整理して';
  assert.deepEqual(answer(many), ['team', 'L2', 'many-files']);
});

test('a file name is recognized when a particle attaches directly, in each language', () => {
  const files = (p: string) => promptFeatures(p).filePaths;
  // Korean: a particle attaches straight to the name, so Hangul ends the name like a space (decision 139)
  assert.equal(files('app.ts에서 그 함수를 고쳐'), 1);
  assert.equal(files('README.md를 고쳐 주세요'), 1);
  assert.equal(files('src/utils.ts의 포맷을 정리해'), 1);
  assert.equal(files('config.json으로 설정을 옮겨'), 1);
  // Japanese (kana) and Chinese (Han) were already handled; confirm they still are
  assert.equal(files('app.tsを直して'), 1);
  assert.equal(files('index.tsの型を直す'), 1);
  assert.equal(files('改一下 app.ts 里的默认值'), 1);
  assert.equal(files('把 app.ts 改一下'), 1);
  // the whole name is kept, the particle is not pulled into it
  assert.equal(files('src/app.module.ts를 수정'), 1);
  // negatives: particle-like or punctuation-like text that is not a file name
  assert.equal(files('에러를 고쳐 주세요'), 0);
  assert.equal(files('버전을 2.0으로 올려'), 0);
  assert.equal(files('그 함수의 동작을 설명해'), 0);
  // many files named with Korean particles between them still reach the many-files rule
  assert.deepEqual(answer('src/a.ts와 src/b.ts와 src/c.ts와 src/d.ts와 src/e.ts와 src/f.ts를 정리해 주세요'), ['team', 'L2', 'many-files']);
});

test('script mix: the record keeps hangulRatio and adds kana, Han and Latin shares', () => {
  const f = (p: string) => (x => [x.script, x.hangulRatio, x.kanaRatio, x.hanRatio, x.latinRatio])(promptFeatures(p));
  assert.deepEqual(f('오타를 고쳐 주세요'), ['ko', 1, 0, 0, 0]);
  assert.deepEqual(f('fix the typo'), ['latin', 0, 0, 0, 1]);
  assert.deepEqual(f('错别字改一下'), ['zh', 0, 0, 1, 0]);
  const ja = promptFeatures('誤字を直してください');
  assert.equal(ja.script, 'ja');
  assert.ok(Number(ja.kanaRatio) > 0.5 && Number(ja.hanRatio) > 0.2 && ja.hangulRatio === 0);
  // Japanese is told from Chinese by its kana, even when most letters are Han or Latin
  assert.equal(promptFeatures('設定読込の不具合を修正する。').script, 'ja');
  assert.equal(promptFeatures('parseDate のバグ').script, 'ja');
  assert.equal(promptFeatures('').script, 'latin');
  for (const v of Object.values(promptFeatures('誤字を直して src/a.ts'))) assert.ok(['number', 'string', 'boolean'].includes(typeof v));
});

test('the translated sets: same tasks and labels, no team-sized request answered direct, answers close to the originals', () => {
  const original = loadPromptSet(fixture('prompts.yaml'));
  // Traditional Chinese (Taiwan usage) is a separate set but the same Han script, so its detected script is 'zh'.
  for (const [lang, script] of [['ja', 'ja'], ['zh', 'zh'], ['zh-Hant', 'zh']] as const) {
    const set = loadPromptSet(fixture(`prompts.${lang}.yaml`));
    assert.equal(set.length, 60, lang);
    assert.deepEqual(set.map(p => [p.id, p.split, p.label]), original.map(p => [p.id, p.split, p.label]), lang);
    assert.ok(set.every(p => p.lang === lang && promptFeatures(p.prompt).script === script), `${lang}: every prompt is in that language`);
    const s = scoreSet(set, stage1);
    assert.deepEqual([s.under, s.over, s.decidedAccuracy], [0, 0, 1], `${lang}: no confident wrong answer`);
    const a = languageAgreement(original, set, stage1);
    assert.deepEqual([a.n, a.newFalseDirect, a.falseDirect, a.falseTeam, a.missing], [60, 0, 0, 0, []], lang);
    assert.ok(a.same >= 48, `${lang}: same answer and level on ${a.same} of 60`);
    // the share left for stage 2 stays where it is for Korean and English (58%)
    assert.ok(Math.abs(s.uncertainShare - scoreSet(original, stage1).uncertainShare) <= 0.08, `${lang}: uncertain share ${s.uncertainShare}`);
  }
});

test('the translated bench tasks: 15 each, labelled by level, settled like the originals', () => {
  for (const lang of ['ja', 'zh', 'zh-Hant']) {
    const set = loadPromptSet(fixture(`bench.${lang}.yaml`));
    assert.equal(set.length, 15, lang);
    assert.ok(set.every(p => p.style === 'task' && p.split === 'bench' && p.id === p.task && /^c-l[0-3]-0\d$/.test(p.id)), lang);
    assert.ok(set.every(p => p.label.kind === (p.label.level === 'L2' || p.label.level === 'L3' ? 'team' : 'direct') && p.id.startsWith(`c-${p.label.level.toLowerCase()}-`)), lang);
    const s = scoreSet(set, stage1);
    assert.deepEqual([s.under, s.over, s.answered.direct, s.answered.team, s.answered.uncertain], [0, 0, 5, 5, 5], lang);
  }
});

test('languageAgreement: counts what changed and which changes are the costly ones', () => {
  const p = (id: string, kind: 'direct' | 'team', prompt: string) => ({ id, task: id, lang: 'x', style: 'short', split: 'dev', label: { kind, level: kind === 'team' ? 'L2' as const : 'L1' as const }, prompt });
  const original = [p('a', 'team', 'team'), p('b', 'team', 'uncertain'), p('c', 'direct', 'direct'), p('d', 'direct', 'uncertain'), p('e', 'direct', 'direct')];
  const translated = [p('a', 'team', 'direct'), p('b', 'team', 'uncertain'), p('c', 'direct', 'team'), p('d', 'direct', 'uncertain')];
  const says: Classifier = x => ({ kind: x.prompt as 'direct' | 'team' | 'uncertain', level: x.prompt === 'team' ? 'L2' : 'L1' });
  const a = languageAgreement(original, translated, says);
  assert.deepEqual([a.n, a.same, a.sameKind, a.falseDirect, a.newFalseDirect, a.falseTeam, a.newFalseTeam, a.missing], [4, 2, 2, 1, 1, 1, 1, ['e']]);
  assert.deepEqual(a.changes.map(c => [c.id, c.from, c.to]), [['a', 'team/L2', 'direct/L1'], ['c', 'direct/L1', 'team/L2']]);
});

test('acceptance: dissatisfaction phrases and re-asks in Japanese and Chinese', () => {
  const hits: Array<[string, string]> = [
    ['まだ動かないんだけど', 'ja-still'], ['相変わらずエラーが出ます', 'ja-still'],
    ['動きません。ログを見てください', 'ja-not-working'], ['うまくいかないです', 'ja-not-working'],
    ['違います、そのファイルではありません', 'ja-wrong'], ['そうじゃなくて、別の関数です', 'ja-wrong'],
    ['さっきの変更を元に戻して', 'ja-undo'], ['取り消してください', 'ja-undo'],
    ['还是不行，测试照样失败', 'zh-still'], ['還是報錯', 'zh-still'],
    ['不行，页面打不开', 'zh-not-working'], ['改了之後沒有生效', 'zh-not-working'],
    ['不对，不是这个文件', 'zh-wrong'], ['你搞錯了', 'zh-wrong'],
    ['把刚才的改动撤销掉', 'zh-undo'], ['請還原剛才的修改', 'zh-undo'],
  ];
  for (const [text, id] of hits) assert.equal(dissatisfactionRule(text), id, text);
  for (const text of ['テストを追加してください', 'README を更新して', '请添加一个测试', '給 sync 指令加上 --dry-run', 'キャッシュに TTL オプションを追加して']) {
    assert.equal(dissatisfactionRule(text), undefined, text);
  }
  // the same request again, by wording, without spaces between words
  const ja = 'parseDate が 2024-02-29 を不正な日付として拒否するバグを直して';
  assert.ok(isReask(promptSimilarity(ja, `${ja}。まだ直っていません`)));
  assert.ok(!isReask(promptSimilarity(ja, 'キャッシュに TTL オプションを追加して、設定で秒単位で受け取れるようにして')));
  const zh = 'parseDate 把 2024-02-29 当成无效日期拒绝了，修一下这个 bug';
  assert.ok(isReask(promptSimilarity(zh, `${zh}，还是不行`)));
  assert.ok(!isReask(promptSimilarity(zh, '给缓存加一个 TTL 选项，在配置里按秒指定，默认不过期')));
  // short prompts are compared by character count, which is small for these scripts: a one-line request still qualifies
  assert.notEqual(promptSimilarity('列表 API 的 pageSize 上限限制在 100，超过返回 400', '列表 API 的 pageSize 上限限制在 100，超过返回 400'), undefined);
});
