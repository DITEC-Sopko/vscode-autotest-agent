import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { loadConfiguration, saveEnvironmentConfig, saveLoginConfig, saveLoginPassword, saveDebugConfig, savePreferredCodeModel, saveTfsConfig, saveTfsPat } from './config';
import { getBugHistory } from './bug-input';

type Status = 'passed' | 'failed' | 'unknown';

/** Signál, že používateľ REÁLNE klikol „Spustiť v agent mode" (marker `.running` zapísaný) → dashboard sa hneď obnoví. */
export const launchSignal = new vscode.EventEmitter<void>();

/** Signál na obnovu dashboardu (napr. po regenerácii scenára) → refresh stavu aj TFS bugov, aby ⚠ neaktuálnosť zmizla. */
export const dashboardRefreshSignal = new vscode.EventEmitter<void>();

interface TestItem { name: string; status: Status; lastRunAt?: string; running?: boolean; }

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

/**
 * Časové okná pre indikátor „beží":
 *  - MARKER: po kliknutí „Spustiť v agent mode" drží „beží" bez ohľadu na aktivitu (pokryje štart:
 *    načítanie toolov, spustenie browsera, login — kým padne prvý screenshot).
 *  - ACTIVITY: po tom, čo sa začala aktivita, „beží" pokiaľ sa transcript/steps menili za posledných toto okno.
 */
const RUNNING_MARKER_GRACE_MS = 90_000;
const RUNNING_ACTIVITY_WINDOW_MS = 45_000;

/** Najnovší mtime súboru priamo v priečinku (nerekurzívne). 0 ak neexistuje/prázdny. */
function latestChildMtime(dir: string): number {
    if (!fs.existsSync(dir)) { return 0; }
    let last = 0;
    try { for (const f of fs.readdirSync(dir)) { const mt = fs.statSync(path.join(dir, f)).mtimeMs; if (mt > last) { last = mt; } } } catch { /* ignore */ }
    return last;
}

/**
 * Test „beží", ak platí:
 *  (a) existuje marker `.running` (zapísaný pri reálnom spustení) novší než result.md a mladší než MARKER grace
 *      — pokryje štart pred prvým výstupom (nábeh toolov/browsera/login), alebo
 *  (b) beží marker tohto testu a nejaká aktivita (transcript.md / steps / zdieľaný _mcp_output, kam Playwright MCP
 *      píše screenshoty a dokumenty počas behu) sa menila za posledné ACTIVITY okno a result.md ešte nie je novší
 *      (agent píše transcript.md aj result.md až na konci — počas behu sa mení hlavne _mcp_output).
 */
function isRunning(testDir: string): boolean {
    const rp = path.join(testDir, 'result.md');
    const resM = fs.existsSync(rp) ? fs.statSync(rp).mtimeMs : 0;
    const marker = path.join(testDir, '.running');
    const hasMarker = fs.existsSync(marker);
    const markerM = hasMarker ? fs.statSync(marker).mtimeMs : 0;
    // Keď indikátor „beží" pre tento test zhasne, zmaž zvyšný marker `.running`. Marker je zdieľane citlivý:
    // pokým existuje, aktivita v spoločnom _mcp_output (kam píše KTORÝKOĽVEK bežiaci test) by tento test
    // falošne rozsvietila. Vyčistením markera zabránime, aby zvyšné markery po nedobehnutých testoch svietili.
    const clearMarker = () => { try { fs.rmSync(marker, { force: true }); } catch { /* ignore */ } };
    // Test dobehol (result.md je novší než marker) → marker sa zmaže vo finalizeTest, ale kým sa tak stane, nesvieť.
    if (hasMarker && resM > markerM) { clearMarker(); return false; }
    // (a) Štartovacie okno hneď po kliknutí, kým nabehnú tooly/browser/login a padne prvý výstup.
    if (hasMarker && (Date.now() - markerM) < RUNNING_MARKER_GRACE_MS) { return true; }

    // (b) Aktivita: transcript.md, steps/ a — pri bežiacom markeri — zdieľaný _mcp_output.
    let last = 0;
    const tr = path.join(testDir, 'transcript.md');
    if (fs.existsSync(tr)) { last = Math.max(last, fs.statSync(tr).mtimeMs); }
    last = Math.max(last, latestChildMtime(path.join(testDir, 'steps')));
    if (hasMarker) { last = Math.max(last, latestChildMtime(path.join(path.dirname(testDir), '_mcp_output'))); }
    const running = last !== 0 && (Date.now() - last) < RUNNING_ACTIVITY_WINDOW_MS && resM <= last;
    // Marker prežil štartovacie okno a test už nie je aktívny → je zvyšný (nedobehnutý test). Zmaž ho,
    // aby ho neskoršia aktivita iného testu v zdieľanom _mcp_output znovu falošne nerozsvietila.
    if (!running && hasMarker) { clearMarker(); }
    return running;
}

