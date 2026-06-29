/**
 * Desktop automation agent.
 *
 * Nový model (2026-06): žiadny code-gen. Vygenerujeme test scenár a celé
 * vykonanie delegujeme na Copilot agent mode + Terminator MCP server
 * (mediar-ai/terminator — "playwright for windows", UIA accessibility).
 * Extension iba: pripraví scenár, nakonfiguruje MCP server a odovzdá riadenie
 * agent mode (handoff button), ktorý scenár naživo odíde a vyhodnotí.
 *
 * Exports: runDesktopTest, handleDesktopRegenerate, handleDesktopRecord
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { AutotestConfig, getLoginPassword } from './config';
import {
    execAsync,
    selectAIModel,
    getNextTestNumber,
    ensureGitignore,
    findPythonExecutable,
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

Test bude bežať na desktop aplikácii: ${config.appUrl}
${config.loginRequired ? `\nAPLIKÁCIA VYŽADUJE PRIHLÁSENIE - začni prihlásením.` : ''}

DÔLEŽITÉ PRAVIDLÁ:
1. Ak bug/popis NEUVÁDZA konkrétne údaje, použi DEFAULT stratégiu (napr. "Vyber prvého klienta").
2. Ak bug hovorí o tlačidle/akcii VŠEOBECNE, špecifikuj ČO hľadať.
3. Pre VALIDÁCIE, špecifikuj presný očakávaný stav.

Formát scenára:
# Test Scenár: [Názov]
## Cieľ:
## Preconditions:
## Test kroky:
1. [Konkrétny krok]
## Očakávaný výsledok:

Vráť IBA markdown scenár, žiadny iný text.
`;
    const msgs = [vscode.LanguageModelChatMessage.User(prompt)];
    const resp = await model.sendRequest(msgs, {}, token);
    let scenario = '';
    for await (const chunk of resp.text) { scenario += chunk; }
    return scenario.replace(/```markdown|```/g, '').trim();
}

// ─── Terminator MCP konfigurácia ────────────────────────────────────────────────

/**
 * Zaistí, že vo workspace `.vscode/mcp.json` je nakonfigurovaný Terminator MCP
 * server. Existujúce servery zachová, iba pridá/aktualizuje `terminator`.
 * Vráti true ak bol súbor vytvorený/zmenený.
 */
function ensureTerminatorMcpConfigured(workspacePath: string): boolean {
    const vscodeDir = path.join(workspacePath, '.vscode');
    const mcpPath = path.join(vscodeDir, 'mcp.json');

    const terminatorServer = {
        command: 'npx',
        args: ['-y', 'terminator-mcp-agent@latest'],
        env: { LOG_LEVEL: 'info' },
    };

    let root: any = {};
    if (fs.existsSync(mcpPath)) {
        try { root = JSON.parse(fs.readFileSync(mcpPath, 'utf-8')) || {}; } catch { root = {}; }
    }
    if (typeof root !== 'object' || root === null) { root = {}; }
    if (typeof root.servers !== 'object' || root.servers === null) { root.servers = {}; }

    const before = JSON.stringify(root.servers.terminator || null);
    root.servers.terminator = terminatorServer;
    const after = JSON.stringify(root.servers.terminator);

    const existedSame = fs.existsSync(mcpPath) && before === after;
    if (existedSame) { return false; }

    if (!fs.existsSync(vscodeDir)) { fs.mkdirSync(vscodeDir, { recursive: true }); }
    fs.writeFileSync(mcpPath, JSON.stringify(root, null, 2) + '\n', 'utf-8');
    return true;
}

/**
 * Zaistí auto-schvaľovanie nástrojov v agent mode pre tento workspace, aby sa
 * Terminator MCP nepýtal pred každým klikom/screenshotom. Vráti true ak zmenené.
 */
function ensureAutoApproveConfigured(workspacePath: string): boolean {
    const vscodeDir = path.join(workspacePath, '.vscode');
    const settingsPath = path.join(vscodeDir, 'settings.json');
    let root: any = {};
    if (fs.existsSync(settingsPath)) {
        try { root = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) || {}; } catch { root = {}; }
    }
    if (typeof root !== 'object' || root === null) { root = {}; }
    if (root['chat.tools.autoApprove'] === true) { return false; }
    root['chat.tools.autoApprove'] = true;
    if (!fs.existsSync(vscodeDir)) { fs.mkdirSync(vscodeDir, { recursive: true }); }
    fs.writeFileSync(settingsPath, JSON.stringify(root, null, 2) + '\n', 'utf-8');
    return true;
}

