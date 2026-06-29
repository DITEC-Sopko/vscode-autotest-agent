import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { 
    loadConfiguration, 
    saveUserRole, 
    saveEnvironmentConfig, 
    saveTfsConfig, 
    saveTfsPat,
    getTfsPat,
    resetConfiguration,
    savePreferredCodeModel,
    savePreferredVisionModel,
    saveLoginConfig,
    saveLoginPassword,
    getLoginPassword,
    saveDebugConfig,
    saveDesktopBackend,
    AutotestConfig
} from './config';
import { 
    getBugDescriptionWithClipboardOption,
    saveBugHistory,
    getBugHistory,
    formatBugHistory,
    BugHistoryItem
} from './bug-input';
import { TfsClient } from './tfs-client';
import {
    ProjectAutomationMemory,
    parseStrategyLogsFromFile
} from './ui-automation-memory';
import { runWebTest, handleWebRecord, handleWebRegenerate } from './agent-web';
import { runDesktopTest, handleDesktopRecord, handleDesktopRegenerate } from './agent-desktop';

const execAsync = promisify(exec);
let tfsClient: TfsClient | null = null;
const dashboardRefreshSubscribers = new Set<() => void>();

function notifyDashboardRefresh(): void {
    for (const subscriber of dashboardRefreshSubscribers) {
        try {
            subscriber();
        } catch {
            // Ignore subscriber failures to avoid breaking other listeners.
        }
    }
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get the next sequential bug number by scanning existing bug_NNN folders
 */
function getNextBugNumber(workspacePath: string): number {
    const autotestDir = path.join(workspacePath, 'autotest');
    
    if (!fs.existsSync(autotestDir)) {
        return 1;
    }
    
    const entries = fs.readdirSync(autotestDir);
    const bugNumbers: number[] = [];
    
    for (const entry of entries) {
        const match = entry.match(/^bug_(\d+)$/);
        if (match) {
            bugNumbers.push(parseInt(match[1], 10));
        }
    }
    
    if (bugNumbers.length === 0) {
        return 1;
    }
    
    return Math.max(...bugNumbers) + 1;
}

/**
 * Zabezpečí že autotest/ je v .gitignore používateľovho projektu
 */
function ensureGitignore(workspacePath: string): void {
    const gitignorePath = path.join(workspacePath, '.gitignore');
    
    const autotestEntries = [
        '',
        '# Autotest Agent - generované testy',
        'autotest/',
        '*.spec.js',
        'error_screenshot.png',
        'success_screenshot.png',
        'test_result.md'
    ].join('\n');
    
    try {
        if (!fs.existsSync(gitignorePath)) {
            // .gitignore neexistuje - vytvor nový
            fs.writeFileSync(gitignorePath, autotestEntries + '\n');
            return;
        }
        
        // .gitignore existuje - skontroluj či už obsahuje autotest/
        const gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
        
        if (!gitignoreContent.includes('autotest/')) {
            // Pridaj na koniec
            const newContent = gitignoreContent.endsWith('\n') 
                ? gitignoreContent + autotestEntries + '\n'
                : gitignoreContent + '\n' + autotestEntries + '\n';
            
            fs.writeFileSync(gitignorePath, newContent);
        }
    } catch (error) {
        console.error('Failed to update .gitignore:', error);
        // Nefatálna chyba - pokračuj ďalej
    }
}

/**
 * Skontroluje či je Playwright nainštalovaný a v prípade potreby ho nainštaluje
 */
async function ensurePlaywrightInstalled(workspacePath: string, response: vscode.ChatResponseStream): Promise<boolean> {
    const playwrightPath = path.join(workspacePath, 'node_modules', 'playwright');
    
    // Playwright už je nainštalovaný
    if (fs.existsSync(playwrightPath)) {
        return true;
    }
    
    response.markdown(`📦 **Inštalujem Playwright (prvé použitie)...**\n\n`);
    response.markdown(`*Toto môže trvať 1-2 minúty. Playwright sa inštaluje len raz pre každý projekt.*\n\n`);
    
    try {
        // Inštalácia Playwright npm balíčka
        response.markdown(`⏳ Inštalujem npm balíček...\n\n`);
        await execAsync('npm install playwright', {
            cwd: workspacePath,
            timeout: 120000 // 2 minúty
        });
        
        // Inštalácia browserov
        response.markdown(`⏳ Sťahujem browsery (Chromium)...\n\n`);
        await execAsync('npx playwright install chromium', {
            cwd: workspacePath,
            timeout: 180000 // 3 minúty
        });
        
        response.markdown(`✅ **Playwright úspešne nainštalovaný!**\n\n`);
        return true;
        
    } catch (error: any) {
        response.markdown(`❌ **Chyba pri inštalácii Playwright:**\n\`\`\`\n${error.message}\n\`\`\`\n\n`);
        response.markdown(`*Skús manuálne spustiť:\n\`npm install playwright\`\n\`npx playwright install chromium\`*\n\n`);
        return false;
    }
}

/**
 * Nájde Python executable v systéme (hľadá python, python3, py)
 * Vráti cestu alebo null ak Python nie je nájdený.
 */
async function findPythonExecutable(): Promise<string | null> {
    const candidates = ['python', 'python3', 'py'];
    for (const cmd of candidates) {
        try {
            const { stdout } = await execAsync(`${cmd} --version`, { timeout: 5000 });
            if (stdout.includes('Python 3') || stdout.includes('Python 2')) {
                return cmd;
            }
        } catch {}
    }
    // Skús aj priamu cestu (bežná lokácia na Windows)
    const directPaths = [
        `${process.env.LOCALAPPDATA}\\Programs\\Python\\Python310\\python.exe`,
        `${process.env.LOCALAPPDATA}\\Programs\\Python\\Python311\\python.exe`,
        `${process.env.LOCALAPPDATA}\\Programs\\Python\\Python312\\python.exe`,
        `${process.env.LOCALAPPDATA}\\Programs\\Python\\Python39\\python.exe`,
        'C:\\Python310\\python.exe',
        'C:\\Python311\\python.exe',
    ];
    for (const p of directPaths) {
        if (p && fs.existsSync(p)) {
            return p;
        }
    }
    return null;
}

/**
 * Skontroluje či je pywinauto nainštalovaný a v prípade potreby ho nainštaluje.
 * Vráti [python_executable, ok].
 */
async function ensurePywinautoInstalled(response: vscode.ChatResponseStream): Promise<[string, boolean]> {
    const python = await findPythonExecutable();
    if (!python) {
        response.markdown(`❌ **Python nebol nájdený.** Inštaluj Python 3 z https://www.python.org/downloads/\n\n`);
        return ['', false];
    }

    try {
        const { stdout } = await execAsync(`"${python}" -m pip show pywinauto`, { timeout: 10000 });
        if (stdout.includes('pywinauto')) {
            return [python, true];
        }
    } catch {}

    response.markdown(`📦 **Inštalujem pywinauto (prvé použitie)...**\n\n`);
    try {
        await execAsync(`"${python}" -m pip install pywinauto pywin32 --quiet`, { timeout: 120000 });
        response.markdown(`✅ **pywinauto úspešne nainštalovaný!**\n\n`);
        return [python, true];
    } catch (error: any) {
        response.markdown(`❌ **Chyba pri inštalácii pywinauto:**\n\`\`\`\n${error.message}\n\`\`\`\n\n`);
        return [python, false];
    }
}


/**
 * Vyber AI model
 * @param purpose - 'code' pre generovanie testov/scenárov, 'vision' pre analýzu obrázkov
 * @param forceSelect - ak true, vždy zobraz picker (ignoruj uloženú voľbu)
 */
async function selectAIModel(context: vscode.ExtensionContext, purpose: 'code' | 'vision' = 'code', forceSelect = false): Promise<vscode.LanguageModelChat | null> {
    const config = loadConfiguration(context);
    
    const savedId = purpose === 'code' ? config.preferredCodeModelId : config.preferredVisionModelId;

    // Ak je už vybraný model a nevynucujeme výber, skús ho použiť
    if (!forceSelect && savedId) {
        const models = await vscode.lm.selectChatModels({ id: savedId });
        if (models.length > 0) {
            return models[0];
        }
    }
    
    // Načítaj všetky dostupné modely
    const allModels = await vscode.lm.selectChatModels();
    
    if (allModels.length === 0) {
        vscode.window.showErrorMessage('Nenašli sa žiadne dostupné AI modely. Uisti sa, že máš aktívne GitHub Copilot subscription.');
        return null;
    }

    // Pre vision: filtruj modely s image support
    const visionCapableModels = allModels.filter(model => {
        const modelIdLower = model.id.toLowerCase();
        const familyLower = model.family.toLowerCase();
        return modelIdLower.includes('gpt-4') ||
               modelIdLower.includes('vision') ||
               modelIdLower.includes('4o') ||
               modelIdLower.includes('claude') ||
               familyLower.includes('gpt-4') ||
               familyLower.includes('vision') ||
               familyLower.includes('claude');
    });

    const availableModels = purpose === 'vision'
        ? (visionCapableModels.length > 0 ? visionCapableModels : allModels)
        : allModels;

    const title = purpose === 'code'
        ? 'Autotest - Model na generovanie testov a scenárov'
        : 'Autotest - Model na analýzu obrázkov (Vision)';
    const placeHolder = purpose === 'code'
        ? 'Vyber model na generovanie kódu (napr. claude, gpt-4o, o3...):'
        : 'Vyber model na analýzu screenshotov (musí podporovať vision):';
    
    // Ponúkni používateľovi výber
    const modelChoices = allModels.map(model => ({
        label: model.name || model.id,
        description: `${model.vendor} - ${model.family || 'N/A'}`,
        detail: visionCapableModels.includes(model) ? '✓ Podporuje vision/OCR' : 'Kódovací model',
        model: model
    }));
    
    const selected = await vscode.window.showQuickPick(modelChoices, {
        placeHolder,
        title,
        ignoreFocusOut: true
    });
    
    if (!selected) {
        // Použij prvý dostupný ak používateľ zruší
        return availableModels[0];
    }
    
    // Ulož výber podľa účelu
    if (purpose === 'code') {
        await savePreferredCodeModel(context, selected.model.id);
    } else {
        await savePreferredVisionModel(context, selected.model.id);
    }
    vscode.window.showInformationMessage(`✅ ${purpose === 'code' ? 'Kódovací model' : 'Vision model'} nastavený: ${selected.label}`);
    
    return selected.model;
}

/**
 * Vytvorí workspace štruktúru: autotest/, autotest/data/, .gitignore, project_overview.md
 */
function initWorkspaceStructure(workspacePath: string): string {
    const autotestDir = path.join(workspacePath, 'autotest');
    const dataDir = path.join(autotestDir, 'data');
    
    if (!fs.existsSync(autotestDir)) { fs.mkdirSync(autotestDir); }
    if (!fs.existsSync(dataDir)) { fs.mkdirSync(dataDir); }
    
    ensureGitignore(workspacePath);
    
    // Create initial project_overview.md (template, to be filled in)
    const overviewPath = path.join(autotestDir, 'project_overview.md');
    if (!fs.existsSync(overviewPath)) {
        const template = `# Project Overview

## Konfigurácia (vyplnené pri init)
- **Rola:** -
- **Typ aplikácie:** -
- **Prostredie:** -
- **Aplikácia / URL:** -

## Desktop Application (ak desktop)
- **Window Name:** -
- **ClassName:** -
- **AutomationId:** -

## Poznámky
- Tento súbor sa automaticky aktualizuje
`;
        fs.writeFileSync(overviewPath, template, 'utf-8');
    }
    
    return autotestDir;
}

/**
 * Aktualizuje project_overview.md s konfiguračnými hodnotami
 */
function updateProjectOverview(workspacePath: string, updates: Record<string, string>): void {
    const overviewPath = path.join(workspacePath, 'autotest', 'project_overview.md');
    if (!fs.existsSync(overviewPath)) { return; }
    
    let content = fs.readFileSync(overviewPath, 'utf-8');
    
    for (const [key, value] of Object.entries(updates)) {
        // Replace lines like "- **Key:** -" or "- **Key:** anything"
        const regex = new RegExp(`(- \\*\\*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\*\\* ).*`, 'm');
        content = content.replace(regex, `$1${value}`);
    }
    
    fs.writeFileSync(overviewPath, content, 'utf-8');
}

/**
 * Spustí existujúci test z priečinka bez regenerácie
 */
async function runExistingTest(
    workspacePath: string,
    testFolderName: string,
    response: vscode.ChatResponseStream,
    context: vscode.ExtensionContext,
    token: vscode.CancellationToken
): Promise<void> {
    const testDir = path.join(workspacePath, 'autotest', testFolderName);
    
    if (!fs.existsSync(testDir)) {
        response.markdown(`❌ Priečinok \`autotest/${testFolderName}\` neexistuje.\n\n`);
        response.markdown(`Dostupné testy:\n`);
        const entries = fs.existsSync(path.join(workspacePath, 'autotest'))
            ? fs.readdirSync(path.join(workspacePath, 'autotest')).filter(e =>
                fs.statSync(path.join(workspacePath, 'autotest', e)).isDirectory() &&
                e !== 'data' && !e.startsWith('_'))
            : [];
        entries.forEach(e => response.markdown(`- \`${e}\`\n`));
        return;
    }
    
    // Find test file
    const pyFile = path.join(testDir, 'test.spec.py');
    const jsFile = path.join(testDir, 'test.spec.js');

    const cfg = loadConfiguration(context);
    const isDesktopMcp = cfg.appType === 'desktop';

    let testFile = '';
    let testCommand = '';

    if (isDesktopMcp) {
        // Desktop beží cez Terminator MCP — žiadny lokálny skript, deleguj do agent mode.
        const scenarioExists = fs.existsSync(path.join(testDir, 'test_scenario.md'));
        response.markdown(scenarioExists
            ? `▶️ Desktop test \`${testFolderName}\` beží cez MCP v Copilot agent mode. Spúšťam podľa scenára...\n\n`
            : `ℹ️ Test \`${testFolderName}\` nemá scenár. Vytvor ho cez \`@autotest test\` alebo \`@autotest regenerate ${testFolderName}\`.\n\n`);
        const opened = await sendAutotestPromptToChat(`regenerate ${testFolderName}`);
        response.markdown(opened
            ? `✅ Odoslané do chatu: \`@autotest regenerate ${testFolderName}\`\n\n`
            : `📋 Príkaz v schránke: \`@autotest regenerate ${testFolderName}\`\n\n`);
        return;
    }

    if (fs.existsSync(pyFile)) {
        const pyExe = await findPythonExecutable() || 'python';
        testFile = pyFile; testCommand = `"${pyExe}" "${pyFile}"`;
    } else if (fs.existsSync(jsFile)) {
        testFile = jsFile; testCommand = `node "${jsFile}"`;
    } else {
        // MCP web test (žiadny code-gen skript) — spusti znovu cez agent mode podľa scenára.
        const scenarioExists = fs.existsSync(path.join(testDir, 'test_scenario.md'));
        response.markdown(scenarioExists
            ? `▶️ Test \`${testFolderName}\` beží cez MCP v Copilot agent mode. Spúšťam podľa scenára...\n\n`
            : `ℹ️ Test \`${testFolderName}\` nemá skript ani scenár. Vytvor ho cez \`@autotest regenerate ${testFolderName}\`.\n\n`);
        const opened = await sendAutotestPromptToChat(`regenerate ${testFolderName}`);
        response.markdown(opened
            ? `✅ Odoslané do chatu: \`@autotest regenerate ${testFolderName}\`\n\n`
            : `📋 Príkaz v schránke: \`@autotest regenerate ${testFolderName}\`\n\n`);
        return;
    }
    
    response.markdown(`▶️ **Spúšťam** \`${path.relative(workspacePath, testFile)}\`...\n\n`);
    
    try {
        const { stdout, stderr } = await execAsync(testCommand, {
            cwd: testDir,
            timeout: 120000
        });
        
        const combinedOutput = [stdout, stderr].filter(Boolean).join('\n');
        if (combinedOutput) {
            response.markdown(`📋 **Output:**\n\`\`\`\n${combinedOutput.substring(0, 2000)}\n\`\`\`\n\n`);
        }
        
        const successShot = path.join(testDir, 'success_screenshot.png');
        const errorShot = path.join(testDir, 'error_screenshot.png');
        const initShot = path.join(testDir, 'init_screenshot.png');
        
        const shotPath = fs.existsSync(successShot) ? successShot
            : fs.existsSync(initShot) ? initShot
            : fs.existsSync(errorShot) ? errorShot : null;
        
        if (shotPath) {
            response.markdown(`📸 Screenshot: \`autotest/${testFolderName}/${path.basename(shotPath)}\`\n\n`);
            
            // Vision analysis
            const visionModel = await selectAIModel(context, 'vision');
            if (visionModel) {
                const imgBuf = fs.readFileSync(shotPath);
                const visionPrompt = `Toto je screenshot z testu "${testFolderName}". Zhodnoť stručne: (1) Čo je na obrazovke, (2) Či test vyzeral úspešne.`;
                try {
                    const vMsg = [vscode.LanguageModelChatMessage.User([
                        new vscode.LanguageModelTextPart(visionPrompt),
                        vscode.LanguageModelDataPart.image(imgBuf, 'image/png')
                    ])];
                    const vResp = await visionModel.sendRequest(vMsg, {}, token);
                    let analysis = '';
                    for await (const chunk of vResp.text) { analysis += chunk; }
                    response.markdown(`### 👁️ Analýza:\n${analysis}\n\n`);
                } catch {}
            }
        } else {
            response.markdown(`⚠️ Test prebehol, ale nevytvoril sa screenshot.\n\n`);
        }
        
    } catch (execError: any) {
        const errDetail = [execError.stderr, execError.stdout].filter(Boolean).join('\n').trim() || execError.message;
        response.markdown(`❌ **Chyba pri spustení:**\n\`\`\`\n${errDetail.substring(0, 3000)}\n\`\`\`\n\n`);
        const _rSuccessShot = path.join(testDir, 'success_screenshot.png');
        const _rNotFoundShot = path.join(testDir, 'not_found_screenshot.png');
        const _rErrorShot = path.join(testDir, 'error_screenshot.png');
        const _rShot = fs.existsSync(_rSuccessShot) ? _rSuccessShot
            : fs.existsSync(_rNotFoundShot) ? _rNotFoundShot
            : fs.existsSync(_rErrorShot) ? _rErrorShot : null;
        if (_rShot) {
            const _rIsSuccess = _rShot === _rSuccessShot;
            let _rScenario = '';
            try { _rScenario = fs.readFileSync(path.join(testDir, 'test_scenario.md'), 'utf-8'); } catch {}
            response.markdown(`📸 Screenshot: \`${testFolderName}/${path.basename(_rShot)}\`\n\n`);
            response.markdown(`👁️ **Analyzujem screenshot...**\n\n`);
            const _rVm = await selectAIModel(context, 'vision');
            if (_rVm) {
                const _rBuf = fs.readFileSync(_rShot);
                const _rPrompt = _rIsSuccess
                    ? `Tu je screenshot Windows desktop aplikácie. Test skript skončil s chybou (assert/exit code), ale screenshot bol uložený.\n\nTest scenár:\n${_rScenario}\n\nChyba:\n${errDetail.substring(0, 500)}\n\nZhodnot:\n1. Čo vidíš na obrazovke?\n2. Vyzerat test vizualne úspšene?\n3. Ak áno - napíš VIZUÁLNE PASSED a popíš čo vidíš.`
                    : `Tu je screenshot keď test zlyhal.\n\nTest scenár:\n${_rScenario}\n\nChyba:\n${errDetail.substring(0, 500)}\n\nPovedz: 1. Čo vidíš? 2. Kde zlyhalo? 3. Ako opraviť?`;
                try {
                    const _rMsgs = [vscode.LanguageModelChatMessage.User([
                        new vscode.LanguageModelTextPart(_rPrompt),
                        vscode.LanguageModelDataPart.image(_rBuf, 'image/png')
                    ])];
                    const _rResp = await _rVm.sendRequest(_rMsgs, {}, token);
                    let _rAnalysis = '';
                    for await (const chunk of _rResp.text) { _rAnalysis += chunk; }
                    response.markdown(`### 👁️ Analýza:\n${_rAnalysis}\n\n`);
                    // Ulož analýzu do memory a test_result.md
                    const _rVisualPassed = _rIsSuccess && _rAnalysis.toUpperCase().includes('VIZUÁLNE PASSED');
                    const _rMemPath = path.join(workspacePath, 'autotest');
                    try {
                        const _rMem = new ProjectAutomationMemory(_rMemPath, testFolderName);
                        _rMem.addNote(`Test ${testFolderName} ${_rVisualPassed ? 'VIZUÁLNE PASSED' : 'FAILED'} - Vision analýza: ${_rAnalysis.substring(0, 200)}`);
                        if (_rVisualPassed) {
                            _rMem.recordResult('test', testFolderName, 'visual-assert', 'success');
                        }
                        _rMem.save();
                    } catch {}
                    const _rResultPath = path.join(testDir, 'test_result.md');
                    fs.writeFileSync(_rResultPath, `# Test Result: ${_rVisualPassed ? 'VIZUÁLNE PASSED ✅' : 'FAILED ❌'}\n\n## Test Info\n- **Bug ID:** ${testFolderName}\n- **Timestamp:** ${new Date().toLocaleString('sk-SK')}\n- **Status:** ${_rVisualPassed ? 'VISUAL_PASSED' : 'FAILED'}\n\n## Vision Analýza\n${_rAnalysis}\n\n## Chyba skriptu\n\`\`\`\n${errDetail.substring(0, 1000)}\n\`\`\`\n`);
                    if (_rVisualPassed) {
                        response.markdown(`✅ **Vizuálne PASSED** \u2014 screenshot potvrdzuje správny výsledok.\n\n`);
                        response.markdown(`📝 Ulóſené do: \`autotest/${testFolderName}/test_result.md\`\n\n`);
                        await saveBugHistory(context, { bugId: testFolderName.replace(/^(bug_|test_)/, ''), description: _rScenario.split('\n').find((l: string) => l.trim().length > 5) || testFolderName, timestamp: new Date().toISOString(), testResult: 'success' });
                    } else {
                        response.markdown(`📝 Report: \`autotest/${testFolderName}/test_result.md\`\n\n`);
                    }
                } catch (e: any) {
                    response.markdown(`*Vision analýza zlyhala: ${e.message}*\n\n`);
                }
            }
        }
    }
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function createNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let text = '';
    for (let i = 0; i < 32; i++) {
        text += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return text;
}

function getWorkspacePathOrNull(): string | null {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        return null;
    }
    return folders[0].uri.fsPath;
}

function listAutotestFolders(workspacePath: string): string[] {
    const autotestDir = path.join(workspacePath, 'autotest');
    if (!fs.existsSync(autotestDir)) {
        return [];
    }

    return fs.readdirSync(autotestDir)
        .filter((entry) => {
            const full = path.join(autotestDir, entry);
            return fs.statSync(full).isDirectory() && entry !== 'data' && !entry.startsWith('_');
        })
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

type DashboardTestStatus = 'success' | 'failed' | 'running' | 'unknown';

interface DashboardTestItem {
    name: string;
    status: DashboardTestStatus;
    hasReport: boolean;
    lastRunAt?: string;
    lastDescription?: string;
}

function normalizeBugId(value?: string): string {
    if (!value) {
        return '';
    }
    const digitsOnly = value.replace(/\D/g, '');
    return digitsOnly.replace(/^0+/, '') || digitsOnly;
}

function normalizeTestFolderName(value?: string): string {
    if (!value) {
        return '';
    }
    let normalized = value.trim().replace(/\\/g, '/');
    normalized = normalized.replace(/^\.?\/+/, '');
    if (normalized.toLowerCase().startsWith('autotest/')) {
        normalized = normalized.substring('autotest/'.length);
    }
    const parts = normalized.split('/').filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : '';
}

function getStatusFromReport(content: string): DashboardTestStatus {
    const upper = content.toUpperCase();
    const verdict = upper.match(/VERDIKT:\s*\**\s*(PASSED|FAILED|SUCCESS|FAIL)/);
    if (verdict) {
        return verdict[1].startsWith('PASS') || verdict[1] === 'SUCCESS' ? 'success' : 'failed';
    }
    const statusMatch = upper.match(/-\s*\*\*STATUS:\*\*\s*([^\n\r]+)/);
    if (statusMatch) {
        const statusValue = statusMatch[1].trim();
        if (statusValue.includes('PASSED') || statusValue.includes('SUCCESS') || statusValue.includes('VISUAL_PASSED')) {
            return 'success';
        }
        if (statusValue.includes('FAILED') || statusValue.includes('FAIL')) {
            return 'failed';
        }
        if (statusValue.includes('RUNNING')) {
            return 'running';
        }
    }

    if (upper.includes('FAILED') || upper.includes('FAIL')) {
        return 'failed';
    }
    if (upper.includes('PASSED') || upper.includes('SUCCESS') || upper.includes('VISUAL_PASSED')) {
        return 'success';
    }
    if (upper.includes('RUNNING')) {
        return 'running';
    }
    return 'unknown';
}

function mapHistoryResultToStatus(result?: BugHistoryItem['testResult']): DashboardTestStatus {
    if (result === 'success') {
        return 'success';
    }
    if (result === 'failed') {
        return 'failed';
    }
    if (result === 'running') {
        return 'running';
    }
    return 'unknown';
}

let reportPanel: vscode.WebviewPanel | undefined;

function showReportPanel(workspacePath: string, folderName: string, reportPath: string): void {
    const testDir = path.join(workspacePath, 'autotest', folderName);
    const reportMd = (() => { try { return fs.readFileSync(reportPath, 'utf-8'); } catch { return ''; } })();
    const status = getStatusFromReport(reportMd);

    let transcript = '';
    const transcriptPath = path.join(testDir, 'transcript.md');
    if (fs.existsSync(transcriptPath)) {
        try { transcript = fs.readFileSync(transcriptPath, 'utf-8'); } catch { transcript = ''; }
    }

    if (!reportPanel) {
        reportPanel = vscode.window.createWebviewPanel(
            'autotest.report',
            `Report: ${folderName}`,
            vscode.ViewColumn.Active,
            { enableScripts: true, localResourceRoots: [vscode.Uri.file(testDir)], retainContextWhenHidden: true }
        );
        reportPanel.onDidDispose(() => { reportPanel = undefined; });
    } else {
        reportPanel.title = `Report: ${folderName}`;
    }
    reportPanel.reveal(vscode.ViewColumn.Active);

    const stepsDir = path.join(testDir, 'steps');
    const stepImgs: { uri: string; caption: string }[] = [];
    if (fs.existsSync(stepsDir)) {
        const files = fs.readdirSync(stepsDir)
            .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        for (const f of files) {
            stepImgs.push({
                uri: reportPanel.webview.asWebviewUri(vscode.Uri.file(path.join(stepsDir, f))).toString(),
                caption: f.replace(/\.(png|jpe?g|webp)$/i, '').replace(/[_-]/g, ' ')
            });
        }
    }
    if (stepImgs.length === 0) {
        for (const f of ['init_screenshot.png', 'success_screenshot.png', 'error_screenshot.png', 'not_found_screenshot.png']) {
            const p = path.join(testDir, f);
            if (fs.existsSync(p)) {
                stepImgs.push({
                    uri: reportPanel.webview.asWebviewUri(vscode.Uri.file(p)).toString(),
                    caption: f.replace(/\.png$/i, '').replace(/_/g, ' ')
                });
            }
        }
    }

    const badge = status === 'success' ? '✅ PASSED' : status === 'failed' ? '❌ FAILED' : '❔ N/A';
    const badgeColor = status === 'success' ? '#2ea043' : status === 'failed' ? '#d1242f' : '#888';
    const stepsHtml = stepImgs.length
        ? stepImgs.map((s, i) => `<div class="step"><div class="step-h">Krok ${i + 1}: ${escapeHtml(s.caption)}</div><img src="${s.uri}" alt="${escapeHtml(s.caption)}" /></div>`).join('')
        : '<p class="muted">Žiadne screenshoty.</p>';

    reportPanel.webview.html = `<!DOCTYPE html><html lang="sk"><head><meta charset="utf-8" />
<style>
body{font-family:var(--vscode-font-family);padding:16px;color:var(--vscode-foreground);}
.badge{display:inline-block;padding:4px 14px;border-radius:14px;color:#fff;font-weight:600;background:${badgeColor};}
h1{font-size:18px;margin:8px 0;}
.summary{background:var(--vscode-textBlockQuote-background);border-left:3px solid ${badgeColor};padding:10px 14px;border-radius:4px;white-space:pre-wrap;font-size:13px;}
.step{margin:14px 0;border:1px solid var(--vscode-panel-border);border-radius:6px;overflow:hidden;}
.step-h{padding:8px 12px;background:var(--vscode-editorWidget-background);font-weight:600;font-size:13px;}
.step img{display:block;width:100%;}
.muted{opacity:.6;}
pre{white-space:pre-wrap;font-size:12px;}
</style></head><body>
<h1>${escapeHtml(folderName)} <span class="badge">${badge}</span></h1>
<div class="summary">${escapeHtml(reportMd || 'Report bez obsahu.')}</div>
<h2>Kroky</h2>
${stepsHtml}
${transcript ? `<h2>Transcript</h2><pre>${escapeHtml(transcript)}</pre>` : ''}
</body></html>`;
}

function resolveReportPath(testDir: string): string {
    const legacy = path.join(testDir, 'test_result.md');
    const mcp = path.join(testDir, 'result.md');
    const legacyExists = fs.existsSync(legacy);
    const mcpExists = fs.existsSync(mcp);
    if (legacyExists && mcpExists) {
        // Preferuj najnovší report (MCP result.md vs. legacy test_result.md)
        try {
            return fs.statSync(mcp).mtimeMs >= fs.statSync(legacy).mtimeMs ? mcp : legacy;
        } catch {
            return mcp;
        }
    }
    if (mcpExists) { return mcp; }
    if (legacyExists) { return legacy; }
    return '';
}

function buildDashboardTests(workspacePath: string, tests: string[], history: BugHistoryItem[]): DashboardTestItem[] {
    return tests.map((testName) => {
        const testDir = path.join(workspacePath, 'autotest', testName);
        const reportPath = resolveReportPath(testDir);
        const hasReport = reportPath !== '';

        let status: DashboardTestStatus = 'unknown';
        let lastRunAt: string | undefined;

        if (hasReport) {
            try {
                const report = fs.readFileSync(reportPath, 'utf-8');
                status = getStatusFromReport(report);
                lastRunAt = fs.statSync(reportPath).mtime.toLocaleString('sk-SK');
            } catch {
                status = 'unknown';
            }
        }

        const normalizedFolderBugId = normalizeBugId(testName);
        const historyMatch = history.find((item) => {
            const itemBugId = normalizeBugId(item.bugId);
            return itemBugId && itemBugId === normalizedFolderBugId;
        });

        if (status === 'unknown' && historyMatch?.testResult) {
            status = mapHistoryResultToStatus(historyMatch.testResult);
        }

        if (!lastRunAt && historyMatch?.timestamp) {
            lastRunAt = new Date(historyMatch.timestamp).toLocaleString('sk-SK');
        }

        return {
            name: testName,
            status,
            hasReport,
            lastRunAt,
            lastDescription: historyMatch?.description
        };
    });
}

function getHealingContextPath(testDir: string): string {
    return path.join(testDir, 'healing_context.md');
}

function loadTestHealingContext(testDir: string): string {
    const filePath = getHealingContextPath(testDir);
    if (!fs.existsSync(filePath)) {
        return '';
    }
    try {
        return fs.readFileSync(filePath, 'utf-8').trim();
    } catch {
        return '';
    }
}

function loadProjectHealingLessons(workspacePath: string): string {
    const filePath = path.join(workspacePath, 'autotest', 'healing_lessons.md');
    if (!fs.existsSync(filePath)) {
        return '';
    }
    try {
        return fs.readFileSync(filePath, 'utf-8').trim();
    } catch {
        return '';
    }
}

function refreshProjectHealingLessons(autotestDir: string): void {
    try {
        if (!fs.existsSync(autotestDir)) {
            return;
        }

        const sections: string[] = [];
        const folders = fs.readdirSync(autotestDir)
            .filter((entry) => {
                const full = path.join(autotestDir, entry);
                return fs.statSync(full).isDirectory() && entry !== 'data' && !entry.startsWith('_');
            })
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

        for (const folder of folders) {
            const content = loadTestHealingContext(path.join(autotestDir, folder));
            if (!content) {
                continue;
            }
            sections.push(`## ${folder}\n\n${content}`);
        }

        const outPath = path.join(autotestDir, 'healing_lessons.md');
        if (sections.length === 0) {
            try { fs.unlinkSync(outPath); } catch {}
            return;
        }

        const out = [
            '# Healing Lessons (Auto-generated)',
            '',
            'Tento súbor je agregovaný prehľad aktuálnych problémov a návrhov opráv.',
            'Sekcie sa prepíšu pri novom zlyhaní a odstránia po úspešnom teste.',
            '',
            ...sections
        ].join('\n');

        fs.writeFileSync(outPath, out, 'utf-8');
    } catch {
        // Ignore persistence errors in non-critical helper.
    }
}

function saveHealingContext(
    workspacePath: string,
    testFolderName: string,
    testScenario: string,
    errorAnalysis: string,
    failureDetail: string,
    source: string,
    searchingFor?: string
): void {
    try {
        const testDir = path.join(workspacePath, 'autotest', testFolderName);
        if (!fs.existsSync(testDir)) {
            fs.mkdirSync(testDir, { recursive: true });
        }

        const scenarioShort = (testScenario || '').trim().substring(0, 1200);
        const detailShort = (failureDetail || '').trim().substring(0, 1600);
        const analysisShort = (errorAnalysis || '').trim().substring(0, 3000);

        const content = [
            '# Healing Context',
            '',
            `- Source: ${source}`,
            `- Timestamp: ${new Date().toISOString()}`,
            searchingFor ? `- Missing element: ${searchingFor}` : '- Missing element: n/a',
            '',
            '## Problem',
            analysisShort || 'n/a',
            '',
            '## Where It Failed',
            '```',
            detailShort || 'n/a',
            '```',
            '',
            '## Scenario Context',
            scenarioShort || 'n/a',
            '',
            '## Possible Fixes',
            '- Use this file as hard context for next regenerate.',
            '- If fix fails again, overwrite this file with the newest failure.',
            '- Delete this file after PASS to avoid stale fixes.',
            ''
        ].join('\n');

        fs.writeFileSync(getHealingContextPath(testDir), content, 'utf-8');
        refreshProjectHealingLessons(path.join(workspacePath, 'autotest'));
    } catch {
        // Ignore persistence errors in non-critical helper.
    }
}

function clearHealingContext(workspacePath: string, testFolderName: string): void {
    try {
        const testDir = path.join(workspacePath, 'autotest', testFolderName);
        try { fs.unlinkSync(getHealingContextPath(testDir)); } catch {}
        refreshProjectHealingLessons(path.join(workspacePath, 'autotest'));
    } catch {
        // Ignore persistence errors in non-critical helper.
    }
}

function compactText(value: string, maxLen: number): string {
    if (!value) {
        return '-';
    }
    return value.length > maxLen ? `${value.substring(0, maxLen)}...` : value;
}

function readProjectOverview(workspacePath: string): string {
    const overviewPath = path.join(workspacePath, 'autotest', 'project_overview.md');
    if (!fs.existsSync(overviewPath)) {
        return '';
    }
    try {
        return fs.readFileSync(overviewPath, 'utf-8').trim();
    } catch {
        return '';
    }
}

async function sendAutotestPromptToChat(prompt: string): Promise<boolean> {
    const fullPrompt = `@autotest ${prompt}`.trim();
    const candidateCommands = [
        'workbench.action.chat.open',
        'workbench.action.quickChat.open'
    ];

    for (const commandId of candidateCommands) {
        try {
            await vscode.commands.executeCommand(commandId, fullPrompt);
            return true;
        } catch {
            // Try the next known command id.
        }
    }

    try {
        await vscode.env.clipboard.writeText(fullPrompt);
        await vscode.commands.executeCommand('workbench.action.chat.open');
    } catch {
        await vscode.env.clipboard.writeText(fullPrompt);
    }

    return false;
}

function reconcileHistoryFromReports(context: vscode.ExtensionContext, workspacePath: string): void {
    const tests = listAutotestFolders(workspacePath);
    const history = context.workspaceState.get<BugHistoryItem[]>('bugHistory') || [];
    let changed = false;
    for (const name of tests) {
        const reportPath = resolveReportPath(path.join(workspacePath, 'autotest', name));
        if (!reportPath) { continue; }
        let status: DashboardTestStatus;
        let mtime: Date;
        try {
            status = getStatusFromReport(fs.readFileSync(reportPath, 'utf-8'));
            mtime = fs.statSync(reportPath).mtime;
        } catch { continue; }
        if (status !== 'success' && status !== 'failed') { continue; }
        const ts = mtime.toISOString();
        const exists = history.some((h) => h.description === name && h.timestamp === ts);
        if (exists) { continue; }
        const bugId = name.startsWith('bug_') ? name.replace(/^bug_/, '') : undefined;
        history.unshift({ bugId, description: name, timestamp: ts, testResult: status });
        changed = true;
    }
    if (changed) { void context.workspaceState.update('bugHistory', history.slice(0, 20)); }
}

function buildDashboardState(context: vscode.ExtensionContext) {
    const config = loadConfiguration(context);
    const workspacePath = getWorkspacePathOrNull();
    if (workspacePath) { reconcileHistoryFromReports(context, workspacePath); }
    const tests = workspacePath ? listAutotestFolders(workspacePath) : [];
    const projectOverview = workspacePath ? readProjectOverview(workspacePath) : '';
    const runHistory = getBugHistory(context, 20);
    const testsWithStatus = workspacePath ? buildDashboardTests(workspacePath, tests, runHistory) : [];

    const dashboardState: any = {
        hasWorkspace: Boolean(workspacePath),
        initialized: Boolean(workspacePath && fs.existsSync(path.join(workspacePath, 'autotest'))),
        role: config.userRole,
        appType: config.appType,
        appUrl: config.appUrl,
        appUrlCompact: compactText(config.appUrl, 42),
        environment: config.environment,
        tfsEnabled: config.tfsEnabled,
        preferredCodeModel: config.preferredCodeModelId || 'nevybraný',
        preferredVisionModel: config.preferredVisionModelId || 'nevybraný',
        headlessMode: config.headlessMode !== false,
        slowMo: config.slowMo || 0,
        projectOverview,
        tests,
        testsWithStatus,
        runHistory,
        tfsWorkItems: [] as Array<{ id: number; title: string; type: string; state: string; url: string }>
    };

    return dashboardState;
}

function getAutotestDashboardHtml(webview: vscode.Webview): string {
    const nonce = createNonce();
    const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';`;

    return `<!DOCTYPE html>
<html lang="sk">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Autotest Dashboard</title>
    <style>
        * { box-sizing: border-box; }
        
        body {
            margin: 0;
            padding: 12px;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            color: var(--vscode-foreground);
            background: var(--vscode-editor-background);
            font-size: 13px;
            line-height: 1.5;
        }

        .wrap {
            display: flex;
            flex-direction: column;
            gap: 0;
            animation: appear 220ms ease-out;
        }

        .collapsible-header {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 8px 10px;
            cursor: pointer;
            user-select: none;
            border: none;
            background: transparent;
            color: var(--vscode-foreground);
            font-weight: 600;
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            border-bottom: 1px solid var(--vscode-panel-border);
            transition: background-color 120ms;
        }

        .collapsible-header:hover {
            background-color: var(--vscode-list-hoverBackground);
        }

        .collapsible-header.collapsed::before {
            content: '▶';
            display: inline-block;
            width: 16px;
            text-align: center;
            opacity: 0.6;
            font-size: 10px;
        }

        .collapsible-header.expanded::before {
            content: '▼';
            display: inline-block;
            width: 16px;
            text-align: center;
            opacity: 0.8;
            font-size: 10px;
        }

        .section {
            border-bottom: 1px solid var(--vscode-panel-border);
        }

        .section:last-child {
            border-bottom: none;
        }

        .section-content {
            padding: 10px;
            display: none;
        }

        .section-content.expanded {
            display: block;
        }

        .title {
            padding: 10px;
            font-size: 14px;
            font-weight: 600;
            color: var(--vscode-foreground);
            border-bottom: 1px solid var(--vscode-panel-border);
        }

        .subtitle {
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
        }

        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
            gap: 8px;
        }

        .stat {
            padding: 8px;
            background: var(--vscode-list-hoverBackground);
            border-radius: 4px;
            border: 1px solid var(--vscode-panel-border);
        }

        .stat-label {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            text-transform: uppercase;
            letter-spacing: 0.3px;
            margin-bottom: 3px;
        }

        .stat-value {
            font-size: 13px;
            font-weight: 600;
            color: var(--vscode-foreground);
        }

        .actions {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            padding: 10px 0;
        }

        .row {
            display: flex;
            gap: 6px;
            align-items: center;
            flex-wrap: wrap;
            padding: 0;
        }

        button {
            padding: 6px 12px;
            border: 1px solid var(--vscode-button-border, transparent);
            border-radius: 2px;
            font-weight: 500;
            font-size: 12px;
            cursor: pointer;
            transition: background-color 120ms, color 120ms;
        }

        .primary {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }

        .primary:hover {
            background: var(--vscode-button-hoverBackground);
        }

        .secondary {
            background: transparent;
            color: var(--vscode-button-foreground);
            border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
        }

        .secondary:hover {
            background: var(--vscode-button-hoverBackground);
        }

        .danger {
            background: transparent;
            color: #c1272d;
            border: 1px solid #c1272d;
        }

        .danger:hover {
            background: rgba(193, 39, 45, 0.1);
        }

        input, select {
            padding: 6px 8px;
            border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
            border-radius: 2px;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            font-family: inherit;
            font-size: 12px;
        }

        input::placeholder {
            color: var(--vscode-input-placeholderForeground);
        }

        #status {
            margin-top: 6px;
            color: var(--vscode-descriptionForeground);
            min-height: 1.2em;
            font-size: 12px;
        }

        .overview {
            margin-top: 6px;
            border: 1px solid var(--vscode-panel-border);
            border-radius: 2px;
            background: var(--vscode-editor-background);
            padding: 8px;
            max-height: 180px;
            overflow: auto;
            white-space: pre-wrap;
            font-size: 11px;
            line-height: 1.4;
            font-family: 'SF Mono', Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, monospace;
        }

        .work-item {
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 10px;
            margin-bottom: 8px;
            background: var(--vscode-list-hoverBackground);
        }

        .work-item-running {
            border-color: #0066cc;
            box-shadow: 0 0 0 1px rgba(0, 102, 204, 0.25);
            background: linear-gradient(90deg, rgba(0, 102, 204, 0.12), transparent 28%);
            animation: runningPulse 1.6s ease-in-out infinite;
        }

        .work-item-header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            gap: 10px;
            margin-bottom: 8px;
        }

        .work-item-title {
            font-size: 13px;
            font-weight: 600;
            color: var(--vscode-foreground);
            flex: 1;
        }

        .work-item-badge {
            display: inline-block;
            padding: 2px 6px;
            border-radius: 3px;
            font-size: 10px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.3px;
            white-space: nowrap;
        }

        .badge-bug {
            background: rgba(193, 39, 45, 0.2);
            color: #c1272d;
        }

        .badge-requirement {
            background: rgba(0, 102, 204, 0.2);
            color: #0066cc;
        }

        .badge-testcase {
            background: rgba(52, 168, 83, 0.2);
            color: #34a853;
        }

        .work-item-state {
            font-size: 10px;
            color: var(--vscode-descriptionForeground);
            opacity: 0.7;
        }

        .work-item-actions {
            display: flex;
            gap: 4px;
        }

        .work-item-actions button {
            padding: 4px 8px;
            font-size: 11px;
        }

        .tfs-list {
            max-height: 400px;
            overflow-y: auto;
        }

        .tfs-loading {
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
            padding: 10px;
            font-style: italic;
        }

        .tfs-error {
            color: #c1272d;
            font-size: 12px;
            padding: 10px;
            background: rgba(193, 39, 45, 0.1);
            border-radius: 4px;
        }

        .status-badge {
            display: inline-block;
            padding: 2px 6px;
            border-radius: 3px;
            font-size: 10px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.3px;
            margin-left: 6px;
        }

        .status-success {
            background: rgba(52, 168, 83, 0.2);
            color: #34a853;
        }

        .status-failed {
            background: rgba(193, 39, 45, 0.2);
            color: #c1272d;
        }

        .status-running {
            background: rgba(0, 102, 204, 0.2);
            color: #0066cc;
        }

        .status-unknown {
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
        }

        .history-item {
            border: 1px solid var(--vscode-panel-border);
            border-radius: 4px;
            padding: 8px;
            margin-bottom: 8px;
            background: var(--vscode-list-hoverBackground);
        }

        .history-item-title {
            font-size: 12px;
            font-weight: 600;
        }

        .history-item-meta {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
        }

        @keyframes appear {
            from { opacity: 0; transform: translateY(4px); }
            to { opacity: 1; transform: translateY(0); }
        }

        @keyframes runningPulse {
            0% { box-shadow: 0 0 0 1px rgba(0, 102, 204, 0.18); }
            50% { box-shadow: 0 0 0 2px rgba(0, 102, 204, 0.32); }
            100% { box-shadow: 0 0 0 1px rgba(0, 102, 204, 0.18); }
        }
    </style>
</head>
<body>
    <div class="wrap">
        <div class="title">
            🤖 Autotest Dashboard
            <div class="subtitle">Jednoduché ovládanie bez chat príkazov</div>
        </div>

        <section class="section">
            <button class="collapsible-header expanded" data-toggle="configuration">⚙️ Stav Konfigurácie</button>
            <div class="section-content expanded" id="configuration">
                <div class="stats" id="stats"></div>
            </div>
        </section>

        <section class="section">
            <button class="collapsible-header expanded" data-toggle="actions">⚡ Rýchle Akcie</button>
            <div class="section-content expanded" id="actions">
                <div class="actions">
                    <button class="primary" id="btnInit" data-action="init">Inicializovať projekt</button>
                    <button class="primary" id="btnAddTest" data-action="addTest">➕ Pridať test</button>
                    <button class="secondary" id="btnSettings" data-action="settings">⚙️ Zmena nastavení</button>
                    <button class="secondary" data-action="refresh">Obnoviť</button>
                    <button class="danger" data-action="reconfigure">Reset</button>
                </div>
            </div>
        </section>

        <section class="section">
            <button class="collapsible-header expanded" data-toggle="tests">📋 Spustit Test</button>
            <div class="section-content expanded" id="tests">
                <div class="row" style="margin-bottom: 10px;">
                    <input id="testInput" type="text" list="testsList" placeholder="bug_001 alebo test_init" style="flex: 1; min-width: 150px;">
                    <datalist id="testsList"></datalist>
                </div>
                <div class="actions">
                    <button class="primary" data-action="run">▶️ Spustit</button>
                    <button class="secondary" data-action="regenerate">🔄 Regenerovat</button>
                    <button class="secondary" data-action="record">⏺️ Nahrat</button>
                </div>
                <div class="tfs-list" id="testsOverviewList"></div>
                <div id="status"></div>
            </div>
        </section>

        <section class="section">
            <button class="collapsible-header collapsed" data-toggle="history">🕘 Historia testov</button>
            <div class="section-content" id="history">
                <div class="tfs-list" id="historyList"></div>
            </div>
        </section>

        <section class="section">
            <button class="collapsible-header collapsed" data-toggle="tfs">🐛 Moje TFS Work Items</button>
            <div class="section-content" id="tfs">
                <div class="tfs-list" id="tfsList"></div>
            </div>
        </section>

        <section class="section">
            <button class="collapsible-header collapsed" data-toggle="settings">🔧 Nastavenia a Popis</button>
            <div class="section-content" id="settings">
                <div class="stats">
                    <div class="stat">
                        <div class="stat-label">Aplikácia (full URL)</div>
                        <div class="stat-value" id="appUrlFull">-</div>
                    </div>
                </div>
                <div style="margin-top: 10px;">
                    <div class="stat-label">Project Overview</div>
                    <pre class="overview" id="projectOverview">Súbor autotest/project_overview.md zatiaľ neexistuje.</pre>
                </div>
            </div>
        </section>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const stats = document.getElementById('stats');
        const status = document.getElementById('status');
        const testInput = document.getElementById('testInput');
        const testsList = document.getElementById('testsList');
        const testsOverviewList = document.getElementById('testsOverviewList');
        const historyList = document.getElementById('historyList');
        const appUrlFull = document.getElementById('appUrlFull');
        const projectOverview = document.getElementById('projectOverview');

        // Collapse/Expand toggle
        document.querySelectorAll('.collapsible-header').forEach((header) => {
            header.addEventListener('click', () => {
                const sectionId = header.getAttribute('data-toggle');
                const content = document.getElementById(sectionId);
                const isExpanded = content.classList.contains('expanded');
                
                content.classList.toggle('expanded', !isExpanded);
                header.classList.toggle('expanded', !isExpanded);
                header.classList.toggle('collapsed', isExpanded);
            });
        });

        function setStatus(text) {
            status.textContent = text || '';
        }

        function pushAction(action, payload = {}) {
            vscode.postMessage({ action, ...payload });
        }

        function fillStats(state) {
            const values = [
                ['Workspace', state.hasWorkspace ? '✓ OK' : '✗ chýba'],
                ['Rola', state.role],
                ['Typ app', state.appType],
                ['Prostredie', state.environment],
                ['Aplikácia/URL', state.appUrlCompact || state.appUrl],
                ['TFS', state.tfsEnabled ? '✓ zapnuté' : '✗ vypnuté'],
                ['Code model', state.preferredCodeModel],
                ['Vision model', state.preferredVisionModel],
                ['Debug', state.headlessMode ? 'headless' : 'visible'],
                ['SlowMo', String(state.slowMo) + ' ms'],
                ['Počet testov', String((state.tests || []).length)]
            ];

            stats.innerHTML = values
                .map(([k, v]) => '<div class="stat"><div class="stat-label">' + k + '</div><div class="stat-value">' + v + '</div></div>')
                .join('');

            testsList.innerHTML = '';
            (state.tests || []).forEach((t) => {
                const option = document.createElement('option');
                option.value = t;
                testsList.appendChild(option);
            });

            if (!testInput.value && state.tests && state.tests.length) {
                testInput.value = state.tests[0];
            }

            appUrlFull.textContent = state.appUrl || '-';
            projectOverview.textContent = state.projectOverview || 'Subor autotest/project_overview.md zatial neexistuje.';

            const initialized = !!state.initialized;
            const btnInit = document.getElementById('btnInit');
            const btnAddTest = document.getElementById('btnAddTest');
            const btnSettings = document.getElementById('btnSettings');
            if (btnInit) { btnInit.style.display = initialized ? 'none' : ''; }
            if (btnAddTest) { btnAddTest.style.display = initialized ? '' : 'none'; }
            if (btnSettings) { btnSettings.style.display = initialized ? '' : 'none'; }

            fillTestsOverview(state.testsWithStatus || []);
            fillHistory(state.runHistory || []);

            // Zobraz TFS work items ak su dostupne
            fillTfsWorkItems(state.tfsWorkItems || [], state.tfsEnabled);
        }

        function getStatusBadge(status) {
            const normalized = status || 'unknown';
            const label = normalized === 'success' ? 'PASS' : normalized === 'failed' ? 'FAIL' : normalized === 'running' ? 'RUN' : 'N/A';
            return '<span class="status-badge status-' + normalized + '">' + label + '</span>';
        }

        function fillTestsOverview(testItems) {
            if (!testItems || testItems.length === 0) {
                testsOverviewList.innerHTML = '<div class="tfs-loading">Zatial nie su vytvorene test priecinky.</div>';
                return;
            }

            const sortedItems = [...testItems].sort((a, b) => {
                const aRunning = a.status === 'running' ? 1 : 0;
                const bRunning = b.status === 'running' ? 1 : 0;
                if (aRunning !== bRunning) {
                    return bRunning - aRunning;
                }
                return (a.name || '').localeCompare(b.name || '', undefined, { numeric: true });
            });

            testsOverviewList.innerHTML = sortedItems
                .map((item) => {
                    const description = item.lastDescription ? item.lastDescription.substring(0, 110) : '';
                    const runningClass = item.status === 'running' ? ' work-item-running' : '';
                    const runningMeta = item.status === 'running'
                        ? '<div class="work-item-state" style="margin-bottom:6px; color:#0066cc; font-weight:600;">Test práve beží...</div>'
                        : '';
                    return \`<div class="work-item\${runningClass}">
                        <div class="work-item-header">
                            <div class="work-item-title">🧪 \${item.name} \${getStatusBadge(item.status)}</div>
                            <div class="work-item-state">\${item.lastRunAt || 'bez historie'}</div>
                        </div>
                        \${runningMeta}
                        \${description ? '<div class="work-item-state" style="margin-bottom:6px;">' + description + '</div>' : ''}
                        <div class="work-item-actions">
                            <button class="secondary" data-action="runTestRow" data-folder="\${item.name}">▶️ Spustit</button>
                            <button class="secondary" data-action="regenerateTestRow" data-folder="\${item.name}">🔄 Regenerovat</button>
                            <button class="secondary" data-action="recordTestRow" data-folder="\${item.name}">⏺️ Nahrat</button>
                            \${item.hasReport ? '<button class="secondary" data-action="openReport" data-folder="' + item.name + '">📄 Report</button>' : ''}
                        </div>
                    </div>\`;
                })
                .join('');

            testsOverviewList.querySelectorAll('button[data-action="runTestRow"]').forEach((btn) => {
                btn.addEventListener('click', () => pushAction('run', { folder: btn.getAttribute('data-folder') }));
            });

            testsOverviewList.querySelectorAll('button[data-action="regenerateTestRow"]').forEach((btn) => {
                btn.addEventListener('click', () => pushAction('regenerate', { folder: btn.getAttribute('data-folder') }));
            });

            testsOverviewList.querySelectorAll('button[data-action="recordTestRow"]').forEach((btn) => {
                btn.addEventListener('click', () => pushAction('record', { folder: btn.getAttribute('data-folder') }));
            });

            testsOverviewList.querySelectorAll('button[data-action="openReport"]').forEach((btn) => {
                btn.addEventListener('click', () => pushAction('openReport', { folder: btn.getAttribute('data-folder') }));
            });
        }

        function fillHistory(history) {
            if (!history || history.length === 0) {
                historyList.innerHTML = '<div class="tfs-loading">Historia je zatial prazdna.</div>';
                return;
            }

            historyList.innerHTML = history
                .map((item) => {
                    const bugLabel = item.bugId ? ('Bug #' + item.bugId) : 'Manual test';
                    const date = item.timestamp ? new Date(item.timestamp).toLocaleString('sk-SK') : '';
                    const historyStatus = item.testResult === 'failed' ? 'failed' : item.testResult || 'unknown';
                    return \`<div class="history-item">
                        <div class="history-item-title">\${bugLabel} \${getStatusBadge(historyStatus)}</div>
                        <div class="history-item-meta">\${date}</div>
                        <div class="history-item-meta">\${(item.description || '').substring(0, 130)}</div>
                    </div>\`;
                })
                .join('');
        }

        function fillTfsWorkItems(workItems, tfsEnabled) {
            const tfsList = document.getElementById('tfsList');
            if (!tfsEnabled) {
                tfsList.innerHTML = '<div class="tfs-loading">TFS nie je zapnute. Pouzi TFS Setup.</div>';
                return;
            }
            if (!workItems || workItems.length === 0) {
                tfsList.innerHTML = '<div class="tfs-loading">Nie su priradene ziadne work items.</div>';
                return;
            }

            tfsList.innerHTML = workItems
                .map((item) => {
                    const icon = item.type === 'Bug' ? '🐛' : item.type === 'Requirement' ? '📋' : '✓';
                    const badgeClass = item.type === 'Bug'
                        ? 'badge-bug'
                        : item.type === 'Requirement'
                            ? 'badge-requirement'
                            : 'badge-testcase';
                    return \`<div class="work-item">
                        <div class="work-item-header">
                            <div>
                                <div class="work-item-title">\${icon} #\${item.id}: \${item.title}</div>
                                <div class="work-item-state">\${item.state}</div>
                            </div>
                            <span class="work-item-badge \${badgeClass}">\${item.type}</span>
                        </div>
                        <div class="work-item-actions">
                            <button class="secondary" data-action="generateFromBug" data-bug-id="\${item.id}">⚙️ Vygenerovat Test</button>
                            <button class="secondary" data-action="openWorkItem" data-work-item-url="\${item.url}">🔗 Otvorit</button>
                        </div>
                    </div>\`;
                })
                .join('');

            tfsList.querySelectorAll('button[data-action="generateFromBug"]').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const bugId = btn.getAttribute('data-bug-id');
                    pushAction('generateFromBug', { bugId: parseInt(bugId) });
                });
            });

            tfsList.querySelectorAll('button[data-action="openWorkItem"]').forEach((btn) => {
                btn.addEventListener('click', () => {
                    const url = btn.getAttribute('data-work-item-url');
                    if (!url) {
                        return;
                    }
                    pushAction('openWorkItem', { url });
                });
            });
        }

        window.addEventListener('message', (event) => {
            const msg = event.data;
            if (msg.type === 'state') {
                fillStats(msg.payload);
                if (msg.info) {
                    setStatus(msg.info);
                }
            }
            if (msg.type === 'status') {
                setStatus(msg.payload || '');
            }
        });

        document.querySelectorAll('button[data-action]').forEach((button) => {
            button.addEventListener('click', () => {
                const action = button.getAttribute('data-action');
                if (action === 'run' || action === 'regenerate' || action === 'record') {
                    const folder = (testInput.value || '').trim();
                    if (!folder) {
                        setStatus('⚠️ Zadaj názov testu (napr. bug_001).');
                        return;
                    }
                    pushAction(action, { folder });
                    return;
                }
                pushAction(action);
            });
        });

        pushAction('refresh');
    </script>
</body>
</html>`;
}

function registerDashboardMessageHandler(
    webview: vscode.Webview,
    context: vscode.ExtensionContext,
    postState: (info?: string) => void | Promise<void>
): vscode.Disposable {
    return webview.onDidReceiveMessage(async (message: any) => {
        switch (message?.action) {
            case 'refresh': {
                postState('Stav obnovený.');
                return;
            }
            case 'init': {
                await vscode.commands.executeCommand('autotest.init');
                postState('Inicializácia dokončená alebo zrušená.');
                return;
            }
            case 'tfs': {
                await vscode.commands.executeCommand('autotest.tfsSetup');
                postState('TFS setup dokončený alebo zrušený.');
                return;
            }
            case 'models': {
                await selectAIModel(context, 'code', true);
                await selectAIModel(context, 'vision', true);
                postState('Modely aktualizované.');
                return;
            }
            case 'debug': {
                const debugChoice = await vscode.window.showQuickPick(
                    [
                        {
                            label: '👁️ Viditeľný browser (Headed)',
                            value: 'visible',
                            description: 'headless: false, slowMo: 100ms'
                        },
                        {
                            label: '⚡ Rýchly neviditeľný (Headless)',
                            value: 'fast',
                            description: 'headless: true, slowMo: 0ms'
                        },
                        {
                            label: '🎬 Pomalý viditeľný (Debug)',
                            value: 'slow',
                            description: 'headless: false, slowMo: 500ms'
                        }
                    ],
                    {
                        placeHolder: 'Vyber mód testovania',
                        ignoreFocusOut: true
                    }
                );

                if (debugChoice?.value === 'visible') {
                    await saveDebugConfig(context, { headless: false, slowMo: 100 });
                    postState('Debug mód: headed (100ms).');
                    return;
                }
                if (debugChoice?.value === 'fast') {
                    await saveDebugConfig(context, { headless: true, slowMo: 0 });
                    postState('Debug mód: headless (0ms).');
                    return;
                }
                if (debugChoice?.value === 'slow') {
                    await saveDebugConfig(context, { headless: false, slowMo: 500 });
                    postState('Debug mód: headed (500ms).');
                    return;
                }

                postState('Nastavenie debug módu zrušené.');
                return;
            }
            case 'reconfigure': {
                await vscode.commands.executeCommand('autotest.reconfigure');
                postState('Konfigurácia bola resetovaná alebo akcia zrušená.');
                return;
            }
            case 'settings': {
                const choice = await vscode.window.showQuickPick(
                    [
                        { label: '⚙️ Aplikácia a prostredie', value: 'app', description: 'URL, typ, prostredie, rola' },
                        { label: '🔗 TFS pripojenie', value: 'tfs', description: 'Server, projekt, token' },
                        { label: '🤖 AI modely', value: 'models', description: 'Code + vision model' },
                        { label: '🎬 Debug mód', value: 'debug', description: 'Headed / headless / slow' },
                        { label: '♻️ Reset konfigurácie', value: 'reset', description: 'Vymazať a začať odznova' }
                    ],
                    { placeHolder: 'Čo chceš zmeniť?', ignoreFocusOut: true }
                );
                if (!choice) { postState('Nastavenia zatvorené.'); return; }
                if (choice.value === 'app') { await vscode.commands.executeCommand('autotest.init'); }
                else if (choice.value === 'tfs') { await vscode.commands.executeCommand('autotest.tfsSetup'); }
                else if (choice.value === 'models') {
                    await selectAIModel(context, 'code', true);
                    await selectAIModel(context, 'vision', true);
                }
                else if (choice.value === 'debug') {
                    const dbg = await vscode.window.showQuickPick(
                        [
                            { label: '👁️ Viditeľný browser (Headed)', value: 'visible' },
                            { label: '⚡ Rýchly neviditeľný (Headless)', value: 'fast' },
                            { label: '🎬 Pomalý viditeľný (Debug)', value: 'slow' }
                        ],
                        { placeHolder: 'Vyber mód testovania', ignoreFocusOut: true }
                    );
                    if (dbg?.value === 'visible') { await saveDebugConfig(context, { headless: false, slowMo: 100 }); }
                    else if (dbg?.value === 'fast') { await saveDebugConfig(context, { headless: true, slowMo: 0 }); }
                    else if (dbg?.value === 'slow') { await saveDebugConfig(context, { headless: false, slowMo: 500 }); }
                }
                else if (choice.value === 'reset') { await vscode.commands.executeCommand('autotest.reconfigure'); }
                postState('Nastavenia aktualizované.');
                return;
            }
            case 'addTest': {
                const src = await vscode.window.showQuickPick(
                    [
                        { label: '✍️ Manuálny test', value: 'manual', description: 'Popíš test ručne (test_XXX)' },
                        { label: '🐞 Z TFS bugu', value: 'tfs', description: 'Podľa čísla bugu (bug_<id>)' }
                    ],
                    { placeHolder: 'Ako chceš pridať test?', ignoreFocusOut: true }
                );
                if (!src) { postState('Pridanie testu zrušené.'); return; }
                let cmd = 'test';
                if (src.value === 'tfs') {
                    const num = await vscode.window.showInputBox({ prompt: 'Číslo bugu z TFS', ignoreFocusOut: true });
                    if (!num) { postState('Pridanie testu zrušené.'); return; }
                    cmd = `over bug ${num.trim()}`;
                }
                const opened = await sendAutotestPromptToChat(cmd);
                postState(opened ? `Odoslané do chatu: @autotest ${cmd}` : `Príkaz v schránke: @autotest ${cmd}`);
                return;
            }

            case 'run': {
                const folderName = normalizeTestFolderName(String(message.folder || ''));
                if (!folderName) {
                    webview.postMessage({ type: 'status', payload: 'Chýba názov test priečinka.' });
                    return;
                }
                await vscode.commands.executeCommand('autotest.runTest', folderName);
                postState(`Spustený test: ${folderName}`);
                return;
            }
            case 'regenerate': {
                const folderName = normalizeTestFolderName(String(message.folder || ''));
                if (!folderName) {
                    webview.postMessage({ type: 'status', payload: 'Chýba názov test priečinka pre regenerate.' });
                    return;
                }
                const opened = await sendAutotestPromptToChat(`regenerate ${folderName}`);
                if (opened) {
                    postState(`Odoslané do chatu: @autotest regenerate ${folderName}`);
                } else {
                    postState(`Príkaz je v schránke: @autotest regenerate ${folderName}`);
                }
                return;
            }
            case 'record': {
                const folderName = normalizeTestFolderName(String(message.folder || ''));
                if (!folderName) {
                    webview.postMessage({ type: 'status', payload: 'Chýba názov test priečinka pre nahrávanie.' });
                    return;
                }
                const opened = await sendAutotestPromptToChat(`record ${folderName}`);
                if (opened) {
                    postState(`Odoslané do chatu: @autotest record ${folderName}`);
                } else {
                    postState(`Príkaz je v schránke: @autotest record ${folderName}`);
                }
                return;
            }
            case 'generateFromBug': {
                const bugId = message.bugId;
                if (!bugId) {
                    webview.postMessage({ type: 'status', payload: 'Chýba bug ID.' });
                    return;
                }
                
                const opened = await sendAutotestPromptToChat(`over bug ${bugId}`);
                if (opened) {
                    postState(`Generujem test pre bug #${bugId}...`);
                } else {
                    postState(`Príkaz je v schránke: @autotest over bug ${bugId}`);
                }
                return;
            }
            case 'openWorkItem': {
                const url = String(message.url || '').trim();
                if (!url) {
                    webview.postMessage({ type: 'status', payload: 'Chyba URL work itemu.' });
                    return;
                }
                try {
                    await vscode.env.openExternal(vscode.Uri.parse(url));
                } catch {
                    webview.postMessage({ type: 'status', payload: 'Nepodarilo sa otvorit work item URL.' });
                }
                return;
            }
            case 'openReport': {
                const folderName = normalizeTestFolderName(String(message.folder || ''));
                if (!folderName) {
                    webview.postMessage({ type: 'status', payload: 'Chyba test folder pre report.' });
                    return;
                }
                const workspacePath = getWorkspacePathOrNull();
                if (!workspacePath) {
                    webview.postMessage({ type: 'status', payload: 'Nie je otvoreny projekt.' });
                    return;
                }
                const reportPath = resolveReportPath(path.join(workspacePath, 'autotest', folderName));
                if (!reportPath) {
                    webview.postMessage({ type: 'status', payload: `Report neexistuje: autotest/${folderName}` });
                    return;
                }
                showReportPanel(workspacePath, folderName, reportPath);
                return;
            }
            default:
                return;
        }
    });
}

class AutotestDashboardViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'autotest.dashboardView';

    constructor(private readonly extensionContext: vscode.ExtensionContext) {}

    async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
        webviewView.webview.options = {
            enableScripts: true
        };
        webviewView.webview.html = getAutotestDashboardHtml(webviewView.webview);

        const postState = async (info?: string) => {
            const state = buildDashboardState(this.extensionContext);
            
            // Načítaj TFS work items ak je TFS zapnutý
            if (state.tfsEnabled && tfsClient) {
                try {
                    state.tfsWorkItems = await tfsClient.getMyWorkItems();
                } catch (error) {
                    console.error('Error loading TFS work items:', error);
                    state.tfsWorkItems = [];
                }
            }

            webviewView.webview.postMessage({
                type: 'state',
                payload: state,
                info: info ? escapeHtml(info) : undefined
            });
        };

        const refreshSubscriber = () => {
            void postState();
        };
        dashboardRefreshSubscribers.add(refreshSubscriber);
        webviewView.onDidDispose(() => {
            dashboardRefreshSubscribers.delete(refreshSubscriber);
        });

        const disposable = registerDashboardMessageHandler(webviewView.webview, this.extensionContext, postState);
        this.extensionContext.subscriptions.push(disposable);
        await postState();
    }
}

