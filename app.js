const state = {
  agent: 'codex',
  mode: localStorage.getItem('remoto.transport') || 'local',
  localUrl: localStorage.getItem('remoto.localUrl') || 'http://127.0.0.1:8081',
  relayUrl: localStorage.getItem('remoto.relayUrl') || '',
  hostId: localStorage.getItem('remoto.hostId') || '',
  token: localStorage.getItem('remoto.token') || '',
  connected: false,
  status: null,
  threads: { codex: [], claude: [] },
  current: { codex: null, claude: null },
  sendMode: 'queue',
  relay: null,
  relayPending: new Map(),
  liveBuffers: { codex: '', claude: '' },
  eventSource: null
};

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function toggleTheme() {
  const dark = document.documentElement.dataset.theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'light' : 'dark';
  $('theme-toggle-btn').textContent = dark ? 'Tema: Claro' : 'Tema: Escuro';
}
function openSettingsModal(){ $('modal-gateway').classList.remove('hidden'); fillSettings(); }
function closeSettingsModal(){ $('modal-gateway').classList.add('hidden'); }
function selectConnectionMode(mode){
  if (mode === 'api') return;
  state.mode = mode === 'relay' ? 'relay' : 'local';
  $('mode-sub-btn').classList.toggle('active', state.mode === 'local');
  $('mode-relay-btn').classList.toggle('active', state.mode === 'relay');
  $('form-sub-container').classList.toggle('hidden', state.mode !== 'local');
  $('form-relay-container').classList.toggle('hidden', state.mode !== 'relay');
}
function fillSettings(){
  selectConnectionMode(state.mode === 'relay' ? 'relay' : 'sub');
  $('local-bridgeurl-input').value = state.localUrl;
  $('local-token-input').value = state.token;
  $('relay-bridgeurl-input').value = state.relayUrl;
  $('relay-hostid-input').value = state.hostId;
  $('relay-token-input').value = state.token;
}
function saveConnectionSettings(){
  if (state.mode === 'relay') {
    state.relayUrl = $('relay-bridgeurl-input').value.trim();
    state.hostId = $('relay-hostid-input').value.trim();
    state.token = $('relay-token-input').value.trim();
  } else {
    state.localUrl = $('local-bridgeurl-input').value.trim().replace(/\/$/, '');
    state.token = $('local-token-input').value.trim();
  }
  localStorage.setItem('remoto.transport', state.mode);
  localStorage.setItem('remoto.localUrl', state.localUrl);
  localStorage.setItem('remoto.relayUrl', state.relayUrl);
  localStorage.setItem('remoto.hostId', state.hostId);
  localStorage.setItem('remoto.token', state.token);
  closeSettingsModal();
  reconnect().catch(showError);
}

class RelayTransport {
  async connect(){
    if (!state.relayUrl || !state.hostId || !state.token) throw new Error('Preencha Relay URL, Host ID e token.');
    if (state.relay?.readyState === WebSocket.OPEN) return;
    await new Promise((resolve,reject)=>{
      const ws = new WebSocket(state.relayUrl);
      state.relay = ws;
      const timer = setTimeout(()=>reject(new Error('Timeout conectando ao Relay.')),10000);
      ws.onopen=()=>ws.send(JSON.stringify({type:'hello',role:'client',hostId:state.hostId,token:state.token}));
      ws.onmessage=e=>{
        let m; try{m=JSON.parse(e.data)}catch{return}
        if(m.type==='hello/ok'){clearTimeout(timer);resolve();return}
        if(m.type==='event'){handleAgentEvent(m.event);return}
        if(m.type==='response'){
          const p=state.relayPending.get(m.id); if(!p)return; state.relayPending.delete(m.id); clearTimeout(p.timer);
          if(m.error)p.reject(new Error(m.error)); else p.resolve(m.result);
        }
      };
      ws.onerror=()=>{clearTimeout(timer);reject(new Error('Falha no WebSocket Relay.'))};
      ws.onclose=()=>{state.connected=false;updateHostStatus()};
    });
  }
  async request(method,path,body={},query={}){
    await this.connect();
    const id=crypto.randomUUID();
    const request={method,path,body,query,token:state.token};
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{state.relayPending.delete(id);reject(new Error('Timeout da requisição Relay.'))},30000);
      state.relayPending.set(id,{resolve,reject,timer});
      state.relay.send(JSON.stringify({type:'request',id,request}));
    });
  }
}
const relayTransport = new RelayTransport();

