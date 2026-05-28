import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AdapterContinuation, type AgentAdapter, type AgentStepPrepareInput } from '../src/adapters/types.js';
import { runHarness } from '../src/runner/evaluate.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test('one-step test case runs through the step lifecycle with one-shot-compatible results and artifacts', async () => {
  const root = await tempRoot();
  const restoreDocker = await installFakeDocker(root);
  const prepareCalls: PrepareCall[] = [];

  try {
    await writeHarnessProject(root, `
id: one-shot-compatible
prompt: Say OK and write a file.
config:
  script: |
    const { writeFileSync } = require('node:fs');
    writeFileSync('one-step.txt', 'done');
    console.log('OK from one step');
assert:
  - type: contains
    value: OK
  - type: workspaceDiff
    changedFiles: [one-step.txt]
`);

    const result = await runHarness({ cwd: root, adapters: [createLifecycleAdapter(prepareCalls)] });
    const run = result.results[0];
    const step = run.steps[0];

    expect(result.pass).toBe(true);
    expect(run.status).toBe('passed');
    expect(run.pass).toBe(true);
    expect(run.output).toBe('OK from one step');
    expect(run.exitCode).toBe(0);
    expect(run.steps).toHaveLength(1);
    expect(step).toMatchObject({
      id: 'run',
      originalStepId: 'run',
      stepIndex: 0,
      status: 'passed',
      pass: true,
      exitCode: 0,
      output: 'OK from one step',
    });
    expect(step.stdout).toContain('OK from one step');
    expect(step.workspace.added).toEqual(['one-step.txt']);
    expect(run.workspace.added).toEqual(['one-step.txt']);
    expect(step.assertions.every((assertion) => assertion.pass)).toBe(true);
    expect(prepareCalls.map((call) => [call.stepId, call.stepIndex, call.workspaceDir])).toEqual([
      ['run', 0, join(run.runDir, 'workspace')],
    ]);
    expect(prepareCalls[0].continuation).toBeUndefined();
    expect(await readFile(join(run.runDir, 'workspace', 'one-step.txt'), 'utf8')).toBe('done');
    expect(await readFile(join(run.runDir, 'steps', 'run', 'stdout.log'), 'utf8')).toBe('OK from one step\n');
    expect(JSON.parse(await readFile(join(run.runDir, 'steps', 'run', 'events-summary.json'), 'utf8')).finalOutput).toBe('OK from one step');
    expect(JSON.parse(await readFile(join(run.runDir, 'steps', 'run', 'assertions.json'), 'utf8')).every((assertion: { pass: boolean }) => assertion.pass)).toBe(true);
    expect(JSON.parse(await readFile(join(run.runDir, 'steps', 'run', 'step-completed.json'), 'utf8'))).toMatchObject({
      stepId: 'run',
      status: 'passed',
      pass: true,
      exitCode: 0,
    });
    expect(JSON.parse(await readFile(join(run.runDir, 'result.json'), 'utf8'))).toMatchObject({
      caseId: 'one-shot-compatible',
      status: 'passed',
      pass: true,
      output: 'OK from one step',
    });
  } finally {
    restoreDocker();
  }
});

test('post-agent verifier parses rewards and controls run status', async () => {
  const root = await tempRoot();
  const restoreDocker = await installFakeDocker(root);

  try {
    await writeHarnessProject(root, `
id: verifier-reward
prompt: Say OK and write a file.
config:
  script: |
    const { writeFileSync } = require('node:fs');
    writeFileSync('one-step.txt', 'done');
    console.log('OK from one step');
verifier:
  command: node
  args:
    - -e
    - |
      const { readFileSync, writeFileSync } = require('node:fs');
      const ok = readFileSync('one-step.txt', 'utf8') === 'done';
      writeFileSync('reward.txt', ok ? '1' : '0');
      console.log('verifier network=' + process.env.HARNESS_FAKE_DOCKER_NETWORK);
  rewardFile: reward.txt
  rewardFormat: text
  network:
    mode: none
assert:
  - type: contains
    value: OK
`);

    const result = await runHarness({ cwd: root, adapters: [createLifecycleAdapter([])] });
    const run = result.results[0];

    expect(run.status).toBe('passed');
    expect(run.pass).toBe(true);
    expect(run.verifier?.status).toBe('passed');
    expect(run.verifier?.reward).toMatchObject({ values: { reward: 1 }, primary: 1, binary: true });
    expect(run.score.buckets.find((bucket) => bucket.type === 'verifierReward')?.score).toBe(1);
    expect(JSON.parse(await readFile(join(run.runDir, 'verifier', 'reward.json'), 'utf8')).values.reward).toBe(1);
    expect(JSON.parse(await readFile(join(run.runDir, 'verifier', 'command.redacted.json'), 'utf8')).network.mode).toBe('none');
    expect(await readFile(join(run.runDir, 'verifier', 'stdout.log'), 'utf8')).toContain('verifier network=none');
  } finally {
    restoreDocker();
  }
});