// ─── Handoff do agent mode ─────────────────────────────────────────────────────

/**
 * Pokyn uložený do `agent_prompt.md` v priečinku bugu (BEZ hesla).
 */
function buildAgentInstructions(bugFolderName: string, config: AutotestConfig, desktopMetadata: any): string {
    const loginLine = config.loginRequired
        ? `**Prihlásenie:** vyžadované — používateľ: \`${config.username || '<neuvedené>'}\` (heslo zadaj keď ťa appka vyzve)`
        : `**Prihlásenie:** nie je potrebné`;
    const winLine = desktopMetadata?.Name ? `\n- **Okno (title):** \`${desktopMetadata.Name}\`` : '';

    return `# Pokyn pre Copilot agent mode — over opravu bugu (${bugFolderName})

Otestuj scenár pomocou **Terminator MCP** nástrojov (MCP server \`terminator\`, mediar-ai/terminator).
Žiadny code-gen — riaď desktop aplikáciu priamo cez MCP nástroje.

## Režim: AUTONÓMNY
- Pracuj **samostatne a bez potvrdzovania** — kliky, písanie, screenshoty a čítanie stromů rob automaticky, neproš ma o povolenie pred každou akciou.
- Na začiatku naplíň používateľovi 1 vetu: „Spustil som autom. test, klikám sám, ozvem sa len ak niečo potrebujem.“
- **Spýtaj sa používateľa IBA ak:** (a) je potrebné prihlásenie a nemáš údaje, (b) máš niečo vyplniť/vybrať a v scenári to nie je popísané. Inak NIKDY neprerušuj.

- **Scenár:** \`test_scenario.md\` v tomto priečinku (\`autotest/${bugFolderName}/\`)
- **Aplikácia:** ${config.appUrl}${winLine}
- ${loginLine}

## Postup
1. Spusti aplikáciu (terminator open_application / launch, prípadne cez cestu vyššie). Ak už beží, pripoj sa k oknu.
2. Cez \`get_window_tree\` / get_applications zisti reálnu UIA štruktúru — NEHÁDA selektory.
3. Ak je potrebné, prihlás sa.
4. Vykonaj kroky scenára cez MCP nástroje (click, type, press_key, …). Pred každou akciou si over stav cez tree/snapshot.
5. Po každom kroku sprav screenshot do \`steps/\`.
6. Skontroluj očakávaný výsledok zo scenára.

## Selektory (KRITICKÉ)
- NIKDY \`#id\` (nedeterministické). Použi \`role:Type && name:Name\`, prípadne \`nativeid:\`.
- Scope na okno/proces: \`window:NazovOkna >> role:Button >> name:Uložiť\`.
- IAM je WinForms MDI — "dialógy" sú vnorené Pane/Group, nie samostatné okná. Hľadaj cez descendant \`>>\`, nie nové okno.

## Výstupy do tohto priečinka (\`autotest/${bugFolderName}/\`)
- **\`result.md\`** — verdikt **PASSED** alebo **FAILED**, krátke zhrnutie a dôvod (či je oprava dostatočná).
- **\`transcript.md\`** — zoznam vykonaných MCP akcií v poradí.
- **\`steps/\`** — screenshoty z jednotlivých krokov.
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
    return `Over opravu bugu pomocou Terminator MCP (server "terminator"). `
        + `Postupuj podľa pokynu v súbore autotest/${bugFolderName}/agent_prompt.md a podľa scenára v autotest/${bugFolderName}/test_scenario.md. `
        + `Desktop aplikácia: ${config.appUrl}.${creds} `
        + `Riaď aplikáciu priamo cez MCP nástroje (žiadny code-gen). `
        + `Na konci ulož autotest/${bugFolderName}/result.md (verdikt PASSED/FAILED + zhrnutie), `
        + `autotest/${bugFolderName}/transcript.md (zoznam akcií) a screenshoty do autotest/${bugFolderName}/steps/.`;
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
    config: AutotestConfig,
    desktopMetadata: any
): Promise<void> {
    const testDir = path.join(workspacePath, 'autotest', bugFolderName);
    if (!fs.existsSync(testDir)) { fs.mkdirSync(testDir, { recursive: true }); }

    // MCP server config
    const changed = ensureTerminatorMcpConfigured(workspacePath);
    const autoApprove = ensureAutoApproveConfigured(workspacePath);
    response.markdown(changed
        ? `🧩 **Terminator MCP nakonfigurovaný** v \`.vscode/mcp.json\`.\n\n`
        : `🧩 Terminator MCP je už nakonfigurovaný (\`.vscode/mcp.json\`).\n\n`);
    if (autoApprove) {
        response.markdown(`⚡ Zapol som **auto-schvaľovanie nástrojov** (\`chat.tools.autoApprove\`) — agent kliká a robí screenshoty automaticky, pýta sa len pri prihlásení/chýbajúcom kroku.\n\n`);
    }

    // Pokyn pre agenta (bez hesla)
    const instructions = buildAgentInstructions(bugFolderName, config, desktopMetadata);
    const promptPath = path.join(testDir, 'agent_prompt.md');
    fs.writeFileSync(promptPath, instructions, 'utf-8');

    // Handoff query (ephemerálne, môže obsahovať heslo)
    const password = config.loginRequired ? await getLoginPassword(context) : undefined;
    const query = buildHandoffQuery(bugFolderName, config, password);

    response.markdown(`✅ **Scenár pripravený.** Vykonanie a vyhodnotenie prebehne v **Copilot agent mode** cez Terminator MCP.\n\n`);
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

    response.markdown(`\n\nℹ️ Pri prvom spustení potvrď dôveru MCP serveru \`terminator\` (VS Code sa spýta). `
        + `Po dobehnutí nájdeš výsledok v \`autotest/${bugFolderName}/result.md\`.\n\n`);
}

