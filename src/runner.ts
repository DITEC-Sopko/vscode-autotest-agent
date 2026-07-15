import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { AutotestConfig, getLoginPassword } from './config';
import { ensureMcpConfigured, Platform } from './mcp';
import { selectModel, getNextTestNumber, ensureGitignore } from './util';

/** Vygeneruje test scenár z popisu bugu cez LLM. */
async function generateScenario(
    model: vscode.LanguageModelChat,
    token: vscode.CancellationToken,
    bugDescription: string,
    config: AutotestConfig,
    projectOverview: string
): Promise<string> {
    const prompt = `Si QA inžinier. Vytvor stručný test scenár v markdown pre overenie tejto úlohy.
Aplikácia: ${config.appUrl} (${config.appType}).${projectOverview ? `\nKontext projektu:\n${projectOverview}` : ''}
${config.loginRequired ? 'Aplikácia vyžaduje prihlásenie — začni krokom prihlásenia.' : ''}

Úloha/bug (môže obsahovať sekciu Komentáre – zohľadni najmä najnovšie informácie z komentárov, lebo podstatné zmeny sa často presunú do diskusie):
${bugDescription}

Formát:
# Test Scenár: [Názov]
## Cieľ:
## Preconditions:
## Test kroky:
1. ...
## Očakávaný výsledok:

Vráť IBA markdown scenár.`;
    const resp = await model.sendRequest([vscode.LanguageModelChatMessage.User(prompt)], {}, token);
    let out = '';
    for await (const c of resp.text) { out += c; }
    return out.replace(/```markdown|```/g, '').trim();
}

/**
 * Uloží `meta.json` pre TFS test — zaznamená dátum zmeny bugu v čase generovania scenára.
 * Slúži na upozornenie „scenár nemusí byť aktuálny", keď sa bug neskôr zmení.
 */
function writeTestMeta(dir: string, bugId: string, bugChangedDate: string): void {
    try {
        const metaPath = path.join(dir, 'meta.json');
        let createdAt = new Date().toISOString();
        try { const prev = JSON.parse(fs.readFileSync(metaPath, 'utf-8')); if (prev?.createdAt) { createdAt = prev.createdAt; } } catch { /* nový */ }
        fs.writeFileSync(metaPath, JSON.stringify({ bugId, bugChangedDate: bugChangedDate || '', createdAt }, null, 2), 'utf-8');
    } catch { /* ignore */ }
}

