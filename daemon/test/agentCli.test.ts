// 명령 속 에이전트 CLI 호출 판별(tasks/agentCli.ts) — 일을 시키는 호출만, 순서·개수 그대로, 명령 본문은 결과에 안 실려요.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentCliCall } from '@mark42/protocol';
import { AGENT_CLI_MAX_CALLS, AGENT_CLI_MAX_INPUT, detectAgentCliCalls } from '../src/tasks/agentCli.ts';

type Case = [command: string, expected: AgentCliCall[]];

// 조사(survey)에서 나온 모양 — 프롬프트는 P로 바꿨어요
const positives: Case[] = [
  ['codex exec --sandbox workspace-write -c model_reasoning_effort=xhigh -m gpt-5.6-sol "P" > out.txt 2>&1 < /dev/null', [{ cli: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh' }]],
  [
    'cd /c/Dev/X && timeout 3600 codex exec -m gpt-5.6-terra -c model_reasoning_effort=max --sandbox workspace-write -C "$W" -o "$O" - < "$PF" > log 2>&1',
    [{ cli: 'codex', model: 'gpt-5.6-terra', effort: 'max' }],
  ],
  ['codex e -m gpt-5.6-sol -c \'model_reasoning_effort="high"\' --sandbox workspace-write - 2>&1 <<\'EOF\'\nP line\nmore\nEOF', [{ cli: 'codex', model: 'gpt-5.6-sol', effort: 'high' }]],
  ['timeout 1800 grok --prompt-file "$S/p.md" -m grok-4.6 --max-turns 40 --always-approve --disable-web-search > "$S/o.txt" 2>&1 < /dev/null', [{ cli: 'grok', model: 'grok-4.6' }]],
  ['grok --prompt-file p.md --cwd "C:/x" -m grok-4.6 --reasoning-effort high', [{ cli: 'grok', model: 'grok-4.6', effort: 'high' }]],
  ['grok -p "P" --effort low', [{ cli: 'grok', effort: 'low' }]],
  ['agy -p "P" --model gemini-4-argon-high --dangerously-skip-permissions --print-timeout 30m < /dev/null > o 2>&1', [{ cli: 'agy', model: 'gemini-4-argon-high' }]],
  ['agy -p "P" --model gemini-3.8-flash-low --output-format json --mode accept-edits --effort high', [{ cli: 'agy', model: 'gemini-3.8-flash-low', effort: 'high' }]],
  ['claude -p --model claude-fable-5 --effort xhigh --allowedTools "Read,Grep" > o.json 2>&1 <<\'EOF\'\nP\nEOF', [{ cli: 'claude', model: 'claude-fable-5', effort: 'xhigh' }]],
  ['claude -p --input-format stream-json --output-format stream-json --verbose --model haiku', [{ cli: 'claude', model: 'haiku' }]],
  ['"/c/Users/u/.local/bin/claude.exe" -p "P"', [{ cli: 'claude' }]],
  ['& "C:\\Users\\u\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe" exec "P"', [{ cli: 'codex' }]],
  ['$env:FOO = "1"; & codex exec -m gpt-6-astra "P"', [{ cli: 'codex', model: 'gpt-6-astra' }]],
  ['npx -y @openai/codex exec "P"', [{ cli: 'codex' }]],
  ['npx @anthropic-ai/claude-code@latest -p "P"', [{ cli: 'claude' }]],
  ['env -u ELECTRON_RUN_AS_NODE CLAUDE_X=1 claude -p "P"', [{ cli: 'claude' }]],
  ['FOO=bar nohup grok -p "P" &', [{ cli: 'grok' }]],
  ['bash -lc \'cd /x && codex exec "P"\'', [{ cli: 'codex' }]],
  ['powershell.exe -NoProfile -Command "& agy -p \'P\' --model gemini-3.6-flash"', [{ cli: 'agy', model: 'gemini-3.6-flash' }]],
  ['cmd /c codex exec "P"', [{ cli: 'codex' }]],
  ['wsl -d Ubuntu -- claude -p "P"', [{ cli: 'claude' }]],
  ['ssh host "claude -p \'P\'"', [{ cli: 'claude' }]],
  ['Start-Process -FilePath grok -ArgumentList "-p","P" -NoNewWindow -Wait', [{ cli: 'grok' }]],
  ['bash <<\'EOF\'\ncodex exec "P"\nEOF', [{ cli: 'codex' }]],
  ['OUT=$(codex exec "P" 2>&1)', [{ cli: 'codex' }]],
  // -m $m 은 허용 모양이 아니라 모델을 빼요
  ['for m in a b; do grok -p "P" -m $m; done', [{ cli: 'grok' }]],
  ['codex', [{ cli: 'codex' }]],
  ['claude --resume abc -p "P"', [{ cli: 'claude' }]],
  ['G="C:/Users/u/.grok/bin/grok.exe"; timeout 600 "$G" -p "P" -m grok-4.6 --reasoning-effort low', [{ cli: 'grok', model: 'grok-4.6', effort: 'low' }]],
];

// 확인 호출 — 일을 시키지 않아요
const metas: string[] = [
  'claude --version',
  'timeout 20 codex exec --help 2>&1 | head -40',
  'grok models 2>&1',
  'agy changelog 2>&1 | head',
  'claude plugin list 2>&1',
  'codex app-server --help',
  'codex features list',
  'claude -v',
  'C="/c/Users/u/.local/bin/claude.exe"; "$C" auth status 2>&1 | head',
  'A="$LOCALAPPDATA/agy/bin/agy.exe"; "$A" --version',
];

// 언급·경로·찾아보기 — 명령어 자리가 아니에요
const negatives: string[] = [
  'git commit -m "claude: fix codex runner"',
  "git commit -F - <<'EOF'\n[Docs] x\n\ncodex exec notes\nCo-Authored-By: Claude\nEOF",
  'cat ~/.claude/settings.json | grep model',
  'ls /c/Users/u/.codex/sessions',
  'grep -rn "codex exec" .agent/',
  'grep -n claude file.ts',
  'tail -f "C:/Users/u/AppData/Local/Temp/claude/x/tasks/a.output"',
  'cd /c/Users/u/.claude/projects && ls',
  'npm run codex-build',
  'node scripts/claude-runs.mjs',
  'where.exe agy grok codex claude',
  'which claude',
  'command -v codex',
  'Get-Command grok',
  'echo "run claude -p later"',
  "cat > run.sh <<'EOF'\ncodex exec \"P\"\nEOF",
  'python -c "import subprocess; subprocess.run([\'claude\',\'-p\',\'x\'])"',
  'Get-Process claude | Select-Object Id',
  'taskkill /IM codex.exe',
  'code --install-extension anthropic.claude-code',
  'mkdir -p /tmp/claude && cp a /tmp/claude/',
  'grep -c agy log.txt',
  'claude-code --version',
  './codex-test.sh',
  'rg grok',
  '$f="C:/x/claude.exe";$b=[IO.File]::ReadAllBytes($f); (Get-Item $f).Length',
  'G="C:/Users/u/.grok/bin/grok.exe"; grep -a -o -E "hook[a-z]+" "$G" | sort | uniq -c',
  '$f="C:\\x\\native-binary\\claude.exe"; $b=[IO.File]::ReadAllBytes($f)',
];

test('agentCli: survey cases (prototype parity)', () => {
  assert.equal(positives.length + metas.length + negatives.length, 67);
});

for (const [cmd, expected] of positives) {
  test(`agentCli: positive ${JSON.stringify(cmd).slice(0, 70)}`, () => {
    assert.deepEqual(detectAgentCliCalls(cmd), expected);
  });
}

for (const cmd of metas) {
  test(`agentCli: meta ${JSON.stringify(cmd).slice(0, 70)}`, () => {
    assert.deepEqual(detectAgentCliCalls(cmd), []);
  });
}

for (const cmd of negatives) {
  test(`agentCli: negative ${JSON.stringify(cmd).slice(0, 70)}`, () => {
    assert.deepEqual(detectAgentCliCalls(cmd), []);
  });
}

const extra: Case[] = [
  // 여러 번·여러 CLI — 순서 그대로
  ['grok -p "a" -m grok-4.6 & grok -p "b" & grok -p "c" -m grok-4.7', [{ cli: 'grok', model: 'grok-4.6' }, { cli: 'grok' }, { cli: 'grok', model: 'grok-4.7' }]],
  ['codex exec "a" -m gpt-5.6-sol && grok -p "b" -m grok-4.6', [{ cli: 'codex', model: 'gpt-5.6-sol' }, { cli: 'grok', model: 'grok-4.6' }]],
  ['grok -p "b"; codex exec "a"', [{ cli: 'grok' }, { cli: 'codex' }]],
  // $(…)는 그 명령보다 먼저 실행돼요
  ['X=$(codex exec "a"); grok -p "b"', [{ cli: 'codex' }, { cli: 'grok' }]],
  ['grok -p "$(codex exec "a")"', [{ cli: 'codex' }, { cli: 'grok' }]],
  // codex -p 는 profile(프롬프트 아님)
  ['codex -p work', []],
  ['codex --profile=work', []],
  ['codex -p work exec "P" -m gpt-5.6-sol', [{ cli: 'codex', model: 'gpt-5.6-sol' }]],
  ['codex -p fast "P"', [{ cli: 'codex' }]],
  ['codex -c model="gpt-6-luna" -c model_reasoning_effort=Ultra exec -', [{ cli: 'codex', model: 'gpt-6-luna', effort: 'ultra' }]],
  // codex -c 는 config(continue 아님)
  ['codex -c foo=1', []],
  // claude 는 -m 이 없어요, codex 는 --effort 가 없어요
  ['claude -p -m opus', [{ cli: 'claude' }]],
  ['codex exec --effort high "P"', [{ cli: 'codex' }]],
  ['claude -p "help"', [{ cli: 'claude' }]],
  // 허용 모양이 아닌 모델·effort는 빼요
  ['codex exec -m \'$MODEL\' "P"', [{ cli: 'codex' }]],
  ['codex exec -m "gpt 5" "P"', [{ cli: 'codex' }]],
  [`codex exec -m ${'a'.repeat(65)} "P"`, [{ cli: 'codex' }]],
  ['grok -p "P" --effort turbo', [{ cli: 'grok' }]],
  ['grok -p "P" --effort HIGH -m "grok-4.6;rm"', [{ cli: 'grok', effort: 'high' }]],
  ['claude -p --model claude-opus-4-6[1m] --effort=max', [{ cli: 'claude', model: 'claude-opus-4-6[1m]', effort: 'max' }]],
  ['agy -p "P" --model=gemini-3.6-flash --effort minimal', [{ cli: 'agy', model: 'gemini-3.6-flash', effort: 'minimal' }]],
  // 감싸기
  ['timeout --signal=KILL -k 5 600 nice -n 10 stdbuf -oL codex exec "P"', [{ cli: 'codex' }]],
  ['sudo -u bot env CODEX_HOME=/x codex exec "P"', [{ cli: 'codex' }]],
  ['pnpm dlx @openai/codex exec "P"', [{ cli: 'codex' }]],
  ['ls *.md | xargs -I{} claude -p "summarize {}"', [{ cli: 'claude' }]],
  ['bash <<< "grok -p P"', [{ cli: 'grok' }]],
  ['pwsh -NoProfile -c "& \'C:\\x\\agy.exe\' -p P"', [{ cli: 'agy' }]],
  ['ssh -p 2222 -i key host claude -p P', [{ cli: 'claude' }]],
  ['$G = "C:/x/grok.exe"; & $G -p "P"', [{ cli: 'grok' }]],
  ['if claude -p "P"; then echo ok; fi', [{ cli: 'claude' }]],
  ['CLAUDE.EXE -p "P"', [{ cli: 'claude' }]],
  ['codex.cmd exec "P"', [{ cli: 'codex' }]],
  // 실행되지 않는 문자열·찾아보기
  ['$G = "C:/x/grok.exe"; $G', []],
  ["echo 'codex exec P' | tee x", []],
  ['bash script.sh -c "codex exec P"', []],
  ['type claude', []],
  ['command -V grok', []],
  ['grok', [{ cli: 'grok' }]],
];

for (const [cmd, expected] of extra) {
  test(`agentCli: extra ${JSON.stringify(cmd).slice(0, 70)}`, () => {
    assert.deepEqual(detectAgentCliCalls(cmd), expected);
  });
}

test('agentCli: call count is capped', () => {
  const cmd = Array.from({ length: 50 }, () => 'grok -p P').join(' & ');
  assert.equal(detectAgentCliCalls(cmd).length, AGENT_CLI_MAX_CALLS);
});

test('agentCli: only the first 64 KB is read', () => {
  const pad = `echo ${'x'.repeat(AGENT_CLI_MAX_INPUT)}`;
  assert.deepEqual(detectAgentCliCalls(`${pad}; codex exec "P"`), []);
  assert.deepEqual(detectAgentCliCalls(`codex exec "P"; ${pad}`), [{ cli: 'codex' }]);
});

test('agentCli: bad input never throws', () => {
  for (const v of [undefined, null, 42, {}, [], '']) {
    assert.deepEqual(detectAgentCliCalls(v as unknown as string), []);
  }
});

test('agentCli: pathological inputs finish fast and do not throw', () => {
  detectAgentCliCalls('codex exec "warm up"');
  const N = 100_000;
  const inputs: [string, string][] = [
    ['parens', '('.repeat(N)],
    ['close parens', ')'.repeat(N)],
    ['word parens', `a${'('.repeat(N)}`],
    ['heredoc ops', '<<'.repeat(N)],
    ['heredoc tags', `${'cat <<A '.repeat(N / 8)}\n`],
    ['heredoc unterminated', `bash <<EOF\n${'codex exec P\n'.repeat(N / 12)}`],
    ['nested $(', `${'$('.repeat(N / 2)}codex exec P${')'.repeat(N / 2)}`],
    ['nested "$(', `${'"$('.repeat(N / 3)}codex`],
    ['nested bash -c', `${"bash -c '".repeat(N / 9)}codex exec P`],
    ['unterminated double quote', `codex exec "${'x\\"'.repeat(N / 3)}`],
    ['unterminated single quote', `codex exec '${'x'.repeat(N)}`],
    ['backticks', '`'.repeat(N)],
    ['here-string', `@'\n${'x'.repeat(N)}`],
    ['redirections', '2>&1 '.repeat(N / 5)],
    ['dashes', `bash -${'c'.repeat(N)}x`],
    ['many commands', 'grok -p P; '.repeat(N / 11)],
    ['assignments', 'A=$(B=$(C=$(D=$(E=$(codex))))) '.repeat(N / 32)],
    ['backslashes', '\\'.repeat(N)],
    ['quote in parens', `$(${"'(".repeat(N / 2)}`],
    ['nested cmd /c', `${'cmd /c '.repeat(N / 7)}codex`],
    ['nested ssh', `${'ssh h "'.repeat(N / 7)}codex`],
    ['ArgumentList', `Start-Process grok -ArgumentList "${'-p,'.repeat(N / 3)}"`],
    ['process substitution', '<('.repeat(N / 2)],
  ];
  for (const [name, input] of inputs) {
    // 다른 일로 바쁜 PC에서도 흔들리지 않게 세 번 중 가장 빠른 값으로 봐요(선형이면 늘 넉넉해요)
    let best = Infinity;
    for (let r = 0; r < 3; r++) {
      const t0 = performance.now();
      let out: AgentCliCall[] = [];
      assert.doesNotThrow(() => {
        out = detectAgentCliCalls(input);
      }, name);
      best = Math.min(best, performance.now() - t0);
      assert.ok(Array.isArray(out), name);
      assert.ok(out.length <= AGENT_CLI_MAX_CALLS, name);
    }
    assert.ok(best < 50, `${name}: ${best.toFixed(1)} ms`);
  }
});

test('agentCli: output never carries command text', () => {
  const secret = 'SECRET-TOKEN-7f3a9c';
  const cmds = [
    `codex exec "${secret}" -m gpt-5.6-sol`,
    `claude -p '${secret}' --model opus --effort high`,
    `grok -p "${secret}"`,
    `bash -c 'codex exec ${secret}'`,
    `ssh host "claude -p ${secret}"`,
    `Start-Process grok -ArgumentList "-p","${secret}"`,
    `codex exec - <<'EOF'\n${secret}\nEOF`,
    `FOO="${secret}" codex exec x`,
    `codex exec -m "${secret} x" --effort "${secret}"`,
    `codex -c model_reasoning_effort="${secret}" exec x`,
  ];
  for (const cmd of cmds) {
    const out = detectAgentCliCalls(cmd);
    assert.ok(out.length > 0, cmd);
    assert.ok(!JSON.stringify(out).includes(secret), cmd);
    for (const c of out) assert.deepEqual(Object.keys(c).filter((k) => !['cli', 'model', 'effort'].includes(k)), []);
  }
});