test('attempts expand runs and produce pass@k for binary verifier rewards', async () => {
  const root = await tempRoot();
  const restoreDocker = await installFakeDocker(root);

  try {
    await writeHarnessProject(root, `
id: verifier-attempts
attempts: 3
prompt: Say OK.
config:
  script: |
    console.log('OK');
verifier:
  command: node
  args:
    - -e
    - |
      require('node:fs').writeFileSync('reward.txt', '1');
  rewardFile: reward.txt
assert:
  - type: contains
    value: OK
`);

    const result = await runHarness({ cwd: root, adapters: [createLifecycleAdapter([])] });

    expect(result.results).toHaveLength(3);
    expect(result.results.map((run) => run.attemptNumber)).toEqual([1, 2, 3]);
    expect(result.passAtK).toEqual([expect.objectContaining({
      caseId: 'verifier-attempts',
      agentName: 'lifecycle',
      attempts: 3,
      successes: 3,
      eligible: true,
      values: { 'pass@1': 1, 'pass@2': 1, 'pass@3': 1 },
    })]);
    expect(JSON.parse(await readFile(join(root, '.harness-evals', 'output', 'latest', 'results.json'), 'utf8')).summary.passAtK[0].values['pass@3']).toBe(1);
  } finally {
    restoreDocker();
  }
});

test('hidden patch is applied after model.patch is captured for verifier runs', async () => {
  const root = await tempRoot();
  const restoreDocker = await installFakeDocker(root);

  try {
    await writeHarnessProject(root, `
id: hidden-patch-verifier
workspace:
  fixture: fixture
prompt: Produce an answer file.
config:
  script: |
    const { writeFileSync } = require('node:fs');
    writeFileSync('answer.txt', 'agent answer');
    console.log('OK');
verifier:
  command: node
  args:
    - -e
    - |
      const { readFileSync, writeFileSync } = require('node:fs');
      const ok = readFileSync('hidden.txt', 'utf8').trim() === 'secret';
      writeFileSync('reward.json', JSON.stringify({ reward: ok ? 1 : 0 }));
  rewardFile: reward.json
  hiddenPatch: patches/hidden.patch
  captureModelPatch: true
assert:
  - type: contains
    value: OK
`);
    await mkdir(join(root, 'patches'), { recursive: true });
    await writeFile(join(root, 'fixture', 'hidden.txt'), 'old\n');
    await writeFile(join(root, 'patches', 'hidden.patch'), `diff --git a/hidden.txt b/hidden.txt
--- a/hidden.txt
+++ b/hidden.txt
@@ -1 +1 @@
-old
+secret
`);

    const result = await runHarness({ cwd: root, adapters: [createLifecycleAdapter([])] });
    const run = result.results[0];

    expect(run.status).toBe('passed');
    expect(run.workspace.added).toEqual(['answer.txt']);
    expect(run.hiddenPatch?.applied).toBe(true);
    expect(run.modelPatch?.empty).toBe(false);
    expect(run.verifier?.reward?.values).toEqual({ reward: 1 });
    const modelPatch = await readFile(join(run.runDir, 'model.patch'), 'utf8');
    expect(modelPatch).toContain('answer.txt');
    expect(modelPatch).not.toContain('secret');
    expect(JSON.parse(await readFile(join(run.runDir, 'hidden-patch.json'), 'utf8')).applied).toBe(true);
  } finally {
    restoreDocker();
  }
});