async function api(method,path,body=null,query={}){
  if(state.mode==='relay'){
    const result=await relayTransport.request(method,path,body||{},query);
    if(result.status>=400) throw new Error(result.body?.error || `HTTP ${result.status}`);
    return result.body;
  }
  if(!state.token) throw new Error('Configure o pairing token do Host.');
  const url=new URL(state.localUrl+path);
  Object.entries(query).forEach(([k,v])=>{if(v!==null&&v!==undefined)url.searchParams.set(k,v)});
  const res=await fetch(url,{method,headers:{'Content-Type':'application/json','x-pairing-token':state.token},body:body?JSON.stringify(body):undefined});
  const data=await res.json().catch(()=>({}));
  if(!res.ok)throw new Error(data.error||`HTTP ${res.status}`);
  return data;
}

async function reconnect(){
  state.connected=false; updateHostStatus();
  if(state.eventSource){state.eventSource.close();state.eventSource=null}
  if(state.mode==='relay') await relayTransport.connect();
  const status=await api('GET','/api/status');
  state.status=status; state.connected=true; state.hostId=status.hostname || state.hostId; updateHostStatus(); updateAgentBadges();
  if(state.mode==='local') startSse();
  await Promise.all([syncThreads('codex'),syncThreads('claude')]);
}
function startSse(){
  const url=`${state.localUrl}/api/events?token=${encodeURIComponent(state.token)}`;
  state.eventSource=new EventSource(url);
  state.eventSource.onmessage=e=>{try{handleAgentEvent(JSON.parse(e.data))}catch{}};
}
function updateHostStatus(){
  $('nav-host-id').textContent=state.connected?(state.status?.hostname||state.hostId||'Online'):'Host offline';
  $('nav-dot-indicator').className='status-indicator-dot '+(state.connected?'dot-green':'');
}
function updateAgentBadges(){
  const c=state.status?.agents?.codex; const a=state.status?.agents?.claude;
  $('codex-sub-badge').textContent=c?.ready?(c.authenticated?'ChatGPT conectado':'Codex online'):(c?.error?'Codex indisponível':'Offline');
  $('claude-sub-badge').textContent=a?.installed?(a.authenticated?'Claude conectado':'Claude não logado'):'Claude indisponível';
}

async function runPingTest(){
  const box=$('ping-test-result'),text=$('ping-test-text'); if(box)box.classList.remove('hidden'); if(text)text.textContent='Testando...';
  try{await reconnect(); if(text)text.textContent=`Conectado a ${state.status.hostname}. Codex: ${state.status.agents.codex.ready?'OK':'falha'} · Claude: ${state.status.agents.claude.installed?'OK':'falha'}`}
  catch(e){state.connected=false;updateHostStatus();if(text)text.textContent=`Falha: ${e.message}`}
}

async function connectSubscriptionOneClick(provider){
  if(!provider){openSettingsModal();return}
  try{
    if(provider==='codex'){
      const r=await api('POST','/api/codex/login/device',{});
      const url=r.verificationUrl||r.verification_url||'https://auth.openai.com/codex/device';
      const code=r.userCode||r.user_code||'';
      alert(`Login Codex\n\nAbra:\n${url}\n\nCódigo: ${code}\n\nDepois volte e clique em Atualizar.`);
    }else{
      const s=await api('GET','/api/status');
      if(s.agents?.claude?.installed) alert('Claude Code está instalado. Esta V2 usa a autenticação já existente do Claude Code no PC. Se ainda não estiver logado, execute "claude" uma vez no terminal do Host e faça o login oficial.');
      else alert('Claude Code CLI não foi encontrado no PATH do Host.');
    }
  }catch(e){showError(e)}
}

