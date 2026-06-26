/**
 * Desktop (pywinauto) automation agent.
 * Exports: runDesktopTest, handleDesktopRegenerate, handleDesktopRecord
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { loadConfiguration, AutotestConfig } from './config';
import { saveBugHistory } from './bug-input';
import { ProjectAutomationMemory, parseStrategyLogsFromFile } from './ui-automation-memory';
import {
    execAsync,
    selectAIModel,
    getNextBugNumber,
    ensureGitignore,
    findPythonExecutable,
    ensurePywinautoInstalled,
    loadTestHealingContext,
    loadProjectHealingLessons,
    saveHealingContext,
    clearHealingContext,
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

function buildDesktopCodePrompt(
    testScenario: string,
    config: AutotestConfig,
    desktopMetadata: any,
    memoryContext: string,
    testHealingContext: string,
    projectHealingLessons: string,
    projectOverview: string
): string {
    const titleRe = (desktopMetadata?.Name || config.appUrl).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').substring(0, 30);
    const appLaunchCode = config.appUrl.includes('\\') || config.appUrl.includes('/')
        ? /\.(exe|bat|com)$/i.test(config.appUrl)
            ? `proc = subprocess.Popen(['${config.appUrl.replace(/\\/g, '\\\\')}'])\n       time.sleep(3)`
            : `os.startfile(r'${config.appUrl}')  # ClickOnce / .appref-ms / .lnk\n       time.sleep(4)\n       proc = None`
        : `subprocess.Popen(['explorer.exe', 'shell:appsFolder\\\\${config.appUrl}'])\n       time.sleep(4)\n       proc = None`;

    return `
Si expert na QA pre Windows desktop aplikácie. Podľa tohto test scenára vytvor Python test skript používajúc pywinauto:

${testScenario}

Cieľ desktop aplikácie: '${config.appUrl}'

${projectOverview ? `PROJECT OVERVIEW:\n${projectOverview}\n` : ''}
${desktopMetadata ? `OVERENÉ ÚDAJE O OKNE (z init):
- Window title regex: "${desktopMetadata.Name}"
- ClassName: "${desktopMetadata.ClassName}"
` : ''}${memoryContext ? `
UI AUTOMATION PAMÄŤ (z predchádzajúcich testov - POUŽI TIETO POZNATKY PREDNOSTNE):
${memoryContext}
` : ''}${testHealingContext ? `
HEALING CONTEXT PRE TENTO BUG (KRITICKÉ - neopakuj tieto chyby):
${testHealingContext}
` : ''}${projectHealingLessons ? `
PROJEKTOVÉ LESSONS (krížové chyby z iných bugov):
${projectHealingLessons.substring(0, 4000)}
` : ''}
KRITICKÉ POŽIADAVKY:
1. Importy:
   from pywinauto import Application
   from pywinauto.findwindows import find_windows
   from pywinauto.keyboard import send_keys
   import time, sys, os, json, subprocess
   from datetime import datetime

2. Funkcia get_timestamp() a log(msg):
   logs = []
   def get_timestamp():
       return datetime.now().strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]
   def log(msg):
       entry = {'timestamp': get_timestamp(), 'message': msg}
       logs.append(entry)
       print(f"[{entry['timestamp']}] {msg}")

3. Spustenie aplikácie - NAJPRV skús pripojiť k bežiacej inštancii, ak nebeží, spusti novú:
   proc = None
   title_re = '.*${titleRe}.*'
   try:
       app = Application(backend='uia').connect(title_re=title_re, timeout=3)
       log('Pripojené k bežiacej inštancii')
   except Exception:
       ${appLaunchCode}
       app = Application(backend='uia').connect(title_re=title_re, timeout=30)

4. Získanie referencie na okno:
   win = app.window(title_re=title_re)
   win.set_focus()
   time.sleep(0.5)

5. POVINNÉ helper funkcie - pridaj HNEĎ po log() funkcii:
   def click_by_text(container, text, screenshot_on_fail=True, timeout=2.5):
       """Nájde element podľa textu kdekoľvek v kontajneri."""
       deadline = time.time() + timeout
       while time.time() < deadline:
           for ctrl in container.descendants():
               try:
                   ct = ctrl.window_text()
                   if text.lower() in ct.lower() and ct.strip():
                       ctrl.click_input()
                       log(f'Kliknuté na: "{ct}"')
                       return ctrl
               except: pass
           time.sleep(0.3)
       if screenshot_on_fail:
           try:
               container.capture_as_image().save('not_found_screenshot.png')
               with open('not_found_info.json', 'w', encoding='utf-8') as f:
                   json.dump({'searching_for': text, 'screenshot': 'not_found_screenshot.png', 'timestamp': get_timestamp()}, f, ensure_ascii=False, indent=2)
               log(f'Screenshot uložený ako not_found_screenshot.png (hľadal som: "{text}")')
           except: pass
       raise Exception(f'Element "{text}" nebol nájdený po {timeout}s')

   def get_edit_value(ctrl):
       """Získa skutočnú HODNOTU Edit poľa (nie AutomationId)."""
       for method in [lambda: ctrl.get_value(), lambda: ctrl.iface_value.CurrentValue,
                     lambda: ctrl.legacy_properties().get('Value', ''), lambda: ctrl.texts()[0] if ctrl.texts() else '']:
           try:
               val = method()
               if val and val.strip() and not val.startswith('AID_'): return val.strip()
           except: pass
       return ctrl.window_text().strip()

   def get_text_of(container, label_text, timeout=2):
       """Nájde hodnotu Edit poľa vedľa labelu."""
       deadline = time.time() + timeout
       while time.time() < deadline:
           ctrls = container.descendants()
           for i, ctrl in enumerate(ctrls):
               try:
                   if label_text.lower() in ctrl.window_text().lower():
                       val = get_edit_value(ctrl)
                       if val: return val
                       for next_ctrl in ctrls[i+1:i+5]:
                           try:
                               if next_ctrl.element_info.control_type == 'Edit':
                                   v = get_edit_value(next_ctrl)
                                   if v: return v
                           except: pass
               except: pass
           time.sleep(0.2)
       return None

   def click_top_menu(win, text, timeout=5):
       """Klikne na top-level menu položku. Spoľahlivé pre WinForms MDI."""
       import re as _re
       deadline = time.time() + timeout
       while time.time() < deadline:
           try:
               for mb in win.descendants(control_type='MenuBar'):
                   for item in mb.children():
                       try:
                           ct = item.window_text()
                           if text.lower() in ct.lower() and ct.strip():
                               item.click_input()
                               log(f'Kliknuté top-menu (MenuBar): "{ct}"')
                               return item
                       except: pass
           except: pass
           try:
               win.child_window(title_re=f'.*{_re.escape(text)}.*', control_type='MenuItem').click_input()
               log(f'Kliknuté top-menu (MenuItem title_re): "{text}"')
               return
           except: pass
           for ctrl in win.descendants():
               try:
                   ct = ctrl.window_text()
                   if text.lower() in ct.lower() and ct.strip():
                       if ctrl.element_info.control_type in ['MenuItem', 'Button', 'Custom', 'Text']:
                           ctrl.click_input()
                           log(f'Kliknuté top-menu (fallback): "{ct}"')
                           return ctrl
               except: pass
           time.sleep(0.3)
       try:
           items = []
           for mb in win.descendants(control_type='MenuBar'):
               items.extend([c.window_text() for c in mb.children() if c.window_text().strip()])
           log(f'DEBUG MenuBar items: {items}')
       except: pass
       raise Exception(f'Top-menu "{text}" nebolo nájdené po {timeout}s')

6. Navigácia cez menu — POVINNÉ PRAVIDLÁ:
   # Top-level menu (napr. Hlavné, Evidencie): VZDY použi click_top_menu()
   # NIKDY nepouzi win.child_window(title='...', control_type='MenuItem').click_input() -- nespol'ahlive!
   click_top_menu(win, 'NazovMenu')
   time.sleep(0.7)
   # Submenu položky: click_by_text
   click_by_text(win, 'NazovSubmenu')
   time.sleep(0.5)

7. KRITICKÉ PRAVIDLO pre WinForms MDI:
   # Co vyzerá ako 'dialóg' NIE JE samostatné okno - je Panel/Group vnořený v MDI okne.
   # NIKDY: app.window(title='Dialóg...')
   # VŽDY hľadaj v potomkoch hlavného okna:
   panel = None
   for ct in ['Group', 'Pane', 'Custom', 'Document']:
       try:
           panel = win.child_window(title_re='.*NazovDialogu.*', control_type=ct)
           panel.wait('visible', timeout=3)
           break
       except: panel = None
   container = panel if panel else win

8. KROKOVÉ SCREENSHOTY — KRITICKÉ. Pridaj helper:
   _step_counter = [0]
   def step_screenshot(name='', container=None):
       import os as _os, re as _rer
       _step_counter[0] += 1
       _dir = 'steps'
       if not _os.path.exists(_dir): _os.makedirs(_dir)
       _n = _rer.sub(r'[^a-zA-Z0-9_]','_',name)[:30] if name else ''
       _fname = f'{_dir}/step_{_step_counter[0]:02d}{"_"+_n if _n else ""}.png'
       try: (container if container else win).capture_as_image().save(_fname); log(f'Screenshot: {_fname}')
       except Exception as _e: log(f'Screenshot chyba: {_e}')
   
   Použi HNEĎ po každej akcii:
   click_top_menu(win, 'Evidencie')
   step_screenshot('po_klik_evidencie')
   click_by_text(win, 'Osoby')
   step_screenshot('po_klik_osoby')

9. Povinná štruktúra skriptu:
    try:
        log('Test started')
        test_passed = False
        # ... kroky testu ...
        (panel if panel else win).capture_as_image().save('success_screenshot.png')
        log('TEST PASSED')
        test_passed = True
    except Exception as e:
        log(f'TEST FAILED: {e}')
        try: win.capture_as_image().save('error_screenshot.png')
        except: pass
        raise
    finally:
        with open('console_logs.json', 'w', encoding='utf-8') as f:
            json.dump({'logs': logs, 'test_passed': test_passed, 'timestamp': get_timestamp()}, f, ensure_ascii=False, indent=2)
        try:
            if proc: proc.terminate()
        except: pass
        sys.exit(0 if test_passed else 1)

Vráť IBA a LEN Python kód, žiadny markdown, žiadne vysvetlenia.
`;
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
    response.markdown(`⚙️ Generujem desktop automatizovaný test (Python pywinauto)...\n\n`);

    const model = await selectAIModel(context, 'code');
    if (!model) {
        response.markdown(`*Chyba: Nenašiel sa AI model. Uisti sa, že máš aktívne GitHub Copilot subscription.*`);
        return;
    }
    response.markdown(`🤖 Kódovací model: **${model.name || model.id}** (${model.vendor})\n\n`);

    const workspaceFolders = vscode.workspace.workspaceFolders;
    const workspacePath = workspaceFolders && workspaceFolders[0] ? workspaceFolders[0].uri.fsPath : process.cwd();

    // Load context
    let projectOverview = '';
    let desktopMetadata: any = null;
    let automationMemory: ProjectAutomationMemory | null = null;
    let memoryContext = '';
    let projectHealingLessons = '';
    let testHealingContext = '';

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
        const targetFolderName = bugId ? `bug_${bugId}` : '';
        if (targetFolderName) {
            testHealingContext = loadTestHealingContext(path.join(workspacePath, 'autotest', targetFolderName));
            if (testHealingContext) { response.markdown(`🩹 Načítaný healing context\n\n`); }
        }
        projectHealingLessons = loadProjectHealingLessons(workspacePath);
        if (projectHealingLessons) { response.markdown(`📚 Načítané projektové lessons\n\n`); }
        const memAutotestDir = path.join(workspacePath, 'autotest');
        if (fs.existsSync(memAutotestDir)) {
            automationMemory = new ProjectAutomationMemory(memAutotestDir, config.appUrl || '');
            memoryContext = automationMemory.formatForPrompt();
            if (memoryContext) { response.markdown(`🧠 Načítaná UI Automation pamäť projektu.\n\n`); }
        }
    } catch {}

    // Generate scenario
    response.markdown(`📝 **Vytváram test scenár...**\n\n`);
    const testScenario = await generateScenario(model, token, bugDescription, config, projectOverview);
    response.markdown(`✅ **Test scenár vytvorený!**\n\n`);

    // Generate Python code
    response.markdown(`⚙️ **Generujem Python pywinauto test script...**\n\n`);
    const codePrompt = buildDesktopCodePrompt(testScenario, config, desktopMetadata, memoryContext, testHealingContext, projectHealingLessons, projectOverview);
    const codeResp = await model.sendRequest([vscode.LanguageModelChatMessage.User(codePrompt)], {}, token);
    let generatedCode = '';
    for await (const chunk of codeResp.text) { generatedCode += chunk; }
    generatedCode = generatedCode.replace(/```(python)?/g, '').trim();

    // Save files
    if (!workspaceFolders) {
        response.markdown(`*Chyba: Nemáš otvorený žiadny projekt.*`);
        return;
    }
    const testFolderName = bugId ? `bug_${bugId}` : `bug_${getNextBugNumber(workspacePath).toString().padStart(3, '0')}`;
    const testDir = path.join(workspacePath, 'autotest', testFolderName);

    if (!fs.existsSync(path.join(workspacePath, 'autotest'))) {
        fs.mkdirSync(path.join(workspacePath, 'autotest'));
        ensureGitignore(workspacePath);
        response.markdown(`📝 *.gitignore* updatovaný - *autotest/* bude ignorovaný Gitom.\n\n`);
    }
    if (!fs.existsSync(testDir)) { fs.mkdirSync(testDir, { recursive: true }); }

    fs.writeFileSync(path.join(testDir, 'test_scenario.md'), testScenario);
    fs.writeFileSync(path.join(testDir, 'test.spec.py'), generatedCode, 'utf-8');
    response.markdown(`✅ **Test bol vygenerovaný a uložený!**\n\n`);
    response.markdown(`📁 **Umiestnenie:** \`autotest/${testFolderName}/\`\n`);
    response.markdown(`- 📝 \`test_scenario.md\`\n- 📦 \`test.spec.py\`\n\n`);

    // Install pywinauto
    const [pythonExe, ready] = await ensurePywinautoInstalled(response);
    if (!ready) {
        response.markdown(`❌ **Nemôžem pokračovať bez Python/pywinauto.**\n\n`);
        return;
    }

    // Run test
    response.markdown(`🚀 **Spúšťam test...**\n\n`);
    await runAndHandleDesktopTest(context, response, token, testDir, testFolderName, testScenario, bugDescription, bugId, workspacePath, automationMemory, memoryContext, projectOverview, config, model, pythonExe);
}

// ─── Shared execution + result handling ──────────────────────────────────────

async function runAndHandleDesktopTest(
    context: vscode.ExtensionContext,
    response: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    testDir: string,
    testFolderName: string,
    testScenario: string,
    bugDescription: string,
    bugId: string | undefined,
    workspacePath: string,
    automationMemory: ProjectAutomationMemory | null,
    memoryContext: string,
    projectOverview: string,
    config: AutotestConfig,
    model: vscode.LanguageModelChat,
    pythonExe: string
): Promise<void> {
    try {
        const { stdout, stderr } = await execAsync(`"${pythonExe}" test.spec.py`, { cwd: testDir, timeout: 120000 });
        if (stderr) { response.markdown(`⚠️ Console output:\n\`\`\`\n${stderr.substring(0, 500)}\n\`\`\`\n\n`); }
        response.markdown(`✅ **Test dokončený!**\n\n`);
        await handleDesktopTestSuccess(context, response, token, testDir, testFolderName, testScenario, bugDescription, bugId, workspacePath, automationMemory, stdout, stderr);
    } catch (execError: any) {
        const errDetail = [execError.stderr, execError.stdout].filter(Boolean).join('\n').trim() || execError.message;
        response.markdown(`❌ **Chyba pri spustení:**\n\`\`\`\n${errDetail.substring(0, 3000)}\n\`\`\`\n\n`);
        response.markdown(`*Uisti sa, že aplikácia je dostupná: ${config.appUrl}*\n\n`);
        await handleDesktopExecError(context, response, token, testDir, testFolderName, testScenario, bugDescription, bugId, workspacePath, automationMemory, memoryContext, config, model, pythonExe, errDetail);
    }
}

async function handleDesktopTestSuccess(
    context: vscode.ExtensionContext,
    response: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    testDir: string,
    testFolderName: string,
    testScenario: string,
    bugDescription: string,
    bugId: string | undefined,
    workspacePath: string,
    automationMemory: ProjectAutomationMemory | null,
    stdout: string,
    stderr: string
): Promise<void> {
    const successShot = path.join(testDir, 'success_screenshot.png');
    const notFoundShot = path.join(testDir, 'not_found_screenshot.png');
    const errorShot = path.join(testDir, 'error_screenshot.png');
    const notFoundInfoPath = path.join(testDir, 'not_found_info.json');
    const testResultPath = path.join(testDir, 'test_result.md');

    const analysisShot = fs.existsSync(notFoundShot) ? notFoundShot : fs.existsSync(errorShot) ? errorShot : null;
    let notFoundInfo: { searching_for?: string } = {};
    if (fs.existsSync(notFoundInfoPath)) { try { notFoundInfo = JSON.parse(fs.readFileSync(notFoundInfoPath, 'utf-8')); } catch {} }

    if (analysisShot) {
        response.markdown(`⚠️ **Test zlyhala pred dokončením!**\n\n`);
        if (notFoundInfo.searching_for) { response.markdown(`🔍 Element **"${notFoundInfo.searching_for}"** nebol nájdený.\n\n`); }
        response.markdown(`📸 Screenshot: \`${testFolderName}/${path.basename(analysisShot)}\`\n\n`);
        const stepsDir = path.join(testDir, 'steps');
        if (fs.existsSync(stepsDir)) {
            const stepFiles = fs.readdirSync(stepsDir).filter((f: string) => f.endsWith('.png')).sort();
            if (stepFiles.length > 0) { response.markdown(`📷 **Krokové screenshoty (${stepFiles.length}):** ${stepFiles.map((f: string) => `\`${testFolderName}/steps/${f}\``).join(', ')}\n\n`); }
        }
        const visionModel = await selectAIModel(context, 'vision');
        if (visionModel) {
            const errorAnalysisPrompt = notFoundInfo.searching_for
                ? `Tu je screenshot Windows desktop aplikácie. Test sa pokúšal nájsť element "${notFoundInfo.searching_for}" ale nepodarilo sa.\n\nTest scenár:\n${testScenario}\n\nDÔLEŽITÉ: Test používa Python pywinauto. Všetky opravy MUSIA byť v Python pywinauto syntaxi.\n\nAnalýzuj a povedz:\n1. Čo vidíš na obrazovke (viditeľné menu, tlačidlá)?\n2. Kde sa pravdepodobne nachádza element "${notFoundInfo.searching_for}"?\n3. Aký PRESNÝ text má daný element v UI?\n4. Konkrétna oprava v Python pywinauto: click_by_text(win, 'SKUTOCNY_TEXT') alebo win.child_window(...)`
                : `Tu je screenshot Windows desktop aplikácie keď test zlyhala.\n\nTest scenár:\n${testScenario}\n\nDÔLEŽITÉ: Python pywinauto syntaxi.\n\nAnalýzuj: 1. Na akom kroku zlyhalo? 2. Čo vidíš? 3. Návrh opravy v Python pywinauto.`;
            try {
                const buf = fs.readFileSync(analysisShot);
                const msgs = [vscode.LanguageModelChatMessage.User([new vscode.LanguageModelTextPart(errorAnalysisPrompt), vscode.LanguageModelDataPart.image(buf, 'image/png')])];
                const vResp = await visionModel.sendRequest(msgs, {}, token);
                let errorAnalysis = '';
                for await (const chunk of vResp.text) { errorAnalysis += chunk; }
                response.markdown(`### 🔍 Analýza zlyhania:\n\n${errorAnalysis}\n\n`);
                fs.writeFileSync(testResultPath, `# Test Result: FAILED ❌\n\n## Test Info\n- **Bug ID:** ${bugId || 'N/A'}\n- **Timestamp:** ${new Date().toLocaleString('sk-SK')}\n- **Status:** FAILED\n\n## Problém\n${errorAnalysis}\n\n## Console Output\n\`\`\`\n${stderr || 'Žiadny stderr output'}\n\`\`\`\n\n## Ďalšie kroky\n1. Otvor \`test_scenario.md\` a uprav kroky\n2. Spusti: \`@autotest regenerate ${testFolderName}\`\n`);
                saveHealingContext(workspacePath, testFolderName, testScenario, errorAnalysis, stderr || '', 'runDesktopTest:error_screenshot', notFoundInfo.searching_for);
                if (automationMemory) {
                    try {
                        const recs = parseStrategyLogsFromFile(path.join(testDir, 'console_logs.json'));
                        for (const r of recs) { automationMemory.recordResult(r.elementType, r.elementName, r.strategyName, r.result); }
                        if (notFoundInfo.searching_for) {
                            const visionSummary = errorAnalysis.split('\n').find(l => l.trim().length > 20) || errorAnalysis.substring(0, 100);
                            automationMemory.addNote(`[not_found] '${notFoundInfo.searching_for}' → vision: ${visionSummary.substring(0, 120)}`);
                        } else {
                            automationMemory.addNote(`Test ${testFolderName} FAILED — ${stderr?.split('\n')[0]?.substring(0, 80) || 'unknown'}`);
                        }
                    } catch {}
                }
                await saveBugHistory(context, { bugId, description: bugDescription, timestamp: new Date().toISOString(), testResult: 'failed' });
            } catch {}
        }
        return;
    }

    if (!fs.existsSync(successShot)) {
        response.markdown(`❌ *Screenshot sa nenašiel. Test mohol zlyhať.*\n\n`);
        saveHealingContext(workspacePath, testFolderName, testScenario, 'Test nevyprodukoval success screenshot.', stderr || '', 'runDesktopTest:missing_screenshot');
        await saveBugHistory(context, { bugId, description: bugDescription, timestamp: new Date().toISOString(), testResult: 'failed' });
        return;
    }

    response.markdown(`📸 Screenshot úspešne vytvorený!\n\n`);
    response.markdown(`👁️ **Analyzujem výsledok testu...**\n\n`);
    const visionModel = await selectAIModel(context, 'vision');
    let analysisResult = 'Vision model nebol dostupný.';
    if (visionModel) {
        try {
            const buf = fs.readFileSync(successShot);
            const visionPrompt = `Tu je screenshot Windows desktop aplikácie po dokončení testu.\n\nTest scenár:\n${testScenario}\n\nPôvodný bug: "${bugDescription}"\n\nSkontroluj:\n1. Či test prebehol správne\n2. Či je viditeľný očakávaný výsledok`;
            const msgs = [vscode.LanguageModelChatMessage.User([new vscode.LanguageModelTextPart(visionPrompt), vscode.LanguageModelDataPart.image(buf, 'image/png')])];
            const vResp = await visionModel.sendRequest(msgs, {}, token);
            analysisResult = '';
            for await (const chunk of vResp.text) { analysisResult += chunk; }
        } catch {}
        response.markdown(`### 🔍 Výsledok analýzy:\n\n${analysisResult}\n\n`);
    }

    fs.writeFileSync(testResultPath, `# Test Result: PASSED ✅\n\n## Test Info\n- **Bug ID:** ${bugId || 'N/A'}\n- **Bug Description:** ${bugDescription}\n- **Timestamp:** ${new Date().toLocaleString('sk-SK')}\n- **Status:** PASSED\n\n## Test Scenár\n${testScenario}\n\n## AI Vision Analysis\n${analysisResult}\n\n## Console Output\n\`\`\`\n${stderr || stdout || 'Test dokončený bez chýb'}\n\`\`\`\n`);
    clearHealingContext(workspacePath, testFolderName);
    response.markdown(`📄 Detail report: \`autotest/${testFolderName}/test_result.md\`\n\n`);

    if (automationMemory) {
        try {
            const recs = parseStrategyLogsFromFile(path.join(testDir, 'console_logs.json'));
            for (const r of recs) { automationMemory.recordResult(r.elementType, r.elementName, r.strategyName, r.result); }
            automationMemory.addNote(`Test ${testFolderName} PASSED`);
        } catch {}
    }
    await saveBugHistory(context, { bugId, description: bugDescription, timestamp: new Date().toISOString(), testResult: 'success' });
}

async function handleDesktopExecError(
    context: vscode.ExtensionContext,
    response: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    testDir: string,
    testFolderName: string,
    testScenario: string,
    bugDescription: string,
    bugId: string | undefined,
    workspacePath: string,
    automationMemory: ProjectAutomationMemory | null,
    memoryContext: string,
    config: AutotestConfig,
    model: vscode.LanguageModelChat,
    pythonExe: string,
    errDetail: string
): Promise<void> {
    const successShot = path.join(testDir, 'success_screenshot.png');
    const notFoundShot = path.join(testDir, 'not_found_screenshot.png');
    const errorShot = path.join(testDir, 'error_screenshot.png');
    const catchShot = fs.existsSync(successShot) ? successShot : fs.existsSync(notFoundShot) ? notFoundShot : fs.existsSync(errorShot) ? errorShot : null;

    if (!catchShot) {
        saveHealingContext(workspacePath, testFolderName, testScenario, errDetail, errDetail, 'runDesktopTest:exec_no_screenshot');
        await saveBugHistory(context, { bugId, description: bugDescription, timestamp: new Date().toISOString(), testResult: 'failed' });
        return;
    }

    const isSuccess = catchShot === successShot;
    response.markdown(`📸 Screenshot: \`${testFolderName}/${path.basename(catchShot)}\`\n\n`);
    const visionModel = await selectAIModel(context, 'vision');
    if (!visionModel) {
        saveHealingContext(workspacePath, testFolderName, testScenario, errDetail, errDetail, 'runDesktopTest:exec_no_vision');
        await saveBugHistory(context, { bugId, description: bugDescription, timestamp: new Date().toISOString(), testResult: 'failed' });
        return;
    }

    const visionPrompt = isSuccess
        ? `Tu je screenshot Windows desktop aplikácie. Test skončil s chybou (exit code 1), ale success screenshot bol uložený.\n\nTest scenár:\n${testScenario}\n\nChyba:\n${errDetail.substring(0, 500)}\n\nDÔLEŽITÉ: Python pywinauto syntaxi.\n\nZhodnot:\n1. Čo vidíš na obrazovke?\n2. Vyzerat test vizuálne úspešne?\n3. Ak áno - napíš VIZUÁLNE PASSED.`
        : `Tu je screenshot Windows desktop aplikácie keď test zlyhal.\n\nTest scenár:\n${testScenario}\n\nChyba:\n${errDetail.substring(0, 500)}\n\nDÔLEŽITÉ: Python pywinauto syntaxi.\n\nPovedz:\n1. Čo vidíš?\n2. Kde zlyhalo?\n3. Návrh opravy v Python pywinauto.`;

    let analysis = '';
    try {
        const buf = fs.readFileSync(catchShot);
        const msgs = [vscode.LanguageModelChatMessage.User([new vscode.LanguageModelTextPart(visionPrompt), vscode.LanguageModelDataPart.image(buf, 'image/png')])];
        const vResp = await visionModel.sendRequest(msgs, {}, token);
        for await (const chunk of vResp.text) { analysis += chunk; }
    } catch {}
    response.markdown(`### 👁️ Analýza:\n${analysis}\n\n`);

    const visualPassed = isSuccess && analysis.toUpperCase().includes('VIZUÁLNE PASSED');
    const resultPath = path.join(testDir, 'test_result.md');
    fs.writeFileSync(resultPath, `# Test Result: ${visualPassed ? 'VIZUÁLNE PASSED ✅' : 'FAILED ❌'}\n\n## Test Info\n- **Folder:** ${testFolderName}\n- **Timestamp:** ${new Date().toLocaleString('sk-SK')}\n- **Status:** ${visualPassed ? 'VISUAL_PASSED' : 'FAILED'}\n\n## Vision Analýza\n${analysis}\n\n## Chyba skriptu\n\`\`\`\n${errDetail.substring(0, 1000)}\n\`\`\`\n`);

    try {
        const mem = new ProjectAutomationMemory(path.join(workspacePath, 'autotest'), config.appUrl || testFolderName);
        mem.addNote(`Test ${testFolderName} ${visualPassed ? 'VIZUÁLNE PASSED' : 'FAILED'} — Vision: ${analysis.substring(0, 200)}`);
        if (visualPassed) { mem.recordResult('test', testFolderName, 'visual-assert', 'success'); }
        mem.save();
    } catch {}

    if (visualPassed) {
        clearHealingContext(workspacePath, testFolderName);
        response.markdown(`✅ **Vizuálne PASSED** — screenshot potvrdzuje správny výsledok.\n\n`);
        await saveBugHistory(context, { bugId, description: bugDescription, timestamp: new Date().toISOString(), testResult: 'success' });
        return;
    }

    saveHealingContext(workspacePath, testFolderName, testScenario, analysis, errDetail.substring(0, 1000), 'runDesktopTest:exec_catch');
    response.markdown(`📝 Report: \`autotest/${testFolderName}/test_result.md\`\n\n`);

    // Auto-heal loop
    let healed = false;
    for (let attempt = 1; attempt <= 2 && !healed; attempt++) {
        response.markdown(`🔄 **Auto-healing pokus ${attempt}/2**...\n\n`);
        try {
            const currentCode = fs.existsSync(path.join(testDir, 'test.spec.py'))
                ? fs.readFileSync(path.join(testDir, 'test.spec.py'), 'utf-8').substring(0, 3000) : '';
            const healPrompt = `Python pywinauto test zlyhal.\n\nAnalýza zlyhania:\n${analysis}\n\nTest scenár:\n${testScenario}\n\nPosledný skript:\n\`\`\`python\n${currentCode}\n\`\`\`\n${memoryContext ? `\nUI Automation pamäť:\n${memoryContext}` : ''}\n\nDÔLEŽITÉ OPRAVY:\n- Pre top-level menu POUŽI click_top_menu(win, 'text') namiesto child_window(title=...).click_input()\n- click_top_menu helper: skúša MenuBar.children() ako prvý prístup\n- Nezabudni definovať click_top_menu v skripte\n\nVráť IBA kompletný Python kód, žiadny markdown.`;
            const healResp = await model.sendRequest([vscode.LanguageModelChatMessage.User(healPrompt)], {}, token);
            let healCode = '';
            for await (const chunk of healResp.text) { healCode += chunk; }
            healCode = healCode.replace(/```(python)?/g, '').trim();
            if (healCode.length < 50) { break; }
            fs.writeFileSync(path.join(testDir, 'test.spec.py'), healCode);
            for (const f of ['success_screenshot.png', 'error_screenshot.png', 'not_found_screenshot.png', 'not_found_info.json']) { try { fs.unlinkSync(path.join(testDir, f)); } catch {} }
            const stepsDir = path.join(testDir, 'steps');
            if (fs.existsSync(stepsDir)) { try { fs.readdirSync(stepsDir).forEach((f: string) => { try { fs.unlinkSync(path.join(stepsDir, f)); } catch {} }); fs.rmdirSync(stepsDir); } catch {} }
            response.markdown(`▶️ Spúšťam opravený test...\n\n`);
            const { stdout: hO, stderr: hE } = await execAsync(`"${pythonExe}" test.spec.py`, { cwd: testDir, timeout: 120000 });
            const hOut = [hO, hE].filter(Boolean).join('\n').trim();
            if (hOut) { response.markdown(`📋 Output:\n\`\`\`\n${hOut.substring(0, 600)}\n\`\`\`\n\n`); }
            if (fs.existsSync(path.join(testDir, 'success_screenshot.png'))) {
                response.markdown(`✅ **Auto-healing úspešný!** Test prešiel na pokuse ${attempt}.\n\n`);
                clearHealingContext(workspacePath, testFolderName);
                if (automationMemory) { try { automationMemory.addNote(`Test ${testFolderName} AUTO-HEALED po ${attempt} pokuse`); } catch {} }
                await saveBugHistory(context, { bugId, description: bugDescription, timestamp: new Date().toISOString(), testResult: 'success' });
                healed = true;
            } else {
                response.markdown(`⚠️ Auto-healing pokus ${attempt} neúspešný...\n\n`);
            }
        } catch (healErr: any) {
            response.markdown(`⚠️ Auto-healing chyba: ${healErr.message?.substring(0, 200)}\n\n`);
            break;
        }
    }
    if (!healed) {
        await saveBugHistory(context, { bugId, description: bugDescription, timestamp: new Date().toISOString(), testResult: 'failed' });
        response.markdown(`🛠️ Auto-healing vyčerpal pokusy. Uprav \`autotest/${testFolderName}/test_scenario.md\` a spusti \`@autotest regenerate ${testFolderName}\`.\n\n`);
    }
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

// ─── handleDesktopRegenerate ──────────────────────────────────────────────────

export async function handleDesktopRegenerate(
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

    const folderMatch = request.prompt.match(/(?:regenerate|regen)\s+(\S+)/i);
    const rawFolder = folderMatch ? folderMatch[1] : '';
    let testFolderName = rawFolder;
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
        response.markdown(`❌ Nenašiel sa \`test_scenario.md\`.\n\n`); return;
    }
    let updatedScenario = fs.readFileSync(scenarioPath, 'utf-8');

    response.markdown(`🔄 **Regenerujem desktop test pre \`${testFolderName}\`**\n\n`);

    const model = await selectAIModel(context, 'code');
    if (!model) {
        response.markdown(`*Chyba: Nenašiel sa AI model.*`); return;
    }

    // Load context
    let projectOverview = '';
    let desktopMetadata: any = null;
    let memoryContext = '';
    let testHealingContext = '';
    let projectHealingLessons = '';
    let regenAutomationMemory: ProjectAutomationMemory | null = null;

    try {
        const overviewPath = path.join(workspacePath, 'autotest', 'project_overview.md');
        if (fs.existsSync(overviewPath)) { projectOverview = fs.readFileSync(overviewPath, 'utf-8'); }
        const metadataPath = path.join(workspacePath, 'autotest', 'desktop_app_metadata.json');
        if (fs.existsSync(metadataPath)) { desktopMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8')); }
        testHealingContext = loadTestHealingContext(testDir);
        if (testHealingContext) { response.markdown(`🩹 Načítaný healing context\n\n`); }
        projectHealingLessons = loadProjectHealingLessons(workspacePath);
        const memDir = path.join(workspacePath, 'autotest');
        if (fs.existsSync(memDir)) {
            regenAutomationMemory = new ProjectAutomationMemory(memDir, config.appUrl || '');
            memoryContext = regenAutomationMemory.formatForPrompt();
        }
    } catch {}

    response.markdown(`⚙️ **Generujem nový Python pywinauto kód...**\n\n`);
    const regenPrompt = buildDesktopCodePrompt(updatedScenario, config, desktopMetadata, memoryContext, testHealingContext, projectHealingLessons, projectOverview);
    const regenResp = await model.sendRequest([vscode.LanguageModelChatMessage.User(regenPrompt)], {}, token);
    let regeneratedCode = '';
    for await (const chunk of regenResp.text) { regeneratedCode += chunk; }
    regeneratedCode = regeneratedCode.replace(/```(python)?/g, '').trim();

    fs.writeFileSync(path.join(testDir, 'test.spec.py'), regeneratedCode);
    response.markdown(`✅ **Test script regenerovaný!** Uložený do: \`autotest/${testFolderName}/test.spec.py\`\n\n`);

    const [pythonExe, ready] = await ensurePywinautoInstalled(response);
    if (!ready) {
        response.markdown(`❌ **Regenerovaný test sa nespustil, chýbajú runtime závislosti.**\n\n`); return;
    }

    response.markdown(`🚀 Spúšťam test...\n\n`);
    for (const f of ['success_screenshot.png', 'error_screenshot.png', 'not_found_screenshot.png', 'not_found_info.json', 'test_result.md']) {
        try { fs.unlinkSync(path.join(testDir, f)); } catch {}
    }
    const stepsDir = path.join(testDir, 'steps');
    if (fs.existsSync(stepsDir)) { try { fs.readdirSync(stepsDir).forEach((f: string) => { try { fs.unlinkSync(path.join(stepsDir, f)); } catch {} }); fs.rmdirSync(stepsDir); } catch {} }

    try {
        const { stdout, stderr } = await execAsync(`"${pythonExe}" test.spec.py`, { cwd: testDir, timeout: 120000 });
        const combinedOutput = [stdout, stderr].filter(Boolean).join('\n').trim();
        if (combinedOutput) { response.markdown(`⚠️ Console output:\n\`\`\`\n${combinedOutput.substring(0, 1000)}\n\`\`\`\n\n`); }

        const successShot = path.join(testDir, 'success_screenshot.png');
        const errorShot = path.join(testDir, 'error_screenshot.png');
        const testResultPath = path.join(testDir, 'test_result.md');

        if (fs.existsSync(errorShot)) {
            response.markdown(`⚠️ **Test stále zlyhala.**\n\n`);
            const visionModel = await selectAIModel(context, 'vision');
            let errorAnalysis = 'Vision model nebol dostupný.';
            if (visionModel) {
                const isPyRegen = true;
                const errorPrompt = `Tu je screenshot Windows desktop aplikácie v momente keď test zlyhala.\n\nTest scenár:\n${updatedScenario}\n\nChyba:\n${combinedOutput}\n\nDÔLEŽITÉ: Aplikácia sa testuje cez Python pywinauto. Všetky opravy MUSÍA byť v Python pywinauto syntaxi (nie C#, nie FlaUI). Ak bol problém s nájdením menu položky, použi click_top_menu(win, "text") namiesto child_window(title=...).click_input().\n\nAnalýzuj screenshot a povedz:\n1. Na akom kroku test zlyhala?\n2. Čo sa na obrazovke nachádza?\n3. Konkrétna oprava v Python pywinauto syntaxi.`;
                try {
                    const buf = fs.readFileSync(errorShot);
                    const msgs = [vscode.LanguageModelChatMessage.User([new vscode.LanguageModelTextPart(errorPrompt), vscode.LanguageModelDataPart.image(buf, 'image/png')])];
                    const vResp = await visionModel.sendRequest(msgs, {}, token);
                    errorAnalysis = '';
                    for await (const chunk of vResp.text) { errorAnalysis += chunk; }
                } catch (e: any) { errorAnalysis = `Vision analýza zlyhala: ${e.message}`; }
                response.markdown(`### 🔍 Analýza zlyhania:\n\n${errorAnalysis}\n\n`);
            }
            fs.writeFileSync(testResultPath, `# Test Result: FAILED ❌\n\n## Test Info\n- **Folder:** ${testFolderName}\n- **Timestamp:** ${new Date().toLocaleString('sk-SK')}\n- **Status:** FAILED\n\n## Problém\n${errorAnalysis}\n\n## Console Output\n\`\`\`\n${combinedOutput || 'Žiadny output'}\n\`\`\`\n`);
            saveHealingContext(workspacePath, testFolderName, updatedScenario, errorAnalysis, combinedOutput || '', 'regenerate:error_screenshot');
            if (regenAutomationMemory) { try { regenAutomationMemory.addNote(`Test ${testFolderName} regenerate FAILED`); } catch {} }
            await saveBugHistory(context, { bugId: testFolderName.replace(/^(bug_|test_)/, ''), description: updatedScenario.split('\n').find((l: string) => l.trim().length > 5) || testFolderName, timestamp: new Date().toISOString(), testResult: 'failed' });
            return;
        }

        if (!fs.existsSync(successShot)) {
            response.markdown(`⚠️ **Žiadny screenshot sa nevytvoril.**\n\n`);
            response.markdown(`Skontroluj \`autotest/${testFolderName}/test.spec.py\` a uprav test_scenario.md.\n\n`);
            return;
        }

        response.markdown(`✅ **Test prešiel úspešne!**\n\n`);
        response.markdown(`📸 Screenshot: \`${testFolderName}/success_screenshot.png\`\n\n`);
        const visionModel = await selectAIModel(context, 'vision');
        let analysisResult = 'Vision model nebol dostupný.';
        if (visionModel) {
            const visionPrompt = `Screenshot po dokončení regenerated desktop testu.\n\nTest scenár:\n${updatedScenario}\n\nZhodnoť: Či test prebehol správne.`;
            try {
                const buf = fs.readFileSync(successShot);
                const msgs = [vscode.LanguageModelChatMessage.User([new vscode.LanguageModelTextPart(visionPrompt), vscode.LanguageModelDataPart.image(buf, 'image/png')])];
                const vResp = await visionModel.sendRequest(msgs, {}, token);
                analysisResult = '';
                for await (const chunk of vResp.text) { analysisResult += chunk; }
            } catch {}
            response.markdown(`### 🔍 Výsledok analýzy:\n\n${analysisResult}\n\n`);
        }
        fs.writeFileSync(testResultPath, `# Test Result: PASSED ✅\n\n## Test Info\n- **Folder:** ${testFolderName}\n- **Timestamp:** ${new Date().toLocaleString('sk-SK')}\n- **Status:** PASSED\n\n## AI Vision Analysis\n${analysisResult}\n\n## Console Output\n\`\`\`\n${combinedOutput || 'Test dokončený bez chýb'}\n\`\`\`\n`);
        clearHealingContext(workspacePath, testFolderName);
        if (regenAutomationMemory) { try { regenAutomationMemory.addNote(`Test ${testFolderName} regenerate PASSED`); } catch {} }
        await saveBugHistory(context, { bugId: testFolderName.replace(/^(bug_|test_)/, ''), description: updatedScenario.split('\n').find((l: string) => l.trim().length > 5) || testFolderName, timestamp: new Date().toISOString(), testResult: 'success' });

    } catch (execError: any) {
        const errDetail = [execError.stderr, execError.stdout].filter(Boolean).join('\n').trim() || execError.message;
        response.markdown(`❌ **Chyba pri spustení:**\n\`\`\`\n${errDetail.substring(0, 3000)}\n\`\`\`\n\n`);

        const catchSuccessShot = path.join(testDir, 'success_screenshot.png');
        const catchErrorShot = path.join(testDir, 'error_screenshot.png');
        const catchShot = fs.existsSync(catchSuccessShot) ? catchSuccessShot : fs.existsSync(catchErrorShot) ? catchErrorShot : null;
        if (catchShot) {
            const isSuccessShot = catchShot === catchSuccessShot;
            const vm = await selectAIModel(context, 'vision');
            if (vm) {
                const vPrompt = isSuccessShot
                    ? `Test skončil s chybou, ale success screenshot existuje.\nTest scenár:\n${updatedScenario}\nChyba:\n${errDetail.substring(0, 500)}\nDÔLEŽITÉ: Python pywinauto.\nZhodnoť: 1. Čo vidíš? 2. VIZUÁLNE PASSED ak je výsledok správny.`
                    : `Desktop test zlyhal.\nTest scenár:\n${updatedScenario}\nChyba:\n${errDetail.substring(0, 500)}\nDÔLEŽITÉ: Python pywinauto.\nPovedz: 1. Čo vidíš? 2. Kde zlyhalo? 3. Oprava v Python pywinauto.`;
                try {
                    const buf = fs.readFileSync(catchShot);
                    const msgs = [vscode.LanguageModelChatMessage.User([new vscode.LanguageModelTextPart(vPrompt), vscode.LanguageModelDataPart.image(buf, 'image/png')])];
                    const vResp = await vm.sendRequest(msgs, {}, token);
                    let vAnalysis = '';
                    for await (const chunk of vResp.text) { vAnalysis += chunk; }
                    response.markdown(`### 👁️ Analýza:\n${vAnalysis}\n\n`);
                    const visualPassed = isSuccessShot && vAnalysis.toUpperCase().includes('VIZUÁLNE PASSED');
                    const resultPath = path.join(testDir, 'test_result.md');
                    fs.writeFileSync(resultPath, `# Test Result: ${visualPassed ? 'VIZUÁLNE PASSED ✅' : 'FAILED ❌'}\n\n## Status: ${visualPassed ? 'VISUAL_PASSED' : 'FAILED'}\n\n## Vision Analýza\n${vAnalysis}\n\n## Chyba\n\`\`\`\n${errDetail.substring(0, 1000)}\n\`\`\`\n`);
                    if (visualPassed) {
                        clearHealingContext(workspacePath, testFolderName);
                        response.markdown(`✅ **Vizuálne PASSED**\n\n`);
                        await saveBugHistory(context, { bugId: testFolderName.replace(/^(bug_|test_)/, ''), description: updatedScenario.split('\n').find((l: string) => l.trim().length > 5) || testFolderName, timestamp: new Date().toISOString(), testResult: 'success' });
                    } else {
                        saveHealingContext(workspacePath, testFolderName, updatedScenario, vAnalysis, errDetail.substring(0, 1000), 'regenerate:exec_catch');
                        // Auto-heal
                        let rhHealed = false;
                        for (let rhi = 1; rhi <= 2 && !rhHealed; rhi++) {
                            response.markdown(`🔄 **Auto-healing pokus ${rhi}/2**...\n\n`);
                            try {
                                const rhCurr = fs.existsSync(path.join(testDir, 'test.spec.py')) ? fs.readFileSync(path.join(testDir, 'test.spec.py'), 'utf-8').substring(0, 3000) : '';
                                const rhPr = `Python pywinauto test zlyhal.\n\nAnalýza zlyhania:\n${vAnalysis}\n\nTest scenár:\n${updatedScenario}\n\nPosledný skript:\n\`\`\`python\n${rhCurr}\n\`\`\`\n${memoryContext ? `\nUI Automation pamäť:\n${memoryContext}` : ''}\n\nDÔLEŽITÉ OPRAVY:\n- Pre top-level menu POUŽI click_top_menu(win, 'text') namiesto child_window(title=...).click_input()\n- Nezabudni definovať click_top_menu v skripte\n\nVráť IBA kompletný Python kód, žiadny markdown.`;
                                const rhResp = await model.sendRequest([vscode.LanguageModelChatMessage.User(rhPr)], {}, token);
                                let rhCode = '';
                                for await (const chunk of rhResp.text) { rhCode += chunk; }
                                rhCode = rhCode.replace(/```(python)?/g, '').trim();
                                if (rhCode.length < 50) { break; }
                                fs.writeFileSync(path.join(testDir, 'test.spec.py'), rhCode);
                                for (const f of ['success_screenshot.png', 'error_screenshot.png', 'not_found_screenshot.png', 'not_found_info.json']) { try { fs.unlinkSync(path.join(testDir, f)); } catch {} }
                                response.markdown(`▶️ Spúšťam opravený test...\n\n`);
                                const { stdout: rhO, stderr: rhE } = await execAsync(`"${pythonExe}" test.spec.py`, { cwd: testDir, timeout: 120000 });
                                const rhOut = [rhO, rhE].filter(Boolean).join('\n').trim();
                                if (rhOut) { response.markdown(`📋 Output:\n\`\`\`\n${rhOut.substring(0, 600)}\n\`\`\`\n\n`); }
                                if (fs.existsSync(path.join(testDir, 'success_screenshot.png'))) {
                                    response.markdown(`✅ **Auto-healing úspešný!** Test prešiel na pokuse ${rhi}.\n\n`);
                                    clearHealingContext(workspacePath, testFolderName);
                                    await saveBugHistory(context, { bugId: testFolderName.replace(/^(bug_|test_)/, ''), description: updatedScenario.split('\n').find((l: string) => l.trim().length > 5) || testFolderName, timestamp: new Date().toISOString(), testResult: 'success' });
                                    rhHealed = true;
                                } else { response.markdown(`⚠️ Auto-healing pokus ${rhi} neúspešný...\n\n`); }
                            } catch (rhErr: any) { response.markdown(`⚠️ Auto-healing chyba: ${rhErr.message?.substring(0, 200)}\n\n`); break; }
                        }
                        if (!rhHealed) {
                            await saveBugHistory(context, { bugId: testFolderName.replace(/^(bug_|test_)/, ''), description: updatedScenario.split('\n').find((l: string) => l.trim().length > 5) || testFolderName, timestamp: new Date().toISOString(), testResult: 'failed' });
                            response.markdown(`🛠️ Auto-healing vyčerpal pokusy. Uprav \`test_scenario.md\` a spusti \`@autotest regenerate ${testFolderName}\`.\n\n`);
                        }
                    }
                } catch (e: any) { response.markdown(`*Vision analýza zlyhala: ${e.message}*\n\n`); }
            }
        }
    }
}
