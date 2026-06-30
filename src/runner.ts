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

function buildAgentPrompt(folder: string, platform: Platform, config: AutotestConfig): string {
    const tool = platform === 'desktop' ? 'Terminator MCP (`terminator`)' : 'Playwright MCP (`playwright`)';
    const login = config.loginRequired
        ? `**Prihlásenie:** vyžadované — používateľ \`${config.username || '<neuvedené>'}\` (heslo zadaj keď ťa appka vyzve)`
        : `**Prihlásenie:** nie je potrebné`;
    return `# Pokyn pre Copilot agent mode — ${folder}

Otestuj scenár pomocou ${tool}. Riaď aplikáciu priamo cez MCP nástroje, žiadny code-gen.

- **Scenár:** \`test_scenario.md\` v tomto priečinku (\`autotest/${folder}/\`)
- **Aplikácia:** ${config.appUrl}
- ${login}

## Režim: AUTONÓMNY
- Pracuj samostatne bez potvrdzovania — kliky, písanie aj screenshoty rob automaticky.
- Na začiatku napíš 1 vetu: „Spustil som automatický test, ozvem sa len ak niečo potrebujem."
- Spýtaj sa IBA ak: (a) treba prihlásenie a nemáš údaje, (b) máš niečo vyplniť/vybrať a v scenári to nie je. Inak neprerušuj.

## Postup
1. Spusti/pripoj aplikáciu, zisti reálnu štruktúru (snapshot/tree) — nehádaj selektory.
2. Vykonaj kroky scenára, po každom kroku screenshot do \`steps/\`.
3. Skontroluj očakávaný výsledok.

## Reporty a dokumenty (PDF/DOCX/XLSX/XML/CSV)
- Ak appka vygeneruje report súbor a potrebuješ overiť jeho obsah, **NEOTVÁRAJ ho v prehliadači** (\`file:\` URL je blokované).
- Použi nástroj **\`autotest_readReport\`** (#readReport) s absolútnou cestou k súboru — vráti extrahovaný text, ktorý porovnáš s očakávaným výsledkom.

## Výstup (do \`autotest/${folder}/\`)
- \`result.md\` — prvý riadok \`VERDIKT: PASSED\` alebo \`VERDIKT: FAILED\`, potom krátke zhrnutie.
- \`transcript.md\` — zoznam MCP akcií.
- \`steps/\` — screenshoty krokov.`;
}

function buildHandoffQuery(folder: string, platform: Platform, config: AutotestConfig, password?: string): string {
    const tool = platform === 'desktop' ? 'Terminator MCP (server "terminator")' : 'Playwright MCP (server "playwright")';
    const creds = config.loginRequired && config.username
        ? ` Prihlásenie: používateľ "${config.username}"${password ? `, heslo "${password}"` : ''}.` : '';
    return `Over úlohu pomocou ${tool}. Postupuj podľa autotest/${folder}/agent_prompt.md a scenára autotest/${folder}/test_scenario.md. Aplikácia: ${config.appUrl}.${creds} Riaď aplikáciu priamo cez MCP nástroje. Na konci ulož autotest/${folder}/result.md (VERDIKT: PASSED/FAILED), transcript.md a screenshoty do steps/.`;
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

    fs.writeFileSync(path.join(testDir, 'agent_prompt.md'), buildAgentPrompt(folder, platform, config), 'utf-8');
    const password = config.loginRequired ? await getLoginPassword(context) : undefined;
    const query = buildHandoffQuery(folder, platform, config, password);

    response.markdown(`✅ **Scenár pripravený** (\`autotest/${folder}\`). Vykonanie prebehne v Copilot agent mode.\n\n`);
    response.button({ command: 'workbench.action.chat.open', title: '▶️ Spustiť v agent mode', arguments: [{ query, mode: 'agent', isPartialQuery: false }] });
    response.button({ command: 'vscode.open', title: '📝 Scenár', arguments: [vscode.Uri.file(path.join(testDir, 'test_scenario.md'))] });
}

/** Hlavný tok: vytvor scenár pre nový test a deleguj. */
export async function runTest(
    context: vscode.ExtensionContext,
    response: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    bugDescription: string,
    bugId: string | undefined,
    config: AutotestConfig
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
    fs.writeFileSync(path.join(dir, 'test_scenario.md'), scenario, 'utf-8');
    response.markdown(`✅ Scenár \`${folder}\`\n\n`);
    await delegateToAgentMode(context, response, ws, folder, config);
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
