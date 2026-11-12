// User acceptance (decision 137): similarity, phrases, file signals and the verdict rule, without a ledger.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ABSENT, ACCEPT_WINDOW_PROMPTS, DISSATISFACTION_RULES, REASK_THRESHOLDS, acceptanceVerdict, countsAsAccepted, dissatisfactionRule, fileSignals,
  foldPrompt, isReask, promptSimilarity, type AcceptSignal, type FileEnd,
} from '../src/acceptance.ts';

const ASK = 'Fix the bug where parse() fails on empty input in src/parse.ts';

test('the same request again is seen by its wording', () => {
  assert.deepEqual(promptSimilarity(ASK, ASK), { jaccard: 1, containment: 1 });
  assert.ok(isReask(promptSimilarity(ASK, `  ${ASK.toUpperCase()}  `)), 'case and spacing do not matter');
  // the old text pasted into a complaint
  const quoted = promptSimilarity(ASK, `It still throws. I asked: ${ASK} Please look at the empty string case again and run the tests this time.`)!;
  assert.ok(quoted.containment >= REASK_THRESHOLDS.containment && quoted.jaccard < REASK_THRESHOLDS.jaccard, JSON.stringify(quoted));
  assert.ok(isReask(quoted));
  // a small edit of the same sentence
  assert.ok(isReask(promptSimilarity(ASK, 'Fix the bug where parse() still fails on empty input in src/parse.ts')));
  // Korean
  const ko = '빈 입력에서 parse()가 실패하는 버그를 src/parse.ts에서 고쳐 주세요';
  assert.ok(isReask(promptSimilarity(ko, `${ko} 다시`)));
});

test('a follow-up, another task and a paraphrase are not a re-ask', () => {
  assert.ok(!isReask(promptSimilarity(ASK, 'Now add unit tests for the parser and update the README section about it')));
  assert.ok(!isReask(promptSimilarity(ASK, 'Rename the config loader to loadSettings across the cli package')));
  // a paraphrase is not caught: wording only (the limit decision 137 accepts)
  assert.ok(!isReask(promptSimilarity(ASK, 'The parser crashes when it gets an empty string, please repair that')));
  assert.ok(!isReask(promptSimilarity('빈 입력에서 parse()가 실패하는 버그를 고쳐 주세요', '이제 그 함수에 테스트를 추가하고 문서도 갱신해 주세요')));
});

test('short prompts are not compared; only numbers come out', () => {
  assert.equal(promptSimilarity('yes', 'yes'), undefined);
  assert.equal(promptSimilarity(ASK, 'go on'), undefined);
  assert.equal(isReask(undefined), false);
  const s = promptSimilarity(ASK, `${ASK} and also the tab case`)!;
  assert.deepEqual(Object.keys(s).sort(), ['containment', 'jaccard']);
  assert.ok(Number.isFinite(s.jaccard) && s.jaccard > 0 && s.jaccard <= 1);
  assert.equal(foldPrompt('  A\n\tB  ').length, 3);
  assert.equal(foldPrompt('x'.repeat(5000)).length, 4000);
  assert.equal(foldPrompt('ＡＢＣ'), 'abc');   // full-width letters fold (NFKC)
});

test('dissatisfaction phrases, English and Korean, by rule id', () => {
  const hits: Array<[string, string]> = [
    ['It is still broken after your change', 'en-still-broken'],
    ['that doesn\'t work, the test fails', 'en-does-not-work'],
    ['No, that\'s wrong.', 'en-wrong'],
    ['undo that and try another way', 'en-undo'],
    ['Please revert your changes', 'en-undo'],
    ['아직도 안 돼요', 'ko-still'],
    ['실행해 봤는데 동작하지 않아요', 'ko-not-working'],
    ['그게 아니라 다른 파일이에요', 'ko-wrong'],
    ['방금 한 거 되돌려 주세요', 'ko-undo'],
  ];
  for (const [text, id] of hits) assert.equal(dissatisfactionRule(text), id, text);
  for (const text of ['Add a retry to the client', 'Write a test that fails when the cache is empty', '테스트를 추가해 주세요', 'revert-safe migrations: add a guide', '']) {
    assert.equal(dissatisfactionRule(text), undefined, text);
  }
  // only the start of a prompt is read (a pasted log further down is not the user's judgement)
  assert.equal(dissatisfactionRule(`${'x'.repeat(700)} this is still broken`), undefined);
  assert.equal(new Set(DISSATISFACTION_RULES.map(r => r.id)).size, DISSATISFACTION_RULES.length);
});

