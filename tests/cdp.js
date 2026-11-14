// 실행 중인 테스트용 앱(DUB_DEBUG_PORT=9333)에서 JS 식을 평가해 결과를 출력: node tests/cdp.js '<expr>'
(async () => {
  const tabs = await (await fetch('http://localhost:9333/json')).json();
  const ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id === 1) { console.log(JSON.stringify(m.result?.result?.value ?? m.result, null, 1)); ws.close() } };
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: process.argv[2], awaitPromise: true, returnByValue: true } }));
})();
