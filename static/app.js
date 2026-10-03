/* TG Drive frontend */
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function fmtSize(b){if(b==null)return'';b=+b;if(b<1024)return b+' B';const u=['KB','MB','GB'];let i=-1;do{b/=1024;i++}while(b>=1024&&i<2);return b.toFixed(1)+' '+u[i]}
async function api(url,opts){const r=await fetch(url,opts);const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||('HTTP '+r.status));return j}
function fmtDate(iso){if(!iso)return'';const d=new Date(iso);return d.toLocaleDateString('id-ID',{day:'numeric',month:'short',year:'numeric'})}
function fmtDay(iso){const d=new Date(iso),t=new Date();const day=x=>x.toDateString();if(day(d)===day(t))return'Hari Ini';const y=new Date(t);y.setDate(y.getDate()-1);if(day(d)===day(y))return'Kemarin';return d.toLocaleDateString('id-ID',{weekday:'long',day:'numeric',month:'long',year:'numeric'})}

/* ---------- storage info ---------- */
let MAX_UPLOAD=20*1024*1024; // batas upload aktual, diambil dari server
const CF_LIMIT=100*1024*1024; // batas Cloudflare per request (hanya via domain)
// ON_DIRECT diset server via base.html (akurat: bandingkan host dgn direct_url admin)
if(typeof ON_DIRECT==='undefined'){var ON_DIRECT=/^\d{1,3}(\.\d{1,3}){3}$/.test(location.hostname)}
(async()=>{try{const s=await api('/api/storage');const el=document.getElementById('storageInfo');if(el)el.textContent=fmtSize(s.bytes)+' • '+s.count+' file';if(s.max_upload_bytes)MAX_UPLOAD=s.max_upload_bytes}catch(e){}})();

/* ---------- lightbox ---------- */
let lbItems=[],lbIdx=0;
function openLightbox(items,i){lbItems=items;lbIdx=i;renderLb();document.getElementById('lightbox').classList.remove('hidden')}
function renderLb(){const it=lbItems[lbIdx];if(!it)return;const b=document.getElementById('lbBody');
  if(it.kind==='video')b.innerHTML='<video src="/file/'+it.id+'/download" controls autoplay style="max-height:80vh"></video>';
  else if(it.kind==='photo')b.innerHTML='<img src="/file/'+it.id+'/download">';
  else b.innerHTML='<div style="color:#ccc">Pratinjau tidak tersedia.<br><a href="/file/'+it.id+'/download">Unduh '+esc(it.name)+'</a></div>';
  document.getElementById('lbCap').textContent=it.name+' • '+fmtSize(it.size)}
function lbNav(d){if(!lbItems.length)return;lbIdx=(lbIdx+d+lbItems.length)%lbItems.length;renderLb()}
function closeLightbox(){document.getElementById('lightbox').classList.add('hidden');document.getElementById('lbBody').innerHTML=''}
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeLightbox();if(!document.getElementById('lightbox').classList.contains('hidden')){if(e.key==='ArrowRight')lbNav(1);if(e.key==='ArrowLeft')lbNav(-1)}});

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

