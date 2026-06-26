/**
 * Web automation agent.
 *
 * Nový model (2026-06): žiadny code-gen. Vygenerujeme test scenár a celé
 * vykonanie delegujeme na Copilot agent mode + Playwright MCP server.
 * Extension iba: pripraví scenár, nakonfiguruje MCP server a odovzdá riadenie
 * agent mode (handoff button), ktorý scenár naživo odíde a vyhodnotí.
 *
 * Exports: runWebTest, handleWebRegenerate, handleWebRecord
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getLoginPassword, AutotestConfig } from './config';
import {
    execAsync,
    selectAIModel,
    getNextBugNumber,
    ensureGitignore,
} from './agent-shared';

// ─── Scenár ───────────────────────────────────────────────────────────────────

async function generateScenario(
    model: vscode.LanguageModelChat,
    token: vscode.CancellationToken,
    bugDescription: string,
    config: AutotestConfig,
    projectOverview: string
): Promise<string> {
    const prompt = `
Si expert na QA. Vytvor detaílný test scenár (v markdown formáte) pre tento bug: "${bugDescription}".

Project overview:
${projectOverview}

Test bude bežať na aplikácii: ${config.appUrl}
${config.loginRequired ? `\nAPLIKÁCIA VYŽADUJE PRIHLÁSENIE - začni prihlásením.` : ''}

DÔLEŽITÉ PRAVIDLÁ:
1. Ak bug/popis NEUVÁDZA konkrétne údaje (napr. "ktorého klienta vybrať"), použi DEFAULT stratégiu:
    - "Vyber klienta" → "Vyber prvého klienta v tabuľke"
    - "Otvor dokument" → "Otvor prvý dokument v zozname"
    - "Zadaj dátum" → "Zadaj dnešný dátum"
2. Ak bug hovorí o tlačidle/akcii VŠEOBECNE, špecifikuj ČO hľadať.
3. Pre VALIDÁCIE, špecifikuj presný očakávaný stav.

Formát scenára:
# Test Scenár: [Názov]
## Cieľ:
## Preconditions:
## Test kroky:
1. [Konkrétny krok s KONRÉTNYMI údajmi]
## Očakávaný výsledok:

Vráť IBA markdown scenár, žiadny iný text.
`;
    const msgs = [vscode.LanguageModelChatMessage.User(prompt)];
    const resp = await model.sendRequest(msgs, {}, token);
    let scenario = '';
    for await (const chunk of resp.text) { scenario += chunk; }
    return scenario.replace(/```markdown|```/g, '').trim();
}

// ─── Playwright MCP konfigurácia ───────────────────────────────────────────────

const MCP_OUTPUT_DIRNAME = '_mcp_output';

/**
 * Zaistí, že vo workspace `.vscode/mcp.json` je nakonfigurovaný Playwright MCP
 * server. Existujúce servery zachová, iba pridá/aktualizuje `playwright`.
 * Vráti true ak bol súbor vytvorený/zmenený.
 */
function ensurePlaywrightMcpConfigured(workspacePath: string, headless: boolean): boolean {
    const vscodeDir = path.join(workspacePath, '.vscode');
    const mcpPath = path.join(vscodeDir, 'mcp.json');

    const args: string[] = ['-y', '@playwright/mcp@latest'];
    if (headless) { args.push('--headless'); }
    args.push('--output-dir', `\${workspaceFolder}/autotest/${MCP_OUTPUT_DIRNAME}`);

    const playwrightServer = { command: 'npx', args };

    let root: any = {};
    if (fs.existsSync(mcpPath)) {
        try { root = JSON.parse(fs.readFileSync(mcpPath, 'utf-8')) || {}; } catch { root = {}; }
    }
    if (typeof root !== 'object' || root === null) { root = {}; }
    if (typeof root.servers !== 'object' || root.servers === null) { root.servers = {}; }

    const before = JSON.stringify(root.servers.playwright || null);
    root.servers.playwright = playwrightServer;
    const after = JSON.stringify(root.servers.playwright);

    const existedSame = fs.existsSync(mcpPath) && before === after;
    if (existedSame) { return false; }

    if (!fs.existsSync(vscodeDir)) { fs.mkdirSync(vscodeDir, { recursive: true }); }
    fs.writeFileSync(mcpPath, JSON.stringify(root, null, 2) + '\n', 'utf-8');
    return true;
}