function listTests(ws: string): TestItem[] {
    const dir = path.join(ws, 'autotest');
    if (!fs.existsSync(dir)) { return []; }
    return fs.readdirSync(dir)
        .filter(e => fs.statSync(path.join(dir, e)).isDirectory() && e !== 'data' && !e.startsWith('_') && e !== 'steps')
        .map(name => {
            const testDir = path.join(dir, name);
            const { status, mtime } = readStatus(testDir);
            return { name, status, lastRunAt: mtime ? new Date(mtime).toLocaleString('sk-SK') : undefined, running: isRunning(testDir) };
        });
}

/** Z absolútnej cesty vytiahne názov test priečinka (prvý segment za autotest/). */
function extractFolder(fsPath: string, ws: string): string | undefined {
    const rel = path.relative(path.join(ws, 'autotest'), fsPath);
    const seg = rel.split(/[\\/]/)[0];
    return seg && !seg.startsWith('..') ? seg : undefined;
}

/**
 * Po dokončení testu: skopíruje vygenerované dokumenty z autotest/_mcp_output do steps/ testu
 * (aby boli v reporte) a zmaže _mcp_output. Idempotentné — po zmazaní je ďalšie volanie no-op.
 */
function finalizeTest(ws: string, folder: string): void {
    // Test skončil (result.md sa zapísal) → zmaž bežiaci marker.
    try { fs.rmSync(path.join(ws, 'autotest', folder, '.running'), { force: true }); } catch { /* ignore */ }
    const mcpOut = path.join(ws, 'autotest', '_mcp_output');
    if (!fs.existsSync(mcpOut)) { return; }
    const stepsDir = path.join(ws, 'autotest', folder, 'steps');
    const keep = /\.(pdf|docx?|xlsx?|xlsm|csv|xml|txt|html?|json|png|jpe?g|webp|gif)$/i;
    try {
        if (!fs.existsSync(stepsDir)) { fs.mkdirSync(stepsDir, { recursive: true }); }
        for (const f of fs.readdirSync(mcpOut)) {
            const src = path.join(mcpOut, f);
            try {
                if (!fs.statSync(src).isFile() || !keep.test(f)) { continue; }
                fs.copyFileSync(src, path.join(stepsDir, `doc_${f}`));
            } catch { /* ignore */ }
        }
        fs.rmSync(mcpOut, { recursive: true, force: true });
    } catch { /* ignore */ }
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
        appType: cfg.appType, appUrl: cfg.appUrl, tfsEnabled: cfg.tfsEnabled,
        loginRequired: !!cfg.loginRequired, username: cfg.username || '', headless: cfg.headlessMode !== false,
        models, preferredModel: cfg.preferredCodeModelId || '', tfsOrg: cfg.tfsOrganization || '', tfsProject: cfg.tfsProject || '',
        tfsAssignedToMe: cfg.tfsAssignedToMe !== false, tfsStates: cfg.tfsStates || 'Proposed, Active', tfsTypes: cfg.tfsTypes || 'Bug, Requirement, Test Case',
        tests: ws ? listTests(ws) : [],
        testFolders: ws ? listTests(ws).map(t => t.name) : [],
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
        reportPanel.webview.onDidReceiveMessage((msg: any) => {
            if (msg?.type === 'openDoc' && typeof msg.path === 'string') {
                const abs = path.resolve(msg.path);
                if (abs.startsWith(path.join(ws, 'autotest'))) { vscode.commands.executeCommand('vscode.open', vscode.Uri.file(abs)); }
            }
        });
    }
    reportPanel.title = `Report: ${folder}`;
    reportPanel.reveal();
    const stepsDir = path.join(testDir, 'steps');
    const imgs: { uri: string; cap: string }[] = [];
    const docs: { name: string; fsPath: string }[] = [];
    const docExt = /\.(pdf|docx?|xlsx?|xlsm|csv|xml|txt|html?|json)$/i;
    if (fs.existsSync(stepsDir)) {
        const files = fs.readdirSync(stepsDir).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        for (const f of files.filter(f => /\.(png|jpe?g|webp)$/i.test(f))) {
            imgs.push({ uri: reportPanel.webview.asWebviewUri(vscode.Uri.file(path.join(stepsDir, f))).toString(), cap: f.replace(/\.\w+$/, '').replace(/[_-]/g, ' ') });
        }
        for (const f of files.filter(f => docExt.test(f))) {
            docs.push({ name: f.replace(/^doc_/, ''), fsPath: path.join(stepsDir, f) });
        }
    }
    const color = status === 'passed' ? '#2ea043' : status === 'failed' ? '#d1242f' : '#888';
    const badge = status === 'passed' ? '✅ PASSED' : status === 'failed' ? '❌ FAILED' : '❔ N/A';
    const steps = imgs.length ? imgs.map((s, i) => `<div class="step"><div class="h">Krok ${i + 1}: ${escapeHtml(s.cap)}</div><img src="${s.uri}"/></div>`).join('') : '<p class="m">Žiadne screenshoty.</p>';
    const docsHtml = docs.length ? `<h2>Dokumenty</h2><div class="docs">${docs.map(d => `<button class="doc" data-p="${escapeHtml(d.fsPath)}">📄 ${escapeHtml(d.name)}</button>`).join('')}</div>` : '';
    reportPanel.webview.html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