// ─── runDesktopTest ───────────────────────────────────────────────────────────

export async function runDesktopTest(
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

    // Project overview + desktop metadata kontext
    let projectOverview = '';
    let desktopMetadata: any = null;
    try {
        const overviewPath = path.join(workspacePath, 'autotest', 'project_overview.md');
        if (fs.existsSync(overviewPath)) {
            projectOverview = fs.readFileSync(overviewPath, 'utf-8');
            response.markdown(`🗂️ Načítaný project overview\n\n`);
        }
        const metadataPath = path.join(workspacePath, 'autotest', 'desktop_app_metadata.json');
        if (fs.existsSync(metadataPath)) {
            desktopMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
            response.markdown(`🔍 Načítané desktop metadata\n\n`);
        }
    } catch {}

    // Scenár
    response.markdown(`📝 **Vytváram test scenár...**\n\n`);
    const testScenario = await generateScenario(model, token, bugDescription, config, projectOverview);
    response.markdown(`✅ **Test scenár vytvorený!**\n\n`);

    // Priečinok bugu
    const testFolderName = bugId ? `bug_${bugId}` : `test_${getNextTestNumber(workspacePath).toString().padStart(3, '0')}`;
    const autotestDir = path.join(workspacePath, 'autotest');
    if (!fs.existsSync(autotestDir)) {
        fs.mkdirSync(autotestDir, { recursive: true });
        ensureGitignore(workspacePath);
        response.markdown(`📝 *.gitignore* updatovaný — *autotest/* bude ignorovaný Gitom.\n\n`);
    }
    const testDir = path.join(autotestDir, testFolderName);
    if (!fs.existsSync(testDir)) { fs.mkdirSync(testDir, { recursive: true }); }
    fs.writeFileSync(path.join(testDir, 'test_scenario.md'), testScenario, 'utf-8');

    // Delegovať na agent mode + Terminator MCP
    await delegateToAgentMode(context, response, workspacePath, testFolderName, config, desktopMetadata);
}

// ─── handleDesktopRegenerate ──────────────────────────────────────────────────

/**
 * Po úprave `test_scenario.md` znova odovzdá scenár agent mode na pretestovanie.
 */