// ─── Handoff do agent mode ─────────────────────────────────────────────────────

/**
 * Pokyn uložený do `agent_prompt.md` v priečinku bugu (BEZ hesla).
 */
function buildAgentInstructions(bugFolderName: string, config: AutotestConfig): string {
    const loginLine = config.loginRequired
        ? `**Prihlásenie:** vyžadované — používateľ: \`${config.username || '<neuvedené>'}\` (heslo zadaj keď ťa appka vyzve)`
        : `**Prihlásenie:** nie je potrebné`;

    return `# Pokyn pre Copilot agent mode — over opravu bugu (${bugFolderName})

Otestuj scenár pomocou **Playwright MCP** nástrojov (MCP server \`playwright\`).
Nepíš žiadny \`test.spec.js\` — riaď prehliadač priamo cez MCP nástroje.

- **Scenár:** \`test_scenario.md\` v tomto priečinku (\`autotest/${bugFolderName}/\`)
- **Aplikácia:** ${config.appUrl}
- ${loginLine}

## Postup
1. \`browser_navigate\` na URL aplikácie.
2. Ak je potrebné, prihlás sa.
3. Vykonaj kroky scenára cez MCP nástroje (\`browser_snapshot\`, \`browser_click\`, \`browser_type\`, \`browser_select_option\`, …). Pred každou akciou si over aktuálny stav cez \`browser_snapshot\`.
4. Po každom kroku sprav \`browser_take_screenshot\` (uloží sa do \`autotest/${MCP_OUTPUT_DIRNAME}/\`).
5. Skontroluj očakávaný výsledok zo scenára.

## Výstupy do tohto priečinka (\`autotest/${bugFolderName}/\`)
- **\`result.md\`** — verdikt **PASSED** alebo **FAILED**, krátke zhrnutie a dôvod (či je oprava dostatočná).
- **\`transcript.md\`** — zoznam vykonaných MCP akcií v poradí.
- **\`steps/\`** — presuň sem screenshoty z \`autotest/${MCP_OUTPUT_DIRNAME}/\`.
`;
}

/**
 * Ephemerálny query pre handoff button (môže obsahovať heslo — neukladá sa do súboru).
 */
function buildHandoffQuery(bugFolderName: string, config: AutotestConfig, password: string | undefined): string {
    let creds = '';
    if (config.loginRequired && config.username) {
        creds = `\nPrihlasovacie údaje: používateľ "${config.username}"${password ? `, heslo "${password}"` : ''}.`;
    }
    return `Over opravu bugu pomocou Playwright MCP (server "playwright"). `
        + `Postupuj podľa pokynu v súbore autotest/${bugFolderName}/agent_prompt.md a podľa scenára v autotest/${bugFolderName}/test_scenario.md. `
        + `Aplikácia beží na ${config.appUrl}.${creds} `
        + `Riaď prehliadač priamo cez MCP nástroje (nepíš test.spec.js). `
        + `Na konci ulož autotest/${bugFolderName}/result.md (verdikt PASSED/FAILED + zhrnutie), `
        + `autotest/${bugFolderName}/transcript.md (zoznam akcií) a screenshoty presuň do autotest/${bugFolderName}/steps/.`;
}

/**
 * Spoločný handoff: pripraví MCP config + agent_prompt.md a ponúkne tlačidlá
 * na spustenie v Copilot agent mode.
 */