function buildAgentPrompt(folder: string, absDir: string, platform: Platform, config: AutotestConfig): string {
    const tool = platform === 'desktop' ? 'Terminator MCP (`terminator`)' : 'Playwright MCP (`playwright`)';
    const login = config.loginRequired
        ? `**Prihlásenie:** vyžadované — používateľ \`${config.username || '<neuvedené>'}\` (heslo zadaj keď ťa appka vyzve)`
        : `**Prihlásenie:** nie je potrebné`;
    const stepsDir = path.join(absDir, 'steps');
    return `# Pokyn pre Copilot agent mode — ${folder}

Otestuj scenár pomocou ${tool}. Riaď aplikáciu priamo cez MCP nástroje, žiadny code-gen.

- **Scenár:** \`test_scenario.md\` v priečinku \`${absDir}\`
- **Aplikácia:** ${config.appUrl}
- ${login}

## DÔLEŽITÉ — vždy ABSOLÚTNE cesty
- Screenshoty aj výstupné súbory ukladaj **výhradne absolútnou cestou**. Relatívna cesta sa rozbije — MCP ju vyhodnotí voči nesprávnemu priečinku a zlyhá (ENOENT / „no such file or directory").
- Priečinok na screenshoty (už existuje): \`${stepsDir}\`. Príklad názvu súboru: \`${path.join(stepsDir, '01_krok.png')}\`.

## Režim: AUTONÓMNY
- Pracuj samostatne bez potvrdzovania — kliky, písanie aj screenshoty rob automaticky.
- Na začiatku napíš 1 vetu: „Spustil som automatický test, ozvem sa len ak niečo potrebujem."
- Spýtaj sa IBA ak: (a) treba prihlásenie a nemáš údaje, (b) máš niečo vyplniť/vybrať a v scenári to nie je. Inak neprerušuj.

## Postup
1. Spusti/pripoj aplikáciu, zisti reálnu štruktúru (snapshot/tree) — nehádaj selektory.
2. Vykonaj kroky scenára. Overuj stav cez **snapshot** (accessibility strom), nie cez screenshoty. Screenshot ukladaj **absolútnou cestou** do \`${stepsDir}\` len pri **kľúčových krokoch** (prihlásenie, každý overovaný výsledok, zlyhanie) — NIE po každej drobnej akcii. Screenshoty slúžia len ako dôkaz do reportu, na rozhodovanie ich nepotrebuješ.
3. Skontroluj očakávaný výsledok.
${platform === 'web' ? `
## Efektívna práca s dropdownmi / dlhými zoznamami (DÔLEŽITÉ pre rýchlosť)
- Ak má dropdown/combobox/listbox možnosť **vyhľadávať/filtrovať** (input na písanie, placeholder „Hľadať…", alebo sa dá písať priamo do poľa), **VŽDY ju využi ako prvú voľbu** — napíš názov hľadanej položky a vyber z filtrovaného výsledku.
- **Nescrolluj a nesnímaj opakovane snapshot celého dlhého zoznamu**, aby si našiel položku — to je pomalé a míňa kroky. Písanie do filtra zúži zoznam na 1–2 položky ihneď.
- Až keď dropdown filter naozaj NEMÁ, použi snapshot zoznamu a klik na konkrétnu položku.
` : ''}
## Reporty a dokumenty (PDF/DOCX/XLSX/XML/CSV)
- **NIKDY neotváraj dokument v prehliadači ani cez „Navigate to a URL" na \`file:\` cestu — Playwright to zablokuje („Access to file: protocol is blocked").**
- Na overenie obsahu použi nástroj **\`autotest_readReport\`** (#readReport) s ABSOLÚTNOU cestou k súboru — vráti extrahovaný text, ktorý porovnáš s očakávaným výsledkom.
- Ak appka vygeneruje dokument, ulož aj jeho **screenshot absolútnou cestou do \`${stepsDir}\`**. Stiahnuté/vygenerované súbory sa po dokončení automaticky prenesú do reportu.

## Výstup (absolútne cesty)
- \`${path.join(absDir, 'result.md')}\` — prvý riadok \`VERDIKT: PASSED\` alebo \`VERDIKT: FAILED\`, potom krátke zhrnutie.
- \`${path.join(absDir, 'transcript.md')}\` — zoznam MCP akcií.
- \`${stepsDir}\` — screenshoty krokov.`;
}

function buildHandoffQuery(folder: string, absDir: string, platform: Platform, config: AutotestConfig, password?: string): string {
    const tool = platform === 'desktop' ? 'Terminator MCP (server "terminator")' : 'Playwright MCP (server "playwright")';
    const creds = config.loginRequired && config.username
        ? ` Prihlásenie: používateľ "${config.username}"${password ? `, heslo "${password}"` : ''}.` : '';
    const stepsDir = path.join(absDir, 'steps');
    return `Over úlohu pomocou ${tool}. Postupuj podľa ${path.join(absDir, 'agent_prompt.md')} a scenára ${path.join(absDir, 'test_scenario.md')}. Aplikácia: ${config.appUrl}.${creds} Riaď aplikáciu priamo cez MCP nástroje. Screenshoty a výstupy ukladaj VÝHRADNE ABSOLÚTNYMI cestami (screenshoty do ${stepsDir}). Dokumenty NEOTVÁRAJ cez file: URL — použi nástroj #readReport. Na konci ulož ${path.join(absDir, 'result.md')} (VERDIKT: PASSED/FAILED) a ${path.join(absDir, 'transcript.md')}.`;
}

/** Spoločné delegovanie do agent mode pre desktop aj web. */
export async function delegateToAgentMode(
    context: vscode.ExtensionContext,
    response: vscode.ChatResponseStream,
    workspacePath: string,
    folder: string,
    config: AutotestConfig
): Promise<void> {
    const platform: Platform = config.appType === 'desktop' ? 'desktop' : 'web';
    const testDir = path.join(workspacePath, 'autotest', folder);
    if (!fs.existsSync(testDir)) { fs.mkdirSync(testDir, { recursive: true }); }
    fs.mkdirSync(path.join(testDir, 'steps'), { recursive: true });
    ensureGitignore(workspacePath);

    const headless = config.headlessMode !== false;
    if (ensureMcpConfigured(workspacePath, platform, headless)) {
        response.markdown(`🧩 ${platform === 'desktop' ? 'Terminator' : 'Playwright'} MCP nakonfigurovaný v \`.vscode/mcp.json\`.\n\n`);
    }
    // Vyšší limit krokov agenta (default je nízky → časté „Continue to iterate?").
    // Scopujeme na TENTO workspace, ostatné projekty ostanú nedotknuté.
    try {
        await vscode.workspace.getConfiguration().update('chat.agent.maxRequests', 100, vscode.ConfigurationTarget.Workspace);
    } catch { /* ignore */ }
    // Auto-schvaľovanie nástrojov: skús najprv Workspace scope (len tento projekt).
    // Ak to VS Code z bezpečnostných dôvodov nepovolí v workspace, fallback na Global.
    let approveScope = 'len pre tento workspace';
    try {
        await vscode.workspace.getConfiguration().update('chat.tools.global.autoApprove', true, vscode.ConfigurationTarget.Workspace);
    } catch {
        try {
            await vscode.workspace.getConfiguration().update('chat.tools.global.autoApprove', true, vscode.ConfigurationTarget.Global);
            approveScope = 'globálne (workspace scope nie je pre túto bezpečnostnú voľbu povolený)';
        } catch { /* ignore */ }
    }
    response.markdown(`⚡ Auto-schvaľovanie nástrojov (${approveScope}) a vyšší limit krokov agenta zapnuté. Pri prvom spustení VS Code raz zobrazí bezpečnostný dialóg — potvrď ho, potom sa už nepýta.\n\n`);

    fs.writeFileSync(path.join(testDir, 'agent_prompt.md'), buildAgentPrompt(folder, testDir, platform, config), 'utf-8');
    const password = config.loginRequired ? await getLoginPassword(context) : undefined;
    const query = buildHandoffQuery(folder, testDir, platform, config, password);

    response.markdown(`✅ **Scenár pripravený** (\`autotest/${folder}\`). Beh sa spustí v **novej Copilot relácii**, takže môžeš ďalej pracovať vo svojej pôvodnej konverzácii (ostáva v zozname relácií).\n\n`);
    response.button({ command: 'autotest.launchAgentRun', title: '▶️ Spustiť v novej relácii', arguments: [{ folder, query }] });
    response.button({ command: 'vscode.open', title: '📝 Scenár', arguments: [vscode.Uri.file(path.join(testDir, 'test_scenario.md'))] });
}

/** Hlavný tok: vytvor scenár pre nový test a deleguj. */
export async function runTest(
    context: vscode.ExtensionContext,
    response: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    bugDescription: string,
    bugId: string | undefined,
    config: AutotestConfig,
    bugChangedDate?: string
): Promise<void> {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!ws) { response.markdown('*Chyba: nie je otvorený projekt.*'); return; }
    const model = await selectModel(context);
    if (!model) { response.markdown('*Chyba: žiadny AI model (potrebný Copilot).*'); return; }

    let overview = '';
    const ovp = path.join(ws, 'autotest', 'project_overview.md');
    if (fs.existsSync(ovp)) { try { overview = fs.readFileSync(ovp, 'utf-8'); } catch { /* ignore */ } }

    response.markdown('📝 **Vytváram scenár...**\n\n');
    const scenario = await generateScenario(model, token, bugDescription, config, overview);
    const folder = bugId ? `bug_${bugId}` : `test_${getNextTestNumber(ws).toString().padStart(3, '0')}`;
    const dir = path.join(ws, 'autotest', folder);
    fs.mkdirSync(dir, { recursive: true });
    // Vytvor priečinok steps/ hneď, aby doň agent mohol ukladať screenshoty bez chyby „neexistuje".
    fs.mkdirSync(path.join(dir, 'steps'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'test_scenario.md'), scenario, 'utf-8');
    if (bugId) { writeTestMeta(dir, bugId, bugChangedDate || ''); }
    response.markdown(`✅ Scenár \`${folder}\`\n\n`);
    await delegateToAgentMode(context, response, ws, folder, config);
}

