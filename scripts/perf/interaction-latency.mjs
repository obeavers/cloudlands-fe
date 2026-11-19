#!/usr/bin/env node
/** Opt-in measurements against an existing, disposable MOCK_AGENT stack. No server is started. */
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { prepareOutDir } from './chat-motion-lib.mjs';
import {
  evaluateLatencyReport,
  analyzeInteractionPaints,
  INTERACTION_BUDGETS,
} from './interaction-latency-lib.mjs';

const USAGE =
  'usage: pnpm perf:interaction-latency --url <stack-url> --repository <path> --reference-machine <name> --out <new-dir> [--frame-budget-ms <reference-display-budget>] [--sandbox-state <stack.json>] [--scenario <json>] [--samples 20] [--baseline] [--cdp <electron-endpoint>] | --check <report.json>';
class HarnessError extends Error {}

const flags = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i];
  if (flags.has(key)) throw new HarnessError(`duplicate option ${key}`);
  if (key === '--baseline') flags.set(key, true);
  else if (
    [
      '--url',
      '--repository',
      '--reference-machine',
      '--frame-budget-ms',
      '--out',
      '--sandbox-state',
      '--scenario',
      '--samples',
      '--cdp',
      '--check',
    ].includes(key)
  ) {
    const value = process.argv[++i];
    if (!value || value.startsWith('--')) throw new HarnessError(USAGE);
    flags.set(key, value);
  } else throw new HarnessError(USAGE);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function probeCopyOnWrite(repository) {
  let directory;
  try {
    directory = await mkdtemp(path.join(repository, '.intent-latency-cow-'));
    await writeFile(path.join(directory, 'source'), Buffer.alloc(64 * 1024, 1));
    await copyFile(
      path.join(directory, 'source'),
      path.join(directory, 'clone'),
      constants.COPYFILE_FICLONE_FORCE,
    );
    return true;
  } catch {
    return false;
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

async function main() {
  if (flags.has('--check')) {
    if (flags.size !== 1) throw new HarnessError(USAGE);
    const evaluation = evaluateLatencyReport(await readJson(flags.get('--check')));
    console.log(JSON.stringify(evaluation, null, 2));
    process.exitCode = evaluation.qualified ? 0 : 1;
    return;
  }
  for (const key of ['--url', '--repository', '--reference-machine', '--out'])
    if (!flags.has(key)) throw new HarnessError(USAGE);
  const url = new URL(flags.get('--url'));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search)
    throw new HarnessError('use a sandbox HTTP(S) URL without credentials or query parameters');
  const count = Number(flags.get('--samples') ?? 20);
  if (!Number.isSafeInteger(count) || count < 20 || count > 200)
    throw new HarnessError('--samples must be between 20 and 200');
  const frameBudgetMs = flags.has('--frame-budget-ms')
    ? Number(flags.get('--frame-budget-ms'))
    : undefined;
  if (
    frameBudgetMs !== undefined &&
    (!Number.isFinite(frameBudgetMs) || frameBudgetMs <= 0 || frameBudgetMs > 1000)
  )
    throw new HarnessError(
      '--frame-budget-ms must be the positive frame duration of the reference display',
    );
  const sandbox = await readJson(flags.get('--sandbox-state') ?? '../../.dev/sandbox/stack.json');
  if (
    sandbox.mode !== 'stack' ||
    sandbox.mockAgent !== true ||
    new URL(sandbox.url).port !== url.port
  )
    throw new HarnessError('the selected URL must name an existing MOCK_AGENT stack sandbox');
  const health = await fetch(new URL('/__sandbox/health', url), {
    signal: AbortSignal.timeout(10_000),
  });
  if (!health.ok || (await health.json()).ok !== true)
    throw new HarnessError('sandbox is not healthy');
  const repository = path.resolve(flags.get('--repository'));
  const tracked = execFileSync('git', ['ls-files', '-z'], {
    cwd: repository,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const repositoryFiles = tracked.split('\0').filter(Boolean).length;
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repository,
    encoding: 'utf8',
  }).trim();
  const copyOnWrite = await probeCopyOnWrite(repository);
  const scenario = flags.has('--scenario')
    ? await readJson(flags.get('--scenario'))
    : { steps: [{ kind: 'request', method: 'host.status' }] };
  if (!Array.isArray(scenario.steps) || !scenario.steps.length || scenario.steps.length > 64)
    throw new HarnessError('scenario.steps must have between 1 and 64 operations');
  for (const step of scenario.steps) {
    if (step.kind === 'interaction') {
      if (
        INTERACTION_BUDGETS[step.metric]?.source !== 'cdp-paint' ||
        typeof step.trigger !== 'string' ||
        typeof step.ready !== 'string'
      )
        throw new HarnessError(
          'an interaction needs a paint-budget metric, trigger selector and ready selector',
        );
      if (step.readyState !== undefined && !['visible', 'hidden'].includes(step.readyState))
        throw new HarnessError('readyState must be visible or hidden');
    } else if (step.kind === 'request') {
      if (typeof step.method !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,99}$/.test(step.method))
        throw new HarnessError('a request needs a method name');
      if (step.metric !== undefined && INTERACTION_BUDGETS[step.metric]?.source !== 'request')
        throw new HarnessError(
          'RPC roundtrips cannot stand in for paint or runtime-overhead budgets',
        );
    } else throw new HarnessError('scenario operations must be request or interaction');
  }
  const out = await prepareOutDir(flags.get('--out'));
  const attached = flags.has('--cdp');
  const browser = attached
    ? await chromium.connectOverCDP(flags.get('--cdp'))
    : await chromium.launch({ headless: true });
  let page;
  let cdp;
  let tracing = false;
  let completionTimer;
  const events = [];
  let traceDropped = 0;
  const requestSamples = [];
  try {
    if (attached) {
      page = browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => p.url().startsWith(url.origin));
      if (!page)
        throw new HarnessError('no existing Electron renderer matches the selected sandbox origin');
    } else {
      page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.goto(url.href, { waitUntil: 'domcontentloaded' });
    }
    await page.waitForFunction(() => !!window.__INTENT_LATENCY__, undefined, { timeout: 180_000 });
    cdp = await page.context().newCDPSession(page);
    cdp.on('Tracing.dataCollected', ({ value }) => {
      const remaining = Math.max(0, 300_000 - events.length);
      for (let index = 0; index < Math.min(value.length, remaining); index++)
        events.push(value[index]);
      traceDropped += Math.max(0, value.length - remaining);
    });
    await cdp.send('Tracing.start', {
      categories: 'devtools.timeline,blink.user_timing',
      transferMode: 'ReportEvents',
    });
    tracing = true;
    await page.evaluate(() => window.__INTENT_LATENCY__.start());
    for (let repeat = 0; repeat < count; repeat++) {
      for (const step of scenario.steps) {
        if (step.kind === 'request') {
          const observed = await page.evaluate(
            async ({ method, params, metric }) => {
              const interaction = metric
                ? window.__INTENT_LATENCY__.beginInteraction(metric)
                : undefined;
              const { backendRequest } = await import('/src/lib/client/live/backend-transport.ts');
              await backendRequest(
                method,
                params,
                interaction ? { interactionTraceId: interaction } : undefined,
              );
              if (interaction) window.__INTENT_LATENCY__.interactionReady(interaction);
              const samples = window.__INTENT_LATENCY__.snapshot().samples;
              return samples
                .filter(
                  (s) =>
                    s.phase === 'request' &&
                    s.method === method &&
                    s.interactionTraceId === interaction,
                )
                .at(-1);
            },
            { method: step.method, params: step.params, metric: step.metric },
          );
          if (step.metric && observed)
            requestSamples.push({ ...observed, metric: step.metric, source: 'request' });
        } else {
          const control = await page.locator(step.trigger).elementHandle();
          if (!control) throw new HarnessError('the interaction control is absent');
          try {
            // Arm the actual pointer/click dispatch. Driver/actionability time is not UI latency.
            const alreadyReady = await control.evaluate((node, step) => {
              const key = Symbol.for('intent.latency.capture');
              const isReady = () => {
                const target = document.querySelector(step.ready);
                const visible =
                  !!target &&
                  target.getClientRects().length > 0 &&
                  getComputedStyle(target).visibility !== 'hidden';
                return step.readyState === 'hidden' ? !visible : visible;
              };
              if (isReady()) return true;
              const capture = { traceId: undefined, ready: false, cleanup: () => undefined };
              let frame;
              const checkReady = () => {
                if (!capture.traceId || !isReady()) return;
                // Mutation delivery precedes rendering; driver polling cannot delay this mark.
                window.__INTENT_LATENCY__.interactionReady(capture.traceId);
                capture.ready = true;
                observer.disconnect();
                if (frame !== undefined) cancelAnimationFrame(frame);
              };
              const observer = new MutationObserver(checkReady);
              const tick = () => {
                checkReady();
                if (!capture.ready) frame = requestAnimationFrame(tick);
              };
              const start = () => {
                capture.traceId = window.__INTENT_LATENCY__.beginInteraction(step.metric);
                node.removeEventListener('pointerdown', start, true);
                node.removeEventListener('click', start, true);
                frame = requestAnimationFrame(tick);
              };
              capture.cleanup = () => {
                node.removeEventListener('pointerdown', start, true);
                node.removeEventListener('click', start, true);
                observer.disconnect();
                if (frame !== undefined) cancelAnimationFrame(frame);
              };
              node[key] = capture;
              observer.observe(document.documentElement, {
                childList: true,
                subtree: true,
                attributes: true,
                characterData: true,
              });
              node.addEventListener('pointerdown', start, true);
              node.addEventListener('click', start, true);
              return false;
            }, step);
            if (alreadyReady)
              throw new HarnessError(
                'the ready predicate already matches; scenario must measure a transition',
              );
            await control.click();
            const traceId = await control.evaluate(
              (node) => node[Symbol.for('intent.latency.capture')]?.traceId,
            );
            if (!traceId)
              throw new HarnessError('the interaction control received no measured dispatch');
            await page.waitForFunction(
              (node) => node[Symbol.for('intent.latency.capture')]?.ready === true,
              control,
            );
          } finally {
            await control
              .evaluate((node) => {
                const key = Symbol.for('intent.latency.capture');
                node[key]?.cleanup();
                delete node[key];
              })
              .catch(() => undefined);
            await control.dispose();
          }
          // Rendering opportunities only keep tracing alive; they are never counted as Paint evidence.
          await page.evaluate(
            () =>
              new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          );
        }
      }
    }
    const snapshot = await page.evaluate(() => window.__INTENT_LATENCY__.stop());
    const complete = new Promise((resolve, reject) => {
      completionTimer = setTimeout(
        () => reject(new HarnessError('CDP trace completion timed out')),
        30_000,
      );
      cdp.once('Tracing.tracingComplete', resolve);
    });
    await Promise.all([cdp.send('Tracing.end'), complete]).finally(() =>
      clearTimeout(completionTimer),
    );
    tracing = false;
    const hopSamples = snapshot.samples
      .filter((s) => s.phase === 'ipc-overhead' && s.method === 'host.status')
      .map((s) => ({ ...s, source: 'ipc-overhead', metric: 'electron-main-hop' }));
    const paints = analyzeInteractionPaints(events);
    const report = {
      version: 1,
      reference: {
        machine: flags.get('--reference-machine'),
        platform: `${os.platform()}/${os.arch()}`,
        repository: path.basename(repository),
        repositoryFiles,
        revision,
        mockAgent: sandbox.mockAgent,
        sandboxMode: sandbox.mode,
        engine: 'git',
        copyOnWrite,
        frameBudgetMs,
      },
      dropped: snapshot.dropped + traceDropped + paints.unmatched,
      samples: [...paints.samples, ...requestSamples, ...hopSamples],
      requests: snapshot.samples,
    };
    const qualification = evaluateLatencyReport(report);
    await writeFile(path.join(out, 'trace.json'), JSON.stringify({ traceEvents: events }));
    await writeFile(
      path.join(out, 'report.json'),
      JSON.stringify({ ...report, qualification }, null, 2),
    );
    console.log(
      JSON.stringify(
        {
          output: out,
          mode: flags.has('--baseline') ? 'baseline-only' : 'qualification',
          ...qualification,
        },
        null,
        2,
      ),
    );
    // A deliberately partial baseline can be collected successfully, but never calls itself qualified.
    process.exitCode = flags.has('--baseline') ? 0 : qualification.qualified ? 0 : 1;
  } finally {
    clearTimeout(completionTimer);
    await page?.evaluate(() => window.__INTENT_LATENCY__?.stop()).catch(() => undefined);
    if (tracing) await cdp?.send('Tracing.end').catch(() => undefined);
    await cdp?.detach().catch(() => undefined);
    // The pinned Playwright connectOverCDP close path disconnects its transport;
    // it does not send Browser.close to the owner's Electron process.
    await browser.close();
  }
}

main().catch((error) => {
  // Transport failures can embed method parameters or page text; never print them.
  console.error(
    error instanceof HarnessError
      ? error.message
      : 'latency harness failed; no qualification was recorded',
  );
  process.exitCode = 1;
});
