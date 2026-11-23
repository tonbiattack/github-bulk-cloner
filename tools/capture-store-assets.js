'use strict';

/**
 * Captures Chrome Web Store listing assets.
 *
 * Produces:
 *   - store/screenshots/*.png  (1280x800, the size the store asks for)
 *   - store/promo/small-440x280.png
 *   - store/promo/marquee-1400x560.png
 *
 * Usage: node tools/capture-store-assets.js <extensionId> <cloneRoot>
 */

const fs = require('node:fs');
const path = require('node:path');

const CDP_PORT = process.env.CDP_PORT || '9350';
const EXTENSION_ID = process.argv[2];
const CLONE_ROOT = process.argv[3];

if (!EXTENSION_ID || !CLONE_ROOT) {
  console.error('usage: node capture-store-assets.js <extensionId> <cloneRoot>');
  process.exit(1);
}

const OUT = path.join(process.cwd(), 'store');
const GITHUB_URL = 'https://github.com/tonbiattack?tab=repositories';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    const pending = new Map();
    let nextId = 1;

    socket.addEventListener('open', () => {
      resolve({
        send(method, params = {}) {
          const id = nextId++;
          return new Promise((res, rej) => {
            pending.set(id, { res, rej });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
        close() { socket.close(); }
      });
    });

    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const { res, rej } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) rej(new Error(JSON.stringify(message.error)));
        else res(message.result);
      }
    });

    socket.addEventListener('error', () => reject(new Error('websocket error')));
  });
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text + ' ' +
      JSON.stringify(result.exceptionDetails.exception && result.exceptionDetails.exception.description));
  }
  return result.result.value;
}

async function newTab(url) {
  const response = await fetch(
    `http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`,
    { method: 'PUT' }
  );
  return response.json();
}

async function capture(client, file, width, height) {
  await client.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false
  });
  await sleep(1200);
  const shot = await client.send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log('wrote', path.relative(process.cwd(), file), `${width}x${height}`);
}