test('runner executes steps linearly with a shared workspace and adapter continuation', async () => {
  const root = await tempRoot();
  const restoreDocker = await installFakeDocker(root);
  const prepareCalls: PrepareCall[] = [];

  try {
    await writeHarnessProject(root, `
id: shared-workspace
workspace:
  fixture: fixture
steps:
  - id: create-file
    prompt: create
    config:
      script: |
        const { writeFileSync } = require('node:fs');
        writeFileSync('shared.txt', 'created');
        console.log('created file');
    assert:
      - type: contains
        value: created file
      - type: workspaceDiff
        changedFiles: [shared.txt]
  - id: read-file
    prompt: read
    config:
      script: |
        const { appendFileSync, readFileSync } = require('node:fs');
        console.log(readFileSync('shared.txt', 'utf8'));
        appendFileSync('shared.txt', '-updated');
    assert:
      - type: contains
        value: created
      - type: workspaceDiff
        changedFiles: [shared.txt]
`);

    const result = await runHarness({ cwd: root, adapters: [createLifecycleAdapter(prepareCalls)] });
    const run = result.results[0];

    expect(result.pass).toBe(true);
    expect(run.status).toBe('passed');
    expect(run.steps.map((step) => step.status)).toEqual(['passed', 'passed']);
    expect(run.steps[0].stdout).toContain('created file');
    expect(run.steps[1].stdout).toContain('created');
    expect(run.steps[0].workspace.added).toEqual(['shared.txt']);
    expect(run.workspace.added).toEqual(['shared.txt']);
    expect(await readFile(join(run.runDir, 'workspace', 'shared.txt'), 'utf8')).toBe('created-updated');
    expect(prepareCalls.map((call) => [call.stepId, call.stepIndex, call.workspaceDir])).toEqual([
      ['create-file', 0, join(run.runDir, 'workspace')],
      ['read-file', 1, join(run.runDir, 'workspace')],
    ]);
    expect(prepareCalls[0].continuation).toBeUndefined();
    expect(prepareCalls[1].continuation).toEqual({ id: 'create-file', metadata: { stepIndex: 0 } });

    const persisted = JSON.parse(await readFile(join(run.runDir, 'result.json'), 'utf8'));
    expect(persisted.steps.map((step: { status: string }) => step.status)).toEqual(['passed', 'passed']);
    expect(JSON.parse(await readFile(join(run.runDir, 'steps', 'read-file', 'step-completed.json'), 'utf8')).status).toBe('passed');
  } finally {
    restoreDocker();
  }
});