export async function handleDesktopRegenerate(
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

    let desktopMetadata: any = null;
    try {
        const metadataPath = path.join(workspacePath, 'autotest', 'desktop_app_metadata.json');
        if (fs.existsSync(metadataPath)) { desktopMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8')); }
    } catch {}

    response.markdown(`🔄 **Odovzdávam upravený scenár \`${testFolderName}\` na pretestovanie...**\n\n`);
    await delegateToAgentMode(context, response, workspacePath, testFolderName, config, desktopMetadata);
}

// ─── handleDesktopRecord ──────────────────────────────────────────────────────

export async function handleDesktopRecord(
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

    response.markdown(`🎬 **Desktop recorder pre ${recFolderName}** (pywinauto + pynput)\n\n`);
    const pythonExeRec = await findPythonExecutable() || 'python';

    // Skontroluj pynput
    response.markdown(`🔍 Kontrolujem pynput...\n\n`);
    try {
        await execAsync(`"${pythonExeRec}" -c "import pynput"`, { timeout: 10000 });
    } catch {
        response.markdown(`📦 Inštalujem pynput...\n\n`);
        try {
            await execAsync(`"${pythonExeRec}" -m pip install pynput`, { timeout: 60000 });
        } catch (pipErr: any) {
            response.markdown(`❌ Nepodarilo sa nainštalovať pynput: ${pipErr.message?.substring(0, 200)}\n\nSkús manuálne: \`pip install pynput\`\n\n`);
            return;
        }
    }

    // Recorder script
    const recorderScript = `# -*- coding: utf-8 -*-
"""Desktop Action Recorder — zaznamenáva kliknutia a identifikáciu elementov cez pywinauto."""
import json, time, sys, os
from datetime import datetime
from pynput import mouse, keyboard as kb
from pywinauto import Desktop

OUTPUT_FILE = 'recorded_actions.json'
actions = []
_stop = [False]
_step = [0]
_kb_ctrl = [False]

def get_element_info(x, y):
    try:
        d = Desktop(backend='uia')
        el = d.from_point(x, y)
        if not el: return None
        ei = el.element_info
        parent = None
        try:
            p = el.parent()
            parent = {'title': p.window_text(), 'control_type': p.element_info.control_type} if p else None
        except: pass
        return {
            'title': ei.name or '',
            'control_type': ei.control_type or '',
            'auto_id': ei.automation_id or '',
            'class_name': ei.class_name or '',
            'rect': {'left': ei.rectangle.left, 'top': ei.rectangle.top,
                     'right': ei.rectangle.right, 'bottom': ei.rectangle.bottom} if ei.rectangle else None,
            'parent': parent
        }
    except Exception as e:
        return {'error': str(e)}

def on_click(x, y, button, pressed):
    if not pressed: return
    if button != mouse.Button.left: return
    _step[0] += 1
    el = get_element_info(x, y)
    a = {
        'step': _step[0],
        'action': 'click',
        'x': x, 'y': y,
        'timestamp': datetime.now().isoformat(),
        'element': el
    }
    actions.append(a)
    title = el.get('title', '?') if el else '?'
    ct = el.get('control_type', '?') if el else '?'
    auto_id = el.get('auto_id', '') if el else ''
    print(f"[{_step[0]:02d}] KLIK ({x},{y}) -> '{title}' [{ct}]{' id='+auto_id if auto_id else ''}")
    sys.stdout.flush()

def on_press(key):
    if key == kb.Key.ctrl_l or key == kb.Key.ctrl_r:
        _kb_ctrl[0] = True
    if _kb_ctrl[0] and key == kb.KeyCode.from_char('s'):
        _stop[0] = True
        return False
    if key == kb.Key.esc:
        _stop[0] = True
        return False

def on_release(key):
    if key == kb.Key.ctrl_l or key == kb.Key.ctrl_r:
        _kb_ctrl[0] = False

print("=== DESKTOP RECORDER ===")
print(f"Zaznamenávam do: {OUTPUT_FILE}")
print("Klikaj v aplikácii. Stlac ESC alebo Ctrl+S pre stop.")
print("=" * 30)
sys.stdout.flush()

mouse_listener = mouse.Listener(on_click=on_click)
kb_listener = kb.Listener(on_press=on_press, on_release=on_release)
mouse_listener.start()
kb_listener.start()

while not _stop[0]:
    time.sleep(0.1)

mouse_listener.stop()
kb_listener.stop()

with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
    json.dump({'actions': actions, 'recorded_at': datetime.now().isoformat(), 'total_steps': _step[0]}, f, ensure_ascii=False, indent=2)

print(f"\\nZaznamenaných {_step[0]} akcií -> {OUTPUT_FILE}")
sys.stdout.flush()
`;
    const recorderPath = path.join(recTestDir, '_recorder.py');
    fs.writeFileSync(recorderPath, recorderScript, 'utf-8');

    const recOutputJson = path.join(recTestDir, 'recorded_actions.json');
    let skipRecording = false;

    if (fs.existsSync(recOutputJson)) {
        const existingData = JSON.parse(fs.readFileSync(recOutputJson, 'utf-8'));
        const existingSteps = existingData.total_steps || existingData.actions?.length || 0;
        const existingDate = existingData.recorded_at ? new Date(existingData.recorded_at).toLocaleString('sk-SK') : 'neznámy';
        const rerecordChoice = await vscode.window.showQuickPick([
            { label: `♻️ Regenerovať test z existujúceho záznamu (${existingSteps} krokov, ${existingDate})`, value: 'reuse' },
            { label: '🔴 Nahrať znova — spustiť nové nahrávanie', value: 'rerecord' }
        ], { placeHolder: 'Existuje záznam z predchádzajúceho nahrávania. Čo chceš urobiť?', ignoreFocusOut: true });
        if (!rerecordChoice) { return; }
        skipRecording = rerecordChoice.value === 'reuse';
    }

    if (!skipRecording) {
        response.markdown(`🖱️ **Klikaj v aplikácii.** Každý klik sa zaznamená.\n`);
        response.markdown(`⏹️ **Stlač ESC alebo Ctrl+S pre zastavenie nahrávanie.**\n\n`);
        response.markdown(`▶️ Spúšťam recorder... (okno CMD zostane otvorené)\n\n`);

        const recTermCmd = `start cmd /k ""${pythonExeRec}" "${recorderPath}""`;
        const { exec: _execRaw } = require('child_process');
        await new Promise<void>((resolve) => { _execRaw(recTermCmd, { cwd: recTestDir }, () => resolve()); });

        try { fs.unlinkSync(recOutputJson); } catch {}

        response.markdown(`⏳ Čakám na dokončenie nahrávanie...\n(CMD okno sa zatvorí automaticky po ESC/Ctrl+S)\n\n`);
        const maxWait = 600;
        let waited = 0;
        while (!fs.existsSync(recOutputJson) && waited < maxWait) {
            await new Promise(r => setTimeout(r, 2000));
            waited += 2;
        }
        if (!fs.existsSync(recOutputJson)) {
            response.markdown(`⏰ Timeout — recorder neukončil v ${maxWait}s.\n\n`); return;
        }
    }

    const recData = JSON.parse(fs.readFileSync(recOutputJson, 'utf-8'));
    const totalSteps = recData.total_steps || recData.actions?.length || 0;
    response.markdown(`✅ **Nahrávanie dokončené!** ${totalSteps} krokov zaznamenaných.\n\n`);

    if (recData.actions?.length > 0) {
        const stepLines = recData.actions.map((a: any) =>
            `- Krok ${a.step}: **${a.element?.title || '?'}** [${a.element?.control_type || '?'}]${a.element?.auto_id ? ` id="${a.element.auto_id}"` : ''}`
        ).join('\n');
        response.markdown(`### Zaznamenané kroky:\n${stepLines}\n\n`);
    }

    response.markdown(`🤖 **Generujem pywinauto test zo záznamu...**\n\n`);
    const recModel = await selectAIModel(context, 'code');
    if (recModel) {
        const appNameShort = (config.appUrl || 'app').split('\\').pop()?.replace(/\..*$/, '') || 'app';
        const recActionsStr = JSON.stringify(recData.actions?.slice(0, 30), null, 2);
        const recPrompt = `Toto sú zaznamenané akcie používateľa v desktop aplikácii (pywinauto UIA):\n\`\`\`json\n${recActionsStr}\n\`\`\`\n\nAplikácia: ${config.appUrl}\nPopis: ${recFolderName}\n\nVytvor Python pywinauto test skript ktorý:\n1. Používa VÝHRADNE: pywinauto, subprocess, os, sys, time, json, datetime — ŽIADNE INÉ KNIŽNICE\n2. ZAKÁZANÉ importy: pyautogui, PIL, win32api, win32con, ctypes, uiautomation — NIKDY\n3. Pripojí sa k aplikácii: Application(backend='uia').connect(title_re='.*${appNameShort}.*', timeout=5) — ak nebeží, spustí cez os.startfile(r'${config.appUrl}')\n4. Pre každý krok použije REÁLNE zaznamenané element info (title, control_type, auto_id)\n5. Pre top-level menu (control_type='MenuItem' s parent='MenuBar') VŽDY použi click_top_menu(win, 'text')\n6. Volá step_screenshot() po každom kroku\n7. Má try/except/finally so success_screenshot.png, error_screenshot.png, console_logs.json, sys.exit(0/1)\n8. Obsahuje helper funkcie: log(), click_by_text(), get_edit_value(), get_text_of(), click_top_menu(), step_screenshot()\nVráť IBA Python kód, žiadny markdown.`;
        const recResp = await recModel.sendRequest([vscode.LanguageModelChatMessage.User(recPrompt)], {}, token);
        let recFinal = '';
        for await (const chunk of recResp.text) { recFinal += chunk; }
        recFinal = recFinal.replace(/```(python)?/g, '').trim();
        fs.writeFileSync(path.join(recTestDir, 'test.spec.py'), recFinal, 'utf-8');
        response.markdown(`✅ **Test uložený:** \`autotest/${recFolderName}/test.spec.py\`\n\n`);
        response.markdown(`▶️ Spusti ho: \`@autotest run ${recFolderName}\`\n\n`);
    }
}