function switchAgentTab(agent){
  state.agent=agent;
  ['codex','claude'].forEach(a=>{ $(`tab-btn-${a}`).classList.toggle('active',a===agent); $(`${a}-remote-container`).classList.toggle('active',a===agent); });
}
function threadTitle(t){return t.title||t.name||t.preview||t.id||'Sem título'}
async function syncThreads(agent){
  try{const r=await api('GET','/api/threads',null,{agent}); state.threads[agent]=r.data||[]; renderThreads(agent)}catch(e){renderEmpty(agent,e.message)}
}
function renderThreads(agent,filter=''){
  const el=$(`${agent}-threads-list`); const list=state.threads[agent].filter(t=>threadTitle(t).toLowerCase().includes(filter.toLowerCase()));
  if(!list.length)return renderEmpty(agent,'Nenhuma tarefa ainda.');
  el.innerHTML=list.map(t=>`<div class="thread-card-item" onclick="openThreadDetail('${agent}','${esc(t.id)}')"><div><div class="thread-title">${esc(threadTitle(t))}</div><div class="caption-sm text-mute">${esc(t.cwd||t.status||t.id)}</div></div><span class="badge-pill-sm">${esc(t.status||'idle')}</span></div>`).join('');
}
function renderEmpty(agent,message){$(`${agent}-threads-list`).innerHTML=`<div class="empty-state-card"><div class="empty-title">${esc(message)}</div><div class="empty-desc">Crie uma nova tarefa para começar.</div></div>`}
function filterThreads(agent,value){renderThreads(agent,value)}
function toggleProjectMenu(){}

async function createNewTask(agent){
  try{
    const cwd=prompt('Pasta do projeto no PC host:', state.status?.cwd||''); if(cwd===null)return;
    const title=prompt('Nome da tarefa:',agent==='codex'?'Nova tarefa Codex':'Nova sessão Claude'); if(title===null)return;
    const model=agent==='claude'?$('claude-model-select').value:undefined;
    const t=await api('POST','/api/threads',{agent,cwd,title,model}); await syncThreads(agent); await openThreadDetail(agent,t.id);
  }catch(e){showError(e)}
}
async function openThreadDetail(agent,id){
  try{
    const t=await api('GET','/api/thread',null,{agent,id}); state.current[agent]=id;
    $(`${agent}-list-screen`).classList.remove('active'); $(`${agent}-detail-screen`).classList.add('active');
    $(`${agent}-chat-title`).textContent=threadTitle(t); const sub=$(`${agent}-chat-sub`); if(sub)sub.textContent=t.cwd||id;
    renderConversation(agent,t); state.liveBuffers[agent]='';
  }catch(e){showError(e)}
}
function closeThreadDetail(agent){$(`${agent}-detail-screen`).classList.remove('active');$(`${agent}-list-screen`).classList.add('active');state.current[agent]=null;syncThreads(agent)}
function renderConversation(agent,t){
  const feed=$(`${agent}-chat-feed`); let msgs=[];
  if(agent==='claude') msgs=t.messages||[]; else msgs=extractCodexMessages(t);
  feed.innerHTML=msgs.length?msgs.map(m=>bubble(m.role,m.content)).join(''):`<div class="chat-bubble agent-response-text">Sessão pronta. Envie uma instrução.</div>`;
  feed.scrollTop=feed.scrollHeight;
}
function extractCodexMessages(t){
  const out=[]; const turns=t.turns||[];
  for(const turn of turns){for(const item of turn.items||[]){
    const type=item.type||''; const role=(type.includes('user')||item.role==='user')?'user':'assistant';
    const text=item.text||item.content?.map?.(x=>x.text||'').join('')||item.message||'';
    if(text)out.push({role,content:text});
  }} return out;
}
function bubble(role,content){const cls=role==='user'?'user-message':'agent-response-text';return `<div class="chat-bubble ${cls}">${esc(content).replace(/\n/g,'<br>')}</div>`}
function appendBubble(agent,role,text,id=''){const feed=$(`${agent}-chat-feed`);const div=document.createElement('div');div.className=`chat-bubble ${role==='user'?'user-message':'agent-response-text'}`;if(id)div.id=id;div.textContent=text;feed.appendChild(div);feed.scrollTop=feed.scrollHeight;return div}