test('runner applies step-scoped args env and config only to the current step', async () => {
  const root = await tempRoot();
  const restoreDocker = await installFakeDocker(root);
  const previousAgentEnv = process.env.AGENT_ENV;
  const previousStep1Env = process.env.STEP1_ENV;
  const previousStep2Env = process.env.STEP2_ENV;
  const prepareCalls: ScopedPrepareCall[] = [];
  process.env.AGENT_ENV = 'agent-value';
  process.env.STEP1_ENV = 'step-1-value';
  process.env.STEP2_ENV = 'step-2-value';

  try {
    await mkdir(join(root, 'cases'), { recursive: true });
    await writeFile(join(root, 'harness-evals.yaml'), `
version: 1
docker:
  image: fake-image
  timeoutMs: 1000
agents:
  scoped:
    adapter: scoped
    args: [agent-arg]
    env: [AGENT_ENV]
    config:
      source: agent
      shared: agent
tests:
  - cases/*.yaml
`);
    await writeFile(join(root, 'cases', 'case.yaml'), `
id: step-scoped-overrides
steps:
  - id: first
    prompt: first
    args: [first-arg]
    env: [STEP1_ENV]
    config:
      shared: first
      firstOnly: true
    assert: []
  - id: second
    prompt: second
    args: [second-arg]
    env: [STEP2_ENV]
    config:
      shared: second
      secondOnly: true
    assert: []
`);

    const result = await runHarness({ cwd: root, adapters: [createScopedAdapter(prepareCalls)] });
    const run = result.results[0];
    const outputs = run.steps.map((step) => JSON.parse(step.stdout.trim()) as ScopedStepOutput);

    expect(result.pass).toBe(true);
    expect(prepareCalls).toEqual([
      {
        stepId: 'first',
        args: ['agent-arg', 'first-arg'],
        env: ['AGENT_ENV', 'STEP1_ENV'],
        agentConfig: { source: 'agent', shared: 'first', firstOnly: true },
        stepConfig: { shared: 'first', firstOnly: true },
      },
      {
        stepId: 'second',
        args: ['agent-arg', 'second-arg'],
        env: ['AGENT_ENV', 'STEP2_ENV'],
        agentConfig: { source: 'agent', shared: 'second', secondOnly: true },
        stepConfig: { shared: 'second', secondOnly: true },
      },
    ]);
    expect(outputs[0]).toEqual({
      argv: ['agent-arg', 'first-arg'],
      env: { agent: 'agent-value', first: 'step-1-value', second: null },
      config: { source: 'agent', shared: 'first', firstOnly: true },
    });
    expect(outputs[1]).toEqual({
      argv: ['agent-arg', 'second-arg'],
      env: { agent: 'agent-value', first: null, second: 'step-2-value' },
      config: { source: 'agent', shared: 'second', secondOnly: true },
    });
    expect(run.steps[0].command?.env.STEP1_ENV).toBe('step-1-value');
    expect(run.steps[0].command?.env.STEP2_ENV).toBeUndefined();
    expect(run.steps[1].command?.env.STEP1_ENV).toBeUndefined();
    expect(run.steps[1].command?.env.STEP2_ENV).toBe('step-2-value');
  } finally {
    if (previousAgentEnv === undefined) delete process.env.AGENT_ENV;
    else process.env.AGENT_ENV = previousAgentEnv;
    if (previousStep1Env === undefined) delete process.env.STEP1_ENV;
    else process.env.STEP1_ENV = previousStep1Env;
    if (previousStep2Env === undefined) delete process.env.STEP2_ENV;
    else process.env.STEP2_ENV = previousStep2Env;
    restoreDocker();
  }
});

test('built-in command adapter uses step args and env without leakage', async () => {
  const root = await tempRoot();
  const restoreDocker = await installFakeDocker(root);
  const previousBaseEnv = process.env.BASE_ENV;
  const previousOneEnv = process.env.ONE_ENV;
  const previousTwoEnv = process.env.TWO_ENV;
  process.env.BASE_ENV = 'base-value';
  process.env.ONE_ENV = 'one-value';
  process.env.TWO_ENV = 'two-value';

  try {
    await mkdir(join(root, 'cases'), { recursive: true });
    await writeFile(join(root, 'harness-evals.yaml'), `
version: 1
docker:
  image: fake-image
  timeoutMs: 1000
agents:
  command:
    adapter: command
    command: node
    args:
      - -e
      - |
        console.log(JSON.stringify({
          argv: process.argv.slice(1),
          env: {
            base: process.env.BASE_ENV ?? null,
            one: process.env.ONE_ENV ?? null,
            two: process.env.TWO_ENV ?? null,
          },
        }));
      - base-arg
    env: [BASE_ENV]
tests:
  - cases/*.yaml
`);
    await writeFile(join(root, 'cases', 'case.yaml'), `
id: built-in-step-scoped
steps:
  - id: one
    prompt: first prompt
    args: [one-arg]
    env: [ONE_ENV]
    assert: []
  - id: two
    prompt: second prompt
    args: [two-arg]
    env: [TWO_ENV]
    assert: []
`);

    const result = await runHarness({ cwd: root });
    const run = result.results[0];
    const outputs = run.steps.map((step) => JSON.parse(step.stdout.trim()) as Omit<ScopedStepOutput, 'config'>);

    expect(result.pass).toBe(true);
    expect(outputs[0]).toEqual({
      argv: ['base-arg', 'one-arg', 'first prompt'],
      env: { base: 'base-value', one: 'one-value', two: null },
    });
    expect(outputs[1]).toEqual({
      argv: ['base-arg', 'two-arg', 'second prompt'],
      env: { base: 'base-value', one: null, two: 'two-value' },
    });
    expect(run.steps[0].command?.env.ONE_ENV).toBe('one-value');
    expect(run.steps[0].command?.env.TWO_ENV).toBeUndefined();
    expect(run.steps[1].command?.env.ONE_ENV).toBeUndefined();
    expect(run.steps[1].command?.env.TWO_ENV).toBe('two-value');
  } finally {
    if (previousBaseEnv === undefined) delete process.env.BASE_ENV;
    else process.env.BASE_ENV = previousBaseEnv;
    if (previousOneEnv === undefined) delete process.env.ONE_ENV;
    else process.env.ONE_ENV = previousOneEnv;
    if (previousTwoEnv === undefined) delete process.env.TWO_ENV;
    else process.env.TWO_ENV = previousTwoEnv;
    restoreDocker();
  }
});

