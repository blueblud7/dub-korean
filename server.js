// 의존성 없는 로컬 서버: 정적 파일 + 업로드 + ffmpeg 내보내기
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const PORT = process.env.PORT || 3000;
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'dubbing-'));
let videoPath = path.join(WORK, 'video');
const HIST = process.env.DUB_DATA || path.join(__dirname, 'history');
fs.mkdirSync(HIST, { recursive: true });
const pdir = pid => path.join(HIST, String(pid).replace(/[^\w-]/g, ''));
const clearSubs = () => fs.readdirSync(WORK).filter(f => /^dl\..+\.vtt$/.test(f)).forEach(f => fs.rmSync(path.join(WORK, f)));
const OUT = process.env.DUB_OUT || path.join(__dirname, 'output');
const comps = require('./components.js')({ dataDir: HIST, projectDir: __dirname });
// ffmpeg: 앱에 포함된 ffmpeg-static 우선, 없으면 PATH의 ffmpeg
const FFMPEG = (() => { try { const p = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked'); if (fs.existsSync(p)) return p } catch {} return 'ffmpeg' })();
fs.mkdirSync(OUT, { recursive: true });

const save = (req, file) => new Promise((res, rej) => {
  const ws = fs.createWriteStream(file);
  req.pipe(ws);
  ws.on('finish', res);
  ws.on('error', rej);
});
const body = (req) => new Promise((res) => {
  let d = ''; req.on('data', c => d += c); req.on('end', () => res(d));
});

function run(args) {
  return new Promise((res, rej) => {
    const p = spawn(FFMPEG, args);
    let err = '';
    p.stderr.on('data', c => err += c);
    p.on('close', code => code === 0 ? res() : rej(new Error(err.slice(-1500))));
  });
}

async function demucs(files, outDir) {
  const PY = comps.paths.python();
  if (!PY) throw new Error('Demucs is not installed (.venv required).');
  const go = (dev) => new Promise((ok, no) => {
    const p = spawn(PY, ['-m', 'demucs', '--two-stems=vocals', '-d', dev, '-o', outDir, ...files]);
    let err = ''; p.stderr.on('data', c => err += c);
    p.on('close', c => c === 0 ? ok() : no(new Error(err.slice(-600))));
  });
  try { await go(process.platform === 'darwin' ? 'mps' : 'cpu'); } catch { await go('cpu'); }
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
    }
    if (req.method === 'PUT' && url.pathname === '/upload/video') {
      videoPath = path.join(WORK, 'video'); fs.rmSync(path.join(WORK, 'bg'), { recursive: true, force: true }); clearSubs();
      await save(req, videoPath);
      return res.end('ok');
    }
    if (req.method === 'POST' && url.pathname === '/fetch') {
      const { url: u } = JSON.parse(await body(req));
      if (!/^https?:\/\//i.test(u)) throw new Error('Only http(s) URLs are supported.');
      const target = path.join(WORK, 'dl.mp4');
      fs.rmSync(target, { force: true });
      fs.readdirSync(WORK).filter(f => /^dl\..+\.vtt$/.test(f)).forEach(f => fs.rmSync(path.join(WORK, f)));
      await new Promise((ok, no) => {
        const p = spawn(comps.paths.ytdlp() || 'yt-dlp', [...comps.jsRuntime(), '--no-playlist', '-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b',
          '--merge-output-format', 'mp4', ...(FFMPEG.includes(path.sep) ? ['--ffmpeg-location', FFMPEG] : []), '-o', target, '--', u]);
        let err = ''; p.stderr.on('data', c => err += c);
        p.on('error', e => no(new Error('Failed to run yt-dlp: ' + e.message)));
        p.on('close', c => c === 0 ? ok() : no(new Error(err.slice(-600))));
      });
      if (!fs.existsSync(target)) throw new Error('Download finished but the video file was not created (merge failed).');
      // 자막은 실패해도(예: 429) 영상 다운로드에는 영향 없도록 따로 시도.
      // 번역 자막은 YouTube가 429를 자주 내므로 제외: 제작자 자막 + 원어 자동자막(*-orig)만.
      const subPass = (extra) => new Promise((ok) => {
        const p = spawn(comps.paths.ytdlp() || 'yt-dlp', [...comps.jsRuntime(), '--no-playlist', '--skip-download', ...extra,
          '--convert-subs', 'vtt', '-o', path.join(WORK, 'dl'), '--', u]);
        p.on('error', ok); p.on('close', ok);
      });
      await subPass(['--write-subs', '--sub-langs', 'all,-live_chat']);
      await subPass(['--write-auto-subs', '--sub-langs', '.*-orig']);
      const title = await new Promise((ok) => {
        let out = ''; const p = spawn(comps.paths.ytdlp() || 'yt-dlp', [...comps.jsRuntime(), '--no-playlist', '--skip-download', '--print', 'title', '--', u]);
        p.stdout.on('data', c => out += c); p.on('error', () => ok('')); p.on('close', () => ok(out.trim().split('\n')[0] || ''));
      });
      videoPath = target; fs.rmSync(path.join(WORK, 'bg'), { recursive: true, force: true });
      const subs = fs.readdirSync(WORK).map(f => (f.match(/^dl\.(.+)\.vtt$/) || [])[1]).filter(Boolean);
      return res.end(JSON.stringify({ ok: true, subs, title }));
    }
    if (req.method === 'GET' && url.pathname.startsWith('/sub/')) {
      const lang = decodeURIComponent(url.pathname.slice(5)).replace(/[^\w.-]/g, '');
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      return fs.createReadStream(path.join(WORK, `dl.${lang}.vtt`)).pipe(res);
    }
    if (req.method === 'GET' && url.pathname === '/video') {
      const size = fs.statSync(videoPath).size;
      const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Accept-Ranges', 'bytes');
      if (m) {
        const a = m[1] ? +m[1] : 0, b = m[2] ? +m[2] : size - 1;
        res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${size}`, 'Content-Length': b - a + 1 });
        return fs.createReadStream(videoPath, { start: a, end: b }).pipe(res);
      }
      res.setHeader('Content-Length', size);
      return fs.createReadStream(videoPath).pipe(res);
    }
    if (req.method === 'PUT' && url.pathname.startsWith('/upload/seg/')) {
      const id = url.pathname.split('/').pop().replace(/\W/g, '');
      await save(req, path.join(WORK, 'seg_' + id));
      return res.end('ok');
    }
    // ---------- 작업 기록 (히스토리) ----------
    if (req.method === 'GET' && url.pathname === '/projects') {
      const list = fs.readdirSync(HIST).map(d => { try { return JSON.parse(fs.readFileSync(path.join(HIST, d, 'project.json'), 'utf8')) } catch { return null } })
        .filter(Boolean).sort((a, b) => b.updated - a.updated);
      return res.end(JSON.stringify(list));
    }
    if (req.method === 'POST' && url.pathname === '/project/save') {
      const { pid: given, title, url: src, segs } = JSON.parse(await body(req));
      const pid = given || Date.now().toString(36);
      const dir = pdir(pid); fs.mkdirSync(dir, { recursive: true });
      const vfile = path.join(dir, 'video.mp4');
      if (!fs.existsSync(vfile) && path.resolve(videoPath) !== path.resolve(vfile)) fs.copyFileSync(videoPath, vfile);
      fs.readdirSync(WORK).filter(f => /^dl\..+\.vtt$/.test(f)).forEach(f => fs.copyFileSync(path.join(WORK, f), path.join(dir, f)));
      const old = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')) } catch { return {} } })();
      fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ pid, title, url: src, segs, created: old.created || Date.now(), updated: Date.now() }));
      const keep = new Set(segs.filter(g => g.hasRec).map(g => `rec_${g.id}.webm`));
      fs.readdirSync(dir).filter(f => /^rec_.*\.webm$/.test(f) && !keep.has(f)).forEach(f => fs.rmSync(path.join(dir, f)));
      return res.end(JSON.stringify({ pid }));
    }
    let m;
    if ((m = url.pathname.match(/^\/project\/([\w-]+)\/rec\/(\d+)$/))) {
      const f = path.join(pdir(m[1]), `rec_${m[2]}.webm`);
      if (req.method === 'PUT') { await save(req, f); return res.end('ok') }
      if (req.method === 'GET') { res.setHeader('Content-Type', 'audio/webm'); return fs.createReadStream(f).pipe(res) }
    }
    if (req.method === 'POST' && url.pathname === '/project/open') {
      const { pid } = JSON.parse(await body(req));
      const dir = pdir(pid);
      const project = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
      videoPath = path.join(dir, 'video.mp4');
      fs.rmSync(path.join(WORK, 'bg'), { recursive: true, force: true }); clearSubs();
      const subs = [];
      fs.readdirSync(dir).forEach(f => { const g = f.match(/^dl\.(.+)\.vtt$/); if (g) { fs.copyFileSync(path.join(dir, f), path.join(WORK, f)); subs.push(g[1]) } });
      return res.end(JSON.stringify({ project, subs }));
    }
    if (req.method === 'DELETE' && (m = url.pathname.match(/^\/project\/([\w-]+)$/))) {
      const dir = pdir(m[1]);
      if (path.dirname(dir) === HIST) fs.rmSync(dir, { recursive: true, force: true });
      return res.end('ok');
    }
    if (req.method === 'GET' && url.pathname === '/setup/status') return res.end(JSON.stringify(comps.refresh()));
    if (req.method === 'POST' && url.pathname === '/setup/install') {
      const { name } = JSON.parse(await body(req));
      if (!['ytdlp', 'deno', 'demucs'].includes(name)) throw new Error('Unknown component.');
      comps.install(name);
      return res.end(JSON.stringify({ ok: true }));
    }
    if (req.method === 'POST' && url.pathname === '/bgclips') {
      // 미리듣기용: 구간별 배경음(목소리 제거) 클립 생성. 한 번 만든 건 캐시.
      const { segs } = JSON.parse(await body(req));
      const bg = path.join(WORK, 'bg'); fs.mkdirSync(bg, { recursive: true });
      const keyOf = sg => `${sg.id}_${Math.round(sg.start * 1000)}_${Math.round(sg.end * 1000)}`;
      const todo = segs.filter(sg => !fs.existsSync(path.join(bg, keyOf(sg) + '.wav')));
      const PAD = 1, clips = [];
      for (const sg of todo) {
        sg.pre = Math.min(PAD, sg.start);
        const clip = path.join(bg, 'in_' + keyOf(sg) + '.wav');
        await run(['-y', '-ss', String(sg.start - sg.pre), '-t', String(sg.end - sg.start + sg.pre + PAD),
          '-i', videoPath, '-vn', '-ac', '2', '-ar', '44100', clip]);
        clips.push(clip);
      }
      if (clips.length) await demucs(clips, path.join(bg, 'sep'));
      for (const sg of todo) {
        const k = keyOf(sg);
        await run(['-y', '-i', path.join(bg, 'sep', 'htdemucs', 'in_' + k, 'no_vocals.wav'),
          '-af', `atrim=${sg.pre.toFixed(3)}:${(sg.pre + sg.end - sg.start).toFixed(3)},asetpts=PTS-STARTPTS`,
          path.join(bg, k + '.wav')]);
      }
      return res.end(JSON.stringify({ keys: Object.fromEntries(segs.map(sg => [sg.id, keyOf(sg)])) }));
    }
    if (req.method === 'GET' && url.pathname.startsWith('/bg/')) {
      res.setHeader('Content-Type', 'audio/wav');
      return fs.createReadStream(path.join(WORK, 'bg', path.basename(url.pathname))).pipe(res);
    }
    if (req.method === 'POST' && url.pathname === '/export') {
      // segs: [{id, start, end}] — 녹음이 있는 구간만 더빙
      // mode: 'mute'(원본 끔) | 'duck'(원본 작게) | 'bg'(목소리만 제거, 배경음/효과음 유지)
      const { segs, mode = 'mute', origVolume = 0.15 } = JSON.parse(await body(req));
      const video = videoPath;
      const dubbed = segs.filter(s => fs.existsSync(path.join(WORK, 'seg_' + s.id)));
      if (!dubbed.length) throw new Error('No recorded segments.');
      const F = 0.06; // 구간 경계 크로스페이드(초)

      // 배경 유지 모드: 구간 오디오(앞뒤 1초 여유)만 잘라 Demucs로 목소리 분리
      const PAD = 1;
      if (mode === 'bg') {
        const dir = path.join(WORK, 'sep'); fs.mkdirSync(dir, { recursive: true });
        const clips = [];
        for (const sg of dubbed) {
          sg.pre = Math.min(PAD, sg.start);
          const clip = path.join(dir, `c${sg.id}.wav`);
          await run(['-y', '-ss', String(sg.start - sg.pre), '-t', String(sg.end - sg.start + sg.pre + PAD),
            '-i', video, '-vn', '-ac', '2', '-ar', '44100', clip]);
          clips.push(clip);
        }
        await demucs(clips, path.join(dir, 'out'));
      }

      const args = ['-y', '-i', video];
      dubbed.forEach(sg => args.push('-i', path.join(WORK, 'seg_' + sg.id)));
      const bgIdx = {};
      if (mode === 'bg') dubbed.forEach(sg => {
        bgIdx[sg.id] = (args.filter(x => x === '-i').length);
        args.push('-i', path.join(WORK, 'sep', 'out', 'htdemucs', 'c' + sg.id, 'no_vocals.wav'));
      });

      // 원본: 더빙 구간에서만 부드럽게 줄임 (나머지는 그대로)
      const v = mode === 'duck' ? origVolume : 0;
      const dip = sg => `min(1,max(0,(t-${sg.start})/${F}))*min(1,max(0,(${sg.end}-t)/${F}))`;
      const mute = dubbed.map(sg => `volume='1-${1 - v}*${dip(sg)}':eval=frame`).join(',');
      let f = `[0:a]${mute}[orig]`;
      const labels = ['[orig]'];
      dubbed.forEach((sg, i) => {
        const ms = Math.round(sg.start * 1000), len = (sg.end - sg.start).toFixed(3);
        f += `;[${i + 1}:a]atrim=0:${len},asetpts=PTS-STARTPTS,afade=t=in:d=${F},afade=t=out:st=${Math.max(0, len - F).toFixed(3)}:d=${F},adelay=${ms}:all=1[d${i}]`;
        labels.push(`[d${i}]`);
        if (mode === 'bg') {
          const st = sg.pre.toFixed(3);
          f += `;[${bgIdx[sg.id]}:a]atrim=${st}:${(+st + +len).toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:d=${F},afade=t=out:st=${Math.max(0, len - F).toFixed(3)}:d=${F},adelay=${ms}:all=1[b${i}]`;
          labels.push(`[b${i}]`);
        }
      });
      f += `;${labels.join('')}amix=inputs=${labels.length}:normalize=0:duration=first[aout]`;

      const outName = `dubbed-${Date.now()}.mp4`;
      args.push('-filter_complex', f, '-map', '0:v', '-map', '[aout]',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', path.join(OUT, outName));
      await run(args);
      return res.end(JSON.stringify({ file: outName }));
    }
    if (req.method === 'GET' && url.pathname.startsWith('/output/')) {
      const f = path.join(OUT, path.basename(url.pathname));
      res.setHeader('Content-Disposition', 'attachment');
      return fs.createReadStream(f).pipe(res);
    }
    res.statusCode = 404; res.end('not found');
  } catch (e) {
    res.statusCode = 500; res.end(JSON.stringify({ error: e.message }));
  }
}).listen(PORT, () => { console.log(`http://localhost:${PORT}`); if (process.env.DUB_AUTOSETUP === '1') comps.installMissing().catch(() => {}) });