async function delegateToAgentMode(
    context: vscode.ExtensionContext,
    response: vscode.ChatResponseStream,
    workspacePath: string,
    bugFolderName: string,
    config: AutotestConfig
): Promise<void> {
    const testDir = path.join(workspacePath, 'autotest', bugFolderName);
    if (!fs.existsSync(testDir)) { fs.mkdirSync(testDir, { recursive: true }); }

    // MCP server config
    const headless = config.headlessMode !== false;
    const changed = ensurePlaywrightMcpConfigured(workspacePath, headless);
    response.markdown(changed
        ? `🧩 **Playwright MCP nakonfigurovaný** v \`.vscode/mcp.json\` (${headless ? 'headless' : 'headed'}).\n\n`
        : `🧩 Playwright MCP je už nakonfigurovaný (\`.vscode/mcp.json\`, ${headless ? 'headless' : 'headed'}).\n\n`);

    // Pokyn pre agenta (bez hesla)
    const instructions = buildAgentInstructions(bugFolderName, config);
    const promptPath = path.join(testDir, 'agent_prompt.md');
    fs.writeFileSync(promptPath, instructions, 'utf-8');

    // Handoff query (ephemerálne, môže obsahovať heslo)
    const password = config.loginRequired ? await getLoginPassword(context) : undefined;
    const query = buildHandoffQuery(bugFolderName, config, password);

    response.markdown(`✅ **Scenár pripravený.** Vykonanie a vyhodnotenie prebehne v **Copilot agent mode** cez Playwright MCP.\n\n`);
    response.markdown(`📁 \`autotest/${bugFolderName}/\` — \`test_scenario.md\`, \`agent_prompt.md\`\n\n`);

    response.button({
        command: 'workbench.action.chat.open',
        title: '▶️ Spustiť test v Copilot agent mode',
        arguments: [{ query, mode: 'agent', isPartialQuery: false }],
    });
    response.button({
        command: 'vscode.open',
        title: '📝 Otvoriť scenár',
        arguments: [vscode.Uri.file(path.join(testDir, 'test_scenario.md'))],
    });

    response.markdown(`\n\nℹ️ Pri prvom spustení potvrď dôveru MCP serveru \`playwright\` (VS Code sa spýta). `
        + `Po dobehnutí nájdeš výsledok v \`autotest/${bugFolderName}/result.md\`.\n\n`);
}

// ─── runWebTest ───────────────────────────────────────────────────────────────

export async function runWebTest(
    context: vscode.ExtensionContext,
    response: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    bugDescription: string,
    bugId: string | undefined,
    config: AutotestConfig
): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        response.markdown(`*Chyba: Nemáš otvorený žiadny projekt.*`);
        return;
    }
    const workspacePath = workspaceFolders[0].uri.fsPath;

    const model = await selectAIModel(context, 'code');
    if (!model) {
        response.markdown(`*Chyba: Nenašiel sa AI model. Uisti sa, že máš aktívne GitHub Copilot subscription.*`);
        return;
    }
    response.markdown(`🤖 Model pre scenár: **${model.name || model.id}** (${model.vendor})\n\n`);

    // Project overview kontext
    let projectOverview = '';
    try {
        const overviewPath = path.join(workspacePath, 'autotest', 'project_overview.md');
        if (fs.existsSync(overviewPath)) {
            projectOverview = fs.readFileSync(overviewPath, 'utf-8');
            response.markdown(`🗂️ Načítaný project overview\n\n`);
        }
    } catch {}

    // Scenár
    response.markdown(`📝 **Vytváram test scenár...**\n\n`);
    const testScenario = await generateScenario(model, token, bugDescription, config, projectOverview);
    response.markdown(`✅ **Test scenár vytvorený!**\n\n`);

    // Priečinok bugu
    const testFolderName = bugId ? `bug_${bugId}` : `bug_${getNextBugNumber(workspacePath).toString().padStart(3, '0')}`;
    const autotestDir = path.join(workspacePath, 'autotest');
    if (!fs.existsSync(autotestDir)) {
        fs.mkdirSync(autotestDir, { recursive: true });
        ensureGitignore(workspacePath);
        response.markdown(`📝 *.gitignore* updatovaný — *autotest/* bude ignorovaný Gitom.\n\n`);
    }
    const testDir = path.join(autotestDir, testFolderName);
    if (!fs.existsSync(testDir)) { fs.mkdirSync(testDir, { recursive: true }); }
    fs.writeFileSync(path.join(testDir, 'test_scenario.md'), testScenario, 'utf-8');

    // Delegovať na agent mode + Playwright MCP
    await delegateToAgentMode(context, response, workspacePath, testFolderName, config);
}

