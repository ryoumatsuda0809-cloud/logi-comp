// デモ画面から見本 PDF（public/samples/）を作る。Chrome を遠隔操作（CDP）して Page.printToPDF を呼ぶ。依存パッケージなし。
// 画面の内容を変えたら作り直す。macOS の Google Chrome が必要。
//   1) ダミーの環境変数でデモを起動（本番 DB には触れない）:
//      VITE_SUPABASE_URL=https://dummy.invalid VITE_SUPABASE_PUBLISHABLE_KEY=dummy npx vite --port 5199 --strictPort
//   2) node scripts/make-demo-pdfs.mjs http://localhost:5199 public/samples
// 作った PDF は目で確かめてからコミットする。
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.argv[2] ?? "http://localhost:5199";
const outDir = process.argv[3];
if (!outDir) throw new Error("outDir required");
mkdirSync(outDir, { recursive: true });

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;
const profile = join(tmpdir(), `demo-pdf-profile-${process.pid}`);
const chrome = spawn(
  CHROME,
  ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "--hide-scrollbars", "about:blank"],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = targets.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error("chrome did not start");
}

const ws = new WebSocket(await connect());
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
  }
};
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
};
const goto = async (path) => {
  await send("Page.navigate", { url: base + path });
  await sleep(2500);
};
const clickByText = (text) =>
  evaluate(`(() => {
    const el = [...document.querySelectorAll('button')].find(b => b.textContent.trim().includes(${JSON.stringify(text)}));
    if (!el) return false;
    el.click();
    return true;
  })()`);
const printPdf = async (name) => {
  const { data } = await send("Page.printToPDF", {
    paperWidth: 8.27,
    paperHeight: 11.69,
    marginTop: 0.4,
    marginBottom: 0.4,
    marginLeft: 0.4,
    marginRight: 0.4,
    printBackground: true,
    preferCSSPageSize: false,
  });
  writeFileSync(join(outDir, name), Buffer.from(data, "base64"));
  console.log("wrote", name);
};

try {
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 1400, deviceScaleFactor: 1, mobile: false });

  // 1) 報告書・警告レポート: 本物の印刷用 CSS（print:hidden など）をそのまま使う
  await send("Emulation.setEmulatedMedia", { media: "print" });
  await goto("/demo/report");
  await printPdf("demo-report.pdf");
  await goto("/demo/warning");
  await printPdf("demo-warning.pdf");

  // 2) 発注書: 例1を承認し、出てきた 4 条書面だけを印刷する
  await send("Emulation.setEmulatedMedia", { media: "screen" });
  await goto("/demo/orders");
  if (!(await clickByText("例1"))) throw new Error("example 1 button not found");
  await sleep(300);
  if (!(await clickByText("AI解析"))) throw new Error("parse button not found");
  await sleep(1500);
  if (!(await clickByText("承認・保存"))) throw new Error("approve button not found");
  await sleep(500);
  if (!(await clickByText("承認して確定する"))) throw new Error("confirm button not found");
  await sleep(1000);
  const ok = await evaluate(`(() => {
    const doc = document.querySelector('article[aria-label="4条書面（架空）"]');
    if (!doc) return false;
    const clone = doc.cloneNode(true);
    clone.style.border = 'none';
    clone.style.borderRadius = '0';
    clone.style.maxWidth = '720px';
    clone.style.margin = '0 auto';
    clone.style.background = '#fff';
    document.body.replaceChildren(clone);
    document.body.style.background = '#fff';
    document.documentElement.classList.remove('dark');
    return true;
  })()`);
  if (!ok) throw new Error("order document not found");
  await sleep(300);
  await send("Emulation.setEmulatedMedia", { media: "print" });
  await printPdf("demo-order.pdf");
} finally {
  ws.close();
  chrome.kill();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true });
}
