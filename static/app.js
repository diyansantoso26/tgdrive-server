/* TG Drive frontend */
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function fmtSize(b){if(b==null)return'';b=+b;if(b<1024)return b+' B';const u=['KB','MB','GB'];let i=-1;do{b/=1024;i++}while(b>=1024&&i<2);return b.toFixed(1)+' '+u[i]}
async function api(url,opts){const r=await fetch(url,opts);const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||('HTTP '+r.status));return j}
// pindah domain/direct pakai token handoff (tanpa login ulang) — global utk semua halaman
async function handoffGo(base){
  try{
    const r=await api('/api/handoff-token',{method:'POST'});
    if(r&&r.token){
      const dest=location.pathname+location.search;
      location.href=base+'/auth/handoff?token='+encodeURIComponent(r.token)+'&next='+encodeURIComponent(dest);
      return;
    }
  }catch(e){}
  location.href=base+location.pathname+location.search; // fallback: navigasi biasa
}
function fmtDate(iso){if(!iso)return'';const d=new Date(iso);return d.toLocaleDateString('id-ID',{day:'numeric',month:'short',year:'numeric'})}
function fmtDay(iso){const d=new Date(iso),t=new Date();const day=x=>x.toDateString();if(day(d)===day(t))return'Hari Ini';const y=new Date(t);y.setDate(y.getDate()-1);if(day(d)===day(y))return'Kemarin';return d.toLocaleDateString('id-ID',{weekday:'long',day:'numeric',month:'long',year:'numeric'})}

/* ---------- storage info & batas upload ---------- */
let MAX_UPLOAD=20*1024*1024; // batas upload aktual, diambil dari server
const CF_LIMIT=100*1024*1024; // batas Cloudflare per request (hanya via domain)
// ON_DIRECT diset server via base.html (akurat: bandingkan host dgn direct_url admin)
if(typeof ON_DIRECT==='undefined'){var ON_DIRECT=/^\d{1,3}(\.\d{1,3}){3}$/.test(location.hostname)}
// LIM: batas per user dari server (dipakai routing upload)
let LIM={maxUpload:20*1024*1024,cfLimit:100*1024*1024,resumeThreshold:10*1024*1024,isPro:false,directUrl:'',chunked:true};
(async()=>{try{const s=await api('/api/storage');if(s.max_upload_bytes)MAX_UPLOAD=s.max_upload_bytes}catch(e){}})();
(async()=>{try{const l=await api('/api/upload-limits');
  LIM={maxUpload:l.max_upload_bytes,cfLimit:l.cf_limit_bytes,resumeThreshold:l.resume_threshold_bytes,isPro:!!l.is_pro,directUrl:l.direct_url||'',chunked:l.chunked!==false};
  MAX_UPLOAD=l.max_upload_bytes;
}catch(e){}})();

/* ---------- lightbox ---------- */
let lbItems=[],lbIdx=0,lbSrc='';
async function dlHref(it){
  // file >100MB: via jalur langsung (hindari timeout Cloudflare), pakai token
  if((it.size||0)>LIM.cfLimit&&LIM.isPro&&LIM.directUrl){
    try{
      const t=await api('/api/download-token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({file_id:it.id})});
      if(t.url)return t.url;
    }catch(e){/* fallback ke domain */}
  }
  return '/file/'+it.id+'/download';
}
async function openLightbox(items,i){lbItems=items;lbIdx=i;lbSrc=await dlHref(items[i]);renderLb();document.getElementById('lightbox').classList.remove('hidden')}
function renderLb(){const it=lbItems[lbIdx];if(!it)return;const b=document.getElementById('lbBody');
  if(it.kind==='video')b.innerHTML='<video src="'+lbSrc+'" controls autoplay style="max-height:80vh"></video>';
  else if(it.kind==='photo')b.innerHTML='<img src="'+lbSrc+'">';
  else b.innerHTML='<div style="color:#ccc">Pratinjau tidak tersedia.<br><a href="'+lbSrc+'">Unduh '+esc(it.name)+'</a></div>';
  document.getElementById('lbCap').textContent=it.name+' • '+fmtSize(it.size)}
async function lbNav(d){if(!lbItems.length)return;lbIdx=(lbIdx+lbItems.length+d)%lbItems.length;lbSrc=await dlHref(lbItems[lbIdx]);renderLb()}
function closeLightbox(){document.getElementById('lightbox').classList.add('hidden');document.getElementById('lbBody').innerHTML=''}
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeLightbox();if(!document.getElementById('lightbox').classList.contains('hidden')){if(e.key==='ArrowRight')lbNav(1);if(e.key==='ArrowLeft')lbNav(-1)}});
/* usap kiri/kanan untuk pindah foto di lightbox (sentuh, mis. Android) */
let lbSx=0,lbSy=0,lbTrack=false;
document.addEventListener('touchstart',e=>{
  lbTrack=false;
  if(e.touches.length!==1||document.getElementById('lightbox').classList.contains('hidden'))return;
  if(e.target.closest('#lightbox video'))return; // jangan ganggu kontrol video
  if(!e.target.closest('#lightbox'))return;
  const t=e.touches[0];lbSx=t.clientX;lbSy=t.clientY;lbTrack=true;
},{passive:true});
document.addEventListener('touchend',e=>{
  if(!lbTrack)return;lbTrack=false;
  const t=e.changedTouches[0],dx=t.clientX-lbSx,dy=t.clientY-lbSy;
  if(Math.abs(dx)>60&&Math.abs(dx)>Math.abs(dy)*1.5)lbNav(dx<0?1:-1);
},{passive:true});

/* ---------- modal helper ---------- */
function modal(html){const d=document.createElement('div');d.className='modal';d.innerHTML='<div class="box">'+html+'</div>';d.onclick=e=>{if(e.target===d)d.remove()};document.body.appendChild(d);return d}

/* dialog input nama (rename) */
function askName(title,current){return new Promise(res=>{
  const m=modal('<h3>'+esc(title)+'</h3><input id="anIn" value="'+esc(current)+'" maxlength="200"><div class="row"><button class="btn" id="anCancel">Batal</button><button class="btn primary" id="anOk">Simpan</button></div>');
  const inp=m.querySelector('#anIn');inp.focus();inp.select();
  const done=v=>{m.remove();res(v)};
  m.querySelector('#anCancel').onclick=()=>done(null);
  m.querySelector('#anOk').onclick=()=>done(inp.value.trim()||null);
  inp.onkeydown=e=>{if(e.key==='Enter')m.querySelector('#anOk').click();if(e.key==='Escape')done(null)};
})}

/* dialog input PIN (kunci folder) */
function askPin(title,msg){return new Promise(res=>{
  const m=modal('<h3>'+esc(title)+'</h3>'+(msg?'<p class="muted" style="margin-bottom:10px;font-size:.88rem">'+esc(msg)+'</p>':'')+'<input id="pinIn" type="password" inputmode="numeric" maxlength="12" placeholder="PIN" autocomplete="off"><div class="row"><button class="btn" id="pinCancel">Batal</button><button class="btn primary" id="pinOk">Buka</button></div>');
  const inp=m.querySelector('#pinIn');inp.focus();
  const done=v=>{m.remove();res(v)};
  m.querySelector('#pinCancel').onclick=()=>done(null);
  m.querySelector('#pinOk').onclick=()=>done(inp.value.trim()||null);
  inp.onkeydown=e=>{if(e.key==='Enter')m.querySelector('#pinOk').click();if(e.key==='Escape')done(null)};
})}

/* ---------- batch 2026-10-03: komponen modern bersama ---------- */
/* notifikasi modern: type ok|err|info */
function notify(msg,type){
  document.querySelectorAll('.ntoast').forEach(t=>t.remove());
  const d=document.createElement('div');d.className='ntoast '+(type||'info');
  const ic=type==='ok'?'<span class="mi mi-check"></span>':type==='err'?'<span class="mi mi-close"></span>':'<span class="mi mi-info"></span>';
  d.innerHTML='<span class="nico">'+ic+'</span><span></span>';
  d.lastChild.textContent=msg;
  document.body.appendChild(d);
  requestAnimationFrame(()=>d.classList.add('show'));
  setTimeout(()=>{d.classList.remove('show');setTimeout(()=>d.remove(),320)},type==='err'?6000:3500);
}
/* dialog konfirmasi modern pengganti confirm() — promise boolean */
function confirmDlg(o){o=o||{};return new Promise(res=>{
  const m=modal('<div class="cdlg"><div class="cico">'+esc(o.ico||'❓')+'</div><h3>'+esc(o.title||'Yakin?')+'</h3>'
    +(o.msg?'<p>'+esc(o.msg)+'</p>':'')
    +'<div class="row"><button class="btn" id="cdNo">'+esc(o.no||'Batal')+'</button>'
    +'<button class="btn '+(o.danger?'danger':'primary')+'" id="cdYes">'+esc(o.yes||'Ya')+'</button></div></div>');
  const done=v=>{m.remove();res(v)};
  m.querySelector('#cdNo').onclick=()=>done(false);
  m.querySelector('#cdYes').onclick=()=>done(true);
  m.querySelector('#cdYes').focus();
  m.onkeydown=e=>{if(e.key==='Escape'){e.stopPropagation();done(false)}};
})}
/* render markdown sederhana + aman (HTML di-escape dulu) */
function mdRender(src){
  let h=esc(src);
  h=h.replace(/```([\s\S]*?)```/g,(m,c)=>'<pre><code>'+c.trim()+'</code></pre>');
  h=h.replace(/^### (.*)$/gm,'<h4>$1</h4>').replace(/^## (.*)$/gm,'<h3>$1</h3>').replace(/^# (.*)$/gm,'<h2>$1</h2>');
  h=h.replace(/\*\*(.+?)\*\*/g,'<b>$1</b>').replace(/(^|\W)\*(.+?)\*/g,'$1<i>$2</i>').replace(/`(.+?)`/g,'<code>$1</code>');
  h=h.replace(/^&gt; (.*)$/gm,'<blockquote>$1</blockquote>');
  h=h.replace(/^\- (.*)$/gm,'<li>$1</li>');
  h=h.replace(/(<li>.*<\/li>\s*)+/g,m=>'<ul>'+m+'</ul>');
  return h.split(/\n\s*\n/).map(p=>/^<(h\d|ul|pre|blockquote)/.test(p.trim())?p:'<p>'+p.replace(/\n/g,'<br>')+'</p>').join('');
}
/* dialog pilih folder tujuan (untuk pindah massal) — promise folderId|null */
function pickFolder(folders,currentId){
  return new Promise(res=>{
    const row=(id,name,indent)=>'<div class="frow'+(String(id)===String(currentId)?' on':'')+'" data-f="'+id+'" style="padding-left:'+(14+indent*18)+'px"><span class="mi mi-folder"></span> '+esc(name)+'</div>';
    let sel=null;
    const m=modal('<h3><span class="mi mi-folder-open"></span> Pindah ke…</h3><div class="fpick">'
      +row('root','Drive Saya',0)
      +folders.map(f=>row(f.id,f.name,0)).join('')
      +'</div><div class="row"><button class="btn" id="pfNo">Batal</button><button class="btn primary" id="pfYes">Pindahkan</button></div>');
    m.querySelectorAll('.frow').forEach(r=>r.onclick=()=>{m.querySelectorAll('.frow').forEach(x=>x.classList.remove('on'));r.classList.add('on');sel=r.dataset.f});
    const done=v=>{m.remove();res(v)};
    m.querySelector('#pfNo').onclick=()=>done(null);
    m.querySelector('#pfYes').onclick=()=>done(sel);
  });
}

/* ---------- editor teks (.txt / .md): buat, baca, edit ---------- */
function openEditor(o){
  o=o||{};
  const isNew=o.mode!=='edit';
  const ext=(o.ext||(o.name||'').split('.').pop()||'txt').toLowerCase();
  const draftKey='tgd_draft_'+(isNew?'new_'+ext+'_'+(o.folder||'root'):'f'+o.fileId);
  const wrap=document.createElement('div');wrap.className='edwrap';
  wrap.innerHTML=
    '<div class="edtop"><button class="btn ghost" id="edBack" title="Kembali"><span class="mi mi-arrow-back"></span></button>'
    +'<input class="edname" id="edName" maxlength="200" value="">'
    +'<span class="eddraft" id="edDraft"></span>'
    +'<button class="btn primary" id="edSave">Simpan</button></div>'
    +'<div class="edtabs"><div class="edseg" id="edTabs"><button data-v="edit" class="on"><span class="mi mi-edit"></span> Tulis</button><button data-v="prev"><span class="mi mi-visibility"></span> Pratinjau</button></div>'
    +'<span class="edcount" id="edCount"></span></div>'
    +'<textarea class="edarea" id="edArea" placeholder="Tulis di sini…"></textarea>'
    +'<div class="edprev" id="edPrev" style="display:none"></div>';
  document.body.appendChild(wrap);
  const q=s=>wrap.querySelector(s);
  const nameInp=q('#edName'),area=q('#edArea'),prev=q('#edPrev'),draftEl=q('#edDraft');
  let orig='';
  function updCount(){
    const t=area.value,w=t.trim()?t.trim().split(/\s+/).length:0;
    q('#edCount').textContent=w+' kata • '+t.length+' karakter';
  }
  function setTab(v){
    q('#edTabs').querySelectorAll('button').forEach(b=>b.classList.toggle('on',b.dataset.v===v));
    const isPrev=v==='prev';
    area.style.display=isPrev?'none':'block';
    prev.style.display=isPrev?'block':'none';
    if(isPrev)prev.innerHTML=ext==='md'?mdRender(area.value):'<p>'+esc(area.value).replace(/\n/g,'<br>')+'</p>';
  }
  q('#edTabs').querySelectorAll('button').forEach(b=>b.onclick=()=>setTab(b.dataset.v));
  let dT=null;
  area.addEventListener('input',()=>{
    updCount();clearTimeout(dT);
    dT=setTimeout(()=>{try{localStorage.setItem(draftKey,area.value);draftEl.textContent='✓ Draf tersimpan'}catch(e){}},800);
  });
  function isDirty(){return area.value!==orig||nameInp.value!==nameInp.dataset.orig}
  async function close(){
    if(isDirty()&&!await confirmDlg({ico:'⚠️',title:'Buang perubahan?',msg:'Perubahan belum disimpan dan akan hilang.',yes:'Ya, keluar'}))return;
    wrap.remove();
  }
  q('#edBack').onclick=close;
  document.addEventListener('keydown',function esc2(e){
    if(e.key!=='Escape'||!document.body.contains(wrap))return;
    if(document.querySelector('.modal'))return; // dialog lain sedang terbuka
    close();document.removeEventListener('keydown',esc2)});
  function fixName(n){
    n=(n||'').trim()||'tanpa-judul';
    return /\.(txt|md)$/i.test(n)?n:n+'.'+ext;
  }
  q('#edSave').onclick=async()=>{
    const name=fixName(nameInp.value),content=area.value;
    const done=msg=>{
      try{localStorage.removeItem(draftKey)}catch(e){}
      notify(msg,'ok');wrap.remove();o.onSaved&&o.onSaved();
    };
    try{
      if(isNew){
        const r=await api('/api/files/create-text',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({name:name,content:content,folder_id:o.folder==='root'?null:o.folder})});
        done('✓ "'+name+'" tersimpan di Drive');
      }else{
        if(!await confirmDlg({ico:'💾',title:'Timpa file?',msg:'"'+name+'" akan ditimpa dengan versi baru ini.',yes:'Ya, simpan'}))return;
        await api('/api/files/'+o.fileId+'/content',{method:'PUT',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({content:content})});
        // nama berubah? rename sekalian
        if(name!==o.name)await api('/api/files/'+o.fileId+'/rename',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name})});
        done('✓ Perubahan "'+name+'" disimpan');
      }
    }catch(e){notify('Gagal menyimpan: '+e.message,'err')}
  };
  // muat isi
  (async()=>{
    if(isNew){
      nameInp.value='catatan-tanpa-judul.'+ext;nameInp.dataset.orig=nameInp.value;
      orig='';
      const d=localStorage.getItem(draftKey);
      if(d){area.value=d;draftEl.textContent='✓ Draf dipulihkan'}
      updCount();setTimeout(()=>area.focus(),200);
    }else{
      nameInp.value=o.name;nameInp.dataset.orig=o.name;
      area.placeholder='Memuat…';area.disabled=true;
      try{
        const r=await api('/api/files/'+o.fileId+'/content');
        orig=r.content||'';
        const d=localStorage.getItem(draftKey);
        area.value=(d&&d!==orig)?d:orig;
        if(d&&d!==orig)draftEl.textContent='✓ Draf dipulihkan';
      }catch(e){notify('Gagal membuka: '+e.message,'err');wrap.remove();return}
      area.disabled=false;area.placeholder='Tulis di sini…';updCount();
    }
  })();
}

