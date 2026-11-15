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
    fs.writeFileSync(entry, original + `\nimport service from './src/services/relevamientoService';\nimport * as api from './src/services/becasApi';\nimport * as emergencia from './src/services/emergenciaCola';\nimport { API_CONFIG } from './src/config/apiConfig';\nimport NetInfo from '@react-native-community/netinfo';\nwindow.__pwaTest = {service, api, emergencia, netinfo: NetInfo, config: API_CONFIG};\n`);
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
    let posts=0, uploads=0, rejectUpload=true, casos=0, localidades=0;
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
        else if(req.method()==='POST' && url.endsWith('/api/emergencia/casos/')) {
          casos++;
          assert.match(req.headers()['content-type'], /multipart\/form-data; boundary=/);
          const datos=req.postDataBuffer();
          for (const parte of ['name="uuid_cliente"','name="relevado_en"','name="traslado"','name="foto_vivienda"; filename="vivienda.jpg"','emergencia-bytes'])
            assert.ok(datos.includes(Buffer.from(parte)), parte);
          status=casos===1?201:200; body={id:184,numero:'2026-000184',prioridad:'MEDIA',total_declarado:1};
        }
        else if(url.endsWith('/api/emergencia/localidades/')) {localidades++;body=[{id:12,nombre:'Barranqueras'}];}
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
    // Emergencia M1: localidades guardadas y una familia relevada sin señal, que sobrevive a
    // recargar y se envía una sola vez al volver la red.
    await page.evaluate(()=>window.__pwaTest.emergencia.getLocalidadesGuardadas());
    assert.equal(localidades,1);
    await context.setOffline(true);
    const uuidM1=await page.evaluate(async()=>{
      const cola=window.__pwaTest.emergencia;
      const borrador=await cola.abrirBorrador();
      await cola.guardarBorrador(borrador.uuid_cliente,{...borrador.datos,traslado:'BOMBEROS',dni:'30111222',
        nombre:'Rosa',apellido:'Benitez',adultos_f:1,direccion:'Av. 9 de Julio 1200',localidad:12});
      await cola.ponerFoto(borrador.uuid_cliente,'foto_vivienda',{uri:'data:image/jpeg;base64,'+btoa('emergencia-bytes'),
        fileName:'vivienda.jpg',mimeType:'image/jpeg',size:16});
      const res=await cola.encolarCaso(borrador.uuid_cliente,{},{sincronizar:false});
      if(res.envio.estado!=='pendiente') throw new Error('M1 no quedó pendiente: '+res.envio.estado);
      return borrador.uuid_cliente;
    });
    await page.reload(); await page.waitForFunction(()=>window.__pwaTest);
    const offlineM1=await page.evaluate(async()=>({pending:await window.__pwaTest.emergencia.getPendingCount(),
      localidades:(await window.__pwaTest.emergencia.getLocalidadesGuardadas()).localidades.length,
      sync:await window.__pwaTest.emergencia.syncPendientes()}));
    assert.equal(offlineM1.pending,1,'M1 sobrevive a recargar sin red');
    assert.equal(offlineM1.localidades,1,'localidades sin red');
    assert.equal(offlineM1.sync.offline,true);
    assert.equal(casos,0);
    // NetInfo web prueba la red con un HEAD a `/` y guarda el resultado: la prueba hecha sin señal
    // dice «sin internet» hasta la próxima (5 s o más). En el CI esa ventana dejaba la cola sin salir
    // (0 envíos). Acá esa prueba falla siempre, para que el escenario no dependa del momento: la
    // cola tiene que mirar la red del navegador, no ese estado guardado.
    const sondeoNetInfo=route=>route.request().method()==='HEAD'?route.abort():route.fallback();
    await context.route('http://localhost:4174/',sondeoNetInfo);
    await context.setOffline(false);
    // Volver la red no es instantáneo para el navegador: se espera a que la app la vea antes de
    // sincronizar, y después se repite la sincronización para comprobar que no se reenvía.
    await page.waitForFunction(()=>navigator.onLine===true);
    const onlineM1=await page.evaluate(async uuid=>{
      const cola=window.__pwaTest.emergencia;
      let synced=0;
      const ni=await window.__pwaTest.netinfo.fetch();
      const pasadas=[{netinfo:{isConnected:ni.isConnected,isInternetReachable:ni.isInternetReachable,type:ni.type},hasConnection:!!navigator.connection}];
      for(let intento=0;intento<10&&await cola.getPendingCount()>0;intento+=1){
        const t0=Date.now();
        const sync=await cola.syncPendientes();
        const e=await cola.getEnvio(uuid);
        pasadas.push({ms:Date.now()-t0,sync,onLine:navigator.onLine,
          fila:e&&{status:e.status,retry_count:e.retry_count,next_retry_at:e.next_retry_at,code:e.code,detail:e.detail}});
        synced+=sync.synced||0;
        if(sync.offline) await new Promise(resolve=>setTimeout(resolve,200));
      }
      const otra=await cola.syncPendientes();
      return {synced,otra,pasadas,pending:await cola.getPendingCount(),envio:await cola.getEnvio(uuid)};
    },uuidM1);
    assert.equal(onlineM1.synced,1,'se envía una vez al volver la red: '+JSON.stringify({pasadas:onlineM1.pasadas,casos}));
    assert.equal(onlineM1.otra.synced,0,'una segunda sincronización no reenvía');
    assert.equal(onlineM1.pending,0);
    assert.equal(onlineM1.envio.estado,'enviado');
    assert.equal(onlineM1.envio.resultado.numero,'2026-000184');
    assert.equal(casos,1,'M1 se envía una sola vez');
    await context.unroute('http://localhost:4174/',sondeoNetInfo);
    assert.deepEqual(errors,[]);
    console.log('PASS: Emergencia M1 offline -> reload -> online, multipart with photo, single send, cached localidades.');
  } finally {
    fs.writeFileSync(entry,original);
    await context?.close(); server?.kill(); fs.rmSync(profile,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
