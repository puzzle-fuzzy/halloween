import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"

// A real Chromium renderer and real range requests; only credential/API IPC is mocked.
const root = path.resolve(import.meta.dir, "..")
const renderer = path.join(root, "packages/desktop/dist/renderer")
assert(await Bun.file(path.join(renderer, "index.html")).exists(), "Run bun run build first")
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "halloween-media-smoke-"))
const sampleRate = 8000
const samples = sampleRate * 9000
const wav = Buffer.alloc(44 + samples, 128)
wav.write("RIFF", 0)
wav.writeUInt32LE(36 + samples, 4)
wav.write("WAVEfmt ", 8)
wav.writeUInt32LE(16, 16)
wav.writeUInt16LE(1, 20)
wav.writeUInt16LE(1, 22)
wav.writeUInt32LE(sampleRate, 24)
wav.writeUInt32LE(sampleRate, 28)
wav.writeUInt16LE(1, 32)
wav.writeUInt16LE(8, 34)
wav.write("data", 36)
wav.writeUInt32LE(samples, 40)
const expired = new Set<string>()
let broken = false
let rejectedRequests = 0
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/fixture/expire") {
      expired.add(url.searchParams.get("v") ?? "")
      return Response.json({ ok: true })
    }
    if (url.pathname === "/fixture/broken") {
      broken = url.searchParams.get("value") === "true"
      return Response.json({ ok: true })
    }
    if (url.pathname === "/sample.wav") {
      if (broken || expired.has(url.searchParams.get("v") ?? "")) {
        rejectedRequests += 1
        return new Response("Preview unavailable", {
          status: 401,
          headers: { "Cache-Control": "no-store" },
        })
      }
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("range") ?? "")
      const start = range ? Number(range[1]) : 0
      const end = range?.[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1
      if (start > end) return new Response(null, { status: 416 })
      let offset = start
      let cancelled = false
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          await Bun.sleep(20)
          if (cancelled) return
          if (offset > end) {
            controller.close()
            return
          }
          const next = Math.min(offset + 16_384, end + 1)
          controller.enqueue(wav.subarray(offset, next))
          offset = next
        },
        cancel() {
          cancelled = true
        },
      })
      return new Response(stream, {
        status: range ? 206 : 200,
        headers: {
          "Content-Type": "audio/wav",
          "Content-Length": String(end - start + 1),
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "X-Content-Type-Options": "nosniff",
          ...(range ? { "Content-Range": `bytes ${start}-${end}/${wav.length}` } : {}),
        },
      })
    }
    const relative = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)
    const file = path.resolve(renderer, `.${relative}`)
    if (!file.startsWith(`${renderer}${path.sep}`)) return new Response(null, { status: 403 })
    const data = Bun.file(file)
    return (await data.exists()) ? new Response(data) : new Response(null, { status: 404 })
  },
})
const origin = `http://127.0.0.1:${server.port}`
try {
  const preload = path.join(temporary, "preload.cjs")
  await fs.writeFile(
    preload,
    `
const {contextBridge,ipcRenderer}=require('electron');
const invoke=(method,...args)=>ipcRenderer.invoke('fixture',method,...args);
contextBridge.exposeInMainWorld('electron',{
 platform:process.platform,
 window:{minimize(){},toggleMaximize(){},close(){},isMaximized:async()=>false,onMaximizeChange:()=>()=>{}},
 cloud:{isAuthed:async()=>true,profile:async()=>({profile:{name:'Media fixture',email:'',avatar:''}}),
  list:()=>invoke('entries'),search:()=>invoke('entries'),fileUrl:()=>invoke('url'),
  onAuthCode:()=>()=>{},onProgress:()=>()=>{},transfers:async()=>[]},
 oss:{accounts:async()=>({accounts:[{id:'fixture',name:'Fixture OSS',region:'fixture'}]}),
  buckets:async()=>({buckets:[{name:'fixture-bucket',createdAt:0}]}),
  objects:()=>invoke('ossEntries'),previewUrl:async()=>({url:await invoke('url')})}
});
`,
  )
  const entry = path.join(temporary, "media.cjs")
  await fs.writeFile(
    entry,
    `
const {app,BrowserWindow,ipcMain}=require('electron');
const assert=require('node:assert/strict');
const origin=${JSON.stringify(origin)};
let version=0;
app.setPath('userData',${JSON.stringify(path.join(temporary, "profile"))});
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
const item={name:'sample.wav',type:'file',size:${wav.length},mtime:Date.now(),path:'/sample.wav'};
ipcMain.handle('fixture',(_event,method)=>{
 if(method==='url') return origin+'/sample.wav?v='+(++version);
 if(method==='entries') return {entries:[item]};
 if(method==='ossEntries') return {entries:[{...item,key:'sample.wav'}],truncated:false};
 throw new Error('Unexpected fixture IPC: '+method);
});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const waitFor=async(win,expression,label)=>{
 for(let i=0;i<240;i++) {
  if(await win.webContents.executeJavaScript(expression)) return;
  await sleep(50);
 }
 const state=await win.webContents.executeJavaScript('JSON.stringify({text:document.body.innerText,audio:document.querySelector("audio")?{src:document.querySelector("audio").src,time:document.querySelector("audio").currentTime,paused:document.querySelector("audio").paused,ready:document.querySelector("audio").readyState,error:document.querySelector("audio").error?.message}:null})');
 throw new Error(label+' timed out: '+state);
};
const click=async(win,text)=>win.webContents.executeJavaScript('[...document.querySelectorAll("button")].find(button=>button.textContent.trim()==='+JSON.stringify(text)+').click()');
const open=async(win,route)=>{
 await win.webContents.executeJavaScript('document.querySelector('+JSON.stringify('a[href="'+route+'"]')+').click()');
 await waitFor(win,'document.querySelector("header h1")?.textContent==='+JSON.stringify(route === '/oss' ? 'OSS' : 'Cloud')+' && !![...document.querySelectorAll("table button")].find(button=>button.textContent.trim()==="sample.wav")','file table');
 await win.webContents.executeJavaScript('[...document.querySelectorAll("table button")].find(button=>button.textContent.trim()==="sample.wav").click()');
 await waitFor(win,'document.querySelector("audio")?.duration>8000','audio metadata');
};
const refreshAt=async(win,time,paused)=>{
 await win.webContents.executeJavaScript('(()=>{const a=document.querySelector("audio");a.pause();a.currentTime='+time+';})()');
 await waitFor(win,'Math.abs((document.querySelector("audio")?.currentTime??0)-'+time+')<1 && !document.querySelector("audio").seeking','initial seek');
 if(!paused) await win.webContents.executeJavaScript('document.querySelector("audio").play()');
 const before=version;
 await click(win,'Refresh preview');
 await waitFor(win,'(()=>{const a=document.querySelector("audio");return a&&a.src.endsWith("v='+String(before+1)+'")&&Math.abs(a.currentTime-'+time+')<2&&a.paused==='+paused+'&&!a.seeking;})()','refresh position and pause state');
 assert.equal(version,before+1,'one manual refresh gets one new URL');
};
app.whenReady().then(async()=>{
 const win=new BrowserWindow({show:false,webPreferences:{preload:${JSON.stringify(preload)},contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
 await win.loadURL(origin+'/');
 await open(win,'/cloud');
 await refreshAt(win,47.25,true);
 await refreshAt(win,91,false);
 const expiredVersion=version;
 await fetch(origin+'/fixture/expire?v='+expiredVersion);
 await win.webContents.executeJavaScript('(()=>{const now=Date.now;Date.now=()=>now()+300001;})()');
 await win.webContents.executeJavaScript('document.querySelector("audio").currentTime=8000');
 await waitFor(win,'(()=>{const a=document.querySelector("audio");return a&&a.src.endsWith("v='+String(expiredVersion+1)+'")&&Math.abs(a.currentTime-8000)<3&&!a.paused&&!a.seeking;})()','expired URL automatic recovery after real range request');
 assert.equal(version,expiredVersion+1,'expiry causes exactly one automatic URL refresh');
 console.log('PASS: Cloud manual refresh preserves paused/playing positions; expired URL seek recovers automatically');
 await win.webContents.executeJavaScript('document.querySelector("[data-slot=dialog-close]").click()');
 await waitFor(win,'!document.querySelector("audio")','preview closed');
 await open(win,'/oss');
 await refreshAt(win,18.5,true);
 console.log('PASS: OSS preview refresh preserves paused playback position');
 await win.webContents.executeJavaScript('document.querySelector("[data-slot=dialog-close]").click()');
 await waitFor(win,'!document.querySelector("audio")','OSS preview closed');
 await fetch(origin+'/fixture/broken?value=true');
 const beforeBroken=version;
 await win.webContents.executeJavaScript('[...document.querySelectorAll("table button")].find(button=>button.textContent.trim()==="sample.wav").click()');
 await waitFor(win,'document.body.innerText.includes("The preview could not be loaded")','broken media error');
 await sleep(1500);
 assert.equal(version,beforeBroken+2,'broken media gets an initial URL and only one automatic retry');
 await sleep(1500);
 assert.equal(version,beforeBroken+2,'broken media does not loop');
 await click(win,'Refresh preview');
 await sleep(1500);
 assert.equal(version,beforeBroken+3,'manual retry remains available without restarting automatic loop');
 console.log('PASS: broken media retries once, stops, and still permits a manual retry');
 win.destroy();app.quit();
}).catch(error=>{console.error(error);app.exit(1)});
process.on('unhandledRejection',error=>{console.error(error);app.exit(1)});
setTimeout(()=>{console.error('Media smoke timed out');app.exit(1)},60000);
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
  assert.equal(code, 0, "real Electron media smoke passes")
  assert(rejectedRequests > 0, "the fixture actually rejected expired or broken media requests")
} finally {
  server.stop(true)
  await fs.rm(temporary, { recursive: true, force: true })
}