// ─── handleWebRegenerate ──────────────────────────────────────────────────────

/**
 * Po úprave `test_scenario.md` znova odovzdá scenár agent mode na pretestovanie.
 */
export async function handleWebRegenerate(
    context: vscode.ExtensionContext,
    response: vscode.ChatResponseStream,
    _token: vscode.CancellationToken,
    request: vscode.ChatRequest,
    config: AutotestConfig
): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        response.markdown(`❌ Nie je otvorený žiadny projekt.\n\n`); return;
    }
    const workspacePath = workspaceFolders[0].uri.fsPath;

    const folderMatch = request.prompt.match(/(?:regenerate|regen)\s+(\S+)/i);
    let testFolderName = folderMatch ? folderMatch[1] : '';
    if (!testFolderName) {
        response.markdown(`❌ Zadaj názov priečinka: \`@autotest regenerate bug_001\`\n\n`); return;
    }
    if (/^\d+$/.test(testFolderName)) { testFolderName = `bug_${testFolderName.padStart(3, '0')}`; }
    else if (!testFolderName.startsWith('bug_') && !testFolderName.startsWith('test_') && !testFolderName.startsWith('recorded_')) {
        testFolderName = `bug_${testFolderName}`;
    }

    const testDir = path.join(workspacePath, 'autotest', testFolderName);
    if (!fs.existsSync(testDir)) {
        response.markdown(`❌ Priečinok \`autotest/${testFolderName}\` neexistuje.\n\n`); return;
    }
    const scenarioPath = path.join(testDir, 'test_scenario.md');
    if (!fs.existsSync(scenarioPath)) {
        response.markdown(`❌ Nenašiel sa \`test_scenario.md\` v \`autotest/${testFolderName}\`.\n\n`); return;
    }

    response.markdown(`🔄 **Odovzdávam upravený scenár \`${testFolderName}\` na pretestovanie...**\n\n`);
    await delegateToAgentMode(context, response, workspacePath, testFolderName, config);
}

// ─── handleWebRecord ──────────────────────────────────────────────────────────