async function main() {
  fs.mkdirSync(path.join(OUT, 'screenshots'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'promo'), { recursive: true });

  // ------------------------------------------------- extension + settings
  const popupTarget = await newTab(`chrome-extension://${EXTENSION_ID}/popup/popup.html`);
  await sleep(2500);
  const worker = await connect(popupTarget.webSocketDebuggerUrl);
  await worker.send('Runtime.enable');

  await evaluate(worker,
    `chrome.runtime.sendMessage({type:"gbc:saveSettings",settings:{root:${JSON.stringify(CLONE_ROOT)}}})`);

  // Close stale listing tabs so the content script is fresh.
  await evaluate(worker, `
    (async () => {
      const tabs = await chrome.tabs.query({});
      const stale = tabs.filter((t) => t.url && t.url.includes('tab=repositories'));
      await Promise.all(stale.map((t) => chrome.tabs.remove(t.id).catch(() => {})));
      return stale.length;
    })()
  `);

  // ------------------------------------------------------- GitHub listing
  const pageTarget = await newTab(GITHUB_URL);
  await sleep(7000);
  const page = await connect(pageTarget.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await page.send('Page.enable');

  // Wait for the content script.
  for (let i = 0; i < 30; i++) {
    const n = await evaluate(page, 'document.querySelectorAll(".gbc-checkbox").length');
    if (n > 0) break;
    await sleep(1000);
  }

  // 1. Listing with checkboxes, nothing selected.
  await capture(page, path.join(OUT, 'screenshots', '01-repository-list.png'), 1280, 800);

  // 2. Check a couple of boxes so the clone badges appear, then wait until the
  // row badges settle (not "working") so the screenshot shows the outcome.
  await evaluate(page, `
    (() => {
      const boxes = [...document.querySelectorAll('.gbc-checkbox')];
      boxes.slice(0, 2).forEach((b) => { if (!b.checked) b.click(); });
    })()
  `);

  for (let i = 0; i < 180; i++) {
    const settled = await evaluate(page, `
      (() => {
        const badges = [...document.querySelectorAll('.gbc-row-status')];
        if (badges.length === 0) return false;
        return badges.every((b) => b.dataset.state && b.dataset.state !== 'working');
      })()
    `);
    if (settled) break;
    await sleep(1000);
  }
  await sleep(1200);
  await capture(page, path.join(OUT, 'screenshots', '02-clone-complete.png'), 1280, 800);

  // 3. Popup with finished results, composed on a branded background so the
  // narrow popup is legible at the store's 1280x800 size.
  const popup2 = await newTab(`chrome-extension://${EXTENSION_ID}/popup/popup.html`);
  await sleep(3000);
  const popup = await connect(popup2.webSocketDebuggerUrl);
  await popup.send('Runtime.enable');
  await popup.send('Page.enable');

  // Wait for the run to finish so the results are populated.
  for (let i = 0; i < 60; i++) {
    const state = await evaluate(popup, 'chrome.runtime.sendMessage({type:"gbc:getRunState"})');
    if (state && state.status !== 'running') break;
    await sleep(1000);
  }

  // Read the popup's rendered height so the composition fits it exactly.
  const popupHeight = await evaluate(popup, 'document.body.scrollHeight');
  const popupShot = await popup.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 0, y: 0, width: 380, height: popupHeight, scale: 2 }
  });
  const popupData = Buffer.from(popupShot.data, 'base64').toString('base64');
  fs.writeFileSync(path.join(OUT, 'promo', 'popup-closeup.png'), Buffer.from(popupData, 'base64'));
  console.log('wrote store/promo/popup-closeup.png');

  // Compose the popup on a branded canvas.
  const composePage = await newTab('about:blank');
  await sleep(1000);
  const compose = await connect(composePage.webSocketDebuggerUrl);
  await compose.send('Runtime.enable');
  await compose.send('Page.enable');
  await compose.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 800, deviceScaleFactor: 1, mobile: false
  });

  const composeHtml = `
    <!DOCTYPE html><html><head><meta charset="utf-8"><style>
      * { margin:0; padding:0; box-sizing:border-box; }
      body {
        width:1280px; height:800px; display:flex; align-items:center; justify-content:center;
        gap:56px; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans JP",sans-serif;
        background:linear-gradient(135deg,#0d1117 0%,#161b22 55%,#1a7f37 170%);
        color:#e6edf3; overflow:hidden;
      }
      .copy { max-width:430px; }
      .copy h2 { font-size:40px; font-weight:700; line-height:1.2; letter-spacing:-0.5px; }
      .copy p { margin-top:18px; font-size:18px; line-height:1.6; color:#9198a1; }
      .copy ul { margin-top:22px; list-style:none; font-size:16px; line-height:2; color:#c9d1d9; }
      .copy li::before { content:"✓"; color:#3fb950; font-weight:700; margin-right:10px; }
      .shot {
        border-radius:12px; overflow:hidden; flex:0 0 auto;
        box-shadow:0 24px 60px rgba(0,0,0,0.55), 0 0 0 1px rgba(240,246,252,0.1);
      }
      .shot img { display:block; width:380px; }
    </style></head><body>
      <div class="copy">
        <h2>チェックするだけ。<br>その場で clone。</h2>
        <p>GitHub のリポジトリ一覧で欲しいものにチェックを付けると、Windows の指定フォルダへすぐに clone されます。</p>
        <ul>
          <li>保存先フォルダは自動作成</li>
          <li>既存フォルダは変更しない</li>
          <li>Private リポジトリにも対応</li>
        </ul>
      </div>
      <div class="shot"><img id="shot" src=""></div>
    </body></html>`;

  await evaluate(compose, `
    (() => {
      document.open();
      document.write(${JSON.stringify(composeHtml)});
      document.close();
      document.getElementById('shot').src = 'data:image/png;base64,${popupData}';
    })()
  `);
  await sleep(1200);
  const composed = await compose.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'screenshots', '03-popup-results.png'), Buffer.from(composed.data, 'base64'));
  console.log('wrote store/screenshots/03-popup-results.png 1280x800');

  // ------------------------------------------------------------- promo art
  // The store wants a 440x280 tile and a 1400x560 marquee. Render them in the
  // browser so the typography matches the extension.
  const promoHtml = `
    <!DOCTYPE html><html><head><meta charset="utf-8"><style>
      * { margin:0; padding:0; box-sizing:border-box; }
      html, body { width:100%; height:100%; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans JP", sans-serif;
        background: linear-gradient(135deg, #0d1117 0%, #161b22 55%, #1a7f37 160%);
        color: #e6edf3; overflow: hidden;
        display:flex; align-items:center; justify-content:center;
      }
      .wrap { display:flex; align-items:center; gap:26px; }
      .icon { border-radius:22%; flex:0 0 auto; display:block; }
      h1 { font-size:34px; font-weight:700; letter-spacing:-0.5px; line-height:1.15; }
      p { margin-top:10px; font-size:15px; color:#9198a1; line-height:1.45; }
      .tag {
        display:inline-block; margin-top:14px; padding:4px 11px; border-radius:999px;
        background:rgba(63,185,80,0.16); color:#3fb950; font-size:12px; font-weight:600;
      }
      body.marquee .wrap { gap:52px; }
      body.marquee h1 { font-size:64px; }
      body.marquee p { font-size:24px; margin-top:16px; }
      body.marquee .tag { font-size:18px; padding:8px 18px; margin-top:22px; }
    </style></head><body>
      <div class="wrap">
        <img class="icon" id="icon" src="">
        <div>
          <h1>GitHub Bulk Cloner</h1>
          <p>チェックを付けるだけで、<br>その場でローカルに clone。</p>
          <span class="tag">Chrome + Windows</span>
        </div>
      </div>
    </body></html>`;

  const promoPath = path.join(OUT, 'promo', '_promo.html');
  fs.writeFileSync(promoPath, promoHtml);

  const iconData = fs.readFileSync(path.join(process.cwd(), 'extension', 'icons', 'icon-128.png')).toString('base64');

  const promoPage = await newTab('about:blank');
  await sleep(1000);
  const promo = await connect(promoPage.webSocketDebuggerUrl);
  await promo.send('Runtime.enable');
  await promo.send('Page.enable');

  async function renderPromo(file, width, height, iconSize, marquee) {
    await promo.send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: false
    });
    await evaluate(promo, `
      (() => {
        document.open();
        document.write(${JSON.stringify(promoHtml)});
        document.close();
        const img = document.getElementById('icon');
        img.src = 'data:image/png;base64,${iconData}';
        img.width = ${iconSize};
        img.height = ${iconSize};
        if (${marquee}) document.body.classList.add('marquee');
      })()
    `);
    await sleep(900);
    const shot = await promo.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log('wrote', path.relative(process.cwd(), file), `${width}x${height}`);
  }

  await renderPromo(path.join(OUT, 'promo', 'small-440x280.png'), 440, 280, 76, false);
  await renderPromo(path.join(OUT, 'promo', 'marquee-1400x560.png'), 1400, 560, 190, true);

  fs.rmSync(promoPath, { force: true });

  page.close();
  popup.close();
  worker.close();
  promo.close();
  compose.close();
}

main().catch((error) => {
  console.error('ERROR: ' + error.message);
  process.exit(1);
});