/**
 * Regeneruje scenár TFS testu z AKTUÁLNEHO stavu bugu (nový popis + komentáre).
 * Pôvodný scenár zazálohuje do `test_scenario.bak.md`. Iba pre `bug_*` priečinky.
 */
export async function regenerateScenario(
    context: vscode.ExtensionContext,
    response: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    workspacePath: string,
    folder: string,
    bugId: string,
    bugDescription: string,
    bugChangedDate: string,
    config: AutotestConfig
): Promise<void> {
    const dir = path.join(workspacePath, 'autotest', folder);
    if (!fs.existsSync(dir)) { response.markdown(`ℹ️ \`${folder}\` neexistuje.\n\n`); return; }
    const model = await selectModel(context);
    if (!model) { response.markdown('*Chyba: žiadny AI model (potrebný Copilot).*'); return; }

    let overview = '';
    const ovp = path.join(workspacePath, 'autotest', 'project_overview.md');
    if (fs.existsSync(ovp)) { try { overview = fs.readFileSync(ovp, 'utf-8'); } catch { /* ignore */ } }

    response.markdown(`🔄 **Regenerujem scenár z aktuálneho stavu bugu #${bugId}...**\n\n`);
    const scenario = await generateScenario(model, token, bugDescription, config, overview);
    const scPath = path.join(dir, 'test_scenario.md');
    // Záloha pôvodného scenára (aby sa nestratili prípadné ručné úpravy).
    if (fs.existsSync(scPath)) { try { fs.copyFileSync(scPath, path.join(dir, 'test_scenario.bak.md')); } catch { /* ignore */ } }
    fs.writeFileSync(scPath, scenario, 'utf-8');
    writeTestMeta(dir, bugId, bugChangedDate || '');
    response.markdown(`✅ Scenár \`${folder}\` aktualizovaný (pôvodný uložený ako \`test_scenario.bak.md\`). Skontroluj ho a potom spusti.\n\n`);
    response.button({ command: 'vscode.open', title: '📝 Otvoriť scenár', arguments: [vscode.Uri.file(scPath)] });
}


/** Znova spusti existujúci test (vždy cez MCP). */
export async function rerunTest(
    context: vscode.ExtensionContext,
    response: vscode.ChatResponseStream,
    workspacePath: string,
    folder: string,
    config: AutotestConfig
): Promise<void> {
    const dir = path.join(workspacePath, 'autotest', folder);
    if (!fs.existsSync(path.join(dir, 'test_scenario.md'))) {
        response.markdown(`ℹ️ \`${folder}\` nemá scenár — vytvor ho cez \`@autotest test\`.\n\n`);
        return;
    }
    await delegateToAgentMode(context, response, workspacePath, folder, config);
}