/* ---------- DRIVE ---------- */
function initDrive(){
  const S={folder:'root',sort:'date',order:'desc',view:'grid',trash:false,q:'',folders:[]};
  const grid=document.getElementById('grid'),empty=document.getElementById('emptyState');
  const crumbs=document.getElementById('crumbs'),lockNote=document.getElementById('lockNote');
  const unlocked=new Set(); // id folder yang sudah dibuka dgn PIN sesi ini
  api('/api/lock/status').then(r=>{(r.unlocked||[]).forEach(id=>unlocked.add(+id))}).catch(()=>{});

  async function openFolder(fid){
    fid=+fid;
    const f=S.folders.find(x=>+x.id===fid);
    if(f&&f.is_locked&&!unlocked.has(fid)){
      const pin=await askPin('🔒 Folder terkunci','Masukkan PIN untuk membuka "'+f.name+'"');
      if(!pin)return;
      try{await api('/api/lock/unlock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({folder_id:fid,pin:pin})});unlocked.add(fid)}
      catch(e){alert(e.message);return}
    }
    S.folder=String(fid);S.trash=false;load();
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
    if(!confirm('Kosongkan tong sampah?\nSemua file dihapus PERMANEN — termasuk dari channel Telegram — dan tidak bisa dikembalikan.'))return;
    try{
      const r=await api('/api/trash/empty',{method:'POST'});
      alert('Tong sampah dikosongkan. '+r.deleted+' file dihapus permanen.'+(r.failed?' ('+r.failed+' gagal)':''));
      load();
    }catch(e){alert('Gagal: '+e.message)}
  }
  function folderChain(fid){
    const byId={};S.folders.forEach(f=>byId[f.id]=f);
    const chain=[];let cur=byId[fid];
    while(cur){chain.unshift(cur);cur=cur.parent_id?byId[cur.parent_id]:null}
    return chain;
  }
  function renderCrumbs(){
    let h='<button class="crumb'+(S.folder==='root'&&!S.trash?' on':'')+'" data-f="root">Drive Saya</button>';
    if(S.folder!=='root'&&!S.trash){
      h+=folderChain(S.folder).map(f=>'<span class="crumb-sep">›</span><button class="crumb'+(String(S.folder)===String(f.id)?' on':'')+'" data-f="'+f.id+'">'+esc(f.name)+'</button>').join('');
    }
    h+='<button class="crumb'+(S.trash?' on':'')+'" data-f="__trash">Tong Sampah</button>';
    crumbs.innerHTML=h;
    crumbs.querySelectorAll('button').forEach(b=>b.onclick=()=>{const v=b.dataset.f;S.trash=(v==='__trash');
      if(v==='__trash'||v==='root'){S.folder='root';load()}else openFolder(v)})}

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
            unlocked.add(+S.folder);return load()}catch(e2){alert(e2.message)}
        }
        S.folder='root';renderCrumbs();return load();
      }
    }
    if(lockNote){lockNote.classList.toggle('hidden',!lockedHidden);if(lockedHidden)lockNote.textContent='🔒 '+lockedHidden+' item di folder terkunci disembunyikan.'}
    renderTrashBar(files);
    grid.className='grid'+(S.view==='list'?' list':'');
    let html='';
    if(!S.trash&&!S.q){
      const subs=S.folders.filter(f=>S.folder==='root'?!f.parent_id:String(f.parent_id)===String(S.folder));
      html+=subs.map(f=>'<div class="fitem folderitem" data-fid="'+f.id+'"><div class="thumb">📁'+(f.is_locked?'<span class="lk">🔒</span>':'')+'</div><div class="meta"><div class="nm">'+esc(f.name)+'</div><div class="sz">Folder</div></div><div class="acts"><button class="kebab" title="Menu">⋮</button></div></div>').join('');
    }
    html+=files.map((f,i)=>{
      const thumb=f.kind==='photo'||f.kind==='video'
        ?'<img src="/file/'+f.id+'/thumb" loading="lazy" onerror="this.parentNode.textContent='+(f.kind==='video'?'🎬':'🖼')+'">'
        :'<div>'+(f.kind==='audio'?'🎵':'📄')+'</div>';
      return '<div class="fitem" data-i="'+i+'"><div class="thumb">'+thumb+'</div><div class="meta"><div class="nm" title="'+esc(f.name)+'">'+esc(f.name)+'</div><div class="sz">'+fmtSize(f.size)+' • '+fmtDate(f.uploaded_at)+(S.trash?'<br><span class="trashcount">'+trashCountdown(f.trashed_at)+'</span>':'')+'</div></div>'+
        '<div class="acts"><button class="kebab" title="Menu">⋮</button></div></div>';
    }).join('');
    grid.innerHTML=html;empty.classList.toggle('hidden',html!=='');
    const items=files;
    grid.querySelectorAll('.fitem').forEach(el=>{
      const fi=el.dataset.fid;
      const kb=el.querySelector('.kebab');
      if(fi!==undefined&&fi!==''){
        const open=()=>openFolder(fi);
        el.querySelector('.thumb').onclick=open;
        el.querySelector('.meta').onclick=open;
        if(kb){kb._folder={fid:fi,el:el};kb.onclick=e=>{e.stopPropagation();openCtxMenu(kb)}}
        return}
      const it=items[+el.dataset.i];
      el.querySelector('.thumb').onclick=()=>{if(it.kind==='photo'||it.kind==='video')openLightbox(items.filter(x=>x.kind==='photo'||x.kind==='video'),items.filter(x=>x.kind==='photo'||x.kind==='video').indexOf(it))};
      if(kb){kb._file=it;kb.onclick=e=>{e.stopPropagation();openCtxMenu(kb)}}
    });
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
        ['ⓘ Properties',()=>folderAct('props',fid,el)],
        ['✏️ Ganti nama',()=>folderAct('rename',fid,el)],
        [fl&&fl.is_locked?'🔓 Buka kunci folder':'🔒 Kunci folder',()=>folderAct(fl&&fl.is_locked?'unlock':'lock',fid,el)],
        ['🗑 Hapus folder',()=>folderAct('del',fid,el)],
      ];
    }else if(kb._file){
      const it=kb._file;
      defs=[['⬇ Unduh',()=>act('dl',it)],['ⓘ Properties',()=>act('props',it)]];
      if(!S.trash)defs.push(['✏️ Ganti nama',()=>act('rename',it)],['🔗 Bagikan',()=>act('share',it)],[(it.favorite?'★ Hapus dari favorit':'☆ Favorit'),()=>act('fav',it)],['🗑 Hapus',()=>act('trash',it)]);
      else defs.push(['↩ Kembalikan',()=>act('restore',it)],['✖ Hapus permanen',()=>act('del',it)]);
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
      if(a==='dl')location.href='/file/'+it.id+'/download';
      else if(a==='trash'&&confirm('Pindahkan "'+it.name+'" ke tong sampah?')){await api('/api/files/'+it.id+'/trash',{method:'POST'});load()}
      else if(a==='restore'){await api('/api/files/'+it.id+'/restore',{method:'POST'});load()}
      else if(a==='del'&&confirm('HAPUS PERMANEN "'+it.name+'"?\nFile juga dihapus dari channel Telegram dan tidak bisa dikembalikan.')){await api('/api/files/'+it.id,{method:'DELETE'});load()}
      else if(a==='fav'){await api('/api/files/'+it.id+'/favorite',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fav:!it.favorite})});load()}
      else if(a==='props')showFileProps(it);
      else if(a==='rename'){const n=await askName('Ganti nama file',it.name);if(n&&n!==it.name){await api('/api/files/'+it.id+'/rename',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:n})});load()}}
      else if(a==='share'){
        const m=modal('<h3>Bagikan "'+esc(it.name)+'"</h3><label style="font-size:.85rem;color:var(--muted)">Berlaku (jam)</label><input id="shHours" type="number" value="24" min="1" max="720"><div class="row"><button class="btn" onclick="this.closest(\'.modal\').remove()">Batal</button><button class="btn primary" id="shGo">Buat Link</button></div><div id="shOut"></div>');
        m.querySelector('#shGo').onclick=async()=>{const r=await api('/api/share',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({file_id:it.id,hours:+m.querySelector('#shHours').value||24})});
          m.querySelector('#shOut').innerHTML='<div class="sharelink">'+esc(r.url)+'</div><div style="font-size:.8rem;color:var(--muted)">Berlaku sampai '+esc(r.expires_at)+'</div>'};
      }
    }catch(e){alert(e.message)}
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
        if(n&&n!==name){await api('/api/folders/'+fid+'/rename',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:n})});await loadFolders();load()}
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
        if(confirm('Hapus folder "'+name+'"?\nFile di dalamnya dipindah ke tong sampah.')){
          const r=await api('/api/folders/'+fid,{method:'DELETE'});
          await loadFolders();S.folder='root';load();
          if(r.trashed_files)alert('Folder dihapus. '+r.trashed_files+' file dipindah ke tong sampah.');
        }
      }
    }catch(e){alert(e.message)}
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
    await loadFolders();load();
  }

  /* antrean upload: cek duplikat dulu, lalu kirim maks 3 paralel */
  async function uploadJobs(jobs){
    queue.classList.remove('hidden');
    let remember=null;
    const ready=[];
    for(const j of jobs){
      const f=j.file;
      if(f.size>MAX_UPLOAD){qitem(f.name,'File maksimal '+fmtSize(MAX_UPLOAD)+'.',true);continue}
      if(f.size>CF_LIMIT&&!ON_DIRECT){qitem(f.name,'⚠ Di atas 100 MB — tidak bisa upload lewat domain (batas Cloudflare). Kecilkan di bawah 100 MB atau pakai ⚡ Max Speed (PRO).',true);continue}
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
        await doUploadP(j.f,j.overwriteId,j.folderId,1);
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
  function qitem(name,status,isErr){const el=document.createElement('div');el.className='qitem'+(isErr?' err':'');
    el.innerHTML='<div><b>'+esc(name)+'</b> — <span></span> <span class="spd"></span></div><div class="bar"><i></i></div>';
    queue.appendChild(el);return{el,status:el.querySelector('span'),spd:el.querySelector('.spd'),bar:el.querySelector('.bar i')}}

  /* toolbar */
  document.getElementById('sort').onchange=e=>{const[s,o]=e.target.value.split('-');S.sort=s;S.order=o;load()};
  let qt;document.getElementById('q').oninput=e=>{clearTimeout(qt);qt=setTimeout(()=>{S.q=e.target.value.trim();load()},350)};
  document.getElementById('viewToggle').onclick=e=>{S.view=S.view==='grid'?'list':'grid';e.target.textContent=S.view==='grid'?'▦':'☰';load()};
  document.getElementById('newFolderBtn').onclick=()=>{const m=modal('<h3>Folder baru</h3><input id="nfName" placeholder="Nama folder"><div class="row"><button class="btn" onclick="this.closest(\'.modal\').remove()">Batal</button><button class="btn primary" id="nfGo">Buat</button></div>');
    m.querySelector('#nfGo').onclick=async()=>{const n=m.querySelector('#nfName').value.trim();if(!n)return;await api('/api/folders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:n,parent_id:S.folder==='root'?null:S.folder})});m.remove();await loadFolders();load()}};
  document.getElementById('trashBtn').onclick=()=>{S.trash=true;S.folder='root';renderCrumbs();load()};

  document.addEventListener('click',e=>{if(!e.target.closest('#ctxmenu'))hideCtxMenu()});
  loadFolders().then(load);
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
        if(!confirm('Hapus akun "'+btn.dataset.n+'"?\n'+btn.dataset.c+' file milik akun ini ikut dihapus dari daftar dan Telegram.'))return;
        const r=await api('/api/accounts/'+id,{method:'DELETE'});
        alert('Akun dihapus ('+r.deleted_files+' file).');load();
      }
    }catch(e){alert(e.message)}
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
  window.handoffGo=handoffGo; // dipakai juga oleh drive.html
  async function loadMaxSpeed(){
    const body=document.getElementById('msBody');
    let info=null;
    try{info=await api('/api/server-info')}catch(e){info=null}
    if(!info||info.error){
      body.innerHTML='<p class="muted">⚡ Max Speed khusus pengguna <b>PRO</b>. Hubungi admin untuk upgrade.</p>';
      return;
    }
    const onDirect=ON_DIRECT;
    body.innerHTML=
      '<p style="font-size:.9rem;margin-bottom:10px">Terhubung via: <b>'+esc(location.host)+'</b> '+
      (onDirect?'<span style="color:#ffd98a">⚡ jalur langsung</span>':'<span class="muted">🌐 domain</span>')+'</p>'+
      '<label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:.95rem">'+
      '<input type="checkbox" id="msToggle" '+(info.max_speed?'checked':'')+' style="width:20px;height:20px;accent-color:var(--acc)">'+
      '<b>Max Speed aktif</b></label>'+
      '<p class="muted" style="font-size:.85rem;margin:8px 0 10px">Aktif = memakai jalur langsung (IP publik) — tanpa batas ±100 MB Cloudflare, upload lebih cepat.'+
      (info.direct_url?'':'<br><span style="color:var(--danger)">Jalur langsung belum diatur admin.</span>')+'</p>'+
      '<div id="msMsg" style="font-size:.85rem;margin-bottom:6px"></div>'+
      '<div style="display:flex;gap:10px;flex-wrap:wrap">'+
      (onDirect
        ?'<button class="btn ghost" id="msBack">← Kembali ke domain</button>'
        :(info.direct_url&&info.max_speed?'<button class="btn primary" id="msGo">⚡ Pindah ke jalur langsung</button>':'')
      )+'</div>';
    const msg=document.getElementById('msMsg');
    const sayM=(t,ok)=>{msg.textContent=t||'';msg.style.color=ok?'#7ddf9a':'var(--danger)'};
    document.getElementById('msToggle').onchange=async(ev)=>{
      const want=ev.target.checked;
      sayM(want?'Mengaktifkan…':'Menonaktifkan…');
      try{
        const r=await api('/api/max-speed',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({max_speed:want})});
        if(!r.ok)throw new Error('gagal');
        sayM(want?'Max Speed aktif ✓':'Max Speed dimatikan ✓',true);
        setTimeout(()=>{
          if(want&&info.direct_url){handoffGo(info.direct_url)}
          else if(!want&&onDirect&&info.domain_url){handoffGo(info.domain_url)}
          else loadMaxSpeed();
        },800);
      }catch(e){ev.target.checked=!want;sayM(e.message,false)}
    };
    const go=document.getElementById('msGo');
    if(go)go.onclick=()=>{handoffGo(info.direct_url)};
    const back=document.getElementById('msBack');
    if(back)back.onclick=async()=>{
      sayM('Menonaktifkan Max Speed…');
      try{await api('/api/max-speed',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({max_speed:false})})}catch(e){}
      handoffGo(info.domain_url);
    };
  }
  loadMaxSpeed();
  /* --- sumber daya --- */
  function setBar(id,frac,txt){const b=document.getElementById(id);b.style.width=Math.min(100,frac*100)+'%';document.getElementById(id+'T').textContent=txt}
  async function pollSys(){
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
  document.getElementById('lApply').onclick=async()=>{
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
  async function loadLock(){
    try{
      const s=await api('/api/lock/status');pinSet=s.pin_set;
      document.getElementById('pinStatus').textContent=pinSet?'PIN sudah diatur.':'Belum ada PIN — atur dulu sebelum mengunci folder.';
      document.getElementById('pinOldWrap').classList.toggle('hidden',!pinSet);
      const fs=(await api('/api/folders')).folders||[];
      const box=document.getElementById('lockFolders');
      box.innerHTML=fs.map(f=>'<div class="lockrow"><span>'+(f.is_locked?'🔒 ':'')+esc(f.name)+'</span><button class="btn ghost" data-id="'+f.id+'" data-lk="'+(f.is_locked?1:0)+'">'+(f.is_locked?'Buka kunci':'Kunci')+'</button></div>').join('')||'<div class="muted">Belum ada folder.</div>';
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
    }catch(e){alert(e.message)}
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
const ACT_LABEL={upload:['⬆️','Mengupload'],overwrite:['🔁','Menimpa'],rename_file:['✏️','Mengganti nama file'],trash:['🗑️','Memindah ke tong sampah'],restore:['↩️','Mengembalikan'],delete:['✖️','Menghapus permanen'],create_folder:['📁','Membuat folder'],rename_folder:['📁','Mengganti nama folder'],delete_folder:['📁','Menghapus folder'],share:['🔗','Membuat link berbagi'],favorite:['★','Menandai favorit'],unfavorite:['☆','Menghapus dari favorit'],switch_account:['👤','Beralih akun'],login:['🔑','Masuk']};
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
  const S={sort:'taken',order:'desc',fav:false,view:'grid'};
  const tl=document.getElementById('timeline'),empty=document.getElementById('emptyState');
  const MONTHS=['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
  const mlabel=ym=>{const[y,m]=ym.split('-');return MONTHS[+m-1]+' '+y};
  const dlabel=f=>{const d=(f.taken_at||f.uploaded_at||'').slice(0,10);return d?fmtDay(d+'T00:00:00'):''};
  function thumb(f,gi){
    const fb=f.kind==='video'?'🎬':'🖼';
    return '<div class="fitem" data-gi="'+gi+'"><div class="thumb"><img src="/file/'+f.id+'/thumb" loading="lazy" onerror="this.remove()">'+fb+'</div>'+(f.kind==='video'?'<div class="vbadge">▶</div>':'')+'</div>';
  }
  async function load(){
    const p=new URLSearchParams({folder:'all',sort:S.sort,order:S.order,kinds:'photo,video'});
    if(S.fav)p.set('fav','1');
    let files=[],lockedHidden=0;
    try{const r=await api('/api/files?'+p);files=r.files||[];lockedHidden=r.locked_hidden||0}catch(e){}
    const ln=document.getElementById('lockNote');
    if(ln){ln.classList.toggle('hidden',!lockedHidden);if(lockedHidden)ln.textContent='🔒 '+lockedHidden+' item di folder terkunci disembunyikan.'}
    // grup per bulan (YYYY-MM)
    const groups={};
    files.forEach(f=>{const ym=(f.taken_at||f.uploaded_at||'').slice(0,7);if(ym)(groups[ym]=groups[ym]||[]).push(f)});
    const keys=Object.keys(groups).sort((a,b)=>S.order==='asc'?a.localeCompare(b):b.localeCompare(a));
    if(S.view==='list'){
      tl.innerHTML=keys.map(k=>'<div class="tl-group"><div class="tl-head">'+esc(mlabel(k))+' <span class="tl-count">'+groups[k].length+' item</span></div>'+
        groups[k].map(f=>{const gi=files.indexOf(f);
          return '<div class="prow" data-gi="'+gi+'"><div class="pthumb"><img src="/file/'+f.id+'/thumb" loading="lazy" onerror="this.remove()">'+(f.kind==='video'?'🎬':'🖼')+'</div><div class="pmeta"><div class="nm">'+esc(f.name)+'</div><div class="sz">'+fmtSize(f.size)+' · '+esc(dlabel(f))+'</div></div></div>'}).join('')+'</div>').join('');
    }else{
      tl.innerHTML=keys.map(k=>'<div class="tl-group"><div class="tl-head">'+esc(mlabel(k))+' <span class="tl-count">'+groups[k].length+' item</span></div><div class="tl-grid'+(S.view==='compact'?' compact':'')+'">'+
        groups[k].map(f=>thumb(f,files.indexOf(f))).join('')+'</div></div>').join('');
    }
    empty.classList.toggle('hidden',files.length>0);
    tl.querySelectorAll('[data-gi]').forEach(el=>el.onclick=()=>openLightbox(files,+el.dataset.gi));
  }
  document.getElementById('psort').onchange=e=>{const[s,o]=e.target.value.split('-');S.sort=s;S.order=o;load()};
  document.getElementById('favToggle').onclick=e=>{S.fav=!S.fav;e.target.style.borderColor=S.fav?'var(--acc)':'';load()};
  document.querySelectorAll('#pview button').forEach(b=>b.onclick=()=>{S.view=b.dataset.v;document.querySelectorAll('#pview button').forEach(x=>x.classList.toggle('on',x===b));load()});
  load();
}