test('required assertion failure skips later steps without preparing or executing them', async () => {
  const root = await tempRoot();
  const restoreDocker = await installFakeDocker(root);
  const prepareCalls: PrepareCall[] = [];

  try {
    await writeHarnessProject(root, `
id: gated-failure
workspace:
  fixture: fixture
steps:
  - id: fail-required
    prompt: fail
    config:
      script: |
        console.log('actual output');
    assert:
      - type: contains
        value: expected output
  - id: should-skip
    prompt: skip
    config:
      script: |
        const { writeFileSync } = require('node:fs');
        writeFileSync('should-not-run.txt', 'ran');
        console.log('ran');
    assert: []
`);

    const result = await runHarness({ cwd: root, adapters: [createLifecycleAdapter(prepareCalls)] });
    const run = result.results[0];

    expect(result.pass).toBe(false);
    expect(run.status).toBe('failed');
    expect(run.steps.map((step) => step.status)).toEqual(['failed', 'skipped']);
    expect(prepareCalls.map((call) => call.stepId)).toEqual(['fail-required']);
    await expect(readFile(join(run.runDir, 'workspace', 'should-not-run.txt'), 'utf8')).rejects.toThrow();
    expect(await readFile(join(run.runDir, 'steps', 'should-skip', 'stdout.log'), 'utf8')).toBe('\n');
    expect(JSON.parse(await readFile(join(run.runDir, 'steps', 'should-skip', 'step-completed.json'), 'utf8')).status).toBe('skipped');
  } finally {
    restoreDocker();
  }
});

test('step timeout is represented on the step and test-case result and gates later steps', async () => {
  const root = await tempRoot();
  const restoreDocker = await installFakeDocker(root);
  const prepareCalls: PrepareCall[] = [];

  try {
    await writeHarnessProject(root, `
id: timeout-case
workspace:
  fixture: fixture
steps:
  - id: slow
    prompt: slow
    timeoutMs: 25
    config:
      mode: sleep
    assert: []
  - id: after-timeout
    prompt: after
    config:
      script: |
        console.log('after');
    assert: []
`);

    const result = await runHarness({ cwd: root, adapters: [createLifecycleAdapter(prepareCalls)] });
    const run = result.results[0];

    expect(result.pass).toBe(false);
    expect(run.status).toBe('timeout');
    expect(run.steps.map((step) => step.status)).toEqual(['timeout', 'skipped']);
    expect(run.steps[0].error).toContain('Timed out after 25ms');
    expect(run.error).toContain('Timed out after 25ms');
    expect(prepareCalls.map((call) => call.stepId)).toEqual(['slow']);
    expect(JSON.parse(await readFile(join(run.runDir, 'steps', 'slow', 'step-completed.json'), 'utf8')).status).toBe('timeout');
  } finally {
    restoreDocker();
  }
});