/* ---------- DRIVE ---------- */
function initDrive(){
  const S={folder:'root',sort:'date',order:'desc',view:'grid',trash:false,q:'',folders:[]};
  const grid=document.getElementById('grid'),empty=document.getElementById('emptyState');
  const crumbs=document.getElementById('crumbs'),lockNote=document.getElementById('lockNote');
  const unlocked=new Set(); // id folder yang sudah dibuka dgn PIN sesi ini
  api('/api/lock/status').then(r=>{(r.unlocked||[]).forEach(id=>unlocked.add(+id))}).catch(()=>{});

  /* ---------- undo / redo ---------- */
  const undoStack=[],redoStack=[];
  let toastTimer=null;
  function toast(msg,actionLabel,actionFn){
    document.querySelectorAll('.utoast').forEach(t=>t.remove());
    const d=document.createElement('div');d.className='utoast';
    const s=document.createElement('span');s.textContent=msg;d.appendChild(s);
    if(actionLabel){const b=document.createElement('button');b.textContent=actionLabel;
      b.onclick=()=>{d.remove();actionFn&&actionFn()};d.appendChild(b)}
    document.body.appendChild(d);
    clearTimeout(toastTimer);toastTimer=setTimeout(()=>d.remove(),6000);
  }
  function updateUndoBtns(){
    const u=document.getElementById('undoBtn'),r=document.getElementById('redoBtn');
    if(u){u.disabled=!undoStack.length;
      u.title=undoStack.length?('Urungkan: '+undoStack[undoStack.length-1].label+' (Ctrl+Z)'):'Urungkan (Ctrl+Z)'}
    if(r){r.disabled=!redoStack.length;
      r.title=redoStack.length?('Ulangi: '+redoStack[redoStack.length-1].label+' (Ctrl+Shift+Z)'):'Ulangi (Ctrl+Shift+Z)'}
  }
  function pushUndo(label,undoFn,redoFn){
    undoStack.push({label,undo:undoFn,redo:redoFn});
    redoStack.length=0;updateUndoBtns();
  }
  async function doUndo(){
    const a=undoStack.pop();if(!a)return;
    try{await a.undo();redoStack.push(a);toast('Dibatalkan: '+a.label,'Ulangi',doRedo)}
    catch(e){toast('Gagal membatalkan: '+e.message)}
    await loadFolders();load();updateUndoBtns();
  }
  async function doRedo(){
    const a=redoStack.pop();if(!a)return;
    try{await a.redo();undoStack.push(a);toast('Diulangi: '+a.label,'Urungkan',doUndo)}
    catch(e){toast('Gagal mengulangi: '+e.message)}
    await loadFolders();load();updateUndoBtns();
  }
  const _ub=document.getElementById('undoBtn'),_rb=document.getElementById('redoBtn');
  if(_ub)_ub.onclick=doUndo;
  if(_rb)_rb.onclick=doRedo;
  document.addEventListener('keydown',e=>{
    if(!(e.ctrlKey||e.metaKey)||e.key.toLowerCase()!=='z')return;
    if(/INPUT|TEXTAREA|SELECT/.test(document.activeElement&&document.activeElement.tagName||''))return;
    e.preventDefault();e.shiftKey?doRedo():doUndo();
  });

  /* ---------- navbar explorer: riwayat per sesi + breadcrumb pill ---------- */
  const navHist=['root'];let navIdx=0;
  function navCur(){return navHist[navIdx]}
  function navGo(fid){
    fid=String(fid);
    if(fid!==navCur()){navHist.length=navIdx+1;navHist.push(fid);navIdx++}
    S.folder=fid;S.trash=false;exitSelMode();renderCrumbs();load();
  }
  function navBack(){
    if(S.trash){S.trash=false;S.folder='root';renderCrumbs();load();return}
    if(navIdx>0){navIdx--;S.folder=navCur();exitSelMode();renderCrumbs();load()}
  }
  function navFwd(){
    if(navIdx<navHist.length-1){navIdx++;S.folder=navCur();S.trash=false;exitSelMode();renderCrumbs();load()}
  }
  function navUp(){
    if(S.trash){S.trash=false;S.folder='root';renderCrumbs();load();return}
    const f=S.folders.find(x=>String(x.id)===String(S.folder));
    navGo(f&&f.parent_id?String(f.parent_id):'root');
  }
  function navReset(){navHist.length=0;navHist.push('root');navIdx=0}

  async function openFolder(fid){
    fid=+fid;
    const f=S.folders.find(x=>+x.id===fid);
    if(f&&f.is_locked&&!unlocked.has(fid)){
      const pin=await askPin('🔒 Folder terkunci','Masukkan PIN untuk membuka "'+f.name+'"');
      if(!pin)return;
      try{await api('/api/lock/unlock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({folder_id:fid,pin:pin})});unlocked.add(fid)}
      catch(e){notify(e.message,'err');return}
    }
    navGo(fid);
  }

  async function loadFolders(){try{S.folders=(await api('/api/folders')).folders||[]}catch(e){S.folders=[]}renderCrumbs()}
  /* --- tong sampah: banner retensi + hitung mundur + kosongkan --- */
  function trashCountdown(trashed_at){
    if(!trashed_at)return '⏳ Dijadwalkan hapus permanen';
    const ms=Date.now()-new Date(trashed_at.replace(' ','T')).getTime();
    const left=Math.max(0,7-Math.floor(ms/86400000));
    return left<=0?'⏳ Dihapus permanen hari ini':'⏳ Hapus permanen '+left+' hari lagi';
  }
  function renderTrashBar(files){
    const bar=document.getElementById('trashBar');
    if(!bar)return;
    if(!S.trash){bar.classList.add('hidden');return}
    bar.classList.remove('hidden');
    bar.innerHTML='<span>🗑️ File di sini dihapus <b>permanen otomatis setelah 7 hari</b> (ikut terhapus dari channel Telegram).</span><span class="spacer"></span>'+
      (files.length?'<button class="btn danger" id="emptyTrashBtn">Kosongkan sampah ('+files.length+')</button>':'');
    const eb=document.getElementById('emptyTrashBtn');
    if(eb)eb.onclick=emptyTrash;
  }
  async function emptyTrash(){
    if(!await confirmDlg({ico:'🗑',title:'Kosongkan tong sampah?',msg:'Semua file dihapus PERMANEN — termasuk dari channel Telegram — dan tidak bisa dikembalikan.',yes:'Ya, kosongkan',danger:true}))return;
    try{
      const r=await api('/api/trash/empty',{method:'POST'});
      notify('Tong sampah dikosongkan. '+r.deleted+' file dihapus permanen.'+(r.failed?' ('+r.failed+' gagal)':''),'ok');
      load();
    }catch(e){notify('Gagal: '+e.message,'err')}
  }
  function folderChain(fid){
    const byId={};S.folders.forEach(f=>byId[f.id]=f);
    const chain=[];let cur=byId[fid];
    while(cur){chain.unshift(cur);cur=cur.parent_id?byId[cur.parent_id]:null}
    return chain;
  }
  function renderCrumbs(){
    const bB=document.getElementById('navBack'),bF=document.getElementById('navFwd'),bU=document.getElementById('navUp');
    if(bB)bB.disabled=S.trash?false:navIdx===0;
    if(bF)bF.disabled=navIdx>=navHist.length-1;
    if(bU)bU.disabled=S.trash?false:S.folder==='root';
    let h='<button class="crumb'+(S.folder==='root'&&!S.trash?' on':'')+'" data-f="root"><span class="mi mi-home"></span> Drive Saya</button>';
    if(!S.trash&&S.folder!=='root'){
      h+=folderChain(S.folder).map(f=>'<span class="csep">›</span><button class="crumb'+(String(S.folder)===String(f.id)?' on':'')+'" data-f="'+f.id+'"><span class="mi mi-folder"></span> '+esc(f.name)+'</button>').join('');
    }
    if(S.trash)h+='<span class="csep">›</span><button class="crumb on" data-f="__trash"><span class="mi mi-delete"></span> Tong Sampah</button>';
    crumbs.innerHTML=h;
    crumbs.querySelectorAll('button').forEach(b=>b.onclick=()=>{const v=b.dataset.f;
      if(v==='__trash'){S.trash=true;exitSelMode();renderCrumbs();load()}
      else if(v==='root')navGo('root');
      else openFolder(v)})}

  async function load(){
    const p=new URLSearchParams({folder:S.folder,sort:S.sort,order:S.order,trashed:S.trash?'1':'0',q:S.q});
    let files=[],lockedHidden=0;
    try{const r=await api('/api/files?'+p);files=r.files||[];lockedHidden=r.locked_hidden||0}
    catch(e){
      files=[];
      // folder terkunci & sesi belum buka -> minta PIN lalu coba lagi
      if(e.message&&e.message.indexOf('terkunci')>=0&&S.folder!=='root'){
        const f=S.folders.find(x=>String(x.id)===String(S.folder));
        const pin=await askPin('🔒 Folder terkunci','Masukkan PIN untuk membuka "'+(f?f.name:'folder ini')+'"');
        if(pin){
          try{await api('/api/lock/unlock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({folder_id:+S.folder,pin:pin})});
            unlocked.add(+S.folder);return load()}catch(e2){notify(e2.message,'err')}
        }
        S.folder='root';renderCrumbs();return load();
      }
    }
    if(lockNote){lockNote.classList.toggle('hidden',!lockedHidden);if(lockedHidden)lockNote.textContent='🔒 '+lockedHidden+' item di folder terkunci disembunyikan.'}
    renderTrashBar(files);
    grid.className='grid'+(S.view==='list'?' list':'')+(sel.mode?' selecting':'');
    let html='';
    if(!S.trash&&!S.q){
      const subs=S.folders.filter(f=>S.folder==='root'?!f.parent_id:String(f.parent_id)===String(S.folder));
      html+=subs.map(f=>'<div class="fitem folderitem" data-fid="'+f.id+'"><div class="chk"><span class="mi mi-check"></span></div><div class="thumb"><span class="mi mi-folder"></span>'+(f.is_locked?'<span class="lk"><span class="mi mi-lock"></span></span>':'')+'</div><div class="meta"><div class="nm">'+esc(f.name)+'</div><div class="sz">Folder</div></div><div class="acts"><button class="kebab" title="Menu"><span class="mi mi-more-vert"></span></button></div></div>').join('');
    }
    html+=files.map((f,i)=>{
      const thumb=f.kind==='photo'||f.kind==='video'
        ?'<img src="/file/'+f.id+'/thumb" loading="lazy" onerror="this.parentNode.innerHTML='+(f.kind==='video'?'<span class="mi mi-movie"></span>':'<span class="mi mi-image"></span>')+'">'
        :'<div>'+(f.kind==='audio'?'<span class="mi mi-music-note"></span>':/\.md$/i.test(f.name)?'<span class="mi mi-edit-note"></span>':'<span class="mi mi-description"></span>')+'</div>';
      return '<div class="fitem" data-i="'+i+'"><div class="chk"><span class="mi mi-check"></span></div><div class="thumb">'+thumb+'</div><div class="meta"><div class="nm" title="'+esc(f.name)+'">'+esc(f.name)+'</div><div class="sz">'+fmtSize(f.size)+' • '+fmtDate(f.uploaded_at)+(S.trash?'<br><span class="trashcount">'+trashCountdown(f.trashed_at)+'</span>':'')+'</div></div>'+
        '<div class="acts"><button class="kebab" title="Menu"><span class="mi mi-more-vert"></span></button></div></div>';
    }).join('');
    grid.innerHTML=html;empty.classList.toggle('hidden',html!=='');
    const items=files;selItems=files;
    grid.querySelectorAll('.fitem').forEach(el=>{
      const fi=el.dataset.fid;
      const kb=el.querySelector('.kebab');
      if(!sel.mode){
        // tahan lama = masuk mode pilih
        let lpT=null;
        const swallow=()=>{const h=e=>{e.stopPropagation();e.preventDefault();window.removeEventListener('click',h,true)};
          window.addEventListener('click',h,true);setTimeout(()=>window.removeEventListener('click',h,true),700)};
        el.addEventListener('pointerdown',()=>{lpT=setTimeout(()=>{
          enterSelMode();
          if(fi!==undefined&&fi!=='')toggleSelFolder(fi);else toggleSelFile(items[+el.dataset.i].id);
          swallow();
        },450)});
        ['pointerup','pointerleave','pointercancel'].forEach(ev=>el.addEventListener(ev,()=>clearTimeout(lpT)));
      }
      if(fi!==undefined&&fi!==''){
        if(sel.mode){el.onclick=()=>toggleSelFolder(fi);return}
        const open=()=>openFolder(fi);
        el.querySelector('.thumb').onclick=open;
        el.querySelector('.meta').onclick=open;
        if(kb){kb._folder={fid:fi,el:el};kb.onclick=e=>{e.stopPropagation();openCtxMenu(kb)}}
        return}
      const it=items[+el.dataset.i];
      if(sel.mode){el.onclick=()=>toggleSelFile(it.id);return}
      el.querySelector('.thumb').onclick=()=>{
        if(it.kind==='photo'||it.kind==='video')openLightbox(items.filter(x=>x.kind==='photo'||x.kind==='video'),items.filter(x=>x.kind==='photo'||x.kind==='video').indexOf(it));
        else if(/\.(txt|md)$/i.test(it.name))openEditor({mode:'edit',fileId:it.id,name:it.name,onSaved:()=>load()});
      };
      if(kb){kb._file=it;kb.onclick=e=>{e.stopPropagation();openCtxMenu(kb)}}
    });
    syncSelUI();
  }
  /* menu konteks ⋮ — satu simbol, diklik baru muncul pilihan */
  function hideCtxMenu(){const m=document.getElementById('ctxmenu');if(m)m.classList.add('hidden')}
  function openCtxMenu(kb){
    const m=document.getElementById('ctxmenu');
    if(!m)return;
    let defs=[];
    if(kb._folder){
      const{fid,el}=kb._folder;
      const fl=S.folders.find(x=>String(x.id)===String(fid));
      defs=[
        ['<span class="mi mi-info"></span> Properties',()=>folderAct('props',fid,el)],
        ['<span class="mi mi-edit"></span> Ganti nama',()=>folderAct('rename',fid,el)],
        [fl&&fl.is_locked?'<span class="mi mi-lock-open"></span> Buka kunci folder':'<span class="mi mi-lock"></span> Kunci folder',()=>folderAct(fl&&fl.is_locked?'unlock':'lock',fid,el)],
        ['<span class="mi mi-delete"></span> Hapus folder',()=>folderAct('del',fid,el)],
      ];
    }else if(kb._file){
      const it=kb._file;
      defs=[['<span class="mi mi-download"></span> Unduh',()=>act('dl',it)],['<span class="mi mi-info"></span> Properties',()=>act('props',it)]];
      if(/\.(txt|md)$/i.test(it.name))defs.push(['<span class="mi mi-edit"></span> Edit',()=>act('edit',it)]);
      if(!S.trash)defs.push(['<span class="mi mi-edit"></span> Ganti nama',()=>act('rename',it)],['<span class="mi mi-share"></span> Bagikan',()=>act('share',it)],[(it.favorite?'★ Hapus dari favorit':'☆ Favorit'),()=>act('fav',it)],['🗑 Hapus',()=>act('trash',it)]);
      else defs.push(['<span class="mi mi-undo"></span> Kembalikan',()=>act('restore',it)],['<span class="mi mi-close"></span> Hapus permanen',()=>act('del',it)]);
    }
    m.innerHTML=defs.map((d,i)=>'<button data-mi="'+i+'">'+d[0]+'</button>').join('');
    m.querySelectorAll('button').forEach(b=>b.onclick=e=>{e.stopPropagation();hideCtxMenu();defs[+b.dataset.mi][1]()});
    m.classList.remove('hidden');
    const r=kb.getBoundingClientRect();
    m.style.visibility='hidden';
    const mw=m.offsetWidth,mh=m.offsetHeight;
    let x=Math.min(r.right-mw,window.innerWidth-mw-8),y=r.bottom+4;
    if(y+mh>window.innerHeight-8)y=Math.max(8,r.top-mh-4);
    m.style.left=Math.max(8,x)+'px';m.style.top=y+'px';m.style.visibility='';
  }
  async function act(a,it){
    try{
      if(a==='dl'){location.href=await dlHref(it)}
      else if(a==='edit'){openEditor({mode:'edit',fileId:it.id,name:it.name,onSaved:()=>load()})}
      else if(a==='trash'&&(await confirmDlg({ico:'🗑',title:'Pindahkan ke tong sampah?',msg:'"'+it.name+'"',yes:'Ya, pindahkan'}))){
        await api('/api/files/'+it.id+'/trash',{method:'POST'});load();
        pushUndo('pindahkan "'+it.name+'" ke tong sampah',
          ()=>api('/api/files/'+it.id+'/restore',{method:'POST'}),
          ()=>api('/api/files/'+it.id+'/trash',{method:'POST'}));
        toast('"'+it.name+'" dipindah ke tong sampah.','Urungkan',doUndo);
      }
      else if(a==='restore'){
        await api('/api/files/'+it.id+'/restore',{method:'POST'});load();
        pushUndo('kembalikan "'+it.name+'" dari tong sampah',
          ()=>api('/api/files/'+it.id+'/trash',{method:'POST'}),
          ()=>api('/api/files/'+it.id+'/restore',{method:'POST'}));
        toast('"'+it.name+'" dikembalikan.','Urungkan',doUndo);
      }
      else if(a==='del'&&(await confirmDlg({ico:'✖',title:'Hapus permanen?',msg:'"'+it.name+'" juga dihapus dari channel Telegram dan tidak bisa dikembalikan.',yes:'Ya, hapus',danger:true}))){await api('/api/files/'+it.id,{method:'DELETE'});load();notify('File dihapus permanen.','ok')}
      else if(a==='fav'){await api('/api/files/'+it.id+'/favorite',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fav:!it.favorite})});load()}
      else if(a==='props')showFileProps(it);
      else if(a==='rename'){const n=await askName('Ganti nama file',it.name);
        if(n&&n!==it.name){
          const old=it.name;
          await api('/api/files/'+it.id+'/rename',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:n})});load();
          pushUndo('ganti nama jadi "'+n+'"',
            ()=>api('/api/files/'+it.id+'/rename',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:old})}),
            ()=>api('/api/files/'+it.id+'/rename',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:n})}));
          toast('Nama diubah jadi "'+n+'".','Urungkan',doUndo);
        }}
      else if(a==='share'){
        const m=modal('<h3>Bagikan "'+esc(it.name)+'"</h3><label style="font-size:.85rem;color:var(--muted)">Berlaku (jam)</label><input id="shHours" type="number" value="24" min="1" max="720"><div class="row"><button class="btn" onclick="this.closest(\'.modal\').remove()">Batal</button><button class="btn primary" id="shGo">Buat Link</button></div><div id="shOut"></div>');
        m.querySelector('#shGo').onclick=async()=>{const r=await api('/api/share',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({file_id:it.id,hours:+m.querySelector('#shHours').value||24})});
          m.querySelector('#shOut').innerHTML='<div class="sharelink">'+esc(r.url)+'</div><div style="font-size:.8rem;color:var(--muted)">Berlaku sampai '+esc(r.expires_at)+'</div>'};
      }
    }catch(e){notify(e.message,'err')}
  }

  /* ---------- mode pilih banyak + aksi massal ---------- */
  const sel={mode:false,files:new Set(),folders:new Set()};
  let selItems=[];
  function selCount(){return sel.files.size+sel.folders.size}
  function enterSelMode(){
    if(S.trash){notify('Mode pilih tidak tersedia di Tong Sampah.','info');return}
    sel.mode=true;sel.files.clear();sel.folders.clear();
    syncSelUI();load();
  }
  function exitSelMode(){
    if(!sel.mode)return;
    sel.mode=false;sel.files.clear();sel.folders.clear();
    syncSelUI();load();
  }
  function syncSelUI(){
    const bar=document.getElementById('selBar'),ab=document.getElementById('selActionBar');
    const n=selCount();
    if(bar){bar.classList.toggle('hidden',!sel.mode);
      const c=document.getElementById('selCount');if(c)c.textContent=n+' dipilih'}
    if(ab)ab.classList.toggle('on',sel.mode&&n>0);
    grid.classList.toggle('selecting',sel.mode);
    grid.querySelectorAll('.fitem').forEach(el=>{
      const fid=el.dataset.fid;
      let on=false;
      if(fid!==undefined&&fid!=='')on=sel.folders.has(String(fid));
      else{const it=selItems[+el.dataset.i];on=it&&sel.files.has(it.id)}
      el.classList.toggle('sel',!!on);
    });
  }
  function toggleSelFile(id){sel.files.has(id)?sel.files.delete(id):sel.files.add(id);syncSelUI()}
  function toggleSelFolder(fid){fid=String(fid);sel.folders.has(fid)?sel.folders.delete(fid):sel.folders.add(fid);syncSelUI()}
  function selVisibleFolders(){
    return S.folders.filter(f=>S.folder==='root'?!f.parent_id:String(f.parent_id)===String(S.folder));
  }
  async function bulkDelete(){
    const n=selCount();if(!n)return;
    if(!await confirmDlg({ico:'🗑',title:'Hapus '+n+' item?',msg:'File dipindah ke Tong Sampah. Folder dihapus (isinya ikut ke Tong Sampah).',yes:'Ya, hapus',danger:true}))return;
    try{
      const fileIds=[...sel.files];
      await api('/api/files/bulk-trash',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({file_ids:fileIds,folder_ids:[...sel.folders]})});
      exitSelMode();await loadFolders();load();
      if(fileIds.length){
        pushUndo('hapus '+n+' item',
          ()=>api('/api/files/bulk-restore',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:fileIds})}),
          ()=>api('/api/files/bulk-trash',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({file_ids:fileIds,folder_ids:[]})}));
        toast('Dipindah ke tong sampah ('+n+' item).','Urungkan',doUndo);
      }else notify('Folder dihapus.','ok');
    }catch(e){notify('Gagal: '+e.message,'err')}
  }
  async function bulkMove(){
    const n=selCount();if(!n)return;
    const dest=await pickFolder(S.folders.filter(f=>!sel.folders.has(String(f.id))),S.folder);
    if(dest===null||dest===undefined)return;
    try{
      const r=await api('/api/files/bulk-move',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({file_ids:[...sel.files],folder_ids:[...sel.folders],folder_id:dest})});
      exitSelMode();await loadFolders();load();
      notify('Dipindah: '+r.files+' file, '+r.folders+' folder.'+(r.skipped?' ('+r.skipped+' dilewati)':''),'ok');
    }catch(e){notify('Gagal: '+e.message,'err')}
  }
  function bulkDownload(){
    const ids=[...sel.files];
    if(!ids.length){notify('Pilih file dulu — folder tidak bisa diunduh massal.','info');return}
    notify(ids.length>1?'Menyiapkan ZIP berisi '+ids.length+' file…':'Mengunduh 1 file…','info');
    location.href='/api/files/download-zip?ids='+ids.join(',');
    exitSelMode();
  }

  /* ---------- properties ala file explorer ---------- */
  function fmtDur(s){s=Math.round(s||0);const m=Math.floor(s/60);return m?m+' mnt '+(s%60)+' dtk':s+' dtk'}
  function showFileProps(it){
    const kinds={photo:'Foto',video:'Video',audio:'Audio',doc:'Dokumen'};
    const fo=it.folder_id?S.folders.find(f=>String(f.id)===String(it.folder_id)):null;
    const loc=fo?('Drive Saya / '+folderChain(fo.id).map(f=>f.name).join(' / ')):'Drive Saya';
    let extra='';
    if((it.kind==='photo'||it.kind==='video')&&it.width)extra+='<div class="pr"><span>Dimensi</span><b>'+it.width+' × '+it.height+' px</b></div>';
    if((it.kind==='video'||it.kind==='audio')&&it.duration)extra+='<div class="pr"><span>Durasi</span><b>'+fmtDur(it.duration)+'</b></div>';
    modal('<h3>Properties</h3><div class="props">'
      +'<div class="pr"><span>Nama</span><b>'+esc(it.name)+'</b></div>'
      +'<div class="pr"><span>Jenis</span><b>'+(kinds[it.kind]||'File')+(it.mime?' ('+esc(it.mime)+')':'')+'</b></div>'
      +'<div class="pr"><span>Ukuran</span><b>'+fmtSize(it.size)+'</b></div>'
      +'<div class="pr"><span>Lokasi</span><b>'+esc(loc)+'</b></div>'
      +'<div class="pr"><span>Diunggah</span><b>'+fmtDT(it.uploaded_at)+'</b></div>'
      +extra
      +'</div><div class="row" style="display:flex;justify-content:flex-end;margin-top:14px"><button class="btn" onclick="this.closest(\'.modal\').remove()">Tutup</button></div>');
  }
  async function showFolderProps(fid){
    const m=modal('<h3>Properties</h3><div class="props"><div class="pr"><span>Memuat…</span><b></b></div></div><div class="row" style="display:flex;justify-content:flex-end;margin-top:14px"><button class="btn" onclick="this.closest(\'.modal\').remove()">Tutup</button></div>');
    try{
      const p=await api('/api/folders/'+fid+'/properties');
      const path='Drive Saya'+folderChain(fid).map(f=>' / '+f.name).join('');
      m.querySelector('.props').innerHTML=
        '<div class="pr"><span>Nama</span><b>'+esc(p.name)+'</b></div>'
        +'<div class="pr"><span>Lokasi</span><b>'+esc(path)+'</b></div>'
        +'<div class="pr"><span>Ukuran</span><b>'+fmtSize(p.size)+' (termasuk subfolder)</b></div>'
        +'<div class="pr"><span>Isi</span><b>'+p.files+' file, '+p.folders+' folder</b></div>'
        +'<div class="pr"><span>Dibuat</span><b>'+fmtDT(p.created_at)+'</b></div>';
    }catch(e){m.querySelector('.props').innerHTML='<div class="pr"><span>Gagal memuat: '+esc(e.message)+'</span><b></b></div>'}
  }

  async function folderAct(a,fid,el){
    const name=el.querySelector('.nm').textContent;
    try{
      if(a==='rename'){
        const n=await askName('Ganti nama folder',name);
        if(n&&n!==name){
          await api('/api/folders/'+fid+'/rename',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:n})});await loadFolders();load();
          pushUndo('ganti nama folder jadi "'+n+'"',
            ()=>api('/api/folders/'+fid+'/rename',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name})}),
            ()=>api('/api/folders/'+fid+'/rename',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:n})}));
          toast('Folder diubah jadi "'+n+'".','Urungkan',doUndo);
        }
      }else if(a==='props'){showFolderProps(fid)}
      else if(a==='lock'){
        await api('/api/folders/'+fid+'/lock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({locked:true})});
        await loadFolders();load();
      }
      else if(a==='unlock'){
        const pin=await askPin('Buka kunci folder','Masukkan PIN untuk melepas kunci "'+name+'"');
        if(!pin)return;
        await api('/api/folders/'+fid+'/lock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({locked:false,pin:pin})});
        await loadFolders();load();
      }
      else if(a==='del'){
        if(await confirmDlg({ico:'🗑',title:'Hapus folder?',msg:'"'+name+'" — file di dalamnya dipindah ke tong sampah.',yes:'Ya, hapus',danger:true})){
          const r=await api('/api/folders/'+fid,{method:'DELETE'});
          await loadFolders();S.folder='root';load();
          notify('Folder "'+name+'" dihapus.'+(r.trashed_files?' '+r.trashed_files+' file dipindah ke tong sampah.':''),'ok');
        }
      }
    }catch(e){notify(e.message,'err')}
  }

  /* pill aktivitas live di menubar — muncul hanya saat ada upload */
  const liveMap=new Map();let liveId=0;
  function liveRefresh(){
    const pill=document.getElementById('livepill');if(!pill)return;
    let sp=0;liveMap.forEach(v=>sp+=v);
    if(liveMap.size){pill.classList.remove('hidden');pill.textContent='⬆ '+fmtSpd(sp)+' · '+liveMap.size+' file'}
    else pill.classList.add('hidden');
  }
  const _lp=document.getElementById('livepill');
  if(_lp)_lp.onclick=()=>{const q=document.getElementById('queue');if(q){q.classList.remove('hidden');q.scrollIntoView({behavior:'smooth',block:'start'})}};

  /* upload */
  const fi=document.getElementById('fileInput'),queue=document.getElementById('queue'),hint=document.getElementById('dropHint');
  fi.onchange=()=>{uploadFiles(fi.files);fi.value=''};
  const fiF=document.getElementById('folderInput');
  if(fiF)fiF.onchange=()=>{const items=[...fiF.files].map(f=>({file:f,rel:f.webkitRelativePath||f.name}));fiF.value='';uploadRelFiles(items)};
  ['dragenter','dragover'].forEach(ev=>document.addEventListener(ev,e=>{e.preventDefault();hint.classList.remove('hidden')}));
  ['dragleave','drop'].forEach(ev=>document.addEventListener(ev,e=>{e.preventDefault();if(ev==='dragleave'&&e.relatedTarget)return;hint.classList.add('hidden')}));
  document.addEventListener('drop',e=>{
    const items=[...(e.dataTransfer.items||[])].filter(it=>it.kind==='file');
    if(!items.length)return;
    const entries=items.map(it=>it.webkitGetAsEntry?it.webkitGetAsEntry():null);
    if(entries.some(en=>en&&en.isDirectory)&&entries.every(Boolean))uploadDropEntries(entries);
    else if(e.dataTransfer.files.length)uploadFiles(e.dataTransfer.files);
  });
  /* baca folder rekursif (drag & drop) */
  function entryFile(entry){return new Promise((res,rej)=>entry.file(res,rej))}
  function readEntries(reader){return new Promise((res,rej)=>reader.readEntries(res,rej))}
  async function walkDir(dirEntry,rel,files,emptyDirs){
    const reader=dirEntry.createReader();
    let batch=[],all=[];
    do{batch=await readEntries(reader);all.push(...batch)}while(batch.length);
    if(!all.length){emptyDirs.push(rel);return}
    for(const en of all){
      const r=rel+'/'+en.name;
      if(en.isDirectory)await walkDir(en,r,files,emptyDirs);
      else if(en.isFile)files.push({file:await entryFile(en),rel:r});
    }
  }
  async function uploadDropEntries(entries){
    queue.classList.remove('hidden');
    const scan=qitem('Memindai folder…','membaca struktur…');
    const files=[],emptyDirs=[];
    try{
      for(const en of entries){
        if(en.isDirectory)await walkDir(en,en.name,files,emptyDirs);
        else if(en.isFile)files.push({file:await entryFile(en),rel:en.name});
      }
    }catch(err){scan.status.textContent='Gagal membaca folder';setTimeout(()=>scan.el.remove(),3000);return}
    scan.el.remove();
    if(!files.length&&!emptyDirs.length)return;
    await uploadRelFiles(files,emptyDirs);
  }
  /* cache folder hasil ensure agar tidak request berulang */
  const dirCache={};
  function clearDirCache(){for(const k in dirCache)delete dirCache[k]}
  async function ensureDir(relDir,baseParent){
    if(dirCache[relDir]!==undefined)return dirCache[relDir];
    const segs=relDir.split('/').filter(Boolean);
    let parent=baseParent,cur='';
    for(const s of segs){
      cur=cur?cur+'/'+s:s;
      if(dirCache[cur]===undefined){
        const r=await api('/api/folders/ensure',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:s,parent_id:parent})});
        dirCache[cur]=r.id;
      }
      parent=dirCache[cur];
    }
    return dirCache[relDir];
  }
  /* upload daftar file ber-relPath: [{file, rel:'A/b/c.jpg'}] */
  async function uploadRelFiles(items,emptyDirs){
    emptyDirs=emptyDirs||[];
    queue.classList.remove('hidden');
    const baseParent=S.folder!=='root'?+S.folder:null;
    const prep=emptyDirs.length?qitem('Menyiapkan '+emptyDirs.length+' folder…',''):null;
    try{
      for(const d of emptyDirs)await ensureDir(d,baseParent);
      const jobs=[];
      for(const it of items){
        const rel=it.rel||it.file.name;
        const relDir=rel.includes('/')?rel.slice(0,rel.lastIndexOf('/')):'';
        const folderId=relDir?await ensureDir(relDir,baseParent):baseParent;
        jobs.push({file:it.file,folderId:folderId});
      }
      if(prep)prep.el.remove();
      await uploadJobs(jobs);
    }catch(err){if(prep){prep.status.textContent='Gagal: '+err.message;setTimeout(()=>prep.el.remove(),4000)}}
    clearDirCache();await loadFolders();load();
  }
  /* dialog duplikat: timpa / lewati */
  function dupDialog(name,size){
    return new Promise(res=>{
      const m=modal('<h3>File sudah ada</h3><p style="font-size:.9rem;margin-bottom:10px">"<b>'+esc(name)+'</b>" ('+fmtSize(size)+') sudah ada di folder ini.</p><label style="font-size:.85rem;color:var(--muted)"><input type="checkbox" id="dupAll" style="width:auto;margin-right:6px">Ingat pilihan ini untuk semua file</label><div class="row" style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px"><button class="btn" id="dupSkip">Lewati</button><button class="btn primary" id="dupOver">Timpa</button></div>');
      const done=(action)=>{const all=m.querySelector('#dupAll')?m.querySelector('#dupAll').checked:false;m.remove();res(action?{action:action,remember:all}:null)};
      m.onclick=e=>{if(e.target===m)done(null)}; // klik backdrop = batal
      m.querySelector('#dupSkip').onclick=()=>done('skip');
      m.querySelector('#dupOver').onclick=()=>done('overwrite');
    });
  }

  /* uploadFiles(list): FileList/File[] -> semua ke folder aktif */
  async function uploadFiles(list){
    const jobs=[...list].map(f=>({file:f,folderId:S.folder!=='root'?+S.folder:null}));
    await uploadJobs(jobs);
    await loadFolders();load();loadStorage();
  }

  /* antrean upload: cek duplikat dulu, lalu kirim maks 3 paralel */
  async function uploadJobs(jobs){
    queue.classList.remove('hidden');
    let remember=null;
    const ready=[];
    for(const j of jobs){
      const f=j.file;
      if(f.size>LIM.maxUpload){qitem(f.name,'File maksimal '+fmtSize(LIM.maxUpload)+'.',true);continue}
      if(!LIM.isPro&&f.size>LIM.cfLimit){qitem(f.name,'⚠ Di atas 100 MB — khusus pengguna PRO. <a href="/upgrade">Upgrade ke PRO</a>',true);continue}
      let action='upload', overwriteId=null;
      try{
        const chk=await api('/api/check-duplicate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:f.name,size:f.size,folder_id:j.folderId})});
        if(chk.duplicate){
          if(remember){action=remember;overwriteId=(remember==='overwrite')?chk.existing_id:null}
          else{
            const c=await dupDialog(f.name,f.size);
            if(!c){const r0=qitem(f.name,'');r0.status.textContent='Dibatalkan';setTimeout(()=>r0.el.remove(),2500);continue}
            if(c.remember)remember=c.action;
            action=c.action;overwriteId=(c.action==='overwrite')?chk.existing_id:null;
          }
        }
      }catch(e){/* abaikan, upload biasa */}
      if(action==='skip'){const r=qitem(f.name,'');r.status.textContent='Dilewati (sudah ada)';setTimeout(()=>r.el.remove(),2500);continue}
      ready.push({f:f,overwriteId:overwriteId,folderId:j.folderId});
    }
    let idx=0;
    async function worker(){
      while(idx<ready.length){
        const j=ready[idx++];
        const big=j.f.size>=LIM.cfLimit;
        if(big){
          // MODE 2: >=100MB khusus PRO, chunked via direct (hindari timeout Cloudflare)
          if(!LIM.chunked){
            // admin mematikan mode resume: PRO bisa single POST bila sudah di direct,
            // di domain tawarkan pindah manual (fallback kontekstual Mode Besar)
            if(ON_DIRECT)await doUploadP(j.f,j.overwriteId,j.folderId,1);
            else{const r0=qitem(j.f.name,'');r0.status.innerHTML='Mode resume dimatikan admin. Pindah manual untuk upload file ini. ';
              const mb=document.createElement('button');mb.className='btn ghost';
              mb.style.cssText='padding:2px 10px;font-size:.78rem';mb.innerHTML='<span class="mi mi-bolt"></span> Mode Besar';
              mb.onclick=()=>handoffGo(LIM.directUrl);r0.status.appendChild(mb)}
            continue;
          }
          await doUploadChunked(j.f,j.overwriteId,j.folderId);
        }else await doUploadP(j.f,j.overwriteId,j.folderId,1); // MODE 1: <100MB single POST via domain
      }
    }
    await Promise.all([worker(),worker(),worker()]);
  }

function fmtSpd(b){if(!b||b<0)return'';if(b<1024)return b.toFixed(0)+' B/dtk';if(b<1048576)return (b/1024).toFixed(1)+' KB/dtk';return (b/1048576).toFixed(1)+' MB/dtk';}
function fmtETA(s){if(!isFinite(s)||s<0)return'';s=Math.round(s);if(s<60)return s+' dtk';const m=Math.floor(s/60);return m+' mnt '+(s%60)+' dtk';}
function fmtMB(mb){return mb>=1024?(mb/1024).toFixed(1)+' GB':Math.round(mb)+' MB';}

  function doUploadP(f,overwriteId,folderId,attempt){
    attempt=attempt||1;
    const MAX_TRY=3;
    const lid=++liveId;liveMap.set(lid,0);liveRefresh();
    return new Promise(resolve=>{
    const row=qitem(f.name,'Menunggu…');
    const fd=new FormData();fd.append('file',f);
    if(folderId)fd.append('folder_id',folderId);
    if(overwriteId)fd.append('overwrite_id',overwriteId);
    const x=new XMLHttpRequest();x.open('POST','/api/upload');
    x.timeout=10800000; // 3 jam (file besar)
    const trk={t:Date.now(),l:0};
    x.upload.onprogress=e=>{if(e.lengthComputable){row.bar.style.width=Math.round(e.loaded/e.total*100)+'%';
      const now=Date.now(),dt=(now-trk.t)/1000;
      if(dt>=0.5){const s=(e.loaded-trk.l)/dt;trk.t=now;trk.l=e.loaded;
        row.spd.textContent=s>0?fmtSpd(s)+' • sisa '+fmtETA((e.total-e.loaded)/s):'';liveMap.set(lid,s);liveRefresh();}}};
    const done=()=>{liveMap.delete(lid);liveRefresh();resolve()};
    const fail=(msg,retryable)=>{
      if(retryable&&attempt<MAX_TRY){
        const wait=attempt*3;
        row.status.textContent='Gagal, mengulang dalam '+wait+' dtk… ('+attempt+'/'+MAX_TRY+')';
        setTimeout(()=>{row.el.remove();doUploadP(f,overwriteId,folderId,attempt+1).then(done)},wait*1000);
      }else{
        row.el.classList.add('err');
        row.status.innerHTML='<span>Gagal: '+esc(msg)+'</span> <button class="btn ghost" style="padding:2px 10px;margin-left:8px">Coba lagi</button>';
        row.status.querySelector('button').onclick=()=>{row.el.remove();doUploadP(f,overwriteId,folderId,1).then(()=>{loadFolders();load()});done()};
      }
    };
    x.onload=()=>{let j={};try{j=JSON.parse(x.responseText)}catch(e){}
      row.spd.textContent='';
      if(x.status===200&&j.ok){row.status.textContent=j.overwritten?'Ditimpakan ✓':'Selesai ✓';row.bar.style.width='100%';setTimeout(()=>row.el.remove(),2500);done()}
      else fail(j.error||('HTTP '+x.status),(x.status===429||x.status===408||x.status>=500))};
    x.onerror=()=>fail('Koneksi terputus',true);
    x.ontimeout=()=>fail('Timeout',true);
    row.status.textContent='Mengupload…';x.send(fd);
    });
  }

  /* ---------- upload chunked / resume (>=10MB) ---------- */
  function saveLocalSession(x){try{const k='tgd_uploads';const a=JSON.parse(localStorage.getItem(k)||'[]').filter(y=>y.upload_id!==x.upload_id);a.push(x);localStorage.setItem(k,JSON.stringify(a))}catch(e){}}
  function clearLocalSession(id){try{const k='tgd_uploads';localStorage.setItem(k,JSON.stringify(JSON.parse(localStorage.getItem(k)||'[]').filter(y=>y.upload_id!==id)))}catch(e){}}
  function getLocalSessions(){try{return JSON.parse(localStorage.getItem('tgd_uploads')||'[]')}catch(e){return[]}}

  // tombol Jeda/Lanjut + Batal untuk baris upload chunked
  function addChunkControls(row,ctx,lbl){
    const ctl=document.createElement('span');ctl.style.marginLeft='8px';
    const bP=document.createElement('button');bP.className='btn ghost';bP.style.cssText='padding:2px 10px;font-size:.78rem';bP.textContent='Jeda';
    const bC=document.createElement('button');bC.className='btn ghost';bC.style.cssText='padding:2px 10px;font-size:.78rem;margin-left:6px';bC.textContent='Batal';
    ctl.appendChild(bP);ctl.appendChild(bC);row.status.appendChild(ctl);
    bP.onclick=()=>{ctx.paused=!ctx.paused;bP.textContent=ctx.paused?'Lanjut':'Jeda';
      if(ctx.paused)lbl.textContent='Dijeda — klik Lanjut untuk meneruskan. ';
      else{if(ctx._resume)ctx._resume()}};
    bC.onclick=async()=>{ctx.cancelled=true;if(ctx._resume)ctx._resume();
      try{if(ctx.upload_id){const fd=new FormData();fd.append('upload_id',ctx.upload_id);
        if(ctx.token)fd.append('transfer_token',ctx.token);
        await fetch((ctx.base||'')+'/api/upload/cancel',{method:'POST',body:fd})}}catch(e){}
      if(ctx.upload_id)clearLocalSession(ctx.upload_id);
      lbl.textContent='Dibatalkan. ';ctl.remove();setTimeout(()=>row.el.remove(),2000)};
    return ctl;
  }

  // loop utama: kirim potongan yang belum ada, dukung jeda/lanjut & retry.
  // ctx.base: '' = domain (same-origin, cookie) atau 'https://direct...:8443' (token di body)
  async function runChunkedUpload(ctx){
    const file=ctx.file,row=ctx.row,upload_id=ctx.upload_id,chunk_size=ctx.chunk_size,total=ctx.total;
    const lbl=ctx.lbl,base=ctx.base||'',token=ctx.token||'';
    const qid='upload_id='+encodeURIComponent(upload_id)+(token?'&transfer_token='+encodeURIComponent(token):'');
    const statusUrl=token?base+'/api/upload/status?'+qid:'/api/upload/status?upload_id='+encodeURIComponent(upload_id);
    let have=new Set();
    try{const st=token?(await(await fetch(statusUrl)).json()):(await api(statusUrl));
      have=new Set(st.received||[])}catch(e){}
    let done=have.size;
    const setPct=()=>{const pc=Math.round(done/total*100);row.bar.style.width=pc+'%';return pc};
    setPct();
    if(done>0)lbl.textContent='Melanjutkan dari '+Math.round(done/total*100)+'%… ';
    let lastT=Date.now(),lastB=done*chunk_size;
    for(let i=0;i<total;i++){
      if(ctx.cancelled)throw new Error('Dibatalkan');
      while(ctx.paused&&!ctx.cancelled){await new Promise(r=>ctx._resume=r)}
      if(ctx.cancelled)throw new Error('Dibatalkan');
      if(have.has(i))continue;
      const blob=file.slice(i*chunk_size,Math.min(file.size,(i+1)*chunk_size));
      let ok=false,lastErr='';
      for(let a=1;a<=3&&!ok;a++){
        try{
          const fd=new FormData();
          fd.append('upload_id',upload_id);fd.append('chunk_index',i);fd.append('chunk',blob,'c'+i);
          if(token)fd.append('transfer_token',token);
          const r=await fetch(base+'/api/upload/chunk',{method:'POST',body:fd});
          const j=await r.json().catch(()=>({}));
          if(!r.ok)throw new Error(j.error||('HTTP '+r.status));
          ok=true;done++;have.add(i);
        }catch(e){lastErr=e.message;if(a<3)await new Promise(r=>setTimeout(r,a*2000))}
      }
      if(!ok)throw new Error('Potongan '+(i+1)+'/'+total+' gagal: '+lastErr);
      const pc=setPct(),now=Date.now(),dt=(now-lastT)/1000;
      if(dt>=0.5){const b=done*chunk_size,spd=(b-lastB)/dt;lastT=now;lastB=b;
        row.spd.textContent=fmtSpd(spd)+' • '+pc+'%'}
      lbl.textContent='Mengupload '+done+'/'+total+' potongan… ';
    }
    lbl.textContent='Merakit & mengirim ke Telegram, mohon tunggu… ';row.spd.textContent='';
    const fd=new FormData();fd.append('upload_id',upload_id);
    if(token)fd.append('transfer_token',token);
    const r=await fetch(base+'/api/upload/complete',{method:'POST',body:fd});
    const j=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(j.error||('HTTP '+r.status));
    return j;
  }

  // tombol fallback: buka jalur langsung manual (Mode Besar) — hanya saat otomatis gagal
  function modeBesarFallbackBtn(row,retryFn){
    const mb=document.createElement('button');mb.className='btn ghost';
    mb.style.cssText='padding:2px 10px;font-size:.78rem;margin-left:6px';
    mb.innerHTML='<span class="mi mi-bolt"></span> Coba via Mode Besar';
    mb.onclick=()=>{handoffGo(LIM.directUrl)};
    row.status.appendChild(mb);
    return mb;
  }

  async function doUploadChunked(f,overwriteId,folderId,clientKey){
    const row=qitem(f.name,'');
    const lbl=document.createElement('span');row.status.appendChild(lbl);
    const ctx={file:f,row,lbl,paused:false,cancelled:false,upload_id:null,chunk_size:0,total:0,base:'',token:''};
    const ctl=addChunkControls(row,ctx,lbl);
    clientKey=clientKey||('ck_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,10));
    try{
      lbl.textContent='Menyiapkan… ';
      const init=await api('/api/upload/init',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({name:f.name,file_size:f.size,folder_id:folderId,overwrite_id:overwriteId,client_key:clientKey})});
      Object.assign(ctx,{upload_id:init.upload_id,chunk_size:init.chunk_size,total:init.total_chunks,
        base:init.target==='direct'?(init.direct_url||''):'' ,token:init.transfer_token||''});
      saveLocalSession({upload_id:init.upload_id,name:f.name,size:f.size,lastModified:f.lastModified,
        folderId:folderId,chunk_size:init.chunk_size,total:init.total_chunks,
        base:ctx.base,token:ctx.token});
      const j=await runChunkedUpload(ctx);
      clearLocalSession(ctx.upload_id);
      lbl.textContent=j.overwritten?'Ditimpakan ✓':'Selesai ✓';row.bar.style.width='100%';row.spd.textContent='';
      ctl.remove();setTimeout(()=>{row.el.remove();loadFolders();load()},2500);
    }catch(e){
      if(ctx.cancelled)return;
      row.el.classList.add('err');ctl.remove();
      lbl.textContent='Gagal: '+e.message+' ';
      const rb=document.createElement('button');rb.className='btn ghost';rb.style.cssText='padding:2px 10px;font-size:.78rem';rb.textContent='Coba lagi';
      rb.onclick=()=>{row.el.remove();doUploadChunked(f,overwriteId,folderId,clientKey)};
      row.status.appendChild(rb);
      // fallback kontekstual: pindah manual ke direct bila upload besar otomatis gagal di domain
      if(!ON_DIRECT&&LIM.directUrl&&f.size>=LIM.cfLimit&&LIM.isPro)
        modeBesarFallbackBtn(row);
    }
  }

  // resume lintas buka aplikasi: sesi aktif di server + file dipilih ulang user
  async function checkPendingUploads(){
    let sessions=[];try{sessions=(await api('/api/upload/sessions')).sessions||[]}catch(e){return}
    if(!sessions.length)return;
    queue.classList.remove('hidden');
    for(const s of sessions){
      const row=qitem(s.name,'');
      const lbl=document.createElement('span');
      lbl.textContent='Belum selesai ('+s.received+'/'+s.total_chunks+' potongan). Pilih file yang sama untuk melanjutkan. ';
      row.status.appendChild(lbl);
      const inp=document.createElement('input');inp.type='file';inp.style.display='none';row.el.appendChild(inp);
      const bp=document.createElement('button');bp.className='btn ghost';bp.style.cssText='padding:2px 10px;font-size:.78rem';bp.textContent='Pilih file & lanjutkan';
      const bc=document.createElement('button');bc.className='btn ghost';bc.style.cssText='padding:2px 10px;font-size:.78rem;margin-left:6px';bc.textContent='Hapus';
      row.status.appendChild(bp);row.status.appendChild(bc);
      bp.onclick=()=>inp.click();
      bc.onclick=async()=>{try{const fd=new FormData();fd.append('upload_id',s.upload_id);
        const ls0=getLocalSessions().find(x=>x.upload_id===s.upload_id)||{};
        if(ls0.token)fd.append('transfer_token',ls0.token);
        await fetch((ls0.base||'')+'/api/upload/cancel',{method:'POST',body:fd})}catch(e){}
        clearLocalSession(s.upload_id);row.el.remove()};
      inp.onchange=async()=>{
        const f=inp.files[0];if(!f)return;
        if(f.name!==s.name||f.size!==s.size){lbl.textContent='File tidak cocok — nama & ukuran harus sama persis dengan sebelumnya. ';return}
        bp.remove();bc.remove();inp.remove();
        const ls=getLocalSessions().find(x=>x.upload_id===s.upload_id)||{};
        const ctx={file:f,row,lbl,paused:false,cancelled:false,upload_id:s.upload_id,chunk_size:s.chunk_size,total:s.total_chunks,
          base:ls.base||'',token:ls.token||''};
        const ctl=addChunkControls(row,ctx,lbl);
        try{
          const j=await runChunkedUpload(ctx);
          clearLocalSession(s.upload_id);
          lbl.textContent=j.overwritten?'Ditimpakan ✓':'Selesai ✓';row.bar.style.width='100%';row.spd.textContent='';
          ctl.remove();setTimeout(()=>{row.el.remove();loadFolders();load()},2500);
        }catch(e){if(!ctx.cancelled){row.el.classList.add('err');ctl.remove();lbl.textContent='Gagal: '+e.message}}
      };
    }
  }

  function qitem(name,status,isErr){const el=document.createElement('div');el.className='qitem'+(isErr?' err':'');
    el.innerHTML='<div><b>'+esc(name)+'</b> — <span></span> <span class="spd"></span></div><div class="bar"><i></i></div>';
    queue.appendChild(el);return{el,status:el.querySelector('span'),spd:el.querySelector('.spd'),bar:el.querySelector('.bar i')}}

  /* toolbar */
  document.getElementById('sort').onchange=e=>{const[s,o]=e.target.value.split('-');S.sort=s;S.order=o;load()};
  let qt;document.getElementById('q').oninput=e=>{clearTimeout(qt);qt=setTimeout(()=>{S.q=e.target.value.trim();load()},350)};
  document.getElementById('viewToggle').onclick=e=>{S.view=S.view==='grid'?'list':'grid';e.currentTarget.innerHTML='<span class="mi '+(S.view==='grid'?'mi-grid-view':'mi-view-list')+'"></span>';load()};
  /* navbar explorer */
  document.getElementById('navBack').onclick=navBack;
  document.getElementById('navFwd').onclick=navFwd;
  document.getElementById('navUp').onclick=navUp;
  /* mode pilih banyak — via tahan lama (HP) atau ⋯ → Pilih banyak (desktop) */
  const ovSel=document.getElementById('ovSelBtn');
  if(ovSel)ovSel.onclick=()=>sel.mode?exitSelMode():enterSelMode();
  document.getElementById('selCancelBtn').onclick=exitSelMode;
  document.getElementById('selAllBtn').onclick=()=>{
    sel.files=new Set(selItems.map(f=>f.id));
    sel.folders=new Set(selVisibleFolders().map(f=>String(f.id)));
    syncSelUI();notify(selCount()+' item dipilih.','info');
  };
  document.getElementById('bulkMoveBtn').onclick=bulkMove;
  document.getElementById('bulkDlBtn').onclick=bulkDownload;
  document.getElementById('bulkDelBtn').onclick=bulkDelete;
  /* storage strip collapsible */
  let ssOpen=localStorage.getItem('tgd_ss')==='1';
  function fmtQuota(v){return v>=1024?(v/1024).toFixed(1).replace('.',',')+' GB':Math.round(v)+' MB'}
  async function loadStorage(){
    try{
      const r=await api('/api/storage');
      const pct=r.quota_mb?Math.min(100,r.used_mb/r.quota_mb*100):0;
      document.getElementById('stText').textContent=fmtQuota(r.used_mb)+' dari '+fmtQuota(r.quota_mb);
      const bar=document.getElementById('stBar');bar.style.width=pct+'%';
      bar.style.background=pct>=95?'linear-gradient(90deg,#f87171,#ef4444)':pct>=80?'linear-gradient(90deg,#fbbf24,#f59e0b)':'linear-gradient(90deg,#34d399,#4f8cff)';
      document.getElementById('stUsedB').textContent=fmtQuota(r.used_mb);
      document.getElementById('stFreeB').textContent=fmtQuota(Math.max(0,r.quota_mb-r.used_mb));
      document.getElementById('stFilesB').textContent=r.files||0;
      document.getElementById('stFoldersB').textContent=S.folders.length;
      const w=document.getElementById('ssWarn');
      w.classList.toggle('hidden',pct<80);w.classList.toggle('crit',pct>=95);
      if(pct>=95)w.innerHTML='🚨 <b>Penyimpanan hampir habis!</b> Upload akan gagal bila penuh — <a href="/upgrade">tingkatkan ke PRO</a>.';
      else if(pct>=80)w.innerHTML='⚠️ Penyimpanan hampir penuh — <a href="/upgrade">tingkatkan ke PRO</a> untuk kuota lebih besar.';
      if(pct>=80&&!ssOpen){ssOpen=true;applySs()}
    }catch(e){document.getElementById('stText').textContent='Gagal memuat info storage'}
  }
  function applySs(){
    document.getElementById('sstrip').classList.toggle('open',ssOpen);
    localStorage.setItem('tgd_ss',ssOpen?'1':'0');
  }
  document.getElementById('ssHead').onclick=()=>{ssOpen=!ssOpen;applySs()};
  applySs();
  /* ＋Baru: file teks / markdown / folder */
  const hideDrops=()=>document.querySelectorAll('.dpdrop').forEach(x=>x.classList.add('hidden'));
  document.getElementById('newTxt').onclick=()=>{hideDrops();openEditor({mode:'new',ext:'txt',folder:S.folder})};
  document.getElementById('newMd').onclick=()=>{hideDrops();openEditor({mode:'new',ext:'md',folder:S.folder})};
  document.getElementById('newFolderBtn').onclick=()=>{hideDrops();const m=modal('<h3>Folder baru</h3><input id="nfName" placeholder="Nama folder"><div class="row"><button class="btn" onclick="this.closest(\'.modal\').remove()">Batal</button><button class="btn primary" id="nfGo">Buat</button></div>');
    m.querySelector('#nfGo').onclick=async()=>{const n=m.querySelector('#nfName').value.trim();if(!n)return;
      const r=await api('/api/folders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:n,parent_id:S.folder==='root'?null:S.folder})});
      m.remove();await loadFolders();load();
      const newId=r&&r.id; // POST /api/folders mengembalikan {id, name} langsung
      if(newId){
        const ref={id:newId}; // referensi mutable: redo membuat folder baru dgn ID baru
        const parentId=S.folder==='root'?null:S.folder;
        pushUndo('buat folder "'+n+'"',
          ()=>api('/api/folders/'+ref.id,{method:'DELETE'}),
          async()=>{const rr=await api('/api/folders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:n,parent_id:parentId})});
            if(rr&&rr.id)ref.id=rr.id}); // simpan ID baru agar undo kedua tetap bekerja
        toast('Folder "'+n+'" dibuat.','Urungkan',doUndo);
      }}};
  document.getElementById('trashBtn').onclick=()=>{S.trash=true;S.folder='root';renderCrumbs();load()};

  document.addEventListener('click',e=>{if(!e.target.closest('#ctxmenu'))hideCtxMenu()});
  loadFolders().then(()=>{load();loadStorage()});
  checkPendingUploads(); // tampilkan upload chunked yang belum selesai (resume)
}

/* ---------- SETTINGS ---------- */
function initSettings(){
  const list=document.getElementById('accList');
  const msg=document.getElementById('accMsg');
  const val=id=>document.getElementById(id).value.trim();
  function say(t,ok){msg.textContent=t||'';msg.style.color=ok?'#7ddf9a':'var(--danger)'}
  let cache=[],editingId=null;
  function setEditMode(a){
    editingId=a?a.id:null;
    document.getElementById('accFormTitle').textContent=a?'Ubah akun':'Tambah akun';
    document.getElementById('accName').value=a?a.name:'';
    document.getElementById('accChannel').value=a?a.channel_id:'';
    const tok=document.getElementById('accToken');
    tok.value='';tok.placeholder=a?'Kosongkan bila tidak diganti':'123456:AAE...';
    document.getElementById('accCancel').style.display=a?'':'none';
    document.getElementById('accSave').textContent=a?'Simpan Perubahan':'Simpan Akun';
    say('');
    if(a)document.getElementById('accForm').scrollIntoView({behavior:'smooth',block:'center'});
  }
  async function load(){
    try{cache=(await api('/api/accounts')).accounts||[]}catch(e){cache=[]}
    list.innerHTML=cache.map(a=>'<div class="fitem"><div class="meta" style="padding:14px"><div class="nm" style="font-size:1rem;white-space:normal">'+esc(a.name)+(a.is_active?' <span style="color:var(--acc);font-size:.75rem">● AKTIF</span>':'')+'</div><div class="sz" style="white-space:normal;line-height:1.7">Token: '+esc(a.token_head)+'…'+esc(a.token_tail)+'<br>Channel: '+esc(a.channel_id)+'<br>'+a.file_count+' file</div><div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap"><button class="btn ghost" data-act="edit" data-id="'+a.id+'">Ubah</button>'+(a.is_active?'':'<button class="btn ghost" data-act="on" data-id="'+a.id+'">Aktifkan</button>')+(a.is_active?'':'<button class="btn danger" data-act="del" data-id="'+a.id+'" data-n="'+esc(a.name)+'" data-c="'+a.file_count+'">Hapus</button>')+'</div></div></div>').join('')||'<div class="empty">Belum ada akun. Tambahkan di bawah.</div>';
    list.querySelectorAll('button').forEach(b=>b.onclick=()=>accAct(b.dataset.act,+b.dataset.id,b));
  }
  async function accAct(act,id,btn){
    try{
      if(act==='on'){await api('/api/accounts/'+id+'/activate',{method:'POST'});load()}
      else if(act==='edit'){const a=cache.find(x=>x.id===id);if(a)setEditMode(a)}
      else if(act==='del'){
        if(!await confirmDlg({ico:'👤',title:'Hapus akun Telegram?',msg:'"'+btn.dataset.n+'" — '+btn.dataset.c+' file milik akun ini ikut dihapus dari daftar dan Telegram.',yes:'Ya, hapus',danger:true}))return;
        const r=await api('/api/accounts/'+id,{method:'DELETE'});
        notify('Akun dihapus ('+r.deleted_files+' file).','ok');load();
      }
    }catch(e){notify(e.message,'err')}
  }
  document.getElementById('accTest').onclick=async()=>{
    if(editingId&&!val('accToken')){say('Isi token dulu untuk mengetes koneksi.',false);return}
    say('Mengetes…');
    try{const r=await api('/api/accounts/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({bot_token:val('accToken'),channel_id:val('accChannel')})});say('Terhubung: '+r.username+' ('+r.name+') → channel "'+r.channel+'" ✓',true)}
    catch(e){say(e.message,false)}
  };
  document.getElementById('accCancel').onclick=()=>setEditMode(null);
  document.getElementById('accSave').onclick=async()=>{
    say('Menyimpan…');
    try{
      const body=JSON.stringify({name:val('accName'),bot_token:val('accToken'),channel_id:val('accChannel')});
      if(editingId)await api('/api/accounts/'+editingId,{method:'PUT',headers:{'Content-Type':'application/json'},body:body});
      else await api('/api/accounts',{method:'POST',headers:{'Content-Type':'application/json'},body:body});
      say(editingId?'Perubahan tersimpan ✓':'Akun tersimpan ✓',true);setEditMode(null);load();
    }catch(e){say(e.message,false)}
  };
  /* --- max speed (PRO): jalur langsung via IP publik --- */
  /* --- max speed: pindah domain/direct pakai token handoff (tanpa login ulang) --- */
  // (handoffGo kini global, didefinisikan di atas bersama api())
  window.handoffGo=handoffGo; // kompatibilitas template lama

  /* --- sumber daya --- */
  function setBar(id,frac,txt){const b=document.getElementById(id);b.style.width=Math.min(100,frac*100)+'%';document.getElementById(id+'T').textContent=txt}
  async function pollSys(){
    if(!document.getElementById('rCpu'))return; // hanya admin yang melihat sumber daya
    try{
      const r=await api('/api/sysinfo');
      setBar('rCpu',r.cpu_pct/100,r.cpu_pct.toFixed(0)+'%');
      const used=r.mem_total_mb-r.mem_avail_mb;
      setBar('rMem',used/Math.max(1,r.mem_total_mb),fmtMB(used)+' / '+fmtMB(r.mem_total_mb));
      setBar('rPCpu',r.proc_cpu_pct/100,r.proc_cpu_pct.toFixed(1)+'%');
      setBar('rPMem',r.proc_rss_mb/Math.max(1,r.limits.mem_mb),Math.round(r.proc_rss_mb)+' MB');
      document.getElementById('rNote').textContent='Batas aktif: CPU '+r.limits.cpu_pct+'% dari '+r.nproc+' core (systemd '+r.cpu_quota_systemd+') • RAM '+r.limits.mem_mb+' MB';
      if(document.activeElement!==document.getElementById('lCpu'))document.getElementById('lCpu').value=r.limits.cpu_pct;
      if(document.activeElement!==document.getElementById('lMem'))document.getElementById('lMem').value=r.limits.mem_mb;
    }catch(e){/* service restart */}
  }
  const lApplyBtn=document.getElementById('lApply');
  if(lApplyBtn)lApplyBtn.onclick=async()=>{ // hanya admin: tombol tidak ada utk user biasa
    const m=document.getElementById('lMsg');
    m.textContent='Menerapkan & me-restart service…';m.style.color='var(--muted)';
    try{
      const r=await api('/api/limits',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({cpu_pct:+document.getElementById('lCpu').value,mem_mb:+document.getElementById('lMem').value})});
      if(!r.ok)throw new Error('gagal');
      for(let i=0;i<40;i++){await new Promise(x=>setTimeout(x,2000));
        try{await api('/api/ping');m.textContent='Berhasil ✓ service kembali online dengan batas baru.';m.style.color='#7ddf9a';pollSys();return}catch(e){}}
      m.textContent='Restart terlalu lama — coba refresh halaman.';m.style.color='var(--danger)';
    }catch(e){m.textContent='Gagal: '+e.message;m.style.color='var(--danger)'}
  };
  pollSys();setInterval(pollSys,3000);
  load();
  /* --- kunci folder --- */
  const pinMsg=document.getElementById('pinMsg');
  const pinSay=(t,ok)=>{pinMsg.textContent=t||'';pinMsg.style.color=ok?'#7ddf9a':'var(--danger)'};
  let pinSet=false;
  // tombol intip PIN
  document.querySelectorAll('.eyebtn').forEach(b=>b.onclick=()=>{
    const i=document.getElementById(b.dataset.for);if(!i)return;
    const show=i.type==='password';i.type=show?'text':'password';
    b.innerHTML=show?'<span class="mi mi-visibility-off"></span>':'<span class="mi mi-visibility"></span>';
  });
  async function loadLock(){
    try{
      const s=await api('/api/lock/status');pinSet=s.pin_set;
      const badge=document.getElementById('pinBadge');
      badge.textContent=pinSet?'PIN aktif':'Belum ada PIN';
      badge.className='pill '+(pinSet?'ok':'warn');
      document.getElementById('pinStatus').textContent=pinSet
        ?'Folder terkunci hanya bisa dibuka dengan PIN ini.'
        :'Atur PIN dulu sebelum bisa mengunci folder.';
      document.getElementById('pinFormTitle').textContent=pinSet?'Ganti PIN keamanan':'Atur PIN keamanan';
      document.getElementById('pinNewLabel').textContent=pinSet?'PIN baru (4–12 digit angka)':'PIN (4–12 digit angka)';
      document.getElementById('pinOldWrap').classList.toggle('hidden',!pinSet);
      const fs=(await api('/api/folders')).folders||[];
      const locked=fs.filter(f=>f.is_locked), unlocked=fs.filter(f=>!f.is_locked);
      document.getElementById('lockCount').textContent=fs.length?(locked.length+' dari '+fs.length+' terkunci'):'';
      const row=f=>'<div class="lockrow"><span class="lname" title="'+esc(f.name)+'"><span class="mi mi-folder"></span> '+(f.is_locked?'<span class="mi mi-lock"></span> ':'')+esc(f.name)+'</span><button class="btn ghost" data-id="'+f.id+'" data-lk="'+(f.is_locked?1:0)+'">'+(f.is_locked?'Buka kunci':'🔒 Kunci')+'</button></div>';
      const box=document.getElementById('lockFolders');
      box.innerHTML=(locked.length?'<div class="locknote">Terkunci</div>'+locked.map(row).join(''):'')+
        (unlocked.length?'<div class="locknote" style="margin-top:8px">Tidak terkunci</div>'+unlocked.map(row).join(''):'')||
        '<div class="muted">Belum ada folder. Buat folder dulu di halaman Drive.</div>';
      box.querySelectorAll('button').forEach(b=>b.onclick=()=>toggleLock(+b.dataset.id,b.dataset.lk==='1'));
    }catch(e){pinSay(e.message,false)}
  }
  async function toggleLock(fid,isLocked){
    try{
      if(isLocked){
        const pin=await askPin('Buka kunci folder','Masukkan PIN untuk melepas kunci folder ini');
        if(!pin)return;
        await api('/api/folders/'+fid+'/lock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({locked:false,pin:pin})});
      }else{
        if(!pinSet){pinSay('Atur PIN dulu di atas.',false);return}
        await api('/api/folders/'+fid+'/lock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({locked:true})});
      }
      loadLock();
    }catch(e){notify(e.message,'err')}
  }
  document.getElementById('pinSave').onclick=async()=>{
    const a=document.getElementById('pinNew').value.trim(),b=document.getElementById('pinNew2').value.trim();
    if(a!==b){pinSay('PIN tidak sama.',false);return}
    pinSay('Menyimpan…');pinMsg.style.color='var(--muted)';
    try{
      await api('/api/lock/pin',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({pin:a,old_pin:document.getElementById('pinOld').value.trim()})});
      pinSay('PIN tersimpan ✓',true);
      document.getElementById('pinNew').value='';document.getElementById('pinNew2').value='';document.getElementById('pinOld').value='';
      loadLock();
    }catch(e){pinSay(e.message,false)}
  };
  document.getElementById('relockAll').onclick=async()=>{
    await api('/api/lock/relock',{method:'POST'});
    pinSay('Semua folder dikunci ulang.',true);
  };
  loadLock();
}

/* ---------- ACTIVITY ---------- */
const ACT_LABEL={upload:['<span class="mi mi-upload"></span>','Mengupload'],overwrite:['<span class="mi mi-sync"></span>','Menimpa'],rename_file:['<span class="mi mi-edit"></span>','Mengganti nama file'],trash:['<span class="mi mi-delete"></span>','Memindah ke tong sampah'],restore:['<span class="mi mi-undo"></span>','Mengembalikan'],delete:['<span class="mi mi-close"></span>','Menghapus permanen'],create_folder:['<span class="mi mi-folder"></span>','Membuat folder'],rename_folder:['<span class="mi mi-folder"></span>','Mengganti nama folder'],delete_folder:['<span class="mi mi-folder"></span>','Menghapus folder'],share:['<span class="mi mi-share"></span>','Membuat link berbagi'],favorite:['<span class="mi mi-star"></span>','Menandai favorit'],unfavorite:['<span class="mi mi-star"></span>','Menghapus dari favorit'],switch_account:['<span class="mi mi-person"></span>','Beralih akun'],login:['<span class="mi mi-vpn-key"></span>','Masuk']};
function localISO(d){const p=n=>String(n).padStart(2,'0');return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+'T'+p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds())}
function fmtDT(iso){if(!iso)return'';const d=new Date(iso);return d.toLocaleDateString('id-ID',{day:'numeric',month:'short',year:'numeric'})+', '+d.toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'})}
function initActivity(){
  const S={action:'',q:'',date:'',order:'desc'};
  const list=document.getElementById('alist'),empty=document.getElementById('aempty'),more=document.getElementById('amore');
  let offset=0;const LIM=50;
  function since(){
    const d=new Date();
    if(S.date==='today'){d.setHours(0,0,0,0);return localISO(d)}
    if(S.date==='yesterday'){d.setDate(d.getDate()-1);d.setHours(0,0,0,0);return localISO(d)}
    if(S.date==='7'||S.date==='30'){d.setDate(d.getDate()-+S.date);return localISO(d)}
    return '';
  }
  function row(it){
    const lb=ACT_LABEL[it.action]||['•',it.action];
    const name=it.file_name||it.folder_name||'';
    return '<div class="fitem" style="cursor:default"><div class="meta" style="display:flex;gap:12px;align-items:flex-start"><div style="font-size:1.4rem;flex-shrink:0">'+lb[0]+'</div><div style="min-width:0"><div class="nm" style="white-space:normal;word-break:break-word">'+esc(lb[1])+(name?' <b>“'+esc(name)+'”</b>':'')+'</div>'+(it.detail?'<div class="sz" style="word-break:break-word">'+esc(it.detail)+'</div>':'')+'<div class="sz">'+fmtDT(it.created_at)+'</div></div></div></div>';
  }
  async function load(reset){
    if(reset){offset=0;list.innerHTML=''}
    const p=new URLSearchParams({action:S.action,q:S.q,date:S.date,order:S.order,limit:LIM,offset:offset});
    let items=[],has=false;
    try{const r=await api('/api/activity?'+p);items=r.items||[];has=r.has_more}catch(e){}
    list.innerHTML+=items.map(row).join('');
    offset+=items.length;
    empty.classList.toggle('hidden',list.innerHTML!=='');
    more.classList.toggle('hidden',!has);
  }
  const reload=()=>load(true);
  document.getElementById('aaction').onchange=e=>{S.action=e.target.value;reload()};
  document.getElementById('adate').onchange=e=>{S.date=e.target.value;reload()};
  document.getElementById('asort').onchange=e=>{S.order=e.target.value;reload()};
  let qt;document.getElementById('aq').oninput=e=>{clearTimeout(qt);qt=setTimeout(()=>{S.q=e.target.value.trim();reload()},350)};
  more.onclick=()=>load(false);
  load(true);
}

/* ---------- PHOTOS ---------- */
function initPhotos(){
  document.body.classList.add('page-photos'); // viewport terkunci: hanya #tlWrap yang scroll
  const S={sort:'taken',order:'desc',fav:false,view:'grid',labelId:null,labels:[],files:[]};
  const tl=document.getElementById('timeline'),empty=document.getElementById('emptyState');
  const wrap=document.getElementById('tlWrap'),scrub=document.getElementById('scrub'),
        knob=document.getElementById('scrubKnob'),bub=document.getElementById('scrubBub');
  const MONTHS=['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
  const mlabel=ym=>{const[y,m]=ym.split('-');return MONTHS[+m-1]+' '+y};
  const dlabel=f=>{const d=(f.taken_at||f.uploaded_at||'').slice(0,10);return d?fmtDay(d+'T00:00:00'):''};
  const LBL_COLORS=['#f87171','#fb923c','#fbbf24','#34d399','#4f8cff','#a78bfa','#f472b6','#94a3b8'];

  /* ---------- mode pilih ---------- */
  const sel={mode:false,ids:new Set()};
  function enterPSelMode(){
    sel.mode=true;sel.ids.clear();
    tl.querySelectorAll('.tl-grid,.prow').forEach(g=>g.classList.add('selecting'));
    syncPSelUI();
  }
  function exitPSelMode(){
    if(!sel.mode)return;
    sel.mode=false;sel.ids.clear();
    tl.querySelectorAll('.selecting').forEach(g=>g.classList.remove('selecting'));
    tl.querySelectorAll('.fitem.sel,.prow.sel').forEach(x=>x.classList.remove('sel'));
    syncPSelUI();
  }
  function syncPSelUI(){
    const bar=document.getElementById('selBar'),ab=document.getElementById('pselActionBar');
    const n=sel.ids.size;
    if(bar){bar.classList.toggle('hidden',!sel.mode);
      const c=document.getElementById('pselCount');if(c)c.textContent=n+' dipilih'}
    if(ab)ab.classList.toggle('on',sel.mode&&n>0);
    const sm=document.getElementById('pselModeBtn');
    if(sm)sm.textContent=sel.mode?'✕ Batal':'☑ Pilih';
    tl.querySelectorAll('[data-gi]').forEach(el=>{
      const f=S.files[+el.dataset.gi];
      el.classList.toggle('sel',!!(f&&sel.ids.has(f.id)));
    });
  }
  function togglePSel(gi){
    const f=S.files[gi];if(!f)return;
    sel.ids.has(f.id)?sel.ids.delete(f.id):sel.ids.add(f.id);syncPSelUI();
  }

  /* ---------- label ---------- */
  async function loadLabels(){
    try{S.labels=(await api('/api/labels')).labels||[]}catch(e){S.labels=[]}
    renderChips();
  }
  function renderChips(){
    const c=document.getElementById('lchips');if(!c)return;
    let h='<button class="lchip'+(!S.fav&&!S.labelId?' on':'')+'" data-l="">Semua</button>'
      +'<button class="lchip'+(S.fav?' on':'')+'" data-l="__fav">★ Favorit</button>';
    h+=S.labels.map(l=>'<button class="lchip'+(String(S.labelId)===String(l.id)?' on':'')+'" data-l="'+l.id+'"><span class="dot" style="background:'+esc(l.color)+'"></span>'+esc(l.icon)+' '+esc(l.name)+'</button>').join('');
    h+='<button class="lchip add" data-l="__add"><span class="mi mi-add"></span> Label</button>';
    c.innerHTML=h;
    c.querySelectorAll('.lchip').forEach(b=>{
      const v=b.dataset.l;let lpFired=false,t=null;
      b.onclick=()=>{
        if(lpFired){lpFired=false;return} // habis tahan lama: jangan ikut kepencet
        if(v==='__add'){labelDialog();return}
        S.fav=(v==='__fav');S.labelId=(v&&v!=='__fav')?v:null;
        exitPSelMode();renderChips();load();
      };
      if(v&&v!=='__fav'&&v!=='__add'){ // tahan lama pada chip = kelola label
        b.addEventListener('pointerdown',()=>{t=setTimeout(()=>{lpFired=true;manageLabels()},500)});
        ['pointerup','pointerleave','pointercancel'].forEach(ev=>b.addEventListener(ev,()=>clearTimeout(t)));
      }
    });
  }
  function labelDialog(ex){
    ex=ex||{};
    const m=modal('<h3>'+(ex.id?'<span class="mi mi-edit"></span> Ubah label':'<span class="mi mi-label"></span> Label baru')+'</h3>'
      +'<input id="lbName" maxlength="30" placeholder="Nama label" value="'+esc(ex.name||'')+'">'
      +'<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px" id="lbColors">'
      +LBL_COLORS.map(c2=>'<button data-c="'+c2+'" style="width:32px;height:32px;border-radius:50%;background:'+c2+';border:3px solid '+((ex.color||'#4f8cff')===c2?'#fff':'transparent')+';cursor:pointer" aria-label="'+c2+'"></button>').join('')+'</div>'
      +'<input id="lbIcon" maxlength="8" placeholder="Ikon emoji (opsional)" value="'+esc(ex.icon||'')+'" style="width:160px">'
      +'<div class="row"><button class="btn" id="lbCancel">Batal</button><button class="btn ghost" id="lbManage"><span class="mi mi-settings"></span> Kelola</button>'
      +(ex.id?'<button class="btn danger" id="lbDel">Hapus</button>':'')
      +'<button class="btn primary" id="lbSave">Simpan</button></div>');
    let color=ex.color||'#4f8cff';
    m.querySelectorAll('#lbColors button').forEach(b=>b.onclick=()=>{color=b.dataset.c;
      m.querySelectorAll('#lbColors button').forEach(x=>x.style.borderColor=x===b?'#fff':'transparent')});
    m.querySelector('#lbCancel').onclick=()=>m.remove();
    m.querySelector('#lbManage').onclick=()=>{m.remove();manageLabels()};
    const del=m.querySelector('#lbDel');
    if(del)del.onclick=async()=>{
      if(!await confirmDlg({ico:'🏷',title:'Hapus label?',msg:'"'+ex.name+'" dihapus. Foto-fotonya TIDAK ikut terhapus.',yes:'Ya, hapus',danger:true}))return;
      try{await api('/api/labels/'+ex.id,{method:'DELETE'});m.remove();await loadLabels();load();notify('Label dihapus.','ok')}
      catch(e){notify('Gagal: '+e.message,'err')}
    };
    m.querySelector('#lbSave').onclick=async()=>{
      const name=m.querySelector('#lbName').value.trim();
      if(!name){notify('Nama label wajib diisi.','err');return}
      try{
        if(ex.id)await api('/api/labels/'+ex.id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name,color:color,icon:m.querySelector('#lbIcon').value.trim()})});
        else await api('/api/labels',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name,color:color,icon:m.querySelector('#lbIcon').value.trim()})});
        m.remove();await loadLabels();notify('Label tersimpan.','ok');
      }catch(e){notify('Gagal: '+e.message,'err')}
    };
    setTimeout(()=>m.querySelector('#lbName').focus(),100);
  }
  async function manageLabels(){
    let labels=[];
    try{labels=(await api('/api/labels?covers=1')).labels||[]}catch(e){}
    const m=modal('<h3><span class="mi mi-label"></span> Kelola Label</h3>'
      +(labels.length?'<div class="labgrid">'
        +labels.map(l=>'<div class="labcard" data-l="'+l.id+'"><div class="collage">'
          +(l.covers||[]).map(id=>'<img src="/file/'+id+'/thumb" loading="lazy" onerror="this.remove()">').join('')
          +'</div><div class="lbody"><div class="lname"><span class="dot" style="background:'+esc(l.color)+'"></span>'+esc(l.icon)+' '+esc(l.name)+'</div><div class="lcount">'+l.file_count+' foto</div></div></div>').join('')
        +'</div>'
        :'<p class="muted" style="font-size:.88rem">Belum ada label. Buat label pertamamu!</p>')
      +'<div class="row" style="margin-top:16px"><button class="btn primary" id="mlAdd"><span class="mi mi-add"></span> Label baru</button><button class="btn" id="mlClose">Tutup</button></div>');
    m.querySelector('#mlClose').onclick=()=>m.remove();
    m.querySelector('#mlAdd').onclick=()=>{m.remove();labelDialog()};
    m.querySelectorAll('.labcard').forEach(c=>c.onclick=()=>{
      const ex=labels.find(x=>String(x.id)===c.dataset.l);
      m.remove();labelDialog(ex);
    });
  }
  function pickLabelsForBulk(){
    return new Promise(res=>{
      if(!S.labels.length){notify('Buat label dulu lewat ＋ Label.','info');res(null);return}
      const picked=new Set();
      const m=modal('<h3><span class="mi mi-label"></span> Tambah label</h3><p class="muted" style="font-size:.85rem;margin-bottom:4px">Pilih label untuk '+sel.ids.size+' foto:</p><div class="labpick">'
        +S.labels.map(l=>'<button class="lchip" data-l="'+l.id+'"><span class="dot" style="background:'+esc(l.color)+'"></span>'+esc(l.name)+'</button>').join('')
        +'</div><div class="row"><button class="btn" id="plNo">Batal</button><button class="btn primary" id="plYes">Terapkan</button></div>');
      m.querySelectorAll('.lchip').forEach(b=>b.onclick=()=>{const id=b.dataset.l;
        picked.has(id)?picked.delete(id):picked.add(id);b.classList.toggle('on',picked.has(id))});
      m.querySelector('#plNo').onclick=()=>{m.remove();res(null)};
      m.querySelector('#plYes').onclick=()=>{m.remove();res([...picked])};
    });
  }

  /* ---------- scrubber timeline ---------- */
  let grpEls=[];
  function refreshScrub(){
    grpEls=[...tl.querySelectorAll('.tl-group')].map(g=>({el:g,ml:g.dataset.ml,yl:g.dataset.yl}));
    scrub.classList.toggle('hidden',grpEls.length<2);
    requestAnimationFrame(buildYearTicks);
  }
  // tick label tahun ala Google Photos, posisi proporsional thd grup pertama tiap tahun
  function buildYearTicks(){
    scrub.querySelectorAll('.ytick').forEach(e=>e.remove());
    if(grpEls.length<2)return;
    const H=scrub.clientHeight,sh=tl.scrollHeight;
    if(!H||!sh||sh<=wrap.clientHeight+2)return;
    let lastY=-99;const seen=new Set();
    grpEls.forEach(g=>{
      if(!g.yl||seen.has(g.yl))return;seen.add(g.yl);
      const y=(g.el.offsetTop/sh)*H;
      if(y-lastY<24)return;lastY=y; // hindari label bertumpuk
      const t=document.createElement('div');t.className='ytick';t.style.top=y+'px';t.textContent=g.yl;
      scrub.appendChild(t);
    });
  }
  function knobTo(ratio){ratio=Math.max(0,Math.min(1,ratio));knob.dataset.r=ratio;knob.style.top='calc('+(ratio*100)+'% - 6px)'}
  // knob mengikuti scroll dengan smoothing rAF (drag tetap instan 1:1)
  let knobRaf=0,knobTarget=0;
  function knobToSmooth(ratio){
    knobTarget=Math.max(0,Math.min(1,ratio));
    if(!knobRaf)knobRaf=requestAnimationFrame(knobStep);
  }
  function knobStep(){
    knobRaf=0;
    const cur=parseFloat(knob.dataset.r||'0');
    const nxt=cur+(knobTarget-cur)*0.3;
    knobTo(nxt);
    if(Math.abs(knobTarget-nxt)>0.002)knobRaf=requestAnimationFrame(knobStep);
  }
  let dragging=false;
  function scrubMove(clientY){
    const r=scrub.getBoundingClientRect();
    const ratio=Math.max(0,Math.min(1,(clientY-r.top)/r.height));
    const idx=Math.min(grpEls.length-1,Math.floor(ratio*grpEls.length));
    const g=grpEls[idx];if(!g)return;
    bub.textContent=g.ml;bub.style.top=(ratio*100)+'%';
    knobTo(ratio);
    wrap.scrollTo({top:g.el.offsetTop,behavior:dragging?'auto':'smooth'});
  }
  scrub.addEventListener('pointerdown',e=>{if(!grpEls.length)return;dragging=true;scrub.classList.add('drag');try{scrub.setPointerCapture(e.pointerId)}catch(x){}scrubMove(e.clientY);e.preventDefault()});
  scrub.addEventListener('pointermove',e=>{if(dragging)scrubMove(e.clientY)});
  ['pointerup','pointercancel'].forEach(ev=>scrub.addEventListener(ev,()=>{dragging=false;scrub.classList.remove('drag')}));
  wrap.addEventListener('scroll',()=>{
    if(!grpEls.length||dragging)return;
    const y=wrap.scrollTop+80;let idx=0;
    grpEls.forEach((g,i)=>{if(g.el.offsetTop<=y)idx=i});
    knobToSmooth(grpEls.length>1?idx/(grpEls.length-1):0);
  },{passive:true});
  window.addEventListener('resize',()=>{if(grpEls.length)buildYearTicks()});

  /* ---------- render ---------- */
  function dotsFor(f){
    const labs=f.labels||[];
    if(!labs.length)return '';
    return '<div class="ldots">'+labs.slice(0,3).map(l=>'<i style="background:'+esc(l.color)+'" title="'+esc(l.name)+'"></i>').join('')
      +(labs.length>3?'<span class="more">+'+(labs.length-3)+'</span>':'')+'</div>';
  }
  function thumb(f,gi){
    const fb=f.kind==='video'?'<span class="mi mi-movie"></span>':'<span class="mi mi-image"></span>';
    return '<div class="fitem" data-gi="'+gi+'"><div class="chk"><span class="mi mi-check"></span></div><div class="thumb"><img src="/file/'+f.id+'/thumb" loading="lazy" onerror="this.remove()">'+fb+'</div>'+dotsFor(f)+(f.kind==='video'?'<div class="vbadge"><span class="mi mi-play-arrow"></span></div>':'')+'</div>';
  }
  // thumbnail grid justified: lebar mengikuti rasio aspek (width/height dari DB)
  function thumbJ(f,gi){
    const ar=(f.width>0&&f.height>0)?(f.width/f.height):1;
    const fb=f.kind==='video'?'<span class="mi mi-movie"></span>':'<span class="mi mi-image"></span>';
    return '<div class="fitem" data-gi="'+gi+'" style="--ar:'+ar.toFixed(3)+'"><div class="chk"><span class="mi mi-check"></span></div><div class="thumb"><img src="/file/'+f.id+'/thumb" loading="lazy" onerror="this.remove()">'+fb+'</div>'+dotsFor(f)+(f.kind==='video'?'<div class="vbadge"><span class="mi mi-play-arrow"></span></div>':'')+'</div>';
  }
  async function load(){
    const p=new URLSearchParams({folder:'all',sort:S.sort,order:S.order,kinds:'photo,video',with_labels:'1'});
    if(S.fav)p.set('fav','1');
    if(S.labelId)p.set('label_id',S.labelId);
    let files=[],lockedHidden=0;
    try{const r=await api('/api/files?'+p);files=r.files||[];lockedHidden=r.locked_hidden||0}catch(e){}
    S.files=files;
    const ln=document.getElementById('lockNote');
    if(ln){ln.classList.toggle('hidden',!lockedHidden);if(lockedHidden)ln.textContent='🔒 '+lockedHidden+' item di folder terkunci disembunyikan.'}
    // grup per HARI (YYYY-MM-DD) ala Google Photos
    const groups={};
    files.forEach(f=>{const yd=(f.taken_at||f.uploaded_at||'').slice(0,10);if(yd)(groups[yd]=groups[yd]||[]).push(f)});
    const keys=Object.keys(groups).sort((a,b)=>S.order==='asc'?a.localeCompare(b):b.localeCompare(a));
    const dhead=yd=>new Date(yd+'T00:00:00').toLocaleDateString('id-ID',{weekday:'short',day:'numeric',month:'short',year:'numeric'});
    if(S.view==='list'){
      tl.innerHTML=keys.map(k=>'<div class="tl-group" data-ml="'+esc(mlabel(k.slice(0,7)))+'" data-yl="'+k.slice(0,4)+'"><div class="tl-head">'+esc(dhead(k))+' <span class="tl-count">'+groups[k].length+' item</span></div>'+
        groups[k].map(f=>{const gi=files.indexOf(f);
          return '<div class="prow'+(sel.mode?' selecting':'')+'" data-gi="'+gi+'"><div class="chk"><span class="mi mi-check"></span></div><div class="pthumb"><img src="/file/'+f.id+'/thumb" loading="lazy" onerror="this.remove()">'+(f.kind==='video'?'<span class="mi mi-movie"></span>':'<span class="mi mi-image"></span>')+'</div><div class="pmeta"><div class="nm">'+esc(f.name)+'</div><div class="sz">'+fmtSize(f.size)+' · '+esc(dlabel(f))+'</div></div></div>'}).join('')+'</div>').join('');
    }else if(S.view==='grid'){
      // grid justified: tinggi baris seragam, lebar ikut rasio aspek (data width/height DB)
      tl.innerHTML=keys.map(k=>'<div class="tl-group" data-ml="'+esc(mlabel(k.slice(0,7)))+'" data-yl="'+k.slice(0,4)+'"><div class="tl-head">'+esc(dhead(k))+' <span class="tl-count">'+groups[k].length+' item</span></div><div class="tl-jgrid'+(sel.mode?' selecting':'')+'">'+
        groups[k].map(f=>thumbJ(f,files.indexOf(f))).join('')+'</div></div>').join('');
    }else{
      tl.innerHTML=keys.map(k=>'<div class="tl-group" data-ml="'+esc(mlabel(k.slice(0,7)))+'" data-yl="'+k.slice(0,4)+'"><div class="tl-head">'+esc(dhead(k))+' <span class="tl-count">'+groups[k].length+' item</span></div><div class="tl-grid compact'+(sel.mode?' selecting':'')+'">'+
        groups[k].map(f=>thumb(f,files.indexOf(f))).join('')+'</div></div>').join('');
    }
    empty.classList.toggle('hidden',files.length>0);
    tl.querySelectorAll('[data-gi]').forEach(el=>{
      const gi=+el.dataset.gi;
      el.onclick=()=>{if(sel.mode)togglePSel(gi);else openLightbox(S.files,gi)};
      let lpT=null;
      const swallow=()=>{const h=e=>{e.stopPropagation();e.preventDefault();window.removeEventListener('click',h,true)};
        window.addEventListener('click',h,true);setTimeout(()=>window.removeEventListener('click',h,true),700)};
      el.addEventListener('pointerdown',()=>{if(sel.mode)return;lpT=setTimeout(()=>{enterPSelMode();togglePSel(gi);swallow()},450)});
      ['pointerup','pointerleave','pointercancel'].forEach(ev=>el.addEventListener(ev,()=>clearTimeout(lpT)));
    });
    syncPSelUI();
    refreshScrub();
  }

  /* ---------- aksi massal ---------- */
  document.getElementById('pselCancelBtn').onclick=exitPSelMode;
  document.getElementById('pselAllBtn').onclick=()=>{
    sel.ids=new Set(S.files.map(f=>f.id));syncPSelUI();
    notify(sel.ids.size+' foto dipilih.','info');
  };
  document.getElementById('pLabBtn').onclick=async()=>{
    const ids=[...sel.ids];if(!ids.length)return;
    const ll=await pickLabelsForBulk();if(!ll||!ll.length)return;
    try{
      await api('/api/files/bulk-label',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:ids,label_ids:ll})});
      notify('Label ditambahkan ke '+ids.length+' foto.','ok');exitPSelMode();load();
    }catch(e){notify('Gagal: '+e.message,'err')}
  };
  document.getElementById('pFavBtn').onclick=async()=>{
    const ids=[...sel.ids];if(!ids.length)return;
    try{
      const r=await api('/api/files/bulk-favorite',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:ids,fav:true})});
      notify(r.count+' foto ditandai favorit.','ok');exitPSelMode();load();
    }catch(e){notify('Gagal: '+e.message,'err')}
  };
  document.getElementById('pDlBtn').onclick=()=>{
    const ids=[...sel.ids];if(!ids.length)return;
    notify(ids.length>1?'Menyiapkan ZIP berisi '+ids.length+' file…':'Mengunduh 1 file…','info');
    location.href='/api/files/download-zip?ids='+ids.join(',');
    exitPSelMode();
  };
  document.getElementById('pDelBtn').onclick=async()=>{
    const ids=[...sel.ids];if(!ids.length)return;
    if(!await confirmDlg({ico:'🗑',title:'Hapus '+ids.length+' foto?',msg:'Dipindah ke Tong Sampah. Bisa dikembalikan dalam 7 hari.',yes:'Ya, hapus',danger:true}))return;
    try{
      await api('/api/files/bulk-trash',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({file_ids:ids,folder_ids:[]})});
      exitPSelMode();load();
      notify(ids.length+' foto dipindah ke Tong Sampah.','ok');
    }catch(e){notify('Gagal: '+e.message,'err')}
  };

  /* ---------- sort & view via ikon ---------- */
  const SORTS=[['taken-desc','Terbaru dulu'],['taken-asc','Terlama dulu'],['date-desc','Upload terbaru'],['size-desc','Ukuran terbesar'],['size-asc','Ukuran terkecil'],['name-asc','Nama A–Z']];
  const sortKey=()=>S.sort+'-'+S.order;
  function closeSortMenu(){const m=document.getElementById('sortMenu');if(m)m.remove()}
  document.getElementById('psortBtn').onclick=e=>{
    e.stopPropagation();closeSortMenu();
    const m=document.createElement('div');m.className='popmenu';m.id='sortMenu';
    m.innerHTML='<div class="pmtitle">Urutkan</div>'+SORTS.map(s=>'<button data-v="'+s[0]+'" class="'+(sortKey()===s[0]?'on':'')+'">'+(sortKey()===s[0]?'✓ ':'')+s[1]+'</button>').join('');
    document.body.appendChild(m);
    const r=e.currentTarget.getBoundingClientRect();
    m.style.top=(r.bottom+6)+'px';m.style.right=Math.max(8,window.innerWidth-r.right)+'px';
    m.querySelectorAll('button').forEach(b=>b.onclick=ev=>{ev.stopPropagation();const[s,o]=b.dataset.v.split('-');S.sort=s;S.order=o;closeSortMenu();exitPSelMode();load()});
    setTimeout(()=>document.addEventListener('click',closeSortMenu,{once:true}),0);
  };
  const VIEWS=['grid','compact','list'],VICON={grid:'mi-grid-view',compact:'mi-view-module',list:'mi-view-list'},VNAME={grid:'Grid nyaman',compact:'Grid rapat',list:'Daftar'};
  const pvb=document.getElementById('pviewBtn');
  function setViewIcon(){pvb.innerHTML='<span class="mi '+VICON[S.view]+'"></span>';pvb.title='Tampilan: '+VNAME[S.view]}
  setViewIcon();
  pvb.onclick=()=>{S.view=VIEWS[(VIEWS.indexOf(S.view)+1)%VIEWS.length];setViewIcon();load()};
  /* ---------- auto-hide toolbar foto saat scroll ---------- */
  const fbarWrap=document.getElementById('fbarWrap');
  let barH=0,lastST=0;
  function measureBar(){barH=fbarWrap.scrollHeight;if(fbarWrap.style.maxHeight!=='0px')fbarWrap.style.maxHeight=barH+'px'}
  wrap.addEventListener('scroll',()=>{
    const st=wrap.scrollTop,dy=st-lastST;lastST=st;
    if(Math.abs(dy)<6||!barH)return;
    if(dy>0&&st>140)fbarWrap.style.maxHeight='0px';
    else if(dy<0||st<=140)fbarWrap.style.maxHeight=barH+'px';
  },{passive:true});
  window.addEventListener('resize',measureBar);
  requestAnimationFrame(measureBar);
  loadLabels().then(load);
}
