// CDP probe: verify footer/header language switchers stay in sync
const { spawn } = require('child_process');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9333;
const URL = process.argv[2] || 'https://global.osmaigc.com/?probe=1';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function evalIn(ws, expr) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const onMsg = ev => {
      const m = JSON.parse(ev.data);
      if (m.id === id) { ws.removeEventListener('message', onMsg); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result.result.value); }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  });
}

const SNAP = `(() => JSON.stringify([...document.querySelectorAll('.lang-switch')].map(s => ({
  where: s.closest('header') ? 'header' : (s.closest('footer') ? 'footer' : 'other'),
  on: [...s.querySelectorAll('.lang-btn.on')].map(b => b.dataset.lang).join(','),
  labels: [...s.querySelectorAll('.lang-btn')].map(b => b.textContent).join('|')
})), null, 0))()`;

(async () => {
  const proc = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--user-data-dir=C:/Users/Administrator/AppData/Local/Temp/cr-probe', '--remote-debugging-port=' + PORT,
    '--window-size=1440,900', URL], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(500);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find(t => t.type === 'page' && t.url.includes('osmaigc'));
    } catch (e) {}
  }
  if (!target) { console.log('NO TARGET'); proc.kill(); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  await sleep(4000);

  console.log('BEFORE:', await evalIn(ws, SNAP));
  console.log('title:', await evalIn(ws, 'document.title'));
  console.log('lang attr:', await evalIn(ws, 'document.documentElement.lang'));

  // click the FOOTER 中文 pill
  console.log('click footer zh:', await evalIn(ws, `(() => { const b = document.querySelector('footer .lang-btn[data-lang="zh"]'); if (!b) return 'no btn'; b.click(); return 'clicked'; })()`));
  await sleep(1200);
  console.log('AFTER :', await evalIn(ws, SNAP));
  console.log('title:', await evalIn(ws, 'document.title'));
  console.log('lang attr:', await evalIn(ws, 'document.documentElement.lang'));

  // click the HEADER EN pill, check footer follows
  console.log('click header en:', await evalIn(ws, `(() => { const b = document.querySelector('header .lang-btn[data-lang="en"]'); if (!b) return 'no btn'; b.click(); return 'clicked'; })()`));
  await sleep(1200);
  console.log('AFTER2:', await evalIn(ws, SNAP));
  console.log('title:', await evalIn(ws, 'document.title'));

  ws.close(); proc.kill();
})();