function toggleSendMode(){state.sendMode=state.sendMode==='queue'?'steer':'queue';$('codex-mode-label').textContent=state.sendMode==='queue'?'Sequência':'Steer';$('codex-mode-icon').textContent=state.sendMode==='queue'?'+':'↳'}
async function sendChatMessage(agent){
  const id=state.current[agent]; if(!id)return;
  const input=$(`${agent}-input-field`); const promptText=input.value.trim(); if(!promptText)return; input.value=''; appendBubble(agent,'user',promptText);
  state.liveBuffers[agent]=''; appendBubble(agent,'assistant','',`live-${agent}`);
  try{await api('POST','/api/message',{agent,threadId:id,prompt:promptText,sendMode:agent==='codex'?state.sendMode:'queue',model:agent==='claude'?$('claude-model-select').value:undefined})}
  catch(e){const live=$(`live-${agent}`);if(live)live.textContent=`Erro: ${e.message}`}
}
async function interruptCurrent(agent){const id=state.current[agent];if(!id)return;try{await api('POST','/api/interrupt',{agent,threadId:id})}catch(e){showError(e)}}

function handleAgentEvent(ev){
  const agent=ev.agent; if(!agent)return; const p=ev.params||{}; const threadId=p.threadId||p.thread?.id;
  if(ev.method==='approval/request'&&agent==='codex'){renderApproval(ev);return}
  if(ev.method==='item/agentMessage/delta'&&threadId===state.current[agent]){
    const delta=p.delta||p.text||''; state.liveBuffers[agent]+=delta; let live=$(`live-${agent}`); if(!live)live=appendBubble(agent,'assistant','',`live-${agent}`); live.textContent=state.liveBuffers[agent]; live.parentElement.scrollTop=live.parentElement.scrollHeight; return;
  }
  if(ev.method==='item/toolUse'&&threadId===state.current[agent]) appendBubble(agent,'assistant',`Ferramenta: ${p.name}`);
  if(ev.method==='turn/completed'){
    if(threadId===state.current[agent]){const live=$(`live-${agent}`);if(live)live.removeAttribute('id');state.liveBuffers[agent]=''; setTimeout(()=>openThreadDetail(agent,threadId).catch(()=>{}),350)}
    syncThreads(agent); return;
  }
  if(ev.method==='turn/error'&&threadId===state.current[agent]) appendBubble(agent,'assistant',`Erro: ${p.message||'execução falhou'}`);
}
function renderApproval(ev){
  if(state.current.codex && ev.params?.threadId && ev.params.threadId!==state.current.codex)return;
  const feed=$('codex-chat-feed');const box=document.createElement('div');box.className='chat-bubble agent-response-text';
  const method=ev.approvalMethod||ev.params?.method||ev.method; const detail=ev.params?.command||ev.params?.reason||JSON.stringify(ev.params||{}).slice(0,500);
  box.innerHTML=`<strong>Aprovação necessária</strong><br><span class="caption-sm">${esc(method)}</span><br><code>${esc(detail)}</code><br><br><button class="button-secondary" data-d="decline">Negar</button> <button class="button-primary" data-d="accept">Aprovar</button>`;
  box.querySelectorAll('button').forEach(btn=>btn.onclick=async()=>{try{await api('POST','/api/approval',{agent:'codex',requestId:ev.requestId,decision:btn.dataset.d});box.innerHTML=`Decisão enviada: ${esc(btn.dataset.d)}`;}catch(e){showError(e)}});feed.appendChild(box);feed.scrollTop=feed.scrollHeight;
}

function showError(err){console.error(err);alert(err?.message||String(err))}
function openOptionsModal(agent){interruptCurrent(agent)}
function closeDiffModal(){}
function generateNewPairingCode(){alert('O token é gerado pelo Host. Copie o valor mostrado por npm run host.');}
function togglePasswordVisibility(){}

window.addEventListener('load',async()=>{
  const savedTheme=localStorage.getItem('remoto.theme'); if(savedTheme)document.documentElement.dataset.theme=savedTheme;
  if(state.token){try{await reconnect()}catch(e){console.warn(e.message);updateHostStatus()}} else {updateHostStatus();openSettingsModal()}
});