test('llmJudge can fall back to the first configured adapter with complete()', async () => {
  const root = await tempRoot();
  const restoreDocker = await installFakeDocker(root);
  const prepareCalls: PrepareCall[] = [];
  const completionPrompts: string[] = [];
  const judgeAdapter: AgentAdapter = {
    name: 'judge-complete',
    async complete(input) {
      completionPrompts.push(input.input);
      return '{"score":0.85,"pass":true,"reason":"Looks good"}';
    },
    async prepareStep() {
      return { argv: ['node', '-e', 'console.log("unused")'], cwd: '/workspace', envNames: [], configMounts: [], parser: 'text' };
    },
    async parseEvents(input) {
      return { finalOutput: input.stdout.trim(), toolCalls: [], errors: [] };
    },
  };

  try {
    await mkdir(join(root, 'cases'), { recursive: true });
    await mkdir(join(root, 'fixture'), { recursive: true });
    await writeFile(join(root, 'fixture', 'README.md'), 'fixture');
    await writeFile(join(root, 'harness-evals.yaml'), `
version: 1
docker:
  image: fake-image
  timeoutMs: 1000
agents:
  judge:
    adapter: judge-complete
  lifecycle:
    adapter: lifecycle
tests:
  - cases/*.yaml
`);
    await writeFile(join(root, 'cases', 'case.yaml'), `
id: adapter-judged
agents:
  include: [lifecycle]
prompt: produce output
config:
  script: |
    console.log('OK from subject');
assert:
  - id: quality
    type: llmJudge
    threshold: 0.8
    judge:
      rubric: Score quality from 0 to 1.
      inputs: [finalOutput]
`);

    const result = await runHarness({ cwd: root, adapters: [judgeAdapter, createLifecycleAdapter(prepareCalls)] });
    const run = result.results[0];
    const step = run.steps[0];

    expect(result.pass).toBe(true);
    expect(completionPrompts).toHaveLength(1);
    expect(completionPrompts[0]).toContain('Score quality from 0 to 1.');
    expect(completionPrompts[0]).toContain('OK from subject');
    expect(step.assertions.find((assertion) => assertion.id === 'quality')).toMatchObject({ pass: true, score: 0.85, threshold: 0.8 });
    const judgeRecord = JSON.parse(await readFile(join(run.runDir, 'steps', 'run', 'judges', 'quality.json'), 'utf8'));
    expect(judgeRecord).toMatchObject({ assertionId: 'quality', score: 0.85, pass: true, metadata: { judge: { source: 'agent-adapter', agentName: 'judge', adapter: 'judge-complete' } } });
  } finally {
    restoreDocker();
  }
});