body{font-family:var(--vscode-font-family);padding:16px;color:var(--vscode-foreground)}
.b{display:inline-block;padding:4px 14px;border-radius:14px;color:#fff;font-weight:600;background:${color}}
.s{background:var(--vscode-textBlockQuote-background);border-left:3px solid ${color};padding:10px 14px;border-radius:4px;white-space:pre-wrap;font-size:13px}
.step{margin:14px 0;border:1px solid var(--vscode-panel-border);border-radius:6px;overflow:hidden}.h{padding:8px 12px;background:var(--vscode-editorWidget-background);font-weight:600}.step img{display:block;width:100%}.m{opacity:.6}
.docs{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}
.doc{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:none;padding:6px 12px;border-radius:4px;cursor:pointer;font-size:13px}
</style></head><body><h1>${escapeHtml(folder)} <span class="b">${badge}</span></h1>
<div class="s">${escapeHtml(result || 'Report bez obsahu.')}</div>${docsHtml}<h2>Kroky</h2>${steps}
<script>const vs=acquireVsCodeApi();document.querySelectorAll('.doc').forEach(b=>b.onclick=()=>vs.postMessage({type:'openDoc',path:b.dataset.p}));</script>
</body></html>`;
}

function html(version: string): string {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
:root{--brand-teal:#009ca6;--brand-teal-2:#33b7bf;--brand-green:#8bc53f;--brand-grad:linear-gradient(135deg,#009ca6,#8bc53f)}
body{font-family:var(--vscode-font-family);font-size:13px;color:var(--vscode-foreground);padding:8px;min-width:240px;box-sizing:border-box}
.toolbar{display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;padding:5px 10px;border-radius:4px;cursor:pointer}
button.sec{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
.meta{opacity:.8;margin-bottom:10px;line-height:1.6}
.filters{display:flex;gap:4px;margin:8px 0;flex-wrap:wrap}.filters button{font-size:11px;padding:2px 8px}
.card{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:1px solid var(--vscode-panel-border);border-left-width:4px;border-radius:6px;margin-bottom:6px;position:relative;overflow:hidden}
.card.p{border-left-color:#2ea043}.card.f{border-left-color:#d1242f}.card.u{border-left-color:#888}
.card.st-new{border-left-color:#9aa0a6}.card.st-act{border-left-color:#1f9cf0}.card.st-res{border-left-color:#e3b341}.card.st-done{border-left-color:#3fb950}.card.st-rem{border-left-color:#d1242f}
.card.linked{background:rgba(0,156,166,.10)}
.card.hl{animation:hlpulse 1.8s ease}
@keyframes hlpulse{0%{box-shadow:0 0 0 0 rgba(0,156,166,0)}15%{box-shadow:0 0 0 3px rgba(0,156,166,.65)}100%{box-shadow:0 0 0 0 rgba(0,156,166,0)}}
.card.run{border-left-color:var(--brand-green);animation:runglow 1.7s ease-in-out infinite}
@keyframes runglow{0%,100%{box-shadow:0 0 0 0 rgba(139,197,63,0)}50%{box-shadow:0 0 0 3px rgba(139,197,63,.5)}}
.card.run::before{content:'';position:absolute;left:0;top:0;height:2px;width:40%;background:linear-gradient(90deg,transparent,var(--brand-green),transparent);animation:runsh 1.3s linear infinite}
@keyframes runsh{0%{transform:translateX(-100%)}100%{transform:translateX(350%)}}
.card.gen::after,.card.appear::after{content:'';position:absolute;left:0;top:0;height:3px;width:45%;background:linear-gradient(90deg,transparent,var(--brand-green),transparent);box-shadow:0 0 8px var(--brand-green);animation:gensweep 1.2s ease-out 1}
@keyframes gensweep{0%{transform:translateX(-120%);opacity:0}12%{opacity:1}88%{opacity:1}100%{transform:translateX(320%);opacity:0}}
.card.appear{animation:cardin .5s ease}
@keyframes cardin{0%{opacity:0;transform:translateY(-8px) scale(.98)}100%{opacity:1;transform:none}}
.runchip{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;background:rgba(139,197,63,.18);color:var(--brand-green);flex:none}
.runchip .dot{width:7px;height:7px;border-radius:50%;background:var(--brand-green);animation:runblink 1s ease-in-out infinite}
@keyframes runblink{0%,100%{opacity:.3}50%{opacity:1}}
.card .top{display:flex;align-items:center;gap:8px;min-width:0}
.card .bot{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.badge{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;letter-spacing:.4px;white-space:nowrap;flex:none}
.badge.p{background:rgba(46,160,67,.18);color:#3fb950}.badge.f{background:rgba(209,36,47,.18);color:#f85149}.badge.u{background:rgba(136,136,136,.18);color:#9aa0a6}
.badge.st-new{background:rgba(154,160,166,.18);color:#b9bcc2}.badge.st-act{background:rgba(31,156,240,.20);color:#3794ff}.badge.st-res{background:rgba(227,179,65,.20);color:#e3b341}.badge.st-done{background:rgba(63,185,80,.20);color:#5bbf52}.badge.st-rem{background:rgba(209,36,47,.18);color:#f85149}
.badge.linked{background:rgba(0,156,166,.20);color:var(--brand-teal-2)}
.name{flex:1;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.time{opacity:.6;font-size:11px;margin-right:auto}
.acts{display:flex;gap:4px;flex-wrap:wrap}.acts button{font-size:11px;padding:2px 8px}.acts button.del{color:#f85149;border:1px solid rgba(248,81,73,.35)}
.outwarn{font-size:11px;line-height:1.4;color:#e3b341;background:rgba(227,179,65,.12);border-left:3px solid #e3b341;border-radius:4px;padding:5px 8px;margin-top:2px}
#add{background:var(--brand-teal);color:#fff;font-weight:700}
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
.wzdot.act{background:var(--brand-teal);color:#fff;opacity:1;border-color:var(--brand-teal)}.wzdot.done{background:var(--brand-green);color:#062;opacity:1;border-color:var(--brand-green)}
.wzttl{font-weight:700;margin-bottom:10px}.wznav{display:flex;gap:6px;margin-top:14px;flex-wrap:wrap}
#startwiz{background:var(--brand-grad);color:#fff;font-weight:600;font-size:13px;padding:8px 16px}
.notinit{text-align:center;padding:26px 8px}.notinit h2{margin:8px 0;font-size:16px}.notinit p{opacity:.7;font-size:12px;margin:0 0 6px}
.w_finish{background:#2ea043;color:#fff}
.ihelp{display:inline-flex;align-items:center;justify-content:center;width:15px;height:15px;border-radius:50%;border:1px solid currentColor;font-size:10px;cursor:pointer;opacity:.7;margin-left:4px;vertical-align:middle}
.helpbox{display:none;font-size:11px;line-height:1.5;background:var(--vscode-textBlockQuote-background);border-left:3px solid var(--brand-teal);border-radius:4px;padding:8px 10px;margin:2px 0 10px}
.helpbox.open{display:block}.helpbox ol{margin:4px 0;padding-left:18px}.helpbox .lnk{color:var(--vscode-textLink-foreground);cursor:pointer;text-decoration:underline}
.foot{margin-top:16px;padding-top:8px;border-top:1px solid var(--vscode-panel-border);text-align:center;font-size:10px;opacity:.55;letter-spacing:.3px}
</style></head><body>
<div id="main">
<div class="toolbar"><button id="add">+ Test</button><button class="sec" id="set">⚙ Nastavenia</button><button class="sec" id="ref">⟳</button></div>
<div class="meta" id="meta"></div>
<div class="panel" id="settings">
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
<div class="foot">Autotest Agent · v${version}</div>
<script>
const v=acquireVsCodeApi();let st={},flt='all';let knownTests=null;const sweeping=new Set();const appearing=new Set();
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
document.getElementById('s_save').onclick=()=>send('saveSettings',{appType:s_type.value,appUrl:s_url.value,login:s_login.checked,username:s_user.value,password:s_pwd.value,headless:s_head.checked,model:s_model.value,tfs:s_tfs.checked,tfsOrg:s_tfsorg.value,tfsProject:s_tfsproj.value,tfsPat:s_tfspat.value,tfsMe:s_tfsme.checked,tfsStates:s_tfsstates.value,tfsTypes:s_tfstypes.value});
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
 appType:document.getElementById('w_type').value,appUrl:document.getElementById('w_url').value,
 login:document.getElementById('w_login').checked,username:document.getElementById('w_user').value,password:document.getElementById('w_pwd').value,
 tfs:document.getElementById('w_tfs').checked,tfsOrg:document.getElementById('w_tfsorg').value,tfsProject:document.getElementById('w_tfsproj').value,tfsPat:document.getElementById('w_tfspat').value
});
function render(){
 const init=!!st.initialized;
 document.getElementById('main').style.display=init?'block':'none';
 document.getElementById('initview').style.display=init?'none':'block';
 if(!init){return;}
 const m=document.getElementById('meta');
 m.textContent=st.initialized?(st.appType+' · '+(st.appUrl||'')+(st.tfsEnabled?(' · TFS: '+(st.tfsProject||'zapnuté')):' · TFS: vypnuté')):'Projekt nie je inicializovaný.';
 s_type.value=st.appType||'web';s_url.value=st.appUrl||'';
 s_login.checked=!!st.loginRequired;s_user.value=st.username||'';s_head.checked=st.headless!==false;
 s_tfs.checked=!!st.tfsEnabled;s_tfsorg.value=st.tfsOrg||'';s_tfsproj.value=st.tfsProject||'';
 s_tfsme.checked=st.tfsAssignedToMe!==false;s_tfsstates.value=st.tfsStates||'';s_tfstypes.value=st.tfsTypes||'';
 document.getElementById('tfsbugs').style.display=st.tfsEnabled?'block':'none';
 s_model.innerHTML=(st.models||[]).map(x=>'<option value="'+x.id+'">'+x.name+'</option>').join('');if(st.preferredModel)s_model.value=st.preferredModel;
 const t=document.getElementById('tests');t.innerHTML='';
 const allNames=(st.tests||[]).map(x=>x.name);
 // Nový test (napr. vygenerovaný z TFS) → naskočí s animáciou príchodu.
 if(knownTests){allNames.forEach(n=>{if(!knownTests.has(n)){appearing.add(n);setTimeout(()=>{appearing.delete(n);const e=document.getElementById('test-'+n);if(e)e.classList.remove('appear');},1300);}});}
 (st.tests||[]).filter(x=>flt==='all'||x.status===flt).forEach(x=>{
  const c=x.status==='passed'?'p':x.status==='failed'?'f':'u';
  const lbl=x.status==='passed'?'✓ PASSED':x.status==='failed'?'✕ FAILED':'? N/A';
  const d=document.createElement('div');d.className='card '+c+(x.running?' run':'')+(sweeping.has(x.name)?' gen':'')+(appearing.has(x.name)?' appear':'');d.id='test-'+x.name;
  const runchip=x.running?'<span class="runchip"><span class="dot"></span>beží…</span>':'';
  const regBtn=/^bug_/.test(x.name)?'<button class="sec" data-a="regenerate" title="Znovu vygenerovať scenár z aktuálneho stavu bugu">↻ Regen</button>':'';
  d.innerHTML='<div class="top"><span class="badge '+c+'">'+lbl+'</span><span class="name" title="'+x.name+'">'+x.name+'</span>'+runchip+'</div>'+
   '<div class="bot"><span class="time">'+(x.lastRunAt||'')+'</span><span class="acts"><button data-a="run">Spustiť</button><button class="sec" data-a="scenario">Scenár</button><button class="sec" data-a="report">Report</button>'+regBtn+'<button class="sec del" data-a="delete" title="Zmazať test">🗑</button></span></div>';
  d.querySelectorAll('button').forEach(b=>b.onclick=()=>{if(b.dataset.a==='run'||b.dataset.a==='regenerate')genSweep(x.name);send(b.dataset.a,{folder:x.name});});
  t.appendChild(d);});
 knownTests=new Set(allNames);
 syncDisabled();
}
window.addEventListener('message',e=>{
 if(e.data.type==='state'){st=e.data.payload;render();if(lastBugs&&lastBugs.ok)renderBugs(lastBugs);}
 else if(e.data.type==='bugs'){renderBugs(e.data.payload);}
 else if(e.data.type==='reloadBugs'){if(lastBugs)send('loadBugs');}
 else if(e.data.type==='discovery'){
  const p=e.data.payload;const el=document.getElementById('w_disc');
  if(p.found){el.innerHTML='✅ '+p.message;if(p.org)document.getElementById('w_tfsorg').value=p.org;if(p.project)document.getElementById('w_tfsproj').value=p.project;if(!document.getElementById('w_tfs').checked){document.getElementById('w_tfs').checked=true;wzShow();}}
  else{el.textContent='ℹ️ '+(p.message||'Nenašiel sa žiadny TFS MCP.');}
 }
});
function bugStateClass(state){
 const s=(state||'').toLowerCase();
 if(/closed|done|complete/.test(s))return 'st-done';
 if(/resolved|ready|fixed/.test(s))return 'st-res';
 if(/active|committed|progress|doing|investigat/.test(s))return 'st-act';
 if(/removed|rejected/.test(s))return 'st-rem';
 return 'st-new';
}
function stateColor(state){
 const s=(state||'').toLowerCase();
 if(/closed|done|complete/.test(s))return '#3fb950';
 if(/resolved|ready|fixed/.test(s))return '#e3b341';
 if(/active|committed|progress|doing|investigat/.test(s))return '#1f9cf0';
 if(/removed|rejected/.test(s))return '#d1242f';
 return '#9aa0a6';
}
function typeColor(type){
 const t=(type||'').toLowerCase();
 if(/bug|chyba/.test(t))return '#CC293D';
 if(/task|úloha|uloha/.test(t))return '#F2CB1D';
 if(/requirement|user story|product backlog|story|požiadav|poziadav/.test(t))return '#009CCC';
 if(/feature/.test(t))return '#773B93';
 if(/epic/.test(t))return '#FF7B00';
 if(/issue/.test(t))return '#B4009E';
 if(/test case|test scen/.test(t))return '#00897B';
 return '#8a8a8a';
}
let lastBugs=null;
function renderBugs(p){
 lastBugs=p;
 const b=document.getElementById('bugs');
 if(!p.ok){b.innerHTML='<p style="color:#f85149">'+(p.error||'Chyba')+'</p>';return;}
 if(!p.bugs||!p.bugs.length){b.innerHTML='<p style="opacity:.6">Žiadne work items.</p>';return;}
 b.innerHTML='';
 const folders=st.testFolders||[];
 p.bugs.forEach(x=>{
  const has=folders.includes('bug_'+x.id)||x.hasTest;
  const sc=bugStateClass(x.state);
  const tc=typeColor(x.type);
  const d=document.createElement('div');d.className='card'+(has?' linked':'');
  d.style.borderLeft='4px solid '+tc;
  d.style.borderTop='4px solid '+stateColor(x.state);
  const act=has?'<button data-a="goTest">K testu →</button>':'<button data-a="bugTest">Vytvoriť test</button>';
  const regBug=has&&x.outdated?'<button class="sec" data-a="regenBug" title="Regenerovať scenár z aktuálneho stavu bugu">↻ Regenerovať</button>':'';
  const linkedBadge=has?'<span class="badge linked" title="Existuje test">✓ test</span>':'';
  const openBtn=x.url?'<button class="sec" data-a="openBug" title="Otvoriť v TFS/Azure DevOps">🔗 Otvoriť</button>':'';
  const outWarn=has&&x.outdated?'<div class="outwarn">⚠ Test scenár nemusí byť aktuálny — došlo k zmene v bug_'+x.id+'</div>':'';
  d.innerHTML='<div class="top"><span class="badge '+sc+'">#'+x.id+' '+x.type+'</span><span class="name" title="'+x.title.replace(/"/g,'&quot;')+'">'+x.title+'</span>'+linkedBadge+'</div>'+outWarn+
   '<div class="bot"><span class="time">'+x.state+'</span><span class="acts">'+openBtn+regBug+act+'</span></div>';
  const primaryBtn=d.querySelector('.acts button[data-a="goTest"],.acts button[data-a="bugTest"]');
  if(primaryBtn)primaryBtn.onclick=()=> has? highlightTest('bug_'+x.id) : send('bugTest',{id:x.id});
  const rb=d.querySelector('.acts button[data-a="regenBug"]');
  if(rb)rb.onclick=()=>{highlightTest('bug_'+x.id);send('regenerate',{folder:'bug_'+x.id});};
  const ob=d.querySelector('.acts button[data-a="openBug"]');
  if(ob)ob.onclick=()=>send('openBug',{url:x.url});
  b.appendChild(d);});
}
function highlightTest(name){
 flt='all';render();
 const el=document.getElementById('test-'+name);
 if(el){el.scrollIntoView({behavior:'smooth',block:'center'});el.classList.remove('hl');void el.offsetWidth;el.classList.add('hl');}
 else{send('refresh');}
}
function genSweep(name){
 sweeping.add(name);
 const el=document.getElementById('test-'+name);
 if(el){el.classList.remove('gen');void el.offsetWidth;el.classList.add('gen');el.scrollIntoView({behavior:'smooth',block:'nearest'});}
 setTimeout(()=>{sweeping.delete(name);const e2=document.getElementById('test-'+name);if(e2)e2.classList.remove('gen');},1300);
}
v.postMessage({action:'refresh'});
</script></body></html>`;
}

