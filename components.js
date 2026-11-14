// 첫 실행 때 필요한 구성요소를 내려받아 설치한다.
//   ytdlp  : YouTube 등 URL 다운로드 (단독 실행 파일)
//   deno   : yt-dlp가 YouTube 보호 스크립트를 푸는 데 쓰는 JS 런타임
//   demucs : 목소리/배경음 분리 (Python + torch + demucs, 용량 큼 · 선택 기능)
// 개발 PC에 이미 있는 도구(PATH의 yt-dlp, 프로젝트 .venv)는 그대로 인식해 설치를 건너뛴다.
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const WIN = process.platform === 'win32', MAC = process.platform === 'darwin';
const ARM = process.arch === 'arm64';
const exe = n => (WIN ? n + '.exe' : n);

module.exports = function createComponents({ dataDir, projectDir }) {
  const root = path.join(dataDir, 'components');
  const bin = path.join(root, 'bin');
  const pyDir = path.join(root, 'python');
  const marker = path.join(root, 'demucs.ok');
  const state = {
    ytdlp: { state: 'missing', pct: 0, msg: '' },
    deno: { state: 'missing', pct: 0, msg: '' },
    demucs: { state: 'missing', pct: 0, msg: '' },
  };

  const has = cmd => { try { return spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0 } catch { return false } };
  const paths = {
    ytdlp: () => { const p = path.join(bin, exe('yt-dlp')); return fs.existsSync(p) ? p : (has('yt-dlp') ? 'yt-dlp' : null) },
    deno: () => { const p = path.join(bin, exe('deno')); return fs.existsSync(p) ? p : (has('deno') ? 'deno' : (has('node') ? 'node' : null)) },
    python: () => {
      const own = WIN ? path.join(pyDir, 'python.exe') : path.join(pyDir, 'bin', 'python3');
      if (fs.existsSync(marker) && fs.existsSync(own)) return own;
      const venv = WIN ? path.join(projectDir, '.venv', 'Scripts', 'python.exe') : path.join(projectDir, '.venv', 'bin', 'python');
      return fs.existsSync(venv) ? venv : null;
    },
  };
  // JS 런타임 지정 인자 (deno 또는 개발 PC의 node)
  const jsRuntime = () => { const d = paths.deno(); if (!d) return []; const isNode = path.basename(d).startsWith('node') || d === 'node'; return ['--js-runtimes', `${isNode ? 'node' : 'deno'}${d.includes(path.sep) ? ':' + d : ''}`] };

  const refresh = () => {
    if (state.ytdlp.state !== 'installing') state.ytdlp = paths.ytdlp() ? { state: 'ready', pct: 100, msg: '' } : (state.ytdlp.state === 'error' ? state.ytdlp : { state: 'missing', pct: 0, msg: '' });
    if (state.deno.state !== 'installing') state.deno = paths.deno() ? { state: 'ready', pct: 100, msg: '' } : (state.deno.state === 'error' ? state.deno : { state: 'missing', pct: 0, msg: '' });
    if (state.demucs.state !== 'installing') state.demucs = paths.python() ? { state: 'ready', pct: 100, msg: '' } : (state.demucs.state === 'error' ? state.demucs : { state: 'missing', pct: 0, msg: '' });
    return state;
  };

  async function download(url, dest, onPct) {
    const r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'dub-korean', Accept: 'application/octet-stream' } });
    if (!r.ok) throw new Error(`Download failed (${r.status}): ${url}`);
    const total = +r.headers.get('content-length') || 0; let got = 0;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const ws = fs.createWriteStream(dest);
    for await (const chunk of r.body) { ws.write(chunk); got += chunk.length; if (total) onPct && onPct(Math.round(got / total * 100)) }
    await new Promise((ok, no) => { ws.end(); ws.on('finish', ok); ws.on('error', no) });
  }
  const run = (cmd, args, opts = {}) => new Promise((ok, no) => {
    const p = spawn(cmd, args, { ...opts }); let err = '';
    p.stderr && p.stderr.on('data', c => err += c); p.stdout && p.stdout.on('data', c => { opts.onOut && opts.onOut(String(c)) });
    p.on('error', no); p.on('close', c => c === 0 ? ok() : no(new Error(err.slice(-500) || 'exit ' + c)));
  });
  const untar = (file, dir) => { fs.mkdirSync(dir, { recursive: true }); return run('tar', ['-xf', file, '-C', dir]) }; // macOS/Windows 10+ 의 tar는 zip도 처리

  const installers = {
    async ytdlp(set) {
      const name = WIN ? 'yt-dlp.exe' : MAC ? 'yt-dlp_macos' : 'yt-dlp';
      const dest = path.join(bin, exe('yt-dlp'));
      await download(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${name}`, dest, set);
      if (!WIN) fs.chmodSync(dest, 0o755);
    },
    async deno(set) {
      const triple = WIN ? 'x86_64-pc-windows-msvc' : MAC ? (ARM ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin') : 'x86_64-unknown-linux-gnu';
      const zip = path.join(root, 'tmp-deno.zip');
      await download(`https://github.com/denoland/deno/releases/latest/download/deno-${triple}.zip`, zip, set);
      await untar(zip, bin); fs.rmSync(zip, { force: true });
      if (!WIN) fs.chmodSync(path.join(bin, 'deno'), 0o755);
    },
    async demucs(set, say) {
      const triple = WIN ? 'x86_64-pc-windows-msvc' : MAC ? (ARM ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin') : 'x86_64-unknown-linux-gnu';
      // 1) 독립 실행형 Python
      say('Python'); set(2);
      const rel = await (await fetch('https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest', { headers: { 'User-Agent': 'dub-korean' } })).json();
      const asset = (rel.assets || []).find(a => new RegExp(`^cpython-3\\.12\\.\\d+\\+\\d+-${triple}-install_only\\.tar\\.gz$`).test(a.name))
        || (rel.assets || []).find(a => new RegExp(`^cpython-3\\.1[123]\\.\\d+\\+\\d+-${triple}-install_only\\.tar\\.gz$`).test(a.name));
      if (!asset) throw new Error('No standalone Python build found for this platform.');
      const tgz = path.join(root, 'tmp-python.tar.gz');
      await download(asset.browser_download_url, tgz, p => set(2 + Math.round(p * 0.08)));
      fs.rmSync(pyDir, { recursive: true, force: true });
      await untar(tgz, root); fs.rmSync(tgz, { force: true });           // 압축을 풀면 python/ 폴더가 생김
      const py = WIN ? path.join(pyDir, 'python.exe') : path.join(pyDir, 'bin', 'python3');
      // 2) torch + demucs (용량이 커서 시간이 걸림)
      say('torch + Demucs'); set(12);
      let n = 12;
      await run(py, ['-m', 'pip', 'install', '--no-warn-script-location', '--disable-pip-version-check', 'demucs', 'soundfile'],
        { onOut: s => { n = Math.min(85, n + (s.match(/\n/g) || []).length * 0.4); set(Math.round(n)) } });
      // 3) 모델 가중치 미리 받아 두기 (무음 1초로 한 번 실행)
      say('model'); set(88);
      const wav = path.join(root, 'warm.wav'); const out = path.join(root, 'warm-out');
      fs.mkdirSync(root, { recursive: true });
      const hdr = Buffer.alloc(44 + 88200); hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + 88200, 4); hdr.write('WAVEfmt ', 8); hdr.writeUInt32LE(16, 16);
      hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22); hdr.writeUInt32LE(44100, 24); hdr.writeUInt32LE(88200, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34);
      hdr.write('data', 36); hdr.writeUInt32LE(88200, 40); fs.writeFileSync(wav, hdr);
      await run(py, ['-m', 'demucs', '--two-stems=vocals', '-d', 'cpu', '-o', out, wav]);
      fs.rmSync(wav, { force: true }); fs.rmSync(out, { recursive: true, force: true });
      fs.writeFileSync(marker, new Date().toISOString());
    },
  };

  const jobs = {};
  function install(name) {
    if (jobs[name]) return jobs[name];
    state[name] = { state: 'installing', pct: 0, msg: '' };
    fs.mkdirSync(root, { recursive: true });
    jobs[name] = installers[name](pct => { state[name].pct = pct }, msg => { state[name].msg = msg })
      .then(() => { state[name] = { state: 'ready', pct: 100, msg: '' } })
      .catch(e => { state[name] = { state: 'error', pct: 0, msg: String(e.message || e).slice(0, 300) } })
      .finally(() => { delete jobs[name] });
    return jobs[name];
  }
  // 빠진 것을 순서대로 설치 (필수 → 선택)
  async function installMissing() {
    refresh();
    for (const n of ['ytdlp', 'deno', 'demucs']) if (state[n].state === 'missing') await install(n);
  }
  return { state, refresh, install, installMissing, paths, jsRuntime, root };
};
