// E2E 테스트: 실제 Electron 앱 + 가짜 마이크(1234Hz 사인파 파일)로
// 구간 선택 → 녹음 → 미리듣기 → 내보내기를 돌리고, 결과 오디오에서 녹음이 들어간 위치를 측정한다.
// 사용: node tests/e2e.js [영상경로]   (먼저 앱이 꺼져 있어야 함)
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VIDEO = process.argv[2] || path.join(ROOT, 'test', 'dub-source.mp4');
const PORT = 47831, DBG = 9333;
const SEGS = [[20, 23], [40, 43]];
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function until(fn, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { const r = await fn(); if (r) return r } catch {} await sleep(300) }
  throw new Error('timeout: ' + what);
}

(async () => {
  // E2E_BIN=설치본 실행 파일 경로를 주면 패키징된 앱을 테스트한다 (기본: 개발 모드)
  const packaged = !!process.env.E2E_BIN;
  const app = spawn(packaged ? process.env.E2E_BIN : path.join(ROOT, 'node_modules', '.bin', 'electron'), packaged ? [] : ['.'], {
    cwd: ROOT, env: { ...process.env, DUB_FAKE_MIC: '1', /* Chrome 기본 가짜 마이크(비프음) */
      DUB_DEBUG_PORT: String(DBG), DUB_HEADLESS: '1', PORT: String(PORT),
      ...(process.env.E2E_DATA ? { DUB_DATA: process.env.E2E_DATA, DUB_OUT: path.join(process.env.E2E_DATA, 'out') } : {}) }, stdio: 'ignore' });
  try {
    await until(() => fetch(`http://localhost:${PORT}/`).then(r => r.ok), 60000, 'server');
    const tabs = await until(() => fetch(`http://localhost:${DBG}/json`).then(r => r.json())
      .then(a => a.find(t => t.type === 'page')), 30000, 'cdp');
    // 설치본은 첫 실행 때 구성요소를 내려받으므로 Demucs 준비를 기다린다
    const st0 = await until(() => fetch(`http://localhost:${PORT}/setup/status`).then(r => r.json()), 30000, 'setup status');
    console.log('구성요소 상태(시작):', JSON.stringify(Object.fromEntries(Object.entries(st0).map(([k, v]) => [k, v.state + (v.pct < 100 ? ' ' + v.pct + '%' : '')]))));
    await until(() => fetch(`http://localhost:${PORT}/setup/status`).then(r => r.json()).then(s => s.demucs.state === 'ready' || (s.demucs.state === 'error' && (() => { throw new Error('demucs install error: ' + s.demucs.msg) })())), 900000, 'demucs ready');
    console.log('Demucs 준비 완료');
    await fetch(`http://localhost:${PORT}/upload/video`, { method: 'PUT', body: fs.readFileSync(VIDEO) });

    // CDP
    const ws = new WebSocket(tabs.webSocketDebuggerUrl);
    await new Promise(r => ws.onopen = r);
    let id = 0; const pend = {};
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id] } };
    const ev = (expr) => new Promise((res, rej) => {
      const i = ++id; pend[i] = m => m.result?.exceptionDetails ? rej(new Error(JSON.stringify(m.result.exceptionDetails.exception?.description || m.result.exceptionDetails))) : res(m.result?.result?.value);
      ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
    });

    await ev(`(async()=>{ fromUrl=true; openEditor('/video?'+Date.now());
      if(!(v.duration>0)) await new Promise(r=>v.addEventListener('loadedmetadata',r,{once:true})); return v.duration })()`);

    // 1) 실제 녹음 경로 (getUserMedia → MediaRecorder)
    const recs = [];
    for (const [a, b] of SEGS) {
      const r = await ev(`(async()=>{
        addSeg(${a},${b}); const s=segs.find(x=>x.start===${a});
        startRec(s);
        for(let i=0;i<200 && !s.blob;i++) await new Promise(r=>setTimeout(r,100));
        if(!s.blob) return {err:'녹음 blob 없음', msg:msg.textContent};
        await new Promise(r=>setTimeout(r,800));            // checkRec 메시지 대기
        return {size:s.blob.size, type:s.blob.type, msg:msg.textContent, vt:v.currentTime} })()`);
      recs.push(r); console.log(`구간 ${a}-${b} 녹음:`, JSON.stringify(r));
    }

    // 2) 미리듣기 (Web Audio 시작 로그 수집)
    const pv = await ev(`(async()=>{ window.__st=[]; const o=AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start=function(w,off){__st.push({vt:+v.currentTime.toFixed(2),off:+(off||0).toFixed(2)});return o.apply(this,arguments)};
      $('mode').value='mute'; await setPreview(true); v.currentTime=18.5; await new Promise(r=>setTimeout(r,6000));
      v.currentTime=38.5; await new Promise(r=>setTimeout(r,6000)); const out=__st.slice(); await setPreview(false); return out })()`);
    console.log('미리듣기 시작 이벤트:', JSON.stringify(pv));

    // 3) 내보내기 (mute, bg)
    const outs = {};
    for (const mode of ['mute', 'bg']) {
      const msgText = await ev(`(async()=>{ $('mode').value='${mode}'; $('exp').click();
        await new Promise(r=>setTimeout(r,500)); for(let i=0;i<300&&$('exp').disabled;i++) await new Promise(r=>setTimeout(r,1000)); return msg.textContent })()`);
      console.log(`내보내기(${mode}):`, msgText);
      outs[mode] = (msgText.match(/dubbed-\d+\.mp4/) || [])[0];
    }

    // 4) 결과 분석: 원본과 출력의 차이(에너지)가 구간 안에서만 생기는지, 시작/끝이 맞는지 측정
    const pcm = (file) => {
      const r = spawnSync('ffmpeg', ['-nostdin', '-i', file, '-t', '60', '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], { maxBuffer: 1 << 28 });
      return new Int16Array(r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + r.stdout.length - (r.stdout.length % 2)));
    };
    const orig = pcm(VIDEO);
    for (const [mode, file] of Object.entries(outs)) {
      if (!file) { console.log(mode, '출력 없음'); continue }
      const out = pcm(path.join(process.env.E2E_DATA ? path.join(process.env.E2E_DATA, 'out') : path.join(ROOT, 'output'), file));
      const win = 800; // 0.1초
      const diff = [];
      for (let i = 0; i + win <= Math.min(out.length, orig.length); i += win) {
        let e = 0; for (let j = 0; j < win; j++) { const d = (out[i + j] - orig[i + j]) / 32768; e += d * d }
        diff.push(Math.sqrt(e / win));
      }
      for (const [a, b] of SEGS) {
        const idx = diff.map((x, i) => [x, i]).filter(([x, i]) => x > 0.01 && i * 0.1 >= a - 3 && i * 0.1 <= b + 3);
        const first = idx.length ? (idx[0][1] * 0.1).toFixed(1) : null, last = idx.length ? ((idx[idx.length - 1][1] + 1) * 0.1).toFixed(1) : null;
        const leakBefore = diff.slice(Math.round((a - 3) * 10), Math.round((a - 0.2) * 10)).filter(x => x > 0.01).length;
        const leakAfter = diff.slice(Math.round((b + 0.2) * 10), Math.round((b + 3) * 10)).filter(x => x > 0.01).length;
        console.log(`[${mode}] 구간 ${a}-${b}: 변화 감지 ${first}s ~ ${last}s | 구간 밖 누출 창 수: 앞 ${leakBefore}, 뒤 ${leakAfter}`);
      }
    }
    ws.close();
  } catch (e) { console.error('테스트 실패:', e.message); process.exitCode = 1 }
  finally { app.kill() }
})();