function openAutotestDashboard(context: vscode.ExtensionContext): void {
    const panel = vscode.window.createWebviewPanel(
        'autotestDashboard',
        'Autotest Dashboard',
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: true
        }
    );

    const postState = async (info?: string) => {
        const state = buildDashboardState(context);
        
        // Načítaj TFS work items ak je TFS zapnutý
        if (state.tfsEnabled && tfsClient) {
            try {
                state.tfsWorkItems = await tfsClient.getMyWorkItems();
            } catch (error) {
                console.error('Error loading TFS work items:', error);
                state.tfsWorkItems = [];
            }
        }

        panel.webview.postMessage({
            type: 'state',
            payload: state,
            info: info ? escapeHtml(info) : undefined
        });
    };

    const refreshSubscriber = () => {
        void postState();
    };
    dashboardRefreshSubscribers.add(refreshSubscriber);

    panel.webview.html = getAutotestDashboardHtml(panel.webview);
    const disposable = registerDashboardMessageHandler(panel.webview, context, postState);
    panel.onDidDispose(() => {
        disposable.dispose();
        dashboardRefreshSubscribers.delete(refreshSubscriber);
    });

    postState();
}

/**
 * Inicializačný setup - @autotest init
 */
async function runInitializationSetup(context: vscode.ExtensionContext): Promise<void> {
    try {
        // === STEP 0: Create workspace structure immediately ===
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            vscode.window.showErrorMessage('Nie je otvorený žiadny projekt!');
            return;
        }
        const workspacePath = workspaceFolders[0].uri.fsPath;
        const autotestDir = initWorkspaceStructure(workspacePath);
        
        // 1. Výber role
        const roleSelection = await vscode.window.showQuickPick(
            [
                { label: '👨‍💻 Developer', value: 'developer', description: 'Automatické testovanie bugov' },
                { label: '🧪 Tester', value: 'tester', description: 'Test scenáre + Bug reporting do TFS' }
            ],
            {
                placeHolder: 'Vyber svoju rolu v projekte:',
                title: 'Autotest Agent - Konfigurácia',
                ignoreFocusOut: true
            }
        );

        if (!roleSelection) {
            vscode.window.showWarningMessage('Konfigurácia zrušená');
            return;
        }

        await saveUserRole(context, roleSelection.value as any);

        // 2. Local vs Remote testing
        const envType = await vscode.window.showQuickPick(
            [
                { label: '💻 Local', value: 'local', description: 'Testovanie na localhost' },
                { label: '🌐 Remote', value: 'remote', description: 'Testovanie na vzdialenom serveri' }
            ],
            { 
                placeHolder: 'Kde chceš testovať aplikáciu?',
                ignoreFocusOut: true
            }
        );

        if (!envType) {
            vscode.window.showWarningMessage('Konfigurácia zrušená');
            return;
        }

        // 3. Typ aplikácie
        const appType = await vscode.window.showQuickPick(
            [
                { label: '🌐 Web', value: 'web' },
                { label: '🖥️ Desktop', value: 'desktop' },
                { label: '📱 Mobile', value: 'mobile' }
            ],
            { 
                placeHolder: 'Aký typ aplikácie testuješ?',
                ignoreFocusOut: true
            }
        );

        if (!appType) {
            vscode.window.showWarningMessage('Konfigurácia zrušená');
            return;
        }

        // 4. Cieľ aplikácie (URL pre web, app path/AppUserModelId pre desktop)
        const appUrl = await vscode.window.showInputBox({
            prompt: appType.value === 'desktop'
                ? 'Zadaj App User Model ID alebo absolútnu cestu k .exe:'
                : 'Zadaj URL aplikácie:',
            placeHolder: appType.value === 'desktop'
                ? 'napr. C:\\Program Files\\MyApp\\MyApp.exe alebo Microsoft.WindowsCalculator_8wekyb3d8bbwe!App'
                : 'http://localhost:3000 alebo https://staging.app.com',
            value: appType.value === 'desktop'
                ? ''
                : (envType.value === 'local' ? 'http://localhost:3000' : ''),
            ignoreFocusOut: true,
            validateInput: (value) => {
                if (!value || value.trim().length === 0) {
                    return appType.value === 'desktop'
                        ? 'Zadaj App User Model ID alebo cestu k .exe'
                        : 'URL nemôže byť prázdne';
                }
                if (appType.value !== 'desktop' && !value.startsWith('http://') && !value.startsWith('https://')) {
                    return 'URL musí začínať http:// alebo https://';
                }
                return null;
            }
        });

        if (!appUrl) {
            vscode.window.showWarningMessage('Konfigurácia zrušená');
            return;
        }

        // Uložiť environment config
        await saveEnvironmentConfig(context, {
            url: appUrl,
            appType: appType.value,
            environment: envType.value,
            skipAvailabilityCheck: false
        });

        // Update project_overview.md with gathered info
        updateProjectOverview(workspacePath, {
            'Rola': roleSelection.value,
            'Typ aplikácie': appType.value,
            'Prostredie': envType.value,
            'Aplikácia / URL': appUrl
        });

        // Desktop backend selection (ak je desktop mode)
        if (appType.value === 'desktop') {
            await saveDesktopBackend(context, 'pywinauto');
            vscode.window.showInformationMessage(
                '🐍 Backend: Python pywinauto - Python 3 a pywinauto sa nainštalujú automaticky pri prvom teste.',
                { modal: false }
            );
        }

        // 5. Prihlasovanie (login credentials)
        const requiresLogin = await vscode.window.showQuickPick(
            [
                { label: '✅ Áno', value: 'yes', description: 'Aplikácia vyžaduje prihlásenie' },
                { label: '❌ Nie', value: 'no', description: 'Veřejná aplikácia bez login formu' }
            ],
            { 
                placeHolder: 'Vyžaduje aplikácia prihlásenie (username/password)?',
                ignoreFocusOut: true
            }
        );

        if (requiresLogin?.value === 'yes') {
            const username = await vscode.window.showInputBox({
                prompt: 'Zadaj prihlasovacie meno (username):',
                placeHolder: 'admin, testuser, ...',
                ignoreFocusOut: true,
                validateInput: (value) => {
                    if (!value || value.trim().length === 0) {
                        return 'Username nemôže byť prázdny';
                    }
                    return null;
                }
            });

            if (!username) {
                vscode.window.showWarningMessage('Konfigurácia zrušená');
                return;
            }

            const password = await vscode.window.showInputBox({
                prompt: 'Zadaj heslo:',
                placeHolder: 'heslo...',
                password: true, // Skryje znaky pri písaní
                ignoreFocusOut: true,
                validateInput: (value) => {
                    if (!value || value.trim().length === 0) {
                        return 'Heslo nemôže byť prázdne';
                    }
                    return null;
                }
            });

            if (!password) {
                vscode.window.showWarningMessage('Konfigurácia zrušená');
                return;
            }

            // Uložiť login config
            await saveLoginConfig(context, {
                required: true,
                username: username
            });

            // Uložiť heslo do secure storage
            await saveLoginPassword(context, password);
            
            vscode.window.showInformationMessage(`✅ Prihlasovacie údaje uložené: ${username}`);
        } else {
            await saveLoginConfig(context, { required: false });
        }

        // 6. TFS konfigurácia (pre obe role)
        const tfsChoice = await vscode.window.showQuickPick(
            [
                { label: '✅ Áno', value: 'yes', description: 'Odporúčané - načítava bug detaily z TFS' },
                { label: '❌ Nie', value: 'no' },
                { label: '⏰ Neskôr', value: 'later' }
            ],
            { 
                placeHolder: 'Chceš pripojiť TFS/Azure DevOps?',
                ignoreFocusOut: true
            }
        );

        if (tfsChoice?.value === 'yes') {
            await setupTfsConnection(context);
        } else {
            await saveTfsConfig(context, { enabled: false });
        }

        vscode.window.showInformationMessage(
            `✅ Konfigurácia uložená! Rola: ${roleSelection.value}, App: ${appUrl}\n• autotest/ štruktúra vytvorená\n• project_overview.md vygenerovaný`
        );
    } catch (error: any) {
        vscode.window.showErrorMessage(`Chyba pri konfigurácii: ${error.message}`);
    }
}

