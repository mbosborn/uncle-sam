import { fork } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBroker } from './broker.mjs';

export async function runEvaluation({ root, client, scenario = '', repeat = 3, onProgress = () => {}, timeoutMs = 25 * 60_000, ...limits }) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'uncle-sam-model-eval-'));
  const output = path.join(temp, 'report.json');
  const broker = createBroker({ client, timeoutMs, ...limits });
  let child;
  try {
    await new Promise((resolve, reject) => {
      child = fork(path.join(root, 'test/model-eval/worker.mjs'), [root, output, scenario, String(repeat)], {
        cwd: temp, execPath: process.execPath, execArgv: ['--import', path.join(root, 'test/replay/isolation.mjs')],
        env: { PATH: path.dirname(process.execPath), TZ: 'UTC', LANG: 'en_US.UTF-8', NODE_NO_WARNINGS: '1' },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      let diagnostic = '';
      child.stderr.on('data', data => { diagnostic = (diagnostic + data).slice(-2000); });
      const timer = setTimeout(() => { child.kill(); reject(Error('Evaluation timed out')); }, timeoutMs);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error(`Evaluation worker exited ${code}: ${diagnostic}`)); });
      child.on('message', async message => {
        if (message.type === 'progress') { onProgress(message); return; }
        if (message.type !== 'model') return;
        let reply;
        try { reply = { id: message.id, response: await broker.complete(message.request, message.context) }; }
        catch (error) { reply = { id: message.id, error: error.code ?? 'eval_model_failed' }; }
        if (child.connected) child.send(reply, () => {});
      });
    });
    return { ...JSON.parse(await readFile(output, 'utf8')), calls: broker.calls, usage: broker.totals, limits };
  } finally { if (child?.connected) child.kill(); await rm(temp, { recursive: true, force: true }); }
}
