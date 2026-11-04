import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { createApplication } from "../packages/server/src/index"

const root = path.resolve(import.meta.dir, "..")
const renderer = path.join(root, "packages/desktop/dist/renderer")
assert(
  await Bun.file(path.join(renderer, "index.html")).exists(),
  "Run bun run build before the recovery smoke",
)
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "halloween-recovery-smoke-"))
const token = "isolated-recovery-fixture-token-".repeat(2)
const binary = process.env.BACKUP_TEST_RESTIC_BINARY
const servers: ReturnType<typeof Bun.serve>[] = []
const fixtures: { origin: string; dataRoot: string; stateRoot: string; configured: boolean }[] = []

async function fixture(name: string, configured: boolean) {
  const folder = path.join(temporary, name)
  const dataRoot = path.join(folder, "files"),
    stateRoot = path.join(folder, "state")
  let repository: string | undefined, passwordFile: string | undefined
  if (configured) {
    assert(binary && path.isAbsolute(binary), "BACKUP_TEST_RESTIC_BINARY must be an absolute path")
    repository = path.join(folder, "repository")
    passwordFile = path.join(folder, "repository-password")
    await fs.mkdir(folder, { recursive: true })
    await fs.writeFile(passwordFile, "isolated-recovery-repository-password", { mode: 0o600 })
    const init = Bun.spawn([binary, "init"], {
      cwd: folder,
      env: {
        PATH: process.env.PATH,
        HOME: folder,
        RESTIC_REPOSITORY: repository,
        RESTIC_PASSWORD_FILE: passwordFile,
        RESTIC_CACHE_DIR: path.join(folder, "init-cache"),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, error] = await Promise.all([init.exited, new Response(init.stderr).text()])
    assert.equal(code, 0, `Temporary encrypted repository initialization failed: ${error}`)
  }
  const application = await createApplication({
    dataRoot,
    stateRoot,
    token,
    adminPassword: "isolated-admin-password-123",
    quiet: true,
    backupConfig: {
      binary: binary || path.join(temporary, "restic-not-installed"),
      repository,
      passwordFile,
    },
  })
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname.startsWith("/renderer/")) {
        const relative = decodeURIComponent(url.pathname.slice("/renderer/".length)) || "index.html"
        const filename = path.resolve(renderer, relative)
        if (!filename.startsWith(`${renderer}${path.sep}`))
          return new Response(null, { status: 403 })
        const data = Bun.file(filename)
        return (await data.exists()) ? new Response(data) : new Response(null, { status: 404 })
      }
      return application.fetch(request)
    },
  })
  servers.push(server)
  const origin = `http://127.0.0.1:${server.port}`
  const api = async (pathname: string, body?: unknown) => {
    const response = await fetch(`${origin}/cloud/api${pathname}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    assert(response.ok, `Fixture API ${pathname} returned HTTP ${response.status}`)
    return response.json()
  }
  if (!configured) {
    await fs.writeFile(path.join(dataRoot, "same.txt"), "original archived version")
    await api("/delete", { paths: ["/same.txt"] })
    await fs.writeFile(path.join(dataRoot, "same.txt"), "new live version")
    for (const filename of ["delete-me.txt", "empty-me.txt"]) {
      await fs.writeFile(path.join(dataRoot, filename), filename)
      await api("/delete", { paths: [`/${filename}`] })
    }
    await fs.mkdir(path.join(stateRoot, "trash", "damaged-fixture"))
    await fs.writeFile(
      path.join(stateRoot, "trash", "damaged-fixture", "manifest.json"),
      "{invalid json",
    )
  } else {
    await fs.writeFile(path.join(dataRoot, "backup.txt"), "back up and verify this exact content")
  }
  const result = { origin, dataRoot, stateRoot, configured }
  fixtures.push(result)
  return result
}

try {
  await fixture("unconfigured", false)
  if (binary) await fixture("configured", true)
  const preload = path.join(temporary, "preload.cjs")
  await fs.writeFile(
    preload,
    `
const {contextBridge,ipcRenderer}=require('electron');
const api=async(method,path,body)=>{const response=await ipcRenderer.invoke('fixture-api',method,path,body);if(!response.ok) throw new Error(response.error);return response.result;};
contextBridge.exposeInMainWorld('electron',{
 platform:process.platform,
 window:{minimize(){},toggleMaximize(){},close(){},isMaximized:async()=>false,onMaximizeChange:()=>()=>{}},
 cloud:{isAuthed:async()=>true,profile:()=>api('GET','/cloud/api/profile'),
 list:dir=>api('GET','/cloud/api/files?path='+encodeURIComponent(dir)),
 listTrash:()=>api('GET','/cloud/api/trash'),
 restoreTrash:(id,destination)=>api('POST','/cloud/api/trash/restore',{id,destination}),
 purgeTrash:input=>api('POST','/cloud/api/trash/purge',input),
 backupStatus:()=>api('GET','/cloud/api/backups/status'),
 startBackupJob:input=>api('POST','/cloud/api/backups/jobs',input),
 backupJob:id=>api('GET','/cloud/api/backups/jobs/'+encodeURIComponent(id)),
 onAuthCode:()=>()=>{},onProgress:()=>()=>{},transfers:async()=>[]},
 oss:{accounts:()=>api('GET','/oss/api/accounts')}
});
`,
  )
  const entry = path.join(temporary, "recovery.cjs")
  await fs.writeFile(
    entry,
    `
const {app,BrowserWindow,ipcMain}=require('electron');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const fixtures=${JSON.stringify(fixtures)};
const token=${JSON.stringify(token)};
let current=fixtures[0];
app.setPath('userData',${JSON.stringify(path.join(temporary, "profile"))});
app.disableHardwareAcceleration();
app.on('window-all-closed',()=>{});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const api=async(method,pathname,body)=>{
 const response=await fetch(current.origin+pathname,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const result=await response.json();
 if(!response.ok) throw new Error('HTTP '+response.status+': '+result.error);
 return result;
};
ipcMain.handle('fixture-api',async(_event,method,pathname,body)=>{try{return {ok:true,result:await api(method,pathname,body)}}catch(error){return {ok:false,error:String(error)}}});
const evaluate=async(win,expression)=>{try{return await win.webContents.executeJavaScript(expression)}catch(error){throw new Error('Renderer expression failed: '+expression,{cause:error})}};
const waitFor=async(win,expression,label,timeout=20000)=>{
 for(let i=0;i<timeout/50;i++) {
  if(await evaluate(win,expression)) return;
  await sleep(50);
 }
 throw new Error(label+' timed out: '+await evaluate(win,'document.body.innerText'));
};
const buttonExpression=text=>'[...document.querySelectorAll("button")].find(button=>button.textContent.trim()==='+JSON.stringify(text)+')';
const click=async(win,text)=>evaluate(win,buttonExpression(text)+'.click()');
const input=async(win,id,value)=>{
 await evaluate(win,'(()=>{const element=document.getElementById('+JSON.stringify(id)+');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(element,'+JSON.stringify(value)+');element.dispatchEvent(new Event("input",{bubbles:true}));})()');
};
const open=async(win,route,title)=>{
 await evaluate(win,'document.querySelector('+JSON.stringify('a[href="'+route+'"]')+').click()');
 await waitFor(win,'document.querySelector("header h1")?.textContent==='+JSON.stringify(title),'route '+route);
};
const rowButton=async(win,originalPath,label)=>{
 const expression='(()=>{const row=[...document.querySelectorAll("tbody tr")].find(row=>row.innerText.includes('+JSON.stringify(originalPath)+'));return row&&[...row.querySelectorAll("button")].find(button=>button.textContent.trim()==='+JSON.stringify(label)+');})()';
 await waitFor(win,'!!'+expression,'trash row '+originalPath);
 await evaluate(win,expression+'.click()');
};
const confirmDisabled=async(win)=>assert(await evaluate(win,buttonExpression('Delete permanently')+'.disabled'),'permanent deletion requires the exact phrase');
const confirm=async(win,phrase)=>{
 await input(win,'purge-confirmation',phrase);
 await waitFor(win,'!'+buttonExpression('Delete permanently')+'.disabled','confirmation accepted');
 await click(win,'Delete permanently');
 await waitFor(win,'!document.querySelector("[role=dialog]")','confirmation closes after deletion');
};
const checkTrash=async(win)=>{
 await open(win,'/trash','Trash');
 await waitFor(win,'document.body.innerText.includes("Damaged") && document.body.innerText.includes("/same.txt")','trash listing and damaged item');
 await rowButton(win,'/same.txt','Restore');
 await waitFor(win,'!!document.getElementById("restore-destination")','conflicting restore offers a new path');
 assert.equal(await fs.readFile(path.join(current.dataRoot,'same.txt'),'utf8'),'new live version','conflict must preserve the live version');
 await input(win,'restore-destination','/same-restored.txt');
 await click(win,'Restore to this path');
 await waitFor(win,'!document.getElementById("restore-destination")','restore conflict resolved');
 assert.equal(await fs.readFile(path.join(current.dataRoot,'same.txt'),'utf8'),'new live version');
 assert.equal(await fs.readFile(path.join(current.dataRoot,'same-restored.txt'),'utf8'),'original archived version');
 const before=await api('GET','/cloud/api/trash');
 const removed=before.entries.find(entry=>entry.originalPath==='/delete-me.txt').id;
 await rowButton(win,'/delete-me.txt','Delete forever');
 await waitFor(win,'!!document.getElementById("purge-confirmation")','delete confirmation');
 await confirmDisabled(win);
 await input(win,'purge-confirmation','delete');
 await confirmDisabled(win);
 assert((await api('GET','/cloud/api/trash')).entries.some(entry=>entry.id===removed),'wrong phrase must not remove the item');
 await confirm(win,'DELETE');
 assert(!(await api('GET','/cloud/api/trash')).entries.some(entry=>entry.id===removed),'confirmed item is removed');
 await waitFor(win,'!'+buttonExpression('Empty trash')+'.disabled','trash refresh after single deletion');
 await click(win,'Empty trash');
 await waitFor(win,'!!document.getElementById("purge-confirmation")','empty-trash confirmation');
 await input(win,'purge-confirmation','DELETE');
 await confirmDisabled(win);
 await confirm(win,'EMPTY_TRASH');
 assert.equal((await api('GET','/cloud/api/trash')).entries.length,0,'empty trash includes the damaged item');
 assert.equal(await fs.readFile(path.join(current.dataRoot,'same.txt'),'utf8'),'new live version');
 assert.equal(await fs.readFile(path.join(current.dataRoot,'same-restored.txt'),'utf8'),'original archived version');
 console.log('PASS: real Trash UI lists damaged items, preserves both conflicting versions, and requires DELETE / EMPTY_TRASH');
};
const checkUnconfigured=async(win)=>{
 await open(win,'/backups','Backups');
 await waitFor(win,'document.body.innerText.includes("Not configured")','unconfigured backup state');
 for(const label of ['Create backup now','Check repository integrity','Refresh snapshots','Verify restore']) assert(await evaluate(win,buttonExpression(label)+'.disabled'),label+' disabled until configured');
 assert(await evaluate(win,'document.body.innerText.includes("Configure a dedicated backup repository")'),'server configuration guidance is visible');
 console.log('PASS: unconfigured backup UI reports its state and disables backup operations');
};
const runJob=async(win,kind,label)=>{
 const previous=new Set((await api('GET','/cloud/api/backups/status')).jobs.map(job=>job.id));
 await waitFor(win,'!'+buttonExpression(label)+'.disabled',label+' available');
 await click(win,label);
 let result;
 for(let i=0;i<1200;i++) {
  const status=await api('GET','/cloud/api/backups/status');
  result=status.jobs.find(job=>job.kind===kind&&!previous.has(job.id));
  if(result&&result.status!=='running') break;
  await sleep(50);
 }
 assert(result,'UI started a real '+kind+' job');
 assert.equal(result.status,'succeeded',kind+': '+(result.error||result.phase));
 await waitFor(win,'!'+buttonExpression(label)+'.disabled','UI sees completed '+kind,30000);
 return result;
};
const checkConfigured=async(win)=>{
 await open(win,'/backups','Backups');
 await waitFor(win,'document.body.innerText.includes("Available")','configured restic state');
 const backup=await runJob(win,'backup','Create backup now');
 assert(/^[a-f0-9]{64}$/.test(backup.snapshotId),'a real repository snapshot was created');
 await runJob(win,'check','Check repository integrity');
 const verified=await runJob(win,'verify','Verify restore');
 assert(/^[a-f0-9]{64}$/.test(verified.result.manifestSha256),'restored contents passed their manifest comparison');
 assert(verified.result.files>0,'verification covered real files');
 assert.equal(await fs.readFile(path.join(current.dataRoot,'backup.txt'),'utf8'),'back up and verify this exact content','verification preserved the live file');
 const verificationRoot=path.join(current.stateRoot,'backups','restores',verified.id);
 assert(await fs.stat(path.join(verificationRoot,'verification.json')),'verification receipt is persisted');
 await assert.rejects(fs.stat(path.join(verificationRoot,'content')),error=>error.code==='ENOENT','temporary restored payload was cleaned up');
 const status=await api('GET','/cloud/api/backups/status');
 assert.equal(status.lastSuccessfulBackup.id,backup.id);
 assert.equal(status.lastCheck.status,'succeeded');
 assert.equal(status.lastVerification.id,verified.id);
 console.log('PASS: real Backups UI creates an encrypted restic snapshot, checks all data, and verifies an isolated restore');
};
const createWindow=async()=>{
 const win=new BrowserWindow({show:false,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
 await win.loadURL(current.origin+'/renderer/');
 // pin the language: locale detection renders 中文 on zh hosts and breaks the EN assertions
 await win.webContents.executeJavaScript("localStorage.setItem('halloween:lang','en')");
 await win.loadURL(current.origin+'/renderer/');
 await waitFor(win,'[...document.querySelectorAll("a")].some(link=>link.getAttribute("href")==="/trash")','renderer ready');
 return win;
};
app.whenReady().then(async()=>{
 let win=await createWindow();
 await checkTrash(win);
 await checkUnconfigured(win);
 win.destroy();
 if(fixtures[1]) { current=fixtures[1];win=await createWindow();await checkConfigured(win);win.destroy(); }
 else console.log('SKIP: set BACKUP_TEST_RESTIC_BINARY to run the real restic UI workflow');
 app.quit();
}).catch(error=>{console.error(error);app.exit(1)});
process.on('unhandledRejection',error=>{console.error(error);app.exit(1)});
setTimeout(()=>{console.error('Recovery smoke timed out');app.exit(1)},180000);
`,
  )
  const require = createRequire(path.join(root, "packages/desktop/package.json"))
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(require("electron"), [entry], {
      cwd: root,
      env: environment,
      stdio: "inherit",
    })
    child.once("error", reject)
    child.once("exit", (result) => resolve(result ?? 1))
  })
  assert.equal(code, 0, "real Electron recovery smoke passes")
} finally {
  for (const server of servers) server.stop(true)
  await fs.rm(temporary, { recursive: true, force: true })
}