/**
 * TFS Setup
 */
async function setupTfsConnection(context: vscode.ExtensionContext): Promise<void> {
    try {
        // 1. Organization URL
        const orgUrl = await vscode.window.showInputBox({
            prompt: 'Zadaj TFS Organization URL:',
            placeHolder: 'https://dev.azure.com/org alebo http://tfs-server:8080/tfs/project',
            ignoreFocusOut: true,
            validateInput: (value) => {
                if (!value || (!value.startsWith('http://') && !value.startsWith('https://'))) {
                    return 'URL musí začínať http:// alebo https://';
                }
                return null;
            }
        });

        if (!orgUrl) {
            vscode.window.showWarningMessage('TFS konfigurácia zrušená');
            return;
        }

        // 2. Project Name
        const projectName = await vscode.window.showInputBox({
            prompt: 'Zadaj názov projektu v TFS:',
            placeHolder: 'MyProject',
            ignoreFocusOut: true
        });

        if (!projectName) {
            vscode.window.showWarningMessage('TFS konfigurácia zrušená');
            return;
        }

        // 3. PAT Token
        const patInfo = await vscode.window.showInformationMessage(
            'Potrebuješ Personal Access Token (PAT) z Azure DevOps/TFS',
            { modal: true, detail: 'Kde nájsť PAT:\n1. Otvor Azure DevOps/TFS\n2. Ikona profilu → Personal Access Tokens\n3. New Token\n4. Scope: Work Items (Read) alebo (Read & Write)\n5. Skopíruj token' },
            'Pokračovať'
        );

        if (patInfo !== 'Pokračovať') {
            vscode.window.showWarningMessage('TFS konfigurácia zrušená');
            return;
        }

        const pat = await vscode.window.showInputBox({
            prompt: 'Zadaj Personal Access Token (PAT):',
            placeHolder: 'Tvoj PAT token',
            password: true,
            ignoreFocusOut: true,
            validateInput: (value) => {
                if (!value || value.length < 10) {
                    return 'PAT token musí mať aspoň 10 znakov';
                }
                return null;
            }
        });

        if (!pat) {
            vscode.window.showWarningMessage('TFS konfigurácia zrušená');
            return;
        }

        // Validácia pripojenia
        vscode.window.showInformationMessage('🔄 Validujem pripojenie k TFS...');
        
        const client = new TfsClient();
        await client.connect(orgUrl, projectName, pat);
        const validation = await client.validateConnection();

        if (!validation.success) {
            vscode.window.showErrorMessage(`TFS validácia zlyhala: ${validation.message}`);
            return;
        }

        // Uložiť konfiguráciu
        await saveTfsConfig(context, {
            enabled: true,
            organization: orgUrl,
            project: projectName
        });
        await saveTfsPat(context, pat);

        // Inicializovať global TFS client
        tfsClient = client;

        vscode.window.showInformationMessage(`✅ TFS pripojenie úspešne nastavené! (${projectName})`);
    } catch (error: any) {
        vscode.window.showErrorMessage(`Chyba pri pripojení k TFS: ${error.message}`);
    }
}