export async function handleWebRecord(
    context: vscode.ExtensionContext,
    response: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    request: vscode.ChatRequest,
    config: AutotestConfig
): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        response.markdown(`❌ Nie je otvorený žiadny projekt.\n\n`); return;
    }
    const workspacePath = workspaceFolders[0].uri.fsPath;

    const recFolderMatch = request.prompt.match(/(?:bug_?|test_?)(\w+)/i);
    let recFolderName: string;
    if (recFolderMatch) {
        const n = recFolderMatch[1];
        recFolderName = /^\d+$/.test(n) ? `bug_${n.padStart(3, '0')}` : recFolderMatch[0];
    } else {
        const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 16);
        recFolderName = `recorded_${ts}`;
    }
    const recTestDir = path.join(workspacePath, 'autotest', recFolderName);
    if (!fs.existsSync(recTestDir)) { fs.mkdirSync(recTestDir, { recursive: true }); }

    response.markdown(`🎬 **Playwright Codegen pre ${recFolderName}**\n\n`);
    response.markdown(`Otvorí sa browser s rekordérom. Klikaj v aplikácii, kód sa generuje živý.\nKeď skončíš, **zatvor browser** — skript sa automaticky uloží.\n\n`);

    const recOutputFile = path.join(recTestDir, 'recorded_script.js');
    const recCmd = `npx playwright codegen --output "${recOutputFile}" "${config.appUrl}"`;
    response.markdown(`▶️ Spúšťam: \`${recCmd}\`\n\n`);

    try {
        await execAsync(recCmd, { cwd: workspacePath, timeout: 600000 });
        if (!fs.existsSync(recOutputFile)) {
            response.markdown(`⚠️ Skript nebol vygenerovaný (browser bol zatvorený bez akcií?).\n\n`);
            return;
        }
        const recCode = fs.readFileSync(recOutputFile, 'utf-8');
        response.markdown(`✅ **Nahrávanie dokončené!** Skript uložený: \`autotest/${recFolderName}/recorded_script.js\`\n\n`);
        response.markdown(`🤖 **Generujem finálny test zo záznamu...**\n\n`);

        const recModel = await selectAIModel(context, 'code');
        if (recModel) {
            const recPrompt = `Toto je Playwright skript nahraný cez codegen:\n\`\`\`javascript\n${recCode.substring(0, 4000)}\n\`\`\`\n\nUprav ho do štandardného formátu s:\n- chromium.launch({ headless: ${config.headlessMode}, slowMo: ${config.slowMo} })\n- newContext({ viewport: { width: 1920, height: 1080 } })\n- try/catch/finally s success_screenshot.png a error_screenshot.png\n- stepShot(page, 'popis') po každom kliku\n- Odstráň test.describe/test wrapery — chceme priamy async IIFE\nVráť IBA kód, žiadny markdown.`;
            const recResp = await recModel.sendRequest([vscode.LanguageModelChatMessage.User(recPrompt)], {}, token);
            let recFinal = '';
            for await (const chunk of recResp.text) { recFinal += chunk; }
            recFinal = recFinal.replace(/```(javascript|js)?/g, '').trim();
            const diagHelper = `// Autogenerated diagnostics helper\nasync function attachDiagnostics(page) { const _fs=require('fs'),_path=require('path'); try { const n=[],cl=[]; page.on('request',r=>{try{n.push({type:'request',url:r.url()});}catch(e){}}); page.on('response',async r=>{try{n.push({type:'response',url:r.url(),status:r.status()});}catch(e){}}); page.on('console',m=>{try{cl.push({type:m.type(),text:m.text()});}catch(e){}}); page.saveDiagnostics=async function(dir){try{if(!_fs.existsSync(dir))_fs.mkdirSync(dir,{recursive:true});_fs.writeFileSync(_path.join(dir,'network.json'),JSON.stringify(n,null,2));_fs.writeFileSync(_path.join(dir,'console_logs.json'),JSON.stringify(cl,null,2));}catch(e){}};} catch(e){} }\nconst _sfs=require('fs');let _sc=0;async function stepShot(pg,name=''){_sc++;if(!_sfs.existsSync('steps'))_sfs.mkdirSync('steps',{recursive:true});const n=\`steps/step_\${String(_sc).padStart(2,'0')}\${name?'_'+name.replace(/\\s+/g,'_').replace(/[^a-zA-Z0-9_]/g,'').substring(0,30):''}.png\`;try{await pg.screenshot({path:n,fullPage:true});}catch(e){}}\n\n`;
            fs.writeFileSync(path.join(recTestDir, 'test.spec.js'), diagHelper + recFinal);
            response.markdown(`✅ **Test uložený:** \`autotest/${recFolderName}/test.spec.js\`\n\n`);
            response.markdown(`▶️ Spusti ho: \`@autotest run ${recFolderName}\`\n\n`);
        }
    } catch (e: any) {
        response.markdown(`❌ Codegen chyba: ${e.message?.substring(0, 300)}\n\n`);
    }
}
