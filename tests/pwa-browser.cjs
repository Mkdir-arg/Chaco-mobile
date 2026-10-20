// Real Chromium + Expo SQLite/OPFS + service worker. No production test hooks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const entry = path.join(root, 'index.js');
const original = fs.readFileSync(entry, 'utf8');
const env = {...process.env, EXPO_PUBLIC_DJANGO_API_URL: 'https://pwa-api.test', PWA_DIST: 'dist-browser', PORT: '4174'};
const run = (cmd, args) => execFileSync(cmd, args, {cwd: root, env, stdio:'inherit'});
let server, context;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'chaco-pwa-browser-'));
(async () => {
  const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
  try {
    fs.writeFileSync(entry, original + `\nimport service from './src/services/relevamientoService';\nimport * as api from './src/services/becasApi';\nimport { API_CONFIG } from './src/config/apiConfig';\nwindow.__pwaTest = {service, api, config: API_CONFIG};\n`);
    try {
      run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['expo','export','--clear','--platform','web','--output-dir','dist-browser']);
      // Runtime setting intentionally differs from the Expo build-time URL.
      fs.writeFileSync(path.join(root,'dist-browser/runtime-config.js'),
        'window.__DATANACH_CONFIG__ = {"URL_backoffice":"https://pwa-runtime.test"};');
      run(process.execPath, ['scripts/build-pwa.cjs']);
    } finally { fs.writeFileSync(entry, original); }
    server = spawn(process.execPath, ['scripts/serve-pwa.cjs'], {cwd:root, env, stdio:'inherit'});
    for (let n=0;n<50;n++) {
      try {if ((await fetch('http://localhost:4174')).ok) break;} catch {}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    const campaign = {id:1,nombre:'Prueba PWA',estado:'EN_CURSO',fecha_asignada:'2020-01-01T00:00:00-03:00',
      fecha_hasta:'2099-12-31T23:59:59-03:00',definicion_formulario:{version:3,globales:[],requisitos:[]}};
    let posts=0, uploads=0, rejectUpload=true;
    const launch = async () => {
      const ctx = await chromium.launchPersistentContext(profile, {headless:true,
        ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {})});
      await ctx.route('https://pwa-runtime.test/**', async route => {
        const req = route.request(); const url = req.url();
        let status=200, body=[];
        if (url.endsWith('/auth/token/')) body={token:'test-token',user_id:7,username:'territorial'};
        else if (req.method()==='POST' && url.endsWith('/adjuntos/')) {
          uploads++;
          assert.match(req.headers()['content-type'], /multipart\/form-data; boundary=/);
          assert.ok(req.postDataBuffer().includes(Buffer.from('offline-bytes')));
          status = rejectUpload ? 401 : 201; body = rejectUpload ? {detail:'Invalid token.'} : {id:55};
        } else if(req.method()==='POST' && url.endsWith('/formularios/')) {posts++;status=201;body={id:99};}
        else if(url.endsWith('/relevamientos/')) body=[campaign];
        else if(url.endsWith('/relevamientos/1/')) body=campaign;
        await route.fulfill({status,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'http://localhost:4174','Access-Control-Allow-Credentials':'true','Access-Control-Allow-Headers':'authorization,content-type','Access-Control-Allow-Methods':'GET,POST,OPTIONS'},body:JSON.stringify(body)});
      });
      return ctx;
    };
    context=await launch(); let page=context.pages()[0];
    // Device-specific login instructions and installed-window detection.
    for (const [device, installed] of [['android',false],['ios',false],['ipad',false],['android',true],['ios',true]]) {
      const mobile = await context.browser().newContext({viewport:{width:390,height:844},
        userAgent:device === 'android' ? 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36'
          : device === 'ipad' ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15'
          : 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1'});
      try {
        await mobile.addInitScript(({device,installed}) => {
          if(device === 'ipad') {
            Object.defineProperty(navigator,'platform',{value:'MacIntel'});
            Object.defineProperty(navigator,'maxTouchPoints',{value:5});
          }
          if(installed && device === 'ios') Object.defineProperty(navigator,'standalone',{value:true});
          if(installed && device === 'android') {
            const original=window.matchMedia.bind(window);
            window.matchMedia=query=>{
              const media=original(query);
              if(query === '(display-mode: standalone)') Object.defineProperty(media,'matches',{value:true});
              return media;
            };
          }
        },{device,installed});
        const login=await mobile.newPage();await login.goto('http://localhost:4174');
        await login.getByText('Iniciá sesión para continuar').waitFor();
        if(installed) {
          assert.equal(await login.getByText('Cómo instalar la app',{exact:true}).count(),0);
          assert.equal(await login.getByText('Instalá DATAÑACH',{exact:true}).count(),0);
        } else {
          await login.getByText('Instalá DATAÑACH',{exact:true}).waitFor();
          await login.getByText(device === 'android' ? 'Abrí esta página en Chrome.' : 'Abrí esta página en Safari.',{exact:false}).waitFor();
          await login.getByRole('button',{name:'Continuar al login',exact:true}).click();
          await login.getByText('Instalá DATAÑACH',{exact:true}).waitFor({state:'hidden'});
          await login.getByRole('button',{name:'Cómo instalar la app',exact:true}).click();
          await login.getByText('Instalá DATAÑACH',{exact:true}).waitFor();
          await login.evaluate(()=>window.dispatchEvent(new Event('appinstalled')));
          await login.getByText('Instalá DATAÑACH',{exact:true}).waitFor({state:'hidden'});
          assert.equal(await login.getByText('Cómo instalar la app',{exact:true}).count(),0);
        }
      } finally {await mobile.close();}
    }
    console.log('PASS: Android/iPhone/iPad installation guide, dismiss/reopen, standalone and appinstalled.');
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    page.on('requestfailed', req => console.log('Request failed:',req.url(),req.failure()));
    await page.goto('http://localhost:4174');
    await page.waitForFunction(()=>window.__pwaTest);
    await page.evaluate(async()=>{
      await navigator.serviceWorker.ready;
      if(window.__pwaTest.config.djangoBaseUrl !== 'https://pwa-runtime.test') throw new Error('Runtime URL was ignored');
      await window.__pwaTest.api.loginBecas({username:'test',password:'test'});
      await window.__pwaTest.service.getRelevamientos({refreshFromRemote:true});
    });
    await context.setOffline(true);
    const saved = await page.evaluate(async()=>{
      const uri=URL.createObjectURL(new Blob(['offline-bytes'],{type:'image/jpeg'}));
      const saved=await window.__pwaTest.service.saveBecasFormulario({relevamiento_id:1,version_capturada:3,
        datos_identificacion:{dni:'12345678'},data:{globales:{1:{uri,fileName:'dni.jpg',size:13}},requisitos:{}},
        campos_definicion:[{id:1,scope:'globales',tipo:'ARCHIVO'}]});
      URL.revokeObjectURL(uri);
      return {id:saved.record.local_id,pending:await window.__pwaTest.service.getPendingCount()};
    });
    assert.equal(saved.pending,1);
    await page.reload(); await page.waitForFunction(()=>window.__pwaTest);
    assert.equal(await page.evaluate(()=>window.__pwaTest.service.getPendingCount()),1);
    assert.equal(await page.evaluate(()=>crossOriginIsolated),true);
    assert.equal(await page.evaluate(()=>window.__pwaTest.config.djangoBaseUrl),'https://pwa-runtime.test');
    await page.getByText('Iniciá sesión para continuar').waitFor({state:'hidden'});
    const exported=await page.evaluate(async id=>{
      const rows=await window.__pwaTest.service.getBecasFormularios(1,{refreshFromRemote:false});
      return rows.records.find(row=>row.local_id===id);
    },saved.id);
    assert.ok(exported,'Capture survives offline reload');
    await context.close(); context=await launch(); page=context.pages()[0];
    await context.setOffline(true); await page.goto('http://localhost:4174');
    await page.waitForFunction(()=>window.__pwaTest);
    assert.equal(await page.evaluate(()=>window.__pwaTest.service.getPendingCount()),1);
    await context.setOffline(false);
    await page.evaluate(()=>window.__pwaTest.service.syncPendingOperations());
    assert.equal(await page.evaluate(()=>window.__pwaTest.api.getBecasToken()),null,'401 invalidates session');
    rejectUpload=false;
    await page.evaluate(async()=>{
      await window.__pwaTest.api.loginBecas({username:'test',password:'test'});
      if (await window.__pwaTest.service.getPendingCount() !== 1) throw new Error('401 lost pending upload');
      await window.__pwaTest.service.syncPendingOperations();
    });
    assert.equal(await page.evaluate(()=>window.__pwaTest.service.getPendingCount()),0);
    assert.equal(posts,1,'Accepted capture is not recreated after attachment 401');
    assert.equal(uploads,2);
    assert.deepEqual(errors,[]);
    console.log('PASS: offline capture + attachment, reload, browser restart, multipart, 401 recovery, no duplicate capture.');
  } finally {
    fs.writeFileSync(entry,original);
    await context?.close(); server?.kill(); fs.rmSync(profile,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
