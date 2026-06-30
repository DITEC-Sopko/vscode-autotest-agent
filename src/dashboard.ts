import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { loadConfiguration, saveUserRole, saveEnvironmentConfig, saveLoginConfig, saveLoginPassword, saveDebugConfig, savePreferredCodeModel, saveTfsConfig, saveTfsPat } from './config';
import { getBugHistory } from './bug-input';

type Status = 'passed' | 'failed' | 'unknown';

interface TestItem { name: string; status: Status; lastRunAt?: string; }

function readStatus(testDir: string): { status: Status; mtime?: number } {
    const rp = path.join(testDir, 'result.md');
    if (!fs.existsSync(rp)) { return { status: 'unknown' }; }
    try {
        const c = fs.readFileSync(rp, 'utf-8').toUpperCase();
        const m = c.match(/VERDIKT:\s*\**\s*(PASSED|FAILED|SUCCESS|FAIL)/);
        const status: Status = m ? (m[1].startsWith('PASS') || m[1] === 'SUCCESS' ? 'passed' : 'failed')
            : c.includes('FAIL') ? 'failed' : c.includes('PASS') ? 'passed' : 'unknown';
        return { status, mtime: fs.statSync(rp).mtimeMs };
    } catch { return { status: 'unknown' }; }
}

function listTests(ws: string): TestItem[] {
    const dir = path.join(ws, 'autotest');
    if (!fs.existsSync(dir)) { return []; }
    return fs.readdirSync(dir)
        .filter(e => fs.statSync(path.join(dir, e)).isDirectory() && e !== 'data' && !e.startsWith('_') && e !== 'steps')
        .map(name => {
            const { status, mtime } = readStatus(path.join(dir, name));
            return { name, status, lastRunAt: mtime ? new Date(mtime).toLocaleString('sk-SK') : undefined };
        });
}