test('llmJudge assertions emit judge and score records without changing pass gates', async () => {
  const root = await tempRoot();
  const restoreDocker = await installFakeDocker(root);
  const prepareCalls: PrepareCall[] = [];
  const previousJudgeKey = process.env.TEST_JUDGE_KEY;
  process.env.TEST_JUDGE_KEY = 'secret-value';
  const judgeRequests: Array<{ prompt: string; inputs: Record<string, unknown> }> = [];

  try {
    await writeHarnessProject(root, `
id: judged-scoring
prompt: produce output
config:
  script: |
    console.log('OK secret-value');
assert:
  - id: ok-output
    type: contains
    value: OK
  - id: optional-miss
    type: contains
    value: missing
    required: false
  - id: quality
    type: llmJudge
    threshold: 0.8
    judge:
      provider: test
      model: judge-model
      apiKeyEnv: TEST_JUDGE_KEY
      rubric: Score quality from 0 to 1.
      inputs: [finalOutput, toolCalls, mockCalls, workspaceDiff]
`);

    const result = await runHarness({
      cwd: root,
      adapters: [createLifecycleAdapter(prepareCalls)],
      judgeRunner: async (request) => {
        judgeRequests.push({ prompt: request.prompt, inputs: request.inputs as Record<string, unknown> });
        return {
          score: 0.9,
          reason: 'Strong output',
          metadata: { usage: { provider: 'test', model: 'judge-model', totalTokens: 10, totalCost: 0.01 } },
        };
      },
    });
    const run = result.results[0];
    const step = run.steps[0];

    expect(result.pass).toBe(true);
    expect(step.assertions.find((assertion) => assertion.id === 'optional-miss')).toMatchObject({ pass: false, required: false, score: 0 });
    expect(step.assertions.find((assertion) => assertion.id === 'quality')).toMatchObject({ pass: true, score: 0.9, threshold: 0.8 });
    expect(judgeRequests[0].prompt).toContain('<redacted:TEST_JUDGE_KEY>');
    expect(judgeRequests[0].prompt).not.toContain('secret-value');
    expect(step.score.score).toBe(0.7);
    expect(run.score.score).toBe(0.7);

    const judgeRecord = JSON.parse(await readFile(join(run.runDir, 'steps', 'run', 'judges', 'quality.json'), 'utf8'));
    expect(judgeRecord).toMatchObject({ assertionId: 'quality', score: 0.9, pass: true });
    expect(JSON.stringify(judgeRecord)).not.toContain('secret-value');
    const stepScore = JSON.parse(await readFile(join(run.runDir, 'steps', 'run', 'score.json'), 'utf8'));
    expect(stepScore.buckets.map((bucket: { type: string }) => bucket.type)).toEqual(expect.arrayContaining(['assertionPassRate', 'judgeScore', 'latency', 'cost', 'tokenUsage']));
    expect(stepScore.buckets.find((bucket: { type: string }) => bucket.type === 'cost')?.metadata.value).toBe(0.01);
    expect(stepScore.buckets.find((bucket: { type: string }) => bucket.type === 'tokenUsage')?.metadata.value).toBe(10);
    expect(step.cost.totalCost).toBe(0.01);
    expect(step.cost.totalTokens).toBe(10);
    const scenarioScore = JSON.parse(await readFile(join(run.runDir, 'score-summary.json'), 'utf8'));
    expect(scenarioScore.buckets.find((bucket: { type: string }) => bucket.type === 'cost')?.metadata.value).toBe(0.01);
    expect(scenarioScore.buckets.find((bucket: { type: string }) => bucket.type === 'tokenUsage')?.metadata.value).toBe(10);
    expect(scenarioScore.score).toBe(0.7);
    expect(JSON.parse(await readFile(join(run.runDir, 'summary.json'), 'utf8')).score.score).toBe(0.7);
  } finally {
    if (previousJudgeKey === undefined) delete process.env.TEST_JUDGE_KEY;
    else process.env.TEST_JUDGE_KEY = previousJudgeKey;
    restoreDocker();
  }
});

interface PrepareCall {
  stepId: string;
  stepIndex: number;
  workspaceDir: string;
  continuation?: AdapterContinuation;
}

interface ScopedPrepareCall {
  stepId: string;
  args?: string[];
  env?: string[];
  agentConfig?: Record<string, unknown>;
  stepConfig?: Record<string, unknown>;
}

interface ScopedStepOutput {
  argv: string[];
  env: { agent?: string | null; base?: string | null; first?: string | null; second?: string | null; one?: string | null; two?: string | null };
  config: Record<string, unknown>;
}

function createLifecycleAdapter(prepareCalls: PrepareCall[]): AgentAdapter {
  return {
    name: 'lifecycle',
    async prepareStep(input: AgentStepPrepareInput) {
      prepareCalls.push({
        stepId: input.step.id,
        stepIndex: input.stepIndex,
        workspaceDir: input.workspaceDir,
        continuation: input.continuation,
      });

      const config = readRecord(input.step.config);
      const plan = {
        argv: config?.mode === 'sleep' ? ['fake-sleep'] : ['node', '-e', readScript(config)],
        cwd: input.workspace.containerPath,
        envNames: [],
        configMounts: [],
        parser: 'text',
        continuation: { id: input.step.id, metadata: { stepIndex: input.stepIndex } },
      };
      return plan;
    },
    async parseEvents(input) {
      return {
        finalOutput: input.stdout.trim(),
        toolCalls: [],
        errors: input.stderr.trim() ? [input.stderr.trim()] : [],
      };
    },
  };
}

