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
body{font-family:var(--vscode-font-family);font-size:13px;color:var(--vscode-foreground);padding:8px}
.toolbar{display:flex;gap:6px;margin-bottom:10px}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;padding:5px 10px;border-radius:4px;cursor:pointer}
button.sec{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
.meta{opacity:.8;margin-bottom:10px;line-height:1.6}
.filters{display:flex;gap:4px;margin:8px 0}.filters button{font-size:11px;padding:2px 8px}
.card{display:flex;align-items:center;gap:8px;padding:8px;border:1px solid;border-radius:6px;margin-bottom:6px;overflow:hidden}
.card.p{border-color:#2ea043;background:rgba(46,160,67,.10)}.card.f{border-color:#d1242f;background:rgba(209,36,47,.10)}.card.u{border-color:#888;background:rgba(136,136,136,.08)}
.bar{align-self:stretch;width:18px;border-radius:4px;color:#fff;font-weight:700;font-size:9px;letter-spacing:1px;display:flex;align-items:center;justify-content:center;writing-mode:vertical-rl;text-orientation:upright}
.bar.p{background:#2ea043}.bar.f{background:#d1242f}.bar.u{background:#888}
.name{flex:1;font-weight:600}.time{opacity:.6;font-size:11px}.acts button{margin-left:4px;font-size:11px;padding:2px 8px}
#add{background:#8957e5;color:#fff;font-weight:600}
h3{margin:12px 0 6px}
.panel{display:none;border:1px solid var(--vscode-panel-border);border-radius:6px;padding:10px;margin-bottom:10px}
.panel.open{display:block}.row{display:flex;flex-direction:column;gap:3px;margin-bottom:8px}
label{font-size:11px;opacity:.8}input,select{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);padding:4px;border-radius:4px}
.chk{flex-direction:row;align-items:center;gap:6px}.chk input{width:auto}
</style></head><body>
<div class="toolbar"><button id="add">+ Test</button><button class="sec" id="set">⚙ Nastavenia</button><button class="sec" id="ref">⟳</button></div>
<div class="meta" id="meta"></div>
<div class="panel" id="settings">
 <div class="row"><label>Rola</label><select id="s_role"><option value="developer">developer</option><option value="tester">tester</option></select></div>
 <div class="row"><label>Typ aplikácie</label><select id="s_type"><option value="web">web</option><option value="desktop">desktop</option></select></div>
 <div class="row"><label>URL / cesta</label><input id="s_url"/></div>
 <div class="row chk"><input type="checkbox" id="s_login"/><label>Vyžaduje prihlásenie</label></div>
 <div class="row"><label>Používateľ</label><input id="s_user"/></div>
 <div class="row"><label>Heslo (uloží sa pri vyplnení)</label><input type="password" id="s_pwd"/></div>
 <div class="row chk"><input type="checkbox" id="s_head"/><label>Headless (neviditeľný)</label></div>
 <div class="row"><label>AI model</label><select id="s_model"></select></div>
 <hr style="border-color:var(--vscode-panel-border);width:100%"/>
 <div class="row chk"><input type="checkbox" id="s_tfs"/><label>TFS zapnuté</label></div>
 <div class="row"><label>TFS organization URL</label><input id="s_tfsorg"/></div>
 <div class="row"><label>TFS projekt</label><input id="s_tfsproj"/></div>
 <div class="row"><label>TFS token (uloží sa pri vyplnení)</label><input type="password" id="s_tfspat"/></div>
 <div style="display:flex;gap:6px"><button id="s_save">Uložiť</button></div>
</div>
<div class="filters"><button data-f="all">Všetky</button><button data-f="passed">✅</button><button data-f="failed">❌</button><button data-f="unknown">❔</button></div>
<h3>Testy</h3><div id="tests"></div>
<script>
const v=acquireVsCodeApi();let st={},flt='all';
function send(a,p){v.postMessage({action:a,...p})}
document.getElementById('add').onclick=()=>send('add');
document.getElementById('set').onclick=()=>document.getElementById('settings').classList.toggle('open');
document.getElementById('ref').onclick=()=>send('refresh');
document.getElementById('s_save').onclick=()=>send('saveSettings',{role:s_role.value,appType:s_type.value,appUrl:s_url.value,login:s_login.checked,username:s_user.value,password:s_pwd.value,headless:s_head.checked,model:s_model.value,tfs:s_tfs.checked,tfsOrg:s_tfsorg.value,tfsProject:s_tfsproj.value,tfsPat:s_tfspat.value});
document.querySelectorAll('.filters button').forEach(b=>b.onclick=()=>{flt=b.dataset.f;render()});
function render(){
 const m=document.getElementById('meta');
 m.textContent=st.initialized?('Rola: '+st.role+' · '+st.appType+' · '+(st.appUrl||'')):'Projekt nie je inicializovaný.';
 s_role.value=st.role==='unknown'?'developer':st.role;s_type.value=st.appType||'web';s_url.value=st.appUrl||'';
 s_login.checked=!!st.loginRequired;s_user.value=st.username||'';s_head.checked=st.headless!==false;
 s_tfs.checked=!!st.tfsEnabled;s_tfsorg.value=st.tfsOrg||'';s_tfsproj.value=st.tfsProject||'';
 s_model.innerHTML=(st.models||[]).map(x=>'<option value="'+x.id+'">'+x.name+'</option>').join('');if(st.preferredModel)s_model.value=st.preferredModel;
 const t=document.getElementById('tests');t.innerHTML='';
 (st.tests||[]).filter(x=>flt==='all'||x.status===flt).forEach(x=>{
  const c=x.status==='passed'?'p':x.status==='failed'?'f':'u';
  const lbl=x.status==='passed'?'PASSED':x.status==='failed'?'FAILED':'N/A';
  const d=document.createElement('div');d.className='card '+c;
  d.innerHTML='<span class="bar '+c+'">'+lbl+'</span><span class="name">'+x.name+'</span><span class="time">'+(x.lastRunAt||'')+'</span><span class="acts"><button>Spustiť</button><button class="sec">Report</button></span>';
  const[run,rep]=d.querySelectorAll('button');run.onclick=()=>send('run',{folder:x.name});rep.onclick=()=>send('report',{folder:x.name});
  t.appendChild(d);});
}
window.addEventListener('message',e=>{if(e.data.type==='state'){st=e.data.payload;render()}});
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
        view.webview.onDidReceiveMessage(async (m: any) => {
            const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            switch (m.action) {
                case 'refresh': await post(); return;
                case 'init': await vscode.commands.executeCommand('autotest.init'); await post(); return;
                case 'add': sendPromptToChat('test'); return;
                case 'run': sendPromptToChat(`run ${m.folder}`); return;
                case 'report': if (ws) { showReportPanel(ws, m.folder); } return;
                case 'saveSettings':
                    await saveUserRole(this.ctx, m.role);
                    await saveEnvironmentConfig(this.ctx, { url: m.appUrl, appType: m.appType, environment: 'local' });
                    await saveLoginConfig(this.ctx, { required: !!m.login, username: m.username || undefined });
                    if (m.password) { await saveLoginPassword(this.ctx, m.password); }
                    await saveDebugConfig(this.ctx, { headless: !!m.headless, slowMo: m.headless ? 0 : 100 });
                    if (m.model) { await savePreferredCodeModel(this.ctx, m.model); }
                    await saveTfsConfig(this.ctx, { enabled: !!m.tfs, organization: m.tfsOrg || undefined, project: m.tfsProject || undefined });
                    if (m.tfsPat) { await saveTfsPat(this.ctx, m.tfsPat); }
                    if (ws && !fs.existsSync(path.join(ws, 'autotest'))) { fs.mkdirSync(path.join(ws, 'autotest'), { recursive: true }); }
                    vscode.window.showInformationMessage('✅ Nastavenia uložené.');
                    await post(); return;
            }
        });
    }
}
