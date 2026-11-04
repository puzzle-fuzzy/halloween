import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { createApplication } from "../packages/server/src/index"

const root = path.resolve(import.meta.dir, "..")
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "halloween-admin-smoke-"))
const adminPassword = "isolated-smoke-password-123"
const application = await createApplication({
  dataRoot: path.join(temporary, "files"),
  stateRoot: path.join(temporary, "state"),
  token: "isolated-smoke-master-token-".repeat(2),
  adminPassword,
  quiet: true,
})
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    const response = await application.fetch(request)
    // Exercise a route change while a real mutation response is still in flight.
    if (new URL(request.url).pathname === "/admin/api/device/approve") await Bun.sleep(500)
    return response
  },
})
const origin = `http://127.0.0.1:${server.port}`
try {
  const response = await fetch(`${origin}/admin/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: adminPassword }),
  })
  if (!response.ok) throw new Error(`Fixture login failed: ${response.status}`)
  const [cookieName, cookieValue] = response.headers.get("set-cookie")!.split(";")[0]!.split("=")
  const entry = path.join(temporary, "admin.cjs")
  await fs.writeFile(
    entry,
    `
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const origin = ${JSON.stringify(origin)};
app.setPath('userData', ${JSON.stringify(path.join(temporary, "profile"))});
app.disableHardwareAcceleration();
const api = async (pathname, body) => {
  const response = await fetch(origin + pathname, {method: 'POST', headers: {'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert(response.ok, 'fixture API ' + pathname + ': ' + response.status);
  return response.json();
};
const waitFor = async (win, expression) => {
  for(let i=0;i<150;i++) {
    if(await win.webContents.executeJavaScript(expression)) return;
    await new Promise(resolve => setTimeout(resolve,100));
  }
  const text = await win.webContents.executeJavaScript("document.body.innerText.slice(0, 300)").catch(() => '(page gone)');
  throw new Error('UI condition timed out: ' + expression + ' | page: ' + text);
};
const check = async (decision) => {
  const name = decision === 'approve' ? 'Smoke desktop' : 'Denied desktop';
  const device = await api('/cloud/api/device/code', {name});
  const win = new BrowserWindow({show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
  // pin the language: locale detection renders 中文 on zh hosts and the EN-string
  // assertions fail — set storage then do a real reload so the provider re-inits
  await win.loadURL(origin + '/admin/#/device/' + device.user_code);
  await win.webContents.executeJavaScript("localStorage.setItem('halloween-admin:lang','en')");
  await win.webContents.reload();
  await new Promise(resolve => setTimeout(resolve, 300));
  await waitFor(win, 'document.body.innerText.includes("' + name + '") && document.body.innerText.includes("Approve device")');
  assert(await win.webContents.executeJavaScript('document.body.innerText.includes(' + JSON.stringify(device.user_code) + ')'), 'authorization code is visible');
  assert.equal((await api('/cloud/api/device/token',{device_code:device.device_code})).status, 'pending', 'opening the page must not approve');
  await win.webContents.executeJavaScript('[...document.querySelectorAll("button")].find(button => button.textContent === ' + JSON.stringify(decision === 'approve' ? 'Approve device' : 'Deny') + ').click()');
  await waitFor(win, 'document.body.innerText.includes(' + JSON.stringify(decision === 'approve' ? 'Approved — return' : 'Access denied') + ')');
  if(decision === 'approve') {
    const token = await api('/cloud/api/device/token',{device_code:device.device_code});
    assert.equal(token.status,'approved'); assert(token.token);
  } else {
    const response = await fetch(origin+'/cloud/api/device/token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({device_code:device.device_code})});
    assert.equal(response.status,403);
  }
  win.destroy();
};
const checkStaleApproval = async () => {
  const a = await api('/cloud/api/device/code',{name:'Device A'});
  const b = await api('/cloud/api/device/code',{name:'Device B'});
  const win = new BrowserWindow({show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
  await win.loadURL(origin+'/admin/#/device/'+a.user_code);
  await waitFor(win,'document.body.innerText.includes("Device A") && document.body.innerText.includes("Approve device")');
  await win.webContents.executeJavaScript('[...document.querySelectorAll("button")].find(button=>button.textContent === "Approve device").click()');
  // Wait until A has actually been approved, before the delayed response reaches the UI.
  for(let i=0;i<50;i++) {
    const result = await api('/cloud/api/device/token',{device_code:a.device_code});
    if(result.status === 'approved') break;
    if(i===49) throw new Error('A was never approved');
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  await win.webContents.executeJavaScript('window.location.hash = '+JSON.stringify('#/device/'+b.user_code));
  await waitFor(win,'document.body.innerText.includes("Device B") && document.body.innerText.includes("Approve device")');
  await new Promise(resolve=>setTimeout(resolve,750));
  assert(await win.webContents.executeJavaScript('document.body.innerText.includes("Device B") && document.body.innerText.includes("Approve device")'),'old approval must not replace the current request');
  assert.equal((await api('/cloud/api/device/token',{device_code:b.device_code})).status,'pending');
  win.destroy();
};
process.on('unhandledRejection',error=>{console.error(error);app.exit(1)});
process.on('uncaughtException',error=>{console.error(error);app.exit(1)});
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
  await session.defaultSession.cookies.set({url:origin,name:${JSON.stringify(cookieName)},value:${JSON.stringify(cookieValue)},httpOnly:true,sameSite:'lax'});
  await check('approve');
  await check('deny');
  await checkStaleApproval();
  console.log('PASS: real admin UI displays device/code, waits for explicit consent, denies access, and ignores stale approval responses');
  app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});
setTimeout(()=>{console.error('Admin smoke timed out');app.exit(1)},45000);
`,
  )
  const require = createRequire(path.join(root, "packages/desktop/package.json"))
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  const result = await new Promise<number>((resolve, reject) => {
    const child = spawn(require("electron"), [entry], {
      cwd: root,
      env: environment,
      stdio: "inherit",
    })
    child.once("error", reject)
    child.once("exit", (code) => resolve(code ?? 1))
  })
  if (result !== 0) throw new Error(`Admin UI smoke exited ${result}`)
} finally {
  server.stop(true)
  await fs.rm(temporary, { recursive: true, force: true })
}
