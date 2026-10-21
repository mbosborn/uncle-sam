// Loaded before production modules, in a dedicated child process with a clean env.
// Defense against accidental I/O, not a security sandbox for hostile source code.
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import dns from 'node:dns';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
export const blocked = [];
const deny = name => () => {
  blocked.push(name);
  throw Object.assign(new Error(`Replay blocked external I/O: ${name}`), { code: 'REPLAY_EXTERNAL_IO' });
};
globalThis.fetch = deny('fetch');
if ('WebSocket' in globalThis) globalThis.WebSocket = class { constructor() { deny('WebSocket')(); } };
for (const [module, names] of [
  [http, ['request', 'get']], [https, ['request', 'get']], [http2, ['connect']],
  [net, ['connect', 'createConnection']], [net.Socket.prototype, ['connect']], [tls, ['connect']],
  [dgram, ['createSocket']], [dns, ['lookup', 'resolve']], [dns.promises, ['lookup', 'resolve']],
  [childProcess, ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']],
]) for (const name of names) module[name] = deny(name);
syncBuiltinESMExports();