/**
 * Delegátor: spustí web alebo desktop test podľa konfigurácie
 */
async function runAutomatedTest(
    context: vscode.ExtensionContext,
    response: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    bugDescription: string,
    bugId: string | undefined,
    config: AutotestConfig
): Promise<void> {
    const isPywinauto = config.appType === 'desktop' && config.desktopBackend === 'pywinauto';
    if (isPywinauto) {
        await runDesktopTest(context, response, token, bugDescription, bugId, config);
    } else {
        await runWebTest(context, response, token, bugDescription, bugId, config);
    }
}

export function activate(context: vscode.ExtensionContext) {
    vscode.window.showInformationMessage('Autotest Agent je aktívny!');

    const dashboardViewProvider = new AutotestDashboardViewProvider(context);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            AutotestDashboardViewProvider.viewType,
            dashboardViewProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    // Načítať konfiguráciu pri štarte
    const cfg = loadConfiguration(context);

    // Inicializovať TFS client ak je enabled
    if (cfg.tfsEnabled && cfg.tfsOrganization && cfg.tfsProject) {
        getTfsPat(context).then(async (pat) => {
            if (pat) {
                try {
                    tfsClient = new TfsClient();
                    await tfsClient.connect(cfg.tfsOrganization!, cfg.tfsProject!, pat);
                } catch (error) {
                    console.error('TFS client initialization failed:', error);
                }
            }
        });
    }

    const autotestAgent = vscode.chat.createChatParticipant('autotest.agent', async (request, _contextObj, response, token) => {
        const userQuery = request.prompt.trim().toLowerCase();
        const config = loadConfiguration(context);

        response.markdown(`Ahoj! Som tvoj Autotest Agent. 🤖\n\n`);

        // ===== PRÍKAZ: @autotest init =====
        if (userQuery.includes('init')) {
            response.markdown(`🔧 **Spúšťam inicializáciu...**\n\n`);
            await runInitializationSetup(context);
            return;
        }

        // ===== PRÍKAZ: @autotest model =====
        if (userQuery.includes('select-model') || userQuery.includes('model') || userQuery.includes('vyber model')) {
            response.markdown(`🤖 **Výber AI modelov...**\n\n`);
            const codeModel = await selectAIModel(context, 'code', true);
            if (codeModel) {
                response.markdown(`✅ Kódovací model: **${codeModel.name || codeModel.id}** (${codeModel.vendor})\n\n`);
            }
            const visionModel = await selectAIModel(context, 'vision', true);
            if (visionModel) {
                response.markdown(`✅ Vision model: **${visionModel.name || visionModel.id}** (${visionModel.vendor})\n\n`);
            }
            return;
        }

        // ===== PRÍKAZ: @autotest debug =====
        if (userQuery.includes('debug') || userQuery.includes('show') || userQuery.includes('visible')) {
            response.markdown(`🕵 **Debug mód...**\n\n`);
            const debugChoice = await vscode.window.showQuickPick(
                [
                    { label: '👁️ Viditeľný browser (Headed)', value: 'visible', description: 'headless: false, slowMo: 100ms' },
                    { label: '⚡ Rýchly neviditeľný (Headless)', value: 'fast', description: 'headless: true, slowMo: 0ms' },
                    { label: '🐌 Pomalý viditeľný (Debug)', value: 'slow', description: 'headless: false, slowMo: 500ms' }
                ],
                { placeHolder: 'Vyber mód testovania:', ignoreFocusOut: true }
            );
            if (debugChoice?.value === 'visible') {
                await saveDebugConfig(context, { headless: false, slowMo: 100 });
                response.markdown(`✅ **Viditeľný browser zapnutý!** (slowMo: 100ms)\n\n`);
            } else if (debugChoice?.value === 'fast') {
                await saveDebugConfig(context, { headless: true, slowMo: 0 });
                response.markdown(`✅ **Headless mód zapnutý!**\n\n`);
            } else if (debugChoice?.value === 'slow') {
                await saveDebugConfig(context, { headless: false, slowMo: 500 });
                response.markdown(`✅ **Pomalý debug mód zapnutý!** (slowMo: 500ms)\n\n`);
            }
            return;
        }

        // ===== PRÍKAZ: @autotest record =====
        if (userQuery.includes('record') || userQuery.includes('nahraj') || userQuery.includes('nahrívaj')) {
            const isDesktopMode = config.appType === 'desktop';
            if (isDesktopMode) {
                await handleDesktopRecord(context, response, token, request, config);
            } else {
                await handleWebRecord(context, response, token, request, config);
            }
            return;
        }

        // ===== PRÍKAZ: @autotest history =====
        if (userQuery.includes('history') || userQuery.includes('história')) {
            const history = getBugHistory(context, 10);
            response.markdown(formatBugHistory(history));
            return;
        }

        // ===== PRÍKAZ: @autotest regenerate =====
        if (userQuery.includes('regenerate') || userQuery.includes('regeneruj')) {
            response.markdown(`🔄 **Regenerácia test scriptu...**\n\n`);
            const folderMatch = request.prompt.match(/(?:bug_|test_)[\w]+/);
            if (!folderMatch) {
                response.markdown(`❌ Zadaj názov test priečinka, napríklad: \`@autotest regenerate bug_622116\`\n\n`);
                return;
            }
            const isDesktopMode = config.appType === 'desktop';
            if (isDesktopMode) {
                await handleDesktopRegenerate(context, response, token, request, config);
            } else {
                await handleWebRegenerate(context, response, token, request, config);
            }
            return;
        }

        // ===== PRÍKAZ: @autotest run =====
        if (userQuery.startsWith('run')) {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                response.markdown(`❌ Nie je otvorený žiadny projekt.\n\n`);
                return;
            }
            const workspacePath = workspaceFolders[0].uri.fsPath;
            const runMatch = request.prompt.match(/run\s+(?:bug_?)?(\d+|test_init|test_\w+)/i);
            if (runMatch) {
                const arg = runMatch[1];
                const folderName = /^\d+$/.test(arg)
                    ? `bug_${arg.padStart(3, '0')}`
                    : arg;
                await runExistingTest(workspacePath, folderName, response, context, token);
                return;
            }
            // No argument - list available tests
            const autotestPath = path.join(workspacePath, 'autotest');
            if (!fs.existsSync(autotestPath)) {
                response.markdown(`❌ Priečinok \`autotest/\` neexistuje. Spusti najprv \`@autotest init\`.\n\n`);
            } else {
                const entries = fs.readdirSync(autotestPath).filter(e =>
                    fs.statSync(path.join(autotestPath, e)).isDirectory() && e !== 'data' && !e.startsWith('_'));
                if (entries.length === 0) {
                    response.markdown(`ℹ️ Žiadne testy. Vytvor test pomocou \`@autotest test\`.\n\n`);
                } else {
                    response.markdown(`📋 **Dostupné testy:**\n${entries.map(e => `- \`@autotest run ${e}\``).join('\n')}\n\n`);
                }
            }
            return;
        }

        // ===== PRÍKAZ: @autotest test =====
        if (userQuery.includes('test') && !userQuery.match(/\d+/)) {
            response.markdown(`📋 **Zadaj popis bugu...**\n\n`);
            let bugDescription = await getBugDescriptionWithClipboardOption();
            if (!bugDescription) {
                response.markdown(`*Popis bugu nebol zadaný. Skús znovu.*`);
                return;
            }
            if (bugDescription === '__CREATE_FILE__') {
                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (!workspaceFolders || workspaceFolders.length === 0) {
                    response.markdown(`*Chyba: Nemáš otvorený žiadny projekt.*`); return;
                }
                const workspacePath = workspaceFolders[0].uri.fsPath;
                const bugNumber = getNextBugNumber(workspacePath);
                const bugFolderName = `bug_${bugNumber.toString().padStart(3, '0')}`;
                const bugDir = path.join(workspacePath, 'autotest', bugFolderName);
                if (!fs.existsSync(path.join(workspacePath, 'autotest'))) {
                    fs.mkdirSync(path.join(workspacePath, 'autotest'));
                    ensureGitignore(workspacePath);
                }
                fs.mkdirSync(bugDir, { recursive: true });
                const scenarioPath = path.join(bugDir, 'test_scenario.md');
                fs.writeFileSync(scenarioPath, `# Test Scenár: [Názov testu]\n\n## Cieľ:\n[Popis]\n\n## Test kroky:\n1. [Krok 1]\n\n## Očakávaný výsledok:\n[Výsledok]\n`);
                const doc = await vscode.workspace.openTextDocument(scenarioPath);
                await vscode.window.showTextDocument(doc);
                response.markdown(`📁 Vytvorený: \`autotest/${bugFolderName}\`\n\n✏️ Uprav \`test_scenario.md\` a spusti: \`@autotest regenerate ${bugFolderName}\`\n\n`);
                return;
            }
            await runAutomatedTest(context, response, token, bugDescription, undefined, config);
            return;
        }

        // ===== PRÍKAZ: @autotest over bug NNN =====
        const bugMatch = request.prompt.match(/\d+/);
        const bugId = bugMatch ? bugMatch[0] : null;

        if (!bugId) {
            const isWebMode = config.appType !== 'desktop';
            response.markdown(`*Zadaj príkaz, napríklad:*\n`);
            response.markdown(`- \`@autotest init\` - Nastaviť konfiguráciu\n`);
            response.markdown(`- \`@autotest model\` - Vybrať AI model\n`);
            response.markdown(`- \`@autotest debug\` - Prepnúť viditeľný/neviditeľný browser\n`);
            if (isWebMode) {
                response.markdown(`- \`@autotest over bug 123\` - Pripraviť scenár a otestovať web cez Playwright MCP\n`);
                response.markdown(`- \`@autotest test\` - Pripraviť scenár z popisu a otestovať web cez Playwright MCP\n`);
                response.markdown(`- \`@autotest regenerate bug_123\` - Znova otestovať upravený scenár cez Playwright MCP\n`);
                response.markdown(`- \`@autotest run bug_001\` - Spustiť existujúci nahraný test (\`test.spec.js\`)\n`);
                response.markdown(`- \`@autotest record bug_001\` - Nahrať akcie cez Playwright codegen\n`);
            } else {
                response.markdown(`- \`@autotest over bug 123\` - Otestovať bug z TFS\n`);
                response.markdown(`- \`@autotest test\` - Otestovať podľa manuálneho popisu\n`);
                response.markdown(`- \`@autotest run bug_001\` - Spustiť existujúci test\n`);
                response.markdown(`- \`@autotest regenerate bug_123\` - Regenerovať test zo scenára\n`);
                response.markdown(`- \`@autotest record bug_001\` - Nahrať akcie a vygenerovať test\n`);
            }
            response.markdown(`- \`@autotest history\` - Zobraziť históriu testov\n`);
            if (config.userRole === 'unknown') {
                response.markdown(`\n⚠️ **Konfigurácia nie je nastavená. Spusti \`@autotest init\` najskôr.**\n`);
            }
            return;
        }

        // Načítať popis bugu (z TFS alebo manuálne)
        let bugDescription: string | undefined;
        if (config.tfsEnabled && tfsClient) {
            response.markdown(`🔍 Hľadám detaily pre **Bug #${bugId}** v TFS...\n\n`);
            try {
                const bugDetails = await tfsClient.getBugDetails(parseInt(bugId));
                if (bugDetails) {
                    bugDescription = `${bugDetails.title}\n\n${bugDetails.description}`;
                    response.markdown(`> **Popis z TFS:** ${bugDescription.substring(0, 200)}...\n\n`);
                } else {
                    response.markdown(`⚠️ Bug #${bugId} sa nenašiel v TFS. Zadaj popis manuálne.\n\n`);
                    bugDescription = await getBugDescriptionWithClipboardOption();
                }
            } catch (error: any) {
                response.markdown(`⚠️ Chyba pri načítaní z TFS: ${error.message}. Zadaj popis manuálne.\n\n`);
                bugDescription = await getBugDescriptionWithClipboardOption();
            }
        } else {
            response.markdown(`ℹ️ TFS nie je nakonfigurované. Zadaj popis bugu manuálne.\n\n`);
            bugDescription = await getBugDescriptionWithClipboardOption();
        }

        if (bugDescription === '__CREATE_FILE__') {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                response.markdown(`*Chyba: Nemáš otvorený žiadny projekt.*`); return;
            }
            const workspacePath = workspaceFolders[0].uri.fsPath;
            const bugFolderName = `bug_${bugId}`;
            const bugDir = path.join(workspacePath, 'autotest', bugFolderName);
            if (!fs.existsSync(path.join(workspacePath, 'autotest'))) {
                fs.mkdirSync(path.join(workspacePath, 'autotest'));
                ensureGitignore(workspacePath);
            }
            fs.mkdirSync(bugDir, { recursive: true });
            const scenarioPath = path.join(bugDir, 'test_scenario.md');
            fs.writeFileSync(scenarioPath, `# Test Scenár: Bug #${bugId}\n\n## Cieľ:\n[Popis]\n\n## Test kroky:\n1. [Krok 1]\n\n## Očakávaný výsledok:\n[Výsledok]\n`);
            const doc = await vscode.workspace.openTextDocument(scenarioPath);
            await vscode.window.showTextDocument(doc);
            response.markdown(`📁 Vytvorený: \`autotest/${bugFolderName}\`\n\n✏️ Uprav \`test_scenario.md\` a spusti: \`@autotest regenerate ${bugFolderName}\`\n\n`);
            return;
        }

        if (!bugDescription) {
            response.markdown(`*Popis bugu nebol zadaný. Test sa nemôže spustiť.*`);
            return;
        }

        await runAutomatedTest(context, response, token, bugDescription, bugId, config);
    });

    context.subscriptions.push(autotestAgent);

    // ===== Registrácia príkazov =====

    context.subscriptions.push(vscode.commands.registerCommand('autotest.init', async () => {
        await runInitializationSetup(context);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotest.reconfigure', async () => {
        const confirm = await vscode.window.showWarningMessage('Naozaj chceš resetovať konfiguráciu?', 'Áno', 'Nie');
        if (confirm === 'Áno') {
            await resetConfiguration(context);
            tfsClient = null;
            vscode.window.showInformationMessage('✅ Konfigurácia bola resetovaná!');
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotest.tfsSetup', async () => {
        await setupTfsConnection(context);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotest.openDashboard', async () => {
        openAutotestDashboard(context);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('autotest.runTest', async (folderName?: string) => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            vscode.window.showErrorMessage('Nie je otvorený žiadny projekt!');
            return;
        }
        const workspacePath = workspaceFolders[0].uri.fsPath;
        if (!folderName) {
            const input = await vscode.window.showInputBox({
                prompt: 'Zadaj číslo alebo názov testu',
                placeHolder: 'bug_001 alebo 1'
            });
            if (!input) { return; }
            folderName = /^\d+$/.test(input.trim())
                ? `bug_${input.trim().padStart(3, '0')}`
                : input.trim();
        }
        const resolvedFolder = normalizeTestFolderName(folderName);
        if (!resolvedFolder) {
            vscode.window.showErrorMessage('Neplatný názov test priečinka.');
            return;
        }
        const channel = vscode.window.createOutputChannel('Autotest Run');
        channel.show();
        channel.appendLine(`Spúšťam test: ${resolvedFolder}`);
        const testDir = path.join(workspacePath, 'autotest', resolvedFolder);
        const testResultPath = path.join(testDir, 'test_result.md');
        try {
            fs.writeFileSync(testResultPath, `# Test Result: RUNNING ⏳\n\n## Test Info\n- **Bug ID:** ${normalizeBugId(resolvedFolder) || 'N/A'}\n- **Timestamp:** ${new Date().toLocaleString('sk-SK')}\n- **Status:** RUNNING\n`);
        } catch {}
        notifyDashboardRefresh();
        const pyFile = path.join(testDir, 'test.spec.py');
        const jsFile = path.join(testDir, 'test.spec.js');
        let testCommand = '';
        if (fs.existsSync(pyFile)) {
            const pyExe = await findPythonExecutable() || 'python';
            testCommand = `"${pyExe}" test.spec.py`;
        } else if (fs.existsSync(jsFile)) {
            testCommand = `node test.spec.js`;
        } else {
            channel.appendLine('Nenašiel sa test súbor (test.spec.py ani test.spec.js).');
            return;
        }
        for (const f of ['success_screenshot.png', 'error_screenshot.png', 'not_found_screenshot.png', 'not_found_info.json']) {
            try { fs.unlinkSync(path.join(testDir, f)); } catch {}
        }
        try {
            const { stdout, stderr } = await execAsync(testCommand, { cwd: testDir, timeout: 180000 });
            channel.appendLine(stdout || '');
            if (stderr) { channel.appendLine(stderr); }
            const succeeded = fs.existsSync(path.join(testDir, 'success_screenshot.png'));
            fs.writeFileSync(testResultPath, `# Test Result: ${succeeded ? 'PASSED ✅' : 'FAILED ❌'}\n\n## Test Info\n- **Folder:** ${resolvedFolder}\n- **Timestamp:** ${new Date().toLocaleString('sk-SK')}\n- **Status:** ${succeeded ? 'PASSED' : 'FAILED'}\n\n## Output\n\`\`\`\n${(stdout || '').substring(0, 2000)}\n\`\`\`\n`);
            notifyDashboardRefresh();
            vscode.window.showInformationMessage(succeeded ? `✅ Test ${resolvedFolder} PASSED!` : `❌ Test ${resolvedFolder} FAILED.`);
        } catch (e: any) {
            const errDetail = [e.stderr, e.stdout].filter(Boolean).join('\n').trim() || e.message;
            channel.appendLine(`Chyba: ${errDetail}`);
            fs.writeFileSync(testResultPath, `# Test Result: FAILED ❌\n\n## Test Info\n- **Folder:** ${resolvedFolder}\n- **Timestamp:** ${new Date().toLocaleString('sk-SK')}\n- **Status:** FAILED\n\n## Chyba\n\`\`\`\n${errDetail.substring(0, 2000)}\n\`\`\`\n`);
            notifyDashboardRefresh();
            vscode.window.showErrorMessage(`❌ Test ${resolvedFolder} zlyhal: ${e.message?.substring(0, 100)}`);
        }
    }));
}

export function deactivate() {}

