# Phase 0 벤치마크 하네스

라우터 없이 쓰는 기준선(Opus 5.5 · high)과 티어 사다리 각 단계(s1~s6), 단일 모델 비교군(Opus low · medium · max)을 같은 과제로 실행해, **완료 작업당 비용**과 **단계별 실효 비용 계수**를 잽니다. 결정 사항은 기획서 4.5 「Phase 0 측정 설정」과 부록 A 33~41번에 있습니다.

## 구성

| 경로 | 내용 |
|---|---|
| `config/matrix.json` | 측정 조합 9종 (모델 ID 고정, effort) |
| `config/budget.json` | 전체 상한 $150, 1회 실행 단계별 상한 |
| `config/estimates.json` | 계획용 사전 추정치 (시범 실행 후 실측으로 교체) |
| `tasks/custom/` | 직접 만든 과제 13개: `task.json`, 숨김 테스트(`hidden/`), 정답 풀이(`oracle/`) |
| `fixtures/` | 직접 만든 과제가 쓰는 작은 TypeScript 저장소 (의존성 없음, `node --test`) |
| `tasks/public/manifest.json` | SWE-bench Verified 7개 (L2 2 · L3 5)와 선정 규칙 |
| `src/` | 하네스 (Node 24가 TypeScript를 바로 실행, 빌드 없음) |
| `scripts/set-key.ps1`, `get-key.ps1` | API 키를 Windows 자격 증명 보관함에 넣고 꺼내는 스크립트 |

## 사용법

```
node bench/src/cli.ts plan     [--levels L0,L1] [--configs s1,s5] [--tasks id,...] [--reps 1]
node bench/src/cli.ts validate [--tasks id,...] [--public]
node bench/src/cli.ts run      [필터] --execute --api-key-helper "<키체인 조회 명령>"
node bench/src/cli.ts report
node bench/src/cli.ts doctor   [--leak-test]
```

- `plan`과 `--execute` 없는 `run`은 **계획만 출력**합니다(모델 호출 없음).
- `validate`는 모델 없이 과제를 검증합니다. 정답 풀이를 적용하기 전에는 채점이 실패하고, 적용한 뒤에는 통과해야 합니다. 공개 과제는 `--public`을 붙여야 하며, Docker와 `pip install swebench`가 필요하고 큰 이미지를 내려받습니다.
- `run --execute`는 키 창구가 있을 때만 실행합니다. 실행 전마다 남은 예산이 그 실행의 상한보다 적으면 멈추고, 이미 기록된 실행은 건너뛰므로 중단 후 이어서 돌릴 수 있습니다.
- `doctor --leak-test`는 키 없이 격리 실행했을 때 인증에 실패하는지(구독 자격증명에 닿지 못하는지) 확인합니다. 비용은 들지 않습니다.

## 공개 과제 채점 환경

- Docker와 SWE-bench 5.0.2 공식 하네스가 필요합니다. 하네스는 시스템 Python을 건드리지 않도록 별도 가상환경에 설치합니다.
  `py -3.12 -m venv bench/.cache/venv && bench/.cache/venv/Scripts/pip install swebench==5.0.2`
- 데이터셋은 `SWE-bench/SWE-bench_Verified`입니다. 과제 선정에 쓴 princeton-nlp 판과 과제·커밋이 같고, swebench 5.x가 필요로 하는 채점 이미지 정보(`image`)가 추가된 판입니다.
- Windows에서는 하네스가 `patch.diff`와 `eval.sh`를 CRLF로 써서 컨테이너 안에서 적용이 실패합니다. 그래서 `scripts/swebench_lf.py`로 감싸 LF를 고정합니다(채점기가 자동으로 사용).
- 채점 이미지는 과제당 약 4~7.5GB이며, 디스크 여유가 20GB 아래면 채점을 시작하지 않습니다.
- 검증 결과(2026-11-10): 직접 제작 13개와 공개 7개가 모두 통과했습니다. 공개 과제는 무관한 패치(no-op)로는 미해결, 정답 패치로는 해결되었습니다.

## API 키와 구독 정보 보호

- **키 창구는 OS 키체인 하나뿐입니다.** 키를 환경변수나 파일로 받지 않으며, 환경에 `ANTHROPIC_API_KEY`가 있어도 무시합니다.
  1. `powershell -NoProfile -ExecutionPolicy Bypass -File bench\scripts\set-key.ps1` — 키를 가려진 입력으로 받아 자격 증명 보관함에 저장합니다.
  2. `--api-key-helper "powershell -NoProfile -ExecutionPolicy Bypass -File <절대경로>\bench\scripts\get-key.ps1"` — 이 명령은 Claude Code가 자식 프로세스 안에서 실행하므로, 하네스는 키 값을 보지 않습니다. macOS에서는 `security find-generic-password -s agentic-router-bench -w`, Linux에서는 `secret-tool lookup service agentic-router-bench` 같은 명령을 씁니다.
- **실행 격리**
  - Claude Code 실행 옵션: `--bare`(사용자 훅·플러그인·CLAUDE.md·자동 메모리를 읽지 않고, OAuth·키체인도 읽지 않음), `--strict-mcp-config`, `--no-session-persistence`
  - 실행마다 전용 `CLAUDE_CONFIG_DIR`을 씀
  - 환경변수는 허용 목록에 있는 것만 넘김
  - 자격증명 경로 읽기와 환경변수 출력을 거부
  - 웹 도구를 빼고, Bash는 허용 목록의 명령만 실행
- **결과 마스킹:** `results/`에 쓰는 모든 기록은 키·토큰 패턴 마스킹을 거칩니다.
- `results/`와 `.cache/`는 git에 올리지 않습니다.