test('file signals: reverted, mostly deleted, untouched', () => {
  const end: FileEnd[] = [
    { path: 'src/a.ts', start: 'a0', end: 'a1', added: 40 },
    { path: 'src/b.ts', start: 'b0', end: 'b1', added: 10 },
    { path: 'src/new.ts', start: ABSENT, end: 'n1', added: 50 },
  ];
  const now = (o: Record<string, [string, number]>) => Object.fromEntries(Object.entries(o).map(([k, [fp, added]]) => [k, { fp, added }]));
  assert.deepEqual(fileSignals(end, now({ 'src/a.ts': ['a1', 40], 'src/b.ts': ['b1', 10], 'src/new.ts': ['n1', 50] })),
    { checked: 3, revertedFiles: 0, reverted: false, mostlyDeleted: false, untouched: true });
  // two of three back at their start state (one of them a created file that is gone)
  const rev = fileSignals(end, now({ 'src/a.ts': ['a0', 0], 'src/b.ts': ['b1', 10], 'src/new.ts': [ABSENT, 0] }));
  assert.deepEqual([rev.reverted, rev.revertedFiles, rev.mostlyDeleted], [true, 2, false]);
  // one of three is not enough
  assert.equal(fileSignals(end, now({ 'src/a.ts': ['a0', 0], 'src/b.ts': ['b1', 10], 'src/new.ts': ['n1', 50] })).reverted, false);
  // rewritten, most added lines gone, but not the start state: the weak signal
  const del = fileSignals(end, now({ 'src/a.ts': ['a2', 5], 'src/b.ts': ['b2', 3], 'src/new.ts': ['n2', 8] }));
  assert.deepEqual([del.reverted, del.mostlyDeleted, del.untouched], [false, true, false]);
  // a following request that builds on the files (more lines) is neither
  const more = fileSignals(end, now({ 'src/a.ts': ['a3', 90], 'src/b.ts': ['b1', 10], 'src/new.ts': ['n3', 120] }));
  assert.deepEqual([more.reverted, more.mostlyDeleted], [false, false]);
  // a single changed file back at its start state is a revert; files that could not be read are left out
  assert.equal(fileSignals(end.slice(0, 1), now({ 'src/a.ts': ['a0', 0] })).reverted, true);
  assert.deepEqual(fileSignals(end, {}), { checked: 0, revertedFiles: 0, reverted: false, mostlyDeleted: false, untouched: false });
});

test('verdict rule v1', () => {
  const sig = (kind: AcceptSignal['kind'], turn = 1): AcceptSignal => ({ kind, turn, at: '2026-11-12T00:00:00.000Z' });
  const v = (signals: AcceptSignal[], promptsSeen = 0, sessionEnded = false, applicable = true) => acceptanceVerdict({ applicable, signals, promptsSeen, sessionEnded });
  assert.equal(ACCEPT_WINDOW_PROMPTS, 2);
  assert.equal(v([], 0, false, false), 'n/a');
  assert.equal(v([sig('reverted')], 2, true, false), 'n/a', 'a request without changes has nothing to accept');
  // strong signals
  assert.equal(v([sig('reverted')]), 'not_accepted');
  assert.equal(v([sig('reask')]), 'not_accepted');
  // weak signals count only together
  assert.equal(v([sig('dissatisfied')], 1), undefined);
  assert.equal(v([sig('mostly_deleted')], 1), undefined);
  assert.equal(v([sig('dissatisfied'), sig('mostly_deleted', 2)], 1), 'not_accepted');
  assert.equal(v([sig('dissatisfied')], 2), 'accepted');
  // a commit accepts at once; a negative still wins over it
  assert.equal(v([sig('committed')]), 'accepted');
  assert.equal(v([sig('committed'), sig('reverted', 2)]), 'not_accepted');
  // the window: open, passed, or cut short by the end of the session
  assert.equal(v([], 1), undefined);
  assert.equal(v([], 2), 'accepted');
  assert.equal(v([], 1, true), 'unobserved');
  assert.equal(v([sig('unavailable')], 0, true), 'unobserved');
  // the KPI counts what was not seen to be rejected
  assert.deepEqual(['accepted', 'unobserved', 'not_accepted', 'n/a', null, undefined].map(a => countsAsAccepted(a as never)), [true, true, false, false, false, false]);
});