export class DashboardProvider implements vscode.WebviewViewProvider {
    static viewType = 'autotest.dashboardView';
    constructor(private ctx: vscode.ExtensionContext) {}
    resolveWebviewView(view: vscode.WebviewView): void {
        view.webview.options = { enableScripts: true };
        view.webview.html = html(this.ctx.extension.packageJSON.version);
        const post = async () => view.webview.postMessage({ type: 'state', payload: await buildState(this.ctx) });
        // Auto-refresh dashboardu keď agent mode dopíše result.md (test dokončený).
        const wsRoot = vscode.workspace.workspaceFolders?.[0];
        if (wsRoot) {
            const wsFs = wsRoot.uri.fsPath;
            const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(wsRoot, 'autotest/*/*.md'));
            const stepsWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(wsRoot, 'autotest/*/steps/*'));
            // Playwright MCP píše screenshoty/dokumenty do _mcp_output počas behu — je to hlavný „živý" signál, že test beží.
            const mcpWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(wsRoot, 'autotest/_mcp_output/*'));
            let expiryTimer: NodeJS.Timeout | undefined;
            // Keď niečo beží, naplánuj re-render aby „running" zhaslo po uplynutí neaktivity.
            const scheduleExpiry = (delayMs: number) => { if (expiryTimer) { clearTimeout(expiryTimer); } expiryTimer = setTimeout(() => { void post(); }, delayMs); };
            const onChange = (uri?: vscode.Uri) => {
                if (uri && /[\\/]result\.md$/i.test(uri.fsPath)) {
                    const folder = extractFolder(uri.fsPath, wsFs);
                    if (folder) { finalizeTest(wsFs, folder); }
                }
                void post();
                scheduleExpiry(RUNNING_ACTIVITY_WINDOW_MS + 5_000);
            };
            watcher.onDidCreate(onChange);
            watcher.onDidChange(onChange);
            watcher.onDidDelete(onChange);
            stepsWatcher.onDidCreate(onChange);
            stepsWatcher.onDidChange(onChange);
            mcpWatcher.onDidCreate(onChange);
            mcpWatcher.onDidChange(onChange);
            // Keď user klikne „Spustiť v agent mode" (marker sa zapíše), obnov dashboard hneď → „beží" naskočí bez režloadu.
            const launchSub = launchSignal.event(() => { void post(); scheduleExpiry(RUNNING_MARKER_GRACE_MS + 5_000); });
            // Po regenerácii scenára (beží v chate) obnov stav aj TFS bugy → ⚠ neaktuálnosť zmizne automaticky.
            const refreshSub = dashboardRefreshSignal.event(() => { void post(); view.webview.postMessage({ type: 'reloadBugs' }); });
            view.onDidDispose(() => { watcher.dispose(); stepsWatcher.dispose(); mcpWatcher.dispose(); launchSub.dispose(); refreshSub.dispose(); if (expiryTimer) { clearTimeout(expiryTimer); } });
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
                case 'run':
                    // Marker `.running` sa NEzapisuje tu — zapíše ho až tlačidlo „Spustiť v agent mode"
                    // (autotest.launchAgentRun), aby „beží" svietilo len pri reálnom spustení, nie pri regenerácii scenára.
                    sendPromptToChat(`run ${m.folder}`); await post(); return;
                case 'scenario': if (ws) { const sc = path.join(ws, 'autotest', m.folder, 'test_scenario.md'); if (fs.existsSync(sc)) { vscode.window.showTextDocument(vscode.Uri.file(sc)); } else { vscode.window.showWarningMessage(`Scenár pre ${m.folder} zatiaľ neexistuje.`); } } return;
                case 'regenerate': sendPromptToChat(`regenerate ${m.folder}`); return;
                case 'delete': {
                    if (!ws) { return; }
                    const pick = await vscode.window.showWarningMessage(`Naozaj zmazať test „${m.folder}"? Odstráni sa celý priečinok (scenár, report aj screenshoty).`, { modal: true }, 'Zmazať');
                    if (pick === 'Zmazať') {
                        try { fs.rmSync(path.join(ws, 'autotest', m.folder), { recursive: true, force: true }); vscode.window.showInformationMessage(`Test „${m.folder}" zmazaný.`); }
                        catch (e: any) { vscode.window.showErrorMessage(`Zmazanie zlyhalo: ${e?.message || e}`); }
                        await post();
                        view.webview.postMessage({ type: 'reloadBugs' });
                    }
                    return;
                }
                case 'report': if (ws) { showReportPanel(ws, m.folder); } return;
                case 'loadBugs': {
                    const res = await vscode.commands.executeCommand('autotest.fetchTfsBugs');
                    view.webview.postMessage({ type: 'bugs', payload: res });
                    return;
                }
                case 'bugTest': sendPromptToChat(`bug #${m.id}`); return;
                case 'openBug': if (m.url) { vscode.env.openExternal(vscode.Uri.parse(m.url)); } return;
                case 'saveSettings':
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