function escapeHtml(v: string): string {
    return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Pokus o autodiscovery TFS/Azure DevOps MCP servera v .vscode/mcp.json. */
function discoverTfsMcp(ws: string): { found: boolean; message: string; org?: string; project?: string } {
    const candidates = [path.join(ws, '.vscode', 'mcp.json'), path.join(ws, 'mcp.json')];
    for (const file of candidates) {
        if (!fs.existsSync(file)) { continue; }
        let root: any;
        try { root = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { continue; }
        const servers = (root && (root.servers || root.mcpServers)) || {};
        for (const name of Object.keys(servers)) {
            const s: any = servers[name] || {};
            const hay = (name + ' ' + JSON.stringify(s)).toLowerCase();
            if (!/azure-devops|azuredevops|devops|\btfs\b|\bado\b/.test(hay)) { continue; }
            const env: any = s.env || {};
            const args: string[] = Array.isArray(s.args) ? s.args : [];
            let org: string | undefined = env.ADO_ORGANIZATION || env.AZURE_DEVOPS_ORG || env.AZURE_DEVOPS_ORGANIZATION || env.ADO_ORG || env.AZURE_DEVOPS_ORG_URL;
            let project: string | undefined = env.ADO_PROJECT || env.AZURE_DEVOPS_PROJECT;
            if (!org) {
                const pkgIdx = args.findIndex(a => typeof a === 'string' && /azure-devops|devops|mcp/.test(a.toLowerCase()));
                for (let i = pkgIdx + 1; i < args.length; i++) {
                    if (typeof args[i] === 'string' && !args[i].startsWith('-')) { org = args[i]; break; }
                }
            }
            const orgUrl = org ? (/^https?:\/\//.test(org) ? org : `https://dev.azure.com/${org}`) : undefined;
            return {
                found: true,
                message: `Nájdený MCP server „${name}“${orgUrl ? ` (org: ${orgUrl})` : ''}. Doplň token (PAT).`,
                org: orgUrl, project
            };
        }
    }
    return { found: false, message: 'V .vscode/mcp.json sa nenašiel žiadny TFS / Azure DevOps MCP server.' };
}

async function buildState(context: vscode.ExtensionContext) {
    const cfg = loadConfiguration(context);
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    let models: { id: string; name: string }[] = [];
    try { models = (await vscode.lm.selectChatModels({ vendor: 'copilot' })).map(m => ({ id: m.id, name: m.name || m.id })); } catch { /* ignore */ }
    return {
        hasWorkspace: !!ws,
        initialized: !!(ws && fs.existsSync(path.join(ws, 'autotest'))),
        role: cfg.userRole, appType: cfg.appType, appUrl: cfg.appUrl, tfsEnabled: cfg.tfsEnabled,
        loginRequired: !!cfg.loginRequired, username: cfg.username || '', headless: cfg.headlessMode !== false,
        models, preferredModel: cfg.preferredCodeModelId || '', tfsOrg: cfg.tfsOrganization || '', tfsProject: cfg.tfsProject || '',
        tfsAssignedToMe: cfg.tfsAssignedToMe !== false, tfsStates: cfg.tfsStates || 'Proposed, Active', tfsTypes: cfg.tfsTypes || 'Bug, Requirement, Test Case',
        tests: ws ? listTests(ws) : [],
        history: getBugHistory(context, 5)
    };
}

function sendPromptToChat(prompt: string): void {
    vscode.commands.executeCommand('workbench.action.chat.open', { query: `@autotest ${prompt}` });
}

let reportPanel: vscode.WebviewPanel | undefined;

export function showReportPanel(ws: string, folder: string): void {
    const testDir = path.join(ws, 'autotest', folder);
    const result = (() => { try { return fs.readFileSync(path.join(testDir, 'result.md'), 'utf-8'); } catch { return ''; } })();
    const { status } = readStatus(testDir);
    if (!reportPanel) {
        reportPanel = vscode.window.createWebviewPanel('autotest.report', `Report: ${folder}`, vscode.ViewColumn.Active,
            { enableScripts: true, localResourceRoots: [vscode.Uri.file(path.join(ws, 'autotest'))], retainContextWhenHidden: true });
        reportPanel.onDidDispose(() => { reportPanel = undefined; });
    }
    reportPanel.title = `Report: ${folder}`;
    reportPanel.reveal();
    const stepsDir = path.join(testDir, 'steps');
    const imgs: { uri: string; cap: string }[] = [];
    if (fs.existsSync(stepsDir)) {
        for (const f of fs.readdirSync(stepsDir).filter(f => /\.(png|jpe?g|webp)$/i.test(f)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
            imgs.push({ uri: reportPanel.webview.asWebviewUri(vscode.Uri.file(path.join(stepsDir, f))).toString(), cap: f.replace(/\.\w+$/, '').replace(/[_-]/g, ' ') });
        }
    }
    const color = status === 'passed' ? '#2ea043' : status === 'failed' ? '#d1242f' : '#888';
    const badge = status === 'passed' ? '✅ PASSED' : status === 'failed' ? '❌ FAILED' : '❔ N/A';
    const steps = imgs.length ? imgs.map((s, i) => `<div class="step"><div class="h">Krok ${i + 1}: ${escapeHtml(s.cap)}</div><img src="${s.uri}"/></div>`).join('') : '<p class="m">Žiadne screenshoty.</p>';
    reportPanel.webview.html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{font-family:var(--vscode-font-family);padding:16px;color:var(--vscode-foreground)}
.b{display:inline-block;padding:4px 14px;border-radius:14px;color:#fff;font-weight:600;background:${color}}
.s{background:var(--vscode-textBlockQuote-background);border-left:3px solid ${color};padding:10px 14px;border-radius:4px;white-space:pre-wrap;font-size:13px}
.step{margin:14px 0;border:1px solid var(--vscode-panel-border);border-radius:6px;overflow:hidden}.h{padding:8px 12px;background:var(--vscode-editorWidget-background);font-weight:600}.step img{display:block;width:100%}.m{opacity:.6}
</style></head><body><h1>${escapeHtml(folder)} <span class="b">${badge}</span></h1>
<div class="s">${escapeHtml(result || 'Report bez obsahu.')}</div><h2>Kroky</h2>${steps}</body></html>`;
}

function html(): string {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{font-family:var(--vscode-font-family);font-size:13px;color:var(--vscode-foreground);padding:8px;min-width:240px;box-sizing:border-box}
.toolbar{display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;padding:5px 10px;border-radius:4px;cursor:pointer}
button.sec{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
.meta{opacity:.8;margin-bottom:10px;line-height:1.6}
.filters{display:flex;gap:4px;margin:8px 0;flex-wrap:wrap}.filters button{font-size:11px;padding:2px 8px}
.card{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:1px solid var(--vscode-panel-border);border-left-width:4px;border-radius:6px;margin-bottom:6px}
.card.p{border-left-color:#2ea043}.card.f{border-left-color:#d1242f}.card.u{border-left-color:#888}
.card.g{border-left-color:#d4af37;background:rgba(212,175,55,.10)}
.card.hl{animation:hlpulse 1.8s ease}
@keyframes hlpulse{0%{box-shadow:0 0 0 0 rgba(212,175,55,.0)}15%{box-shadow:0 0 0 3px rgba(212,175,55,.65)}100%{box-shadow:0 0 0 0 rgba(212,175,55,0)}}
.card .top{display:flex;align-items:center;gap:8px;min-width:0}
.card .bot{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.badge{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;letter-spacing:.4px;white-space:nowrap;flex:none}
.badge.p{background:rgba(46,160,67,.18);color:#3fb950}.badge.f{background:rgba(209,36,47,.18);color:#f85149}.badge.u{background:rgba(136,136,136,.18);color:#9aa0a6}
.badge.g{background:rgba(212,175,55,.22);color:#e3b341}
.name{flex:1;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.time{opacity:.6;font-size:11px;margin-right:auto}
.acts{display:flex;gap:4px;flex-wrap:wrap}.acts button{font-size:11px;padding:2px 8px}
#add{background:#2ea043;color:#fff;font-weight:600}
h3{margin:12px 0 6px}
.sec-h{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;opacity:.7;margin:4px 0 8px}
.panel{display:none;border:1px solid var(--vscode-panel-border);border-radius:6px;padding:10px;margin-bottom:10px}
.panel.open{display:block}.row{display:flex;flex-direction:column;gap:3px;margin-bottom:8px}
label{font-size:11px;opacity:.8}input,select{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);padding:4px;border-radius:4px;max-width:100%;box-sizing:border-box}
.chk{flex-direction:row;align-items:center;gap:6px}.chk input{width:auto}
input:disabled,select:disabled{opacity:.5;cursor:not-allowed}
.dim{opacity:.45;pointer-events:none}
.wzbar{display:flex;gap:8px;justify-content:center;margin:6px 0 14px}
.wzdot{width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;background:var(--vscode-input-background);border:1px solid var(--vscode-panel-border);opacity:.5}
.wzdot.act{background:#8957e5;color:#fff;opacity:1;border-color:#8957e5}.wzdot.done{background:#2ea043;color:#fff;opacity:1;border-color:#2ea043}
.wzttl{font-weight:700;margin-bottom:10px}.wznav{display:flex;gap:6px;margin-top:14px;flex-wrap:wrap}
#startwiz{background:#8957e5;color:#fff;font-weight:600;font-size:13px;padding:8px 16px}
.notinit{text-align:center;padding:26px 8px}.notinit h2{margin:8px 0;font-size:16px}.notinit p{opacity:.7;font-size:12px;margin:0 0 6px}
.w_finish{background:#2ea043;color:#fff}
.ihelp{display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;border-radius:50%;border:1px solid currentColor;font-size:10px;cursor:pointer;opacity:.7;margin-left:4px;vertical-align:middle}
.helpbox{display:none;font-size:11px;line-height:1.5;background:var(--vscode-textBlockQuote-background);border-left:3px solid #8957e5;border-radius:4px;padding:8px 10px;margin:2px 0 10px}
.helpbox.open{display:block}.helpbox ol{margin:4px 0;padding-left:18px}.helpbox .lnk{color:var(--vscode-textLink-foreground);cursor:pointer;text-decoration:underline}
</style></head><body>
<div id="main">
<div class="toolbar"><button id="add">+ Test</button><button class="sec" id="set">⚙ Nastavenia</button><button class="sec" id="ref">⟳</button></div>
<div class="meta" id="meta"></div>
<div class="panel" id="settings">
 <div class="row"><label>Rola</label><select id="s_role"><option value="developer">developer</option><option value="tester">tester</option></select></div>
 <div class="row"><label>Typ aplikácie</label><select id="s_type"><option value="web">web</option><option value="desktop">desktop</option></select></div>
 <div class="row"><label>URL / cesta</label><input id="s_url"/></div>
 <div class="row chk"><input type="checkbox" id="s_login"/><label>Vyžaduje prihlásenie</label></div>
 <div id="loginfields">
  <div class="row"><label>Používateľ</label><input id="s_user"/></div>
  <div class="row"><label>Heslo (uloží sa pri vyplnení)</label><input type="password" id="s_pwd"/></div>
 </div>
 <div class="row chk"><input type="checkbox" id="s_head"/><label>Headless (neviditeľný)</label></div>
 <div class="row"><label>AI model</label><select id="s_model"></select></div>
 <hr style="border-color:var(--vscode-panel-border);width:100%;margin:6px 0 12px"/>
 <div class="sec-h">TFS / Azure DevOps</div>
 <div class="row chk"><input type="checkbox" id="s_tfs"/><label>TFS zapnuté</label></div>
 <div id="tfsfields">
  <div class="row"><label>TFS organization URL</label><input id="s_tfsorg"/></div>
  <div class="row"><label>TFS projekt</label><input id="s_tfsproj"/></div>
  <div class="row"><label>TFS token (PAT) <span class="ihelp" id="s_patinfo" title="Ako vytvoriť PAT">?</span></label><input type="password" id="s_tfspat"/></div>
  <div class="helpbox" id="s_pathelp">
   <b>Ako vytvoriť PAT (Personal Access Token):</b>
   <ol><li>V Azure DevOps klikni vpravo hore na ikonu používateľa → <b>User settings → Personal access tokens</b>.</li>
   <li><b>+ New Token</b> → názov, organizácia, expirácia.</li>
   <li><b>Scopes → Work Items → Read</b> (na čítanie bugov).</li>
   <li><b>Create</b> → skopíruj token (zobrazí sa len raz) a vlož ho sem.</li></ol>
   <span class="lnk" id="s_patdocs">📖 Otvoriť oficiálny návod</span>
  </div>
  <div class="row chk"><input type="checkbox" id="s_tfsme"/><label>Iba priradené mne (@Me)</label></div>
  <div class="row"><label>Stavy (čiarkou)</label><input id="s_tfsstates"/></div>
  <div class="row"><label>Typy (čiarkou)</label><input id="s_tfstypes"/></div>
 </div>
 <div style="display:flex;gap:6px"><button id="s_save">Uložiť</button></div>
</div>
<div class="filters"><button data-f="all">Všetky</button><button data-f="passed">✅</button><button data-f="failed">❌</button><button data-f="unknown">❔</button></div>
<h3>Testy</h3><div id="tests"></div>
<div id="tfsbugs" style="display:none">
 <h3 id="tfshdr" style="display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none"><span id="tfschev">▸</span>TFS bugy <button class="sec" id="loadbugs" title="Znovu načítať" style="font-size:11px;padding:2px 8px">↻</button></h3>
 <div id="bugswrap" style="display:none"><div id="bugs"></div></div>
</div>
</div>
<div id="initview" style="display:none">
 <div id="notinit" class="notinit">
  <div style="font-size:34px">🧪</div>
  <h2>Autotest nie je ešte inicializovaný</h2>
  <p>Priprav projekt v krátkom sprievodcovi.</p>
  <button id="startwiz">🚀 Inicializovať projekt</button>
 </div>
 <div id="wizard" style="display:none">
  <div class="wzbar"><span class="wzdot" data-s="1">1</span><span class="wzdot" data-s="2">2</span><span class="wzdot" data-s="3">3</span></div>
  <div class="wzttl" id="wztitle"></div>
  <div class="wzstep" data-step="1">
   <div class="row"><label>Rola</label><select id="w_role"><option value="developer">developer</option><option value="tester">tester</option></select></div>
   <div class="row"><label>Typ projektu</label><select id="w_type"><option value="web">web</option><option value="desktop">desktop</option></select></div>
   <div class="row"><label id="w_urllbl">URL aplikácie</label><input id="w_url" placeholder="https://…"/></div>
  </div>
  <div class="wzstep" data-step="2" style="display:none">
   <div class="row chk"><input type="checkbox" id="w_login"/><label>Projekt vyžaduje prihlásenie</label></div>
   <div id="w_loginfields" style="display:none">
    <div class="row"><label>Používateľ</label><input id="w_user"/></div>
    <div class="row"><label>Heslo (uloží sa do secure storage)</label><input type="password" id="w_pwd"/></div>
   </div>
  </div>
  <div class="wzstep" data-step="3" style="display:none">
   <div class="row chk"><input type="checkbox" id="w_tfs"/><label>Pripojiť TFS / Azure DevOps</label></div>
   <div id="w_tfsfields" style="display:none">
    <button class="sec" id="w_discover" style="font-size:11px;padding:3px 8px;margin-bottom:8px">🔍 Skúsiť nájsť TFS MCP v projekte</button>
    <div id="w_disc" style="font-size:11px;opacity:.8;margin-bottom:8px"></div>
    <div class="row"><label>Organization URL</label><input id="w_tfsorg" placeholder="https://dev.azure.com/org"/></div>
    <div class="row"><label>Projekt</label><input id="w_tfsproj"/></div>
    <div class="row"><label>Personal Access Token (PAT) <span class="ihelp" id="w_patinfo" title="Ako vytvoriť PAT">?</span></label><input type="password" id="w_tfspat"/></div>
    <div class="helpbox" id="w_pathelp">
     <b>Ako vytvoriť PAT:</b>
     <ol><li>Azure DevOps → ikona používateľa → <b>User settings → Personal access tokens</b>.</li>
     <li><b>+ New Token</b> → názov, organizácia, expirácia.</li>
     <li><b>Scopes → Work Items → Read</b>.</li>
     <li><b>Create</b> → skopíruj token a vlož ho sem.</li></ol>
     <span class="lnk" id="w_patdocs">📖 Otvoriť oficiálny návod</span>
    </div>
   </div>
  </div>
  <div class="wznav">
   <button class="sec" id="w_back" style="display:none">← Späť</button>
   <button id="w_next">Ďalej →</button>
   <button id="w_finish" class="w_finish" style="display:none">✓ Dokončiť</button>
   <button class="sec" id="w_cancel">Zrušiť</button>
  </div>
 </div>
</div>
<script>
const v=acquireVsCodeApi();let st={},flt='all';
function send(a,p){v.postMessage({action:a,...p})}
document.getElementById('add').onclick=()=>send('add');
document.getElementById('set').onclick=()=>document.getElementById('settings').classList.toggle('open');
document.getElementById('ref').onclick=()=>send('refresh');
let bugsLoaded=false;
function loadBugs(){document.getElementById('bugs').innerHTML='<p style="opacity:.6">Načítavam…</p>';bugsLoaded=true;send('loadBugs');}
document.getElementById('loadbugs').onclick=(e)=>{e.stopPropagation();loadBugs();};
document.getElementById('tfshdr').onclick=()=>{
 const w=document.getElementById('bugswrap');const open=w.style.display==='none';
 w.style.display=open?'block':'none';document.getElementById('tfschev').textContent=open?'▾':'▸';
 if(open&&!bugsLoaded)loadBugs();
};
document.getElementById('s_save').onclick=()=>send('saveSettings',{role:s_role.value,appType:s_type.value,appUrl:s_url.value,login:s_login.checked,username:s_user.value,password:s_pwd.value,headless:s_head.checked,model:s_model.value,tfs:s_tfs.checked,tfsOrg:s_tfsorg.value,tfsProject:s_tfsproj.value,tfsPat:s_tfspat.value,tfsMe:s_tfsme.checked,tfsStates:s_tfsstates.value,tfsTypes:s_tfstypes.value});
document.querySelectorAll('.filters button').forEach(b=>b.onclick=()=>{flt=b.dataset.f;render()});
function setDim(id,on){const el=document.getElementById(id);if(!el)return;el.classList.toggle('dim',!on);el.querySelectorAll('input,select').forEach(i=>i.disabled=!on);}
function syncDisabled(){setDim('loginfields',document.getElementById('s_login').checked);setDim('tfsfields',document.getElementById('s_tfs').checked);}
document.getElementById('s_login').addEventListener('change',syncDisabled);
document.getElementById('s_tfs').addEventListener('change',syncDisabled);
// Inicializačný sprievodca
let wzStep=1;const wzT={1:'1/3 · Základné údaje',2:'2/3 · Prihlásenie',3:'3/3 · TFS / Azure DevOps'};
function wzShow(){
 document.querySelectorAll('.wzstep').forEach(s=>s.style.display=(+s.dataset.step===wzStep)?'block':'none');
 document.querySelectorAll('.wzdot').forEach(d=>{const n=+d.dataset.s;d.className='wzdot'+(n===wzStep?' act':n<wzStep?' done':'');});
 document.getElementById('wztitle').textContent=wzT[wzStep];
 document.getElementById('w_back').style.display=wzStep>1?'inline-block':'none';
 document.getElementById('w_next').style.display=wzStep<3?'inline-block':'none';
 document.getElementById('w_finish').style.display=wzStep===3?'inline-block':'none';
 document.getElementById('w_loginfields').style.display=document.getElementById('w_login').checked?'block':'none';
 document.getElementById('w_tfsfields').style.display=document.getElementById('w_tfs').checked?'block':'none';
}
function wzUrlLbl(t){document.getElementById('w_urllbl').textContent=(t==='desktop')?'Cesta k aplikácii (.exe / .appref-ms)':'URL aplikácie';}
document.getElementById('startwiz').onclick=()=>{
 document.getElementById('notinit').style.display='none';document.getElementById('wizard').style.display='block';wzStep=1;
 document.getElementById('w_role').value=(st.role&&st.role!=='unknown')?st.role:'developer';
 document.getElementById('w_type').value=st.appType||'web';document.getElementById('w_url').value=st.appUrl||'';
 wzUrlLbl(st.appType||'web');wzShow();
};
document.getElementById('w_cancel').onclick=()=>{document.getElementById('wizard').style.display='none';document.getElementById('notinit').style.display='block';};
document.getElementById('w_back').onclick=()=>{if(wzStep>1){wzStep--;wzShow();}};
document.getElementById('w_next').onclick=()=>{if(wzStep===1&&!document.getElementById('w_url').value.trim()){document.getElementById('w_url').focus();return;}if(wzStep<3){wzStep++;wzShow();}};
document.getElementById('w_type').onchange=()=>wzUrlLbl(document.getElementById('w_type').value);
document.getElementById('w_login').onchange=wzShow;
document.getElementById('w_tfs').onchange=wzShow;
document.getElementById('w_discover').onclick=()=>{document.getElementById('w_disc').textContent='Hľadám…';send('discoverTfs');};
document.getElementById('s_patinfo').onclick=()=>document.getElementById('s_pathelp').classList.toggle('open');
document.getElementById('w_patinfo').onclick=()=>document.getElementById('w_pathelp').classList.toggle('open');
document.getElementById('s_patdocs').onclick=()=>send('openPatDocs');
document.getElementById('w_patdocs').onclick=()=>send('openPatDocs');
document.getElementById('w_finish').onclick=()=>send('initProject',{
 role:document.getElementById('w_role').value,appType:document.getElementById('w_type').value,appUrl:document.getElementById('w_url').value,
 login:document.getElementById('w_login').checked,username:document.getElementById('w_user').value,password:document.getElementById('w_pwd').value,
 tfs:document.getElementById('w_tfs').checked,tfsOrg:document.getElementById('w_tfsorg').value,tfsProject:document.getElementById('w_tfsproj').value,tfsPat:document.getElementById('w_tfspat').value
});
function render(){
 const init=!!st.initialized;
 document.getElementById('main').style.display=init?'block':'none';
 document.getElementById('initview').style.display=init?'none':'block';
 if(!init){return;}
 const m=document.getElementById('meta');
 m.textContent=st.initialized?('Rola: '+st.role+' · '+st.appType+' · '+(st.appUrl||'')+(st.tfsEnabled?(' · TFS: '+(st.tfsProject||'zapnuté')):' · TFS: vypnuté')):'Projekt nie je inicializovaný.';
 s_role.value=st.role==='unknown'?'developer':st.role;s_type.value=st.appType||'web';s_url.value=st.appUrl||'';
 s_login.checked=!!st.loginRequired;s_user.value=st.username||'';s_head.checked=st.headless!==false;
 s_tfs.checked=!!st.tfsEnabled;s_tfsorg.value=st.tfsOrg||'';s_tfsproj.value=st.tfsProject||'';
 s_tfsme.checked=st.tfsAssignedToMe!==false;s_tfsstates.value=st.tfsStates||'';s_tfstypes.value=st.tfsTypes||'';
 document.getElementById('tfsbugs').style.display=st.tfsEnabled?'block':'none';
 s_model.innerHTML=(st.models||[]).map(x=>'<option value="'+x.id+'">'+x.name+'</option>').join('');if(st.preferredModel)s_model.value=st.preferredModel;
 const t=document.getElementById('tests');t.innerHTML='';
 (st.tests||[]).filter(x=>flt==='all'||x.status===flt).forEach(x=>{
  const c=x.status==='passed'?'p':x.status==='failed'?'f':'u';
  const lbl=x.status==='passed'?'✓ PASSED':x.status==='failed'?'✕ FAILED':'? N/A';
  const d=document.createElement('div');d.className='card '+c;d.id='test-'+x.name;
  d.innerHTML='<div class="top"><span class="badge '+c+'">'+lbl+'</span><span class="name" title="'+x.name+'">'+x.name+'</span></div>'+
   '<div class="bot"><span class="time">'+(x.lastRunAt||'')+'</span><span class="acts"><button data-a="run">Spustiť</button><button class="sec" data-a="scenario">Scenár</button><button class="sec" data-a="report">Report</button></span></div>';
  d.querySelectorAll('button').forEach(b=>b.onclick=()=>send(b.dataset.a,{folder:x.name}));
  t.appendChild(d);});
 syncDisabled();
}
window.addEventListener('message',e=>{
 if(e.data.type==='state'){st=e.data.payload;render();}
 else if(e.data.type==='bugs'){renderBugs(e.data.payload);}
 else if(e.data.type==='discovery'){
  const p=e.data.payload;const el=document.getElementById('w_disc');
  if(p.found){el.innerHTML='✅ '+p.message;if(p.org)document.getElementById('w_tfsorg').value=p.org;if(p.project)document.getElementById('w_tfsproj').value=p.project;if(!document.getElementById('w_tfs').checked){document.getElementById('w_tfs').checked=true;wzShow();}}
  else{el.textContent='ℹ️ '+(p.message||'Nenašiel sa žiadny TFS MCP.');}
 }
});
function renderBugs(p){
 const b=document.getElementById('bugs');
 if(!p.ok){b.innerHTML='<p style="color:#f85149">'+(p.error||'Chyba')+'</p>';return;}
 if(!p.bugs||!p.bugs.length){b.innerHTML='<p style="opacity:.6">Žiadne work items.</p>';return;}
 b.innerHTML='';
 p.bugs.forEach(x=>{
  const has=x.hasTest;const c=has?'g':'u';
  const d=document.createElement('div');d.className='card '+c;
  const act=has?'<button data-a="goTest">K testu →</button>':'<button data-a="bugTest">Vytvoriť test</button>';
  d.innerHTML='<div class="top"><span class="badge '+c+'">#'+x.id+' '+x.type+'</span><span class="name" title="'+x.title.replace(/"/g,'&quot;')+'">'+x.title+'</span></div>'+
   '<div class="bot"><span class="time">'+x.state+(has?' · test vytvorený':'')+'</span><span class="acts">'+act+'</span></div>';
  d.querySelector('button').onclick=()=> has? highlightTest('bug_'+x.id) : send('bugTest',{id:x.id});
  b.appendChild(d);});
}
function highlightTest(name){
 flt='all';render();
 const el=document.getElementById('test-'+name);
 if(el){el.scrollIntoView({behavior:'smooth',block:'center'});el.classList.remove('hl');void el.offsetWidth;el.classList.add('hl');}
 else{send('refresh');}
}
v.postMessage({action:'refresh'});
</script></body></html>`;
}

export class DashboardProvider implements vscode.WebviewViewProvider {
    static viewType = 'autotest.dashboardView';
    constructor(private ctx: vscode.ExtensionContext) {}
    resolveWebviewView(view: vscode.WebviewView): void {
        view.webview.options = { enableScripts: true };
        view.webview.html = html();
        const post = async () => view.webview.postMessage({ type: 'state', payload: await buildState(this.ctx) });
        // Auto-refresh dashboardu keď agent mode dopíše result.md (test dokončený).
        const wsRoot = vscode.workspace.workspaceFolders?.[0];
        if (wsRoot) {
            const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(wsRoot, 'autotest/*/result.md'));
            const onChange = () => { void post(); };
            watcher.onDidCreate(onChange);
            watcher.onDidChange(onChange);
            watcher.onDidDelete(onChange);
            view.onDidDispose(() => watcher.dispose());
        }
        view.webview.onDidReceiveMessage(async (m: any) => {
            const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            switch (m.action) {
                case 'refresh': await post(); return;
                case 'init': await vscode.commands.executeCommand('autotest.init'); await post(); return;
                case 'openPatDocs': vscode.env.openExternal(vscode.Uri.parse('https://learn.microsoft.com/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate')); return;
                case 'discoverTfs': {
                    view.webview.postMessage({ type: 'discovery', payload: ws ? discoverTfsMcp(ws) : { found: false, message: 'Nie je otvorený projekt.' } });
                    return;
                }
                case 'initProject': {
                    await saveUserRole(this.ctx, m.role);
                    await saveEnvironmentConfig(this.ctx, { url: m.appUrl, appType: m.appType, environment: 'local' });
                    await saveLoginConfig(this.ctx, { required: !!m.login, username: m.username || undefined });
                    if (m.password) { await saveLoginPassword(this.ctx, m.password); }
                    await saveTfsConfig(this.ctx, { enabled: !!m.tfs, organization: m.tfsOrg || undefined, project: m.tfsProject || undefined, assignedToMe: true, states: 'Proposed, Active', types: 'Bug, Requirement, Test Case' });
                    if (m.tfsPat) { await saveTfsPat(this.ctx, m.tfsPat); }
                    if (ws && !fs.existsSync(path.join(ws, 'autotest'))) { fs.mkdirSync(path.join(ws, 'autotest'), { recursive: true }); }
                    vscode.window.showInformationMessage('✅ Autotest inicializovaný.');
                    await post(); return;
                }
                case 'add': sendPromptToChat('test'); return;
                case 'run': sendPromptToChat(`run ${m.folder}`); return;
                case 'scenario': if (ws) { const sc = path.join(ws, 'autotest', m.folder, 'test_scenario.md'); if (fs.existsSync(sc)) { vscode.window.showTextDocument(vscode.Uri.file(sc)); } else { vscode.window.showWarningMessage(`Scenár pre ${m.folder} zatiaľ neexistuje.`); } } return;
                case 'report': if (ws) { showReportPanel(ws, m.folder); } return;
                case 'loadBugs': {
                    const res = await vscode.commands.executeCommand('autotest.fetchTfsBugs');
                    view.webview.postMessage({ type: 'bugs', payload: res });
                    return;
                }
                case 'bugTest': sendPromptToChat(`bug #${m.id}`); return;
                case 'saveSettings':
                    await saveUserRole(this.ctx, m.role);
                    await saveEnvironmentConfig(this.ctx, { url: m.appUrl, appType: m.appType, environment: 'local' });
                    await saveLoginConfig(this.ctx, { required: !!m.login, username: m.username || undefined });
                    if (m.password) { await saveLoginPassword(this.ctx, m.password); }
                    await saveDebugConfig(this.ctx, { headless: !!m.headless, slowMo: m.headless ? 0 : 100 });
                    if (m.model) { await savePreferredCodeModel(this.ctx, m.model); }
                    await saveTfsConfig(this.ctx, { enabled: !!m.tfs, organization: m.tfsOrg || undefined, project: m.tfsProject || undefined, assignedToMe: !!m.tfsMe, states: m.tfsStates || undefined, types: m.tfsTypes || undefined });
                    if (m.tfsPat) { await saveTfsPat(this.ctx, m.tfsPat); }
                    if (ws && !fs.existsSync(path.join(ws, 'autotest'))) { fs.mkdirSync(path.join(ws, 'autotest'), { recursive: true }); }
                    vscode.window.showInformationMessage('✅ Nastavenia uložené.');
                    await post(); return;
            }
        });
    }
}