function createScopedAdapter(prepareCalls: ScopedPrepareCall[]): AgentAdapter {
  return {
    name: 'scoped',
    async prepareStep(input: AgentStepPrepareInput) {
      const agentConfig = readRecord(input.agent.config);
      const stepConfig = readRecord(input.step.config);
      prepareCalls.push({
        stepId: input.step.id,
        args: input.agent.args,
        env: input.agent.env,
        agentConfig,
        stepConfig,
      });
      const script = `console.log(JSON.stringify({ argv: process.argv.slice(1), env: { agent: process.env.AGENT_ENV ?? null, first: process.env.STEP1_ENV ?? null, second: process.env.STEP2_ENV ?? null }, config: ${JSON.stringify(agentConfig ?? {})} }));`;
      return {
        argv: ['node', '-e', script, ...(input.agent.args ?? [])],
        cwd: input.workspace.containerPath,
        envNames: input.agent.env ?? [],
        configMounts: [],
        parser: 'text',
      };
    },
    async parseEvents(input) {
      return {
        finalOutput: input.stdout.trim(),
        toolCalls: [],
        errors: input.stderr.trim() ? [input.stderr.trim()] : [],
      };
    },
  };
}

async function writeHarnessProject(root: string, testCaseYaml: string): Promise<void> {
  await mkdir(join(root, 'cases'), { recursive: true });
  await mkdir(join(root, 'fixture'), { recursive: true });
  await writeFile(join(root, 'fixture', 'README.md'), 'fixture');
  await writeFile(join(root, 'harness-evals.yaml'), `
version: 1
docker:
  image: fake-image
  timeoutMs: 1000
agents:
  lifecycle:
    adapter: lifecycle
tests:
  - cases/*.yaml
`);
  await writeFile(join(root, 'cases', 'case.yaml'), testCaseYaml);
}

async function installFakeDocker(root: string): Promise<() => void> {
  const binDir = join(root, 'bin');
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, 'docker'), FAKE_DOCKER);
  await chmod(join(binDir, 'docker'), 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = previousPath ? `${binDir}:${previousPath}` : binDir;
  return () => {
    process.env.PATH = previousPath;
  };
}

async function tempRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'harness-evals-'));
  tempDirs.push(path);
  return path;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readScript(config: Record<string, unknown> | undefined): string {
  if (typeof config?.script !== 'string') throw new Error('step config.script is required');
  return config.script;
}

const FAKE_DOCKER = `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');

const args = process.argv.slice(2);
if (args[0] === 'rm') process.exit(0);
if (args[0] !== 'run') {
  console.error('Unsupported fake docker args: ' + args.join(' '));
  process.exit(1);
}

let index = 1;
let workdir;
const mounts = [];
const env = { PATH: process.env.PATH };
while (index < args.length) {
  const arg = args[index];
  if (arg === '--rm') {
    index += 1;
    continue;
  }
  if (arg === '--name' || arg === '--user') {
    index += 2;
    continue;
  }
  if (arg === '--network') {
    env.HARNESS_FAKE_DOCKER_NETWORK = args[index + 1];
    index += 2;
    continue;
  }
  if (arg === '--workdir') {
    workdir = args[index + 1];
    index += 2;
    continue;
  }
  if (arg === '--mount') {
    mounts.push(parseMount(args[index + 1]));
    index += 2;
    continue;
  }
  if (arg === '-e') {
    const spec = args[index + 1];
    const equals = spec.indexOf('=');
    if (equals === -1) {
      if (process.env[spec] !== undefined) env[spec] = process.env[spec];
    } else {
      env[spec.slice(0, equals)] = spec.slice(equals + 1);
    }
    index += 2;
    continue;
  }
  if (arg.startsWith('-')) {
    index += 1;
    continue;
  }
  break;
}

index += 1;
const command = args[index];
const commandArgs = args.slice(index + 1);
if (!command) process.exit(0);
if (command === 'fake-sleep') {
  setInterval(() => {}, 60_000);
} else {
  const result = spawnSync(command, commandArgs, {
    cwd: workdir ? mapPath(workdir) : process.cwd(),
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) {
    console.error(result.error.message);
    process.exit(127);
  }
  process.exit(result.status ?? (result.signal ? 1 : 0));
}

function parseMount(value) {
  const mount = {};
  for (const part of value.split(',')) {
    const equals = part.indexOf('=');
    if (equals !== -1) mount[part.slice(0, equals)] = part.slice(equals + 1);
  }
  return mount;
}

function mapPath(path) {
  for (const mount of mounts) {
    if (path === mount.target || path.startsWith(mount.target + '/')) return mount.source + path.slice(mount.target.length);
  }
  return path;
}
`;
