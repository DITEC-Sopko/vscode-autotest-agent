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
                e !== 'data')
            : [];
        entries.forEach(e => response.markdown(`- \`${e}\`\n`));
        return;
    }
    
    // Find test file
    const pyFile = path.join(testDir, 'test.spec.py');
    const jsFile = path.join(testDir, 'test.spec.js');
    
    let testFile = '';
    let testCommand = '';
    
    if (fs.existsSync(pyFile)) {
        const pyExe = await findPythonExecutable() || 'python';
        testFile = pyFile; testCommand = `"${pyExe}" "${pyFile}"`;
    } else if (fs.existsSync(jsFile)) {
        testFile = jsFile; testCommand = `node "${jsFile}"`;
    } else {
        response.markdown(`❌ V priečinku \`autotest/${testFolderName}\` sa nenašiel žiadny test súbor.\n\n`);
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
            return fs.statSync(full).isDirectory() && entry !== 'data';
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

function buildDashboardTests(workspacePath: string, tests: string[], history: BugHistoryItem[]): DashboardTestItem[] {
    return tests.map((testName) => {
        const testDir = path.join(workspacePath, 'autotest', testName);
        const reportPath = path.join(testDir, 'test_result.md');
        const hasReport = fs.existsSync(reportPath);

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
                return fs.statSync(full).isDirectory() && entry !== 'data';
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

function buildDashboardState(context: vscode.ExtensionContext) {
    const config = loadConfiguration(context);
    const workspacePath = getWorkspacePathOrNull();
    const tests = workspacePath ? listAutotestFolders(workspacePath) : [];
    const projectOverview = workspacePath ? readProjectOverview(workspacePath) : '';
    const runHistory = getBugHistory(context, 20);
    const testsWithStatus = workspacePath ? buildDashboardTests(workspacePath, tests, runHistory) : [];

    const dashboardState: any = {
        hasWorkspace: Boolean(workspacePath),
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
                    <button class="primary" data-action="init">Inicializovať</button>
                    <button class="secondary" data-action="tfs">TFS Setup</button>
                    <button class="secondary" data-action="models">AI Modely</button>
                    <button class="secondary" data-action="debug">Debug mód</button>
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
                const reportPath = path.join(workspacePath, 'autotest', folderName, 'test_result.md');
                if (!fs.existsSync(reportPath)) {
                    webview.postMessage({ type: 'status', payload: `Report neexistuje: autotest/${folderName}/test_result.md` });
                    return;
                }
                const doc = await vscode.workspace.openTextDocument(reportPath);
                await vscode.window.showTextDocument(doc, { preview: false });
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
 * Hlavná funkcia pre spustenie automatizovaného testu
 */
async function runAutomatedTest(
    context: vscode.ExtensionContext,
    response: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    bugDescription: string,
    bugId: string | undefined,
    config: AutotestConfig
): Promise<void> {
    const isDesktopMode = config.appType === 'desktop';
    const isPywinautoBackend = isDesktopMode && config.desktopBackend === 'pywinauto';

    // 1. Generovanie automatizovaného testu pomocou Copilot LLM
    response.markdown(
        isPywinautoBackend
            ? `⚙️ Generujem desktop automatizovaný test (Python pywinauto)...\n\n`
            : `⚙️ Generujem Playwright automatizovaný test...\n\n`
    );

    try {
        // Vyber kódovací model na generovanie testu
        const model = await selectAIModel(context, 'code');
        
        if (!model) {
            response.markdown(`*Chyba: Nenašiel sa AI model. Uisti sa, že máš aktívne GitHub Copilot subscription a si prihlásený.*`);
            return;
        }
        
        response.markdown(`🤖 Kódovací model: **${model.name || model.id}** (${model.vendor})\n\n`);

        // Načítať login credentials ak sú nastavené
        let loginCredentials = '';
        if (config.loginRequired && config.username) {
            const password = await getLoginPassword(context);
            if (password) {
                loginCredentials = `

DÔLEŽITÉ - Aplikácia vyžaduje prihlásenie:
1. Username: "${config.username}"
2. Password: "${password}"

Pre prihlásenie použi tento Playwright kód (PRESNE takto):
  // Prihlásenie
  await page.fill('input[name="username"]', '${config.username}');
  await page.fill('input[name="password"]', '${password}');
  
  // Klikni na login button - POUŽI VIACERO MOŽNOSTÍ (prvá ktorá funguje):
  try {
    // Možnosť 1: Hľadaj button s textom "Prihlásiť", "Login", "Přihlásit", atď.
    await page.getByRole('button', { name: /prihlásiť|login|přihlásit|sign in|submit/i }).click({ timeout: 5000 });
  } catch {
    try {
      // Možnosť 2: Hľadaj button type="submit"
      await page.locator('button[type="submit"]').click({ timeout: 5000 });
    } catch {
      // Možnosť 3: Hľadaj akýkoľvek button vo forme
      await page.locator('form button').first().click({ timeout: 5000 });
    }
  }
  
  // Počkaj kým sa aplikácia plne načíta (Blazor SPA — waitForLoadState tu NEFUNGUJE)
  await page.waitForFunction(() => !document.body?.innerText?.includes('Completing login'), { timeout: 30000 });
  await page.waitForTimeout(2000);

Teraz pokračuj s testovaním bugu.`;
            }
        }

          // Ensure workspace path and optionally load project overview + desktop metadata
          const workspaceFolders = vscode.workspace.workspaceFolders;
          const workspacePath = workspaceFolders && workspaceFolders[0] ? workspaceFolders[0].uri.fsPath : process.cwd();
          let projectOverview = '';
          let desktopMetadata: any = null;
          let automationMemory: ProjectAutomationMemory | null = null;
          let memoryContext = '';
          let projectHealingLessons = '';
          let testHealingContext = '';
          let domTestIds = '';
          try {
                const overviewPath = path.join(workspacePath, 'autotest', 'project_overview.md');
                if (fs.existsSync(overviewPath)) {
                     projectOverview = fs.readFileSync(overviewPath, 'utf-8');
                     response.markdown(`🗂️ Načítaný project overview: \`autotest/project_overview.md\`\n\n`);
                }

                if (isPywinautoBackend) {
                    const metadataPath = path.join(workspacePath, 'autotest', 'desktop_app_metadata.json');
                    if (fs.existsSync(metadataPath)) {
                        desktopMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
                        response.markdown(`🔍 Načítané desktop metadata: \`autotest/desktop_app_metadata.json\`\n\n`);
                    }
                }

                const _targetFolderName = bugId ? `bug_${bugId}` : '';
                if (_targetFolderName) {
                    testHealingContext = loadTestHealingContext(path.join(workspacePath, 'autotest', _targetFolderName));
                    if (testHealingContext) {
                        response.markdown(`🩹 Načítaný healing context: \`autotest/${_targetFolderName}/healing_context.md\`\n\n`);
                    }
                }

                projectHealingLessons = loadProjectHealingLessons(workspacePath);
                if (projectHealingLessons) {
                    response.markdown(`📚 Načítané projektové lessons: \`autotest/healing_lessons.md\`\n\n`);
                }

                // Načítaj pamäť UI Automation stratégií pre VŠETKY typy testov (web aj desktop)
                const _memAutotestDir = path.join(workspacePath, 'autotest');
                if (fs.existsSync(_memAutotestDir)) {
                    automationMemory = new ProjectAutomationMemory(_memAutotestDir, config.appUrl || '');
                    memoryContext = automationMemory.formatForPrompt();
                    if (memoryContext) {
                        response.markdown(`🧠 Načítaná UI Automation pamäť projektu.\n\n`);
                    }
                }

                // Extrahuj data-testid hodnoty z dom.html pre Playwright selektory
                const _domSearchDirs: string[] = [];
                if (_targetFolderName) {
                    _domSearchDirs.push(path.join(workspacePath, 'autotest', _targetFolderName));
                }
                const _domAutotestDir = path.join(workspacePath, 'autotest');
                if (fs.existsSync(_domAutotestDir)) {
                    const _bugFolders = fs.readdirSync(_domAutotestDir)
                        .filter(f => /^bug_\d+$/.test(f))
                        .map(f => path.join(_domAutotestDir, f))
                        .filter(p => !_domSearchDirs.includes(p));
                    _domSearchDirs.push(..._bugFolders);
                }
                for (const _dir of _domSearchDirs) {
                    const _domPath = path.join(_dir, 'dom.html');
                    if (fs.existsSync(_domPath)) {
                        try {
                            const _domContent = fs.readFileSync(_domPath, 'utf-8');
                            const _matches = [..._domContent.matchAll(/data-testid="([^"]+)"/g)];
                            const _uniqueIds = [...new Set(_matches.map((m: RegExpMatchArray) => m[1]))];
                            if (_uniqueIds.length > 0) {
                                domTestIds = _uniqueIds.join('\n');
                                response.markdown(`🏷️ Načítané data-testid z DOM (${_uniqueIds.length} el.): \`${path.relative(workspacePath, _dir)}/dom.html\`\n\n`);
                                break;
                            }
                        } catch (_e) { /* ignore */ }
                    }
                }
          } catch (e) {
                // ignore
          }

          // Generovanie test scenára
          response.markdown(`📝 **Vytváram test scenár...**\n\n`);
        
          const scenarioPrompt = `
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

2. Ak bug hovorí o tlačidle/akcii VŠEOBECNE (napr. "zobrazí detail"), špecifikuj ČO hľadať:
    - "Zobrazí detail klienta" → "Klikni na tlačidlo/link 'Detail' alebo ikonu detail (class 'icon-detail')"
    - "Filtruje záznamy" → "Klikni na tlačidlo 'Filter' alebo ikonu filtra"

3. Pre VALIDÁCIE:
    - Ak má byť tabuľka/grid naplnená, špecifikuj: "Skontroluj že tabuľka obsahuje aspoň 1 riadok"
    - Ak má byť prázdna: "Skontroluj že tabuľka je prázdna"

Formát scenára:
# Test Scenár: [Názov]

## Cieľ:
[Stručný popis čo test overuje]

## Preconditions:
- [Podmienky pred testom]

## Test kroky:
1. [Prvý krok - napísany jasne a čitateľne s KONKRÉTNYMI údajmi]
2. [Druhý krok - ak treba vybrať niečo, špecifikuj ČO (prvý riadok, konkrétny ID, ...)]
...

## Očakávaný výsledok:
[Ako by mala aplikácia reagovať - KONKRÉTNE (tabuľka má X riadkov, panel je viditeľný, ...)]

Vráť IBA markdown scenár, žiadny iný text.
`;

        const scenarioMessages = [vscode.LanguageModelChatMessage.User(scenarioPrompt)];
        const scenarioResponse = await model.sendRequest(scenarioMessages, {}, token);
        
        let testScenario = '';
        for await (const chunk of scenarioResponse.text) {
            testScenario += chunk;
        }
        testScenario = testScenario.replace(/```markdown|```/g, '').trim();
        
        response.markdown(`✅ **Test scenár vytvorený!**\n\n`);


          // Generovanie test kódu
          response.markdown(
            isPywinautoBackend
                ? `⚙️ **Generujem Python pywinauto test script...**\n\n`
                : `⚙️ **Generujem Playwright test script...**\n\n`
        );

        const prompt = isPywinautoBackend
                ? `
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

2. Funkcia get_timestamp():
   def get_timestamp():
       return datetime.now().strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]

3. Funkcia log(msg) pre logovanie (pridáva do zoznamu logs):
   logs = []
   def log(msg):
       entry = {'timestamp': get_timestamp(), 'message': msg}
       logs.append(entry)
       print(f"[{entry['timestamp']}] {msg}")

4. Spustenie aplikácie - NAJPRV skús pripojiť k bežiacej inštancii, ak nebeží, spusti novú:
   proc = None
   title_re = '.*${(desktopMetadata?.Name || config.appUrl).replace(/[.*+?^${}()|[\]\\]/g, '\\\\$&').substring(0, 30)}.*'
   try:
       app = Application(backend='uia').connect(title_re=title_re, timeout=3)
       log('Pripojené k bežiacej inštancii')
   except Exception:
       ${config.appUrl.includes('\\') || config.appUrl.includes('/')
           ? /\.(exe|bat|com)$/i.test(config.appUrl)
               ? `proc = subprocess.Popen(['${config.appUrl.replace(/\\/g, '\\\\')}'])
       time.sleep(3)`
               : `os.startfile(r'${config.appUrl}')  # ClickOnce / .appref-ms / .lnk
       time.sleep(4)
       proc = None`
           : `subprocess.Popen(['explorer.exe', 'shell:appsFolder\\\\${config.appUrl}'])
       time.sleep(4)
       proc = None`}
       app = Application(backend='uia').connect(title_re=title_re, timeout=30)

5. Získanie referencie na okno:
   win = app.window(title_re=title_re)
   win.set_focus()
   time.sleep(0.5)

6. POVINNÁ helper funkcia - pridaj ju HNEĎ po log() funkcii (pred try blokom):
   def click_by_text(container, text, screenshot_on_fail=True, timeout=2.5):
       """Nájde element podľa textu kdekoľvek v kontajneri - skúša všetky control types."""
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
       # Element nenájdený - screenshot pre AI analýzu
       if screenshot_on_fail:
           try:
               container.capture_as_image().save('not_found_screenshot.png')
               with open('not_found_info.json', 'w', encoding='utf-8') as f:
                   json.dump({'searching_for': text, 'screenshot': 'not_found_screenshot.png', 'timestamp': get_timestamp()}, f, ensure_ascii=False, indent=2)
               log(f'Screenshot uložený ako not_found_screenshot.png (hľadal som: "{text}")')
           except: pass
       raise Exception(f'Element "{text}" nebol nájdený po {timeout}s - pozri not_found_screenshot.png')

   def get_edit_value(ctrl):
       """Získa skutočnú HODNOTU Edit poľa (nie AutomationId). Pouzi toto vzdy pre citanie textu z Edit kontrol."""
       for method in [lambda: ctrl.get_value(), lambda: ctrl.iface_value.CurrentValue,
                     lambda: ctrl.legacy_properties().get('Value', ''), lambda: ctrl.texts()[0] if ctrl.texts() else '']:
           try:
               val = method()
               if val and val.strip() and not val.startswith('AID_'): return val.strip()
           except: pass
       return ctrl.window_text().strip()  # fallback

   def get_text_of(container, label_text, timeout=2):
       """Nájde hodnotu Edit poľa vedľa labelu. Používa get_edit_value() pre správne čítanie (nie AutomationId)."""
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
       """Klikne na top-level menu položku. Skúsá MenuBar.children() ako prvý prístup (spoľahlivé pre WinForms MDI)."""
       import re as _re
       deadline = time.time() + timeout
       while time.time() < deadline:
           # Prístup 1: MenuBar → children (najspoľahlivé pre WinForms MDI)
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
           # Prístup 2: child_window s title_re
           try:
               win.child_window(title_re=f'.*{_re.escape(text)}.*', control_type='MenuItem').click_input()
               log(f'Kliknuté top-menu (MenuItem title_re): "{text}"')
               return
           except: pass
           # Prístup 3: descendants fallback
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
       # Debug: log dostupné menu položky
       try:
           items = []
           for mb in win.descendants(control_type='MenuBar'):
               items.extend([c.window_text() for c in mb.children() if c.window_text().strip()])
           log(f'DEBUG MenuBar items: {items}')
       except: pass
       raise Exception(f'Top-menu "{text}" nebolo nájdené po {timeout}s')

7. Navigácia cez menu — POVINNÉ PRAVIDLÁ:
   # Top-level menu (napr. Hlavné, Evidencie): VZDY použi click_top_menu()
   # NIKDY nepouzi win.child_window(title='...', control_type='MenuItem').click_input() -- nespol'ahlive!
   click_top_menu(win, 'NazovMenu')
   time.sleep(0.7)
   # Submenu položky: click_by_text
   click_by_text(win, 'NazovSubmenu')
   time.sleep(0.5)

8. KRITICKٰ PRAVIDLO pre WinForms MDI aplikácie (ako IAM):
   """
   Co vyzerá ako 'dialóg' NIE JE samostatné okno! Je to Panel/Group/Pane vnořený
   v hlavnom MDI okne. NIKDY nepiš: app.window(title='Dialóg...') — to nenajde nič.
   VŽDY hľadaj v potomkoch hlaveého okna: win.child_window(...) alebo win.descendants()
   """
   # Správny sposób hľadania obsahu 'dialógu':
   time.sleep(1.0)  # počkaj kym sa obsah zobrazi
   # Skús nájst kontajner podľa názvu (Group, Pane, Custom):
   panel = None
   for ct in ['Group', 'Pane', 'Custom', 'Document']:
       try:
           panel = win.child_window(title_re='.*NazovDialogu.*', control_type=ct)
           panel.wait('visible', timeout=3)
           break
       except: panel = None
   container = panel if panel else win  # ak nenajdes panel, hľadáj priamo v win

   # Čítanie hodnoty polía (VŽDY cez get_edit_value, nie window_text!):
   val = get_text_of(container, 'NazovLabelu')  # get_text_of interné volaní get_edit_value()
   log(f'Hodnota: "{val}"')

   # Overenie (assert):
   assert val and 'OčakávanáHodnota' in val, f'Očakával som \'OčakávanáHodnota\' ale získal \'{val}\''

9. KROKOVÉ SCREENSHOTY — KRITICKÉ: Po každom úspešnom kroku (klik, navigácia, otvorenie panelu) MUSÍŠ volať step_screenshot(). Pridaj helper hneď po click_by_text definícii:
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
   
   Príklady povinného použitia:
   click_top_menu(win, 'Evidencie')
   step_screenshot('po_klik_evidencie')         # VŽDY hneď po kliku na menu
   click_by_text(win, 'Osoby')
   step_screenshot('po_klik_osoby')              # pred ďalším krokom
   panel = win.child_window(...); panel.wait('visible', timeout=5)
   step_screenshot('panel_otvoreny', container=panel)

10. Povinná štruktúra skriptu:
    try:
        log('Test started')
        # ... kroky testu s step_screenshot() po každom kliku/akcii ...
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
`
                : `
          Si expert na QA a Playwright. Podľa tohto test scenára vytvor Playwright JavaScript kód:
        
          ${testScenario}
          ${loginCredentials}
        
          Test pôjde na adresu '${config.appUrl}'.
        
          DÔLEŽITÉ POŽIADAVKY:
          0. SELEKTORY — PRIORITNÉ PORADIE (KRITICKÉ, vždy dodržuj):
             1. PRVÁ VOĽBA — data-testid: page.getByTestId('nazov-elementu') alebo page.locator('[data-testid="nazov-elementu"]')
                → Toto je najstabilnejší selektor, VŽDY ho použi ak element má data-testid atribút.
                → Príklady: page.getByTestId('login-button'), page.locator('[data-testid="search-input"]').fill(...)
             2. DRUHÁ VOĽBA — getByRole + name: page.getByRole('button', {name: /text/i})
             3. TRETIA VOĽBA — getByLabel / getByPlaceholder pre inputy
             4. ŠTVRTÁ VOĽBA — CSS selektor s ID (#id) alebo unikátnou triedou
             5. POSLEDNÁ VOĽBA — text selektor alebo XPath
             NIKDY nepoužívaj len triedový selektor ako .btn alebo div.some-class ak existuje data-testid.
          ${domTestIds ? `0b. DOSTUPNÉ data-testid HODNOTY V TEJTO APLIKÁCII (použi ich PREDNOSTNE):
\`\`\`
${domTestIds}
\`\`\`
             → Tieto hodnoty sú extrahované priamo z DOM aplikácie. Ak hľadáš element, skontroluj tento zoznam NAJPRV.
             → Použi page.getByTestId('hodnota') alebo page.locator('[data-testid="hodnota"]').
` : ''}
          1. Browser launch: const browser = await chromium.launch({ headless: ${config.headlessMode}, slowMo: ${config.slowMo} });
          2. Po launchi vytvor context s veľkým viewportom: const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } }); const page = await context.newPage();
          3. Obal CEĽÝ test do try-catch bloku
          4. V catch bloku:
              - Ulož screenshot: await page.screenshot({ path: 'error_screenshot.png', fullPage: true });
              - Vyprintuj chybu: console.error('TEST FAILED:', error.message);
              - Vyprintuj URL: console.error('Current URL:', page.url());
          5. Bezprostredne po vytvorení 'page' zavolaj 'await attachDiagnostics(page);' aby sa zachytili sieťové volania, console logy a DOM snapshot. Pomenuj súbory: 'network.json', 'console_logs.json', 'dom.html'.
          6. Na konci (v try bloku) ulož úspešný screenshot: await page.screenshot({ path: 'success_screenshot.png', fullPage: true });
          6b. KROKOVÉ SCREENSHOTY — KRITICKÉ: Po každej akcii (klik, navigácia, submit) volaj stepShot(). Pridaj helper HNEĎ za 'await attachDiagnostics(page)':
              const _sfs = require('fs'); let _sc = 0;
              async function stepShot(pg, name = '') { _sc++; if (!_sfs.existsSync('steps')) _sfs.mkdirSync('steps', {recursive: true}); const n = 'steps/step_' + String(_sc).padStart(2,'0') + (name ? '_'+name.replace(/\s+/g,'_').replace(/[^a-zA-Z0-9_]/g,'').substring(0,30) : '') + '.png'; try { await pg.screenshot({ path: n, fullPage: true }); } catch(e) {} }
              Príklady povinného použitia:
              await page.locator('.tab a:has-text("Evidencia")').click();
              await stepShot(page, 'po_klik_evidencia');   // VŽDY hneď po kliku
              await page.getByRole('button', {name: /vyhľadať/i}).click();
              await stepShot(page, 'po_vyhladavani');
          7. V finally bloku zatvor browser: await browser.close();
          8. KRITICKÉ - SPA/AJAX ČAKANIE: Aplikácia je SPA (Blazor). Tlačidlá spúšťajú AJAX - stránka sa NENAVIGÁVA.
              ZAKAŽANÉ metody (vždy timeoutujú v Blazor SPA):
                 await page.waitForLoadState(...)  ← NIKDY, ani 'networkidle', ani 'load'
                 await page.waitForNavigation(...)  ← NIKDY
              POVOLENÉ metódy pre čakanie po AJAX akcii - použi JEDNO z:
                 await page.waitForResponse(resp => resp.url().includes('/api/') && resp.status() === 200, { timeout: 15000 });
                 await page.locator('SPECIFICKY_SELEKTOR').first().waitFor({ state: 'attached', timeout: 15000 });
                 await page.waitForFunction(() => document.querySelectorAll('SELEKTOR').length > 0, { timeout: 15000 });
              UPOZORNENIE pre waitForSelector a locator.waitFor:
                 - NIKDY nepoužívaj state:'visible' na selektory ktoré matchujú veľa elementov (napr. 'table tbody tr')
                 - Ak selektor môže matchovať viac elementov, vždy použi .first() alebo .nth(0)
                 - Bezpečný vzor: await page.locator('table tbody tr').first().waitFor({ state: 'attached', timeout: 15000 });
              waitForLoadState je povolené LEN hneď po page.goto().

          9. KOMPLETNÝ KÓD — KRITICKÉ: Každý krok scenára MUSÍ mať reálny fungujúci kód. NIKDY nevytváraj placeholder komentáre ako "(implementácia...)" alebo "(TODO)". Ak nevieš presný selektor, použi fallback (skúšaj viacero možností v try/catch).

          ${projectOverview ? `10. POVINNÉ SELEKTORY z project_overview.md (MUSÍŠ POUŽÍVAŤ TIETO — nie vymýšľaj vlastné):
             - Záložka/tab: page.locator('li.tab a:has-text("NazovZalozky")').click() alebo page.locator('.tab').filter({hasText:'NazovZalozky'}).click()
             - Filter input: nájdi label → for="ID" atribút → page.locator('#ID').fill(hodnota) alebo page.locator('label').filter({hasText:'NazovFiltra'}).locator('..').locator('input').fill(hodnota)
             - Dropdown: page.locator('label:has-text("NazovDropdown")').locator('..').locator('div.dtc-dropdown-trigger').click(), potom page.locator('input.dtc-dropdown-filter.dtc-inputtext:visible').fill(hodnota), potom page.getByTitle(hodnota).click()
             - Detail ikona: page.locator('.v-icon-detail').first().click() alebo page.locator('[class*="icon"][class*="detail"]').first().click()
             - Vyhľadať záznamy: page.getByRole('button', {name: /vyhľadať záznamy/i}).click() alebo page.locator('button:has-text("Vyhľadať záznamy")').click()
             - Počet záznamov: (await page.locator('text=/\\d+ záznamov/').first().textContent()) || ''
` : ''}
          ${memoryContext ? `11. PAMÄŤ Z PREDCHÁDZAJÚCICH TESTOV (uč sa z týchto chýb — KRITICKÉ):
${memoryContext}
` : ''}
          ${testHealingContext ? `12. HEALING CONTEXT PRE TENTO BUG (neopakuj tieto chyby):
${testHealingContext}
` : ''}
          ${projectHealingLessons ? `13. PROJEKTOVÉ LESSONS (krížové chyby z iných bugov):
${projectHealingLessons.substring(0, 4000)}
` : ''}
          Vráť IBA a LEN kód, žiadne vysvetľovanie, žiadny markdown naokolo.
          `;

        const messages = [vscode.LanguageModelChatMessage.User(prompt)];
        const chatResponse = await model.sendRequest(messages, {}, token);
        
        let generatedCode = '';
        for await (const chunk of chatResponse.text) {
            generatedCode += chunk;
        }

        generatedCode = generatedCode.replace(/```(python|javascript|typescript)?/g, '').trim();

        if (!workspaceFolders) {
            response.markdown(`*Chyba: Nemáš otvorený žiadny projekt.*`);
            return;
        }
        
        // Vytvorenie štruktúrovaného priečinku s postupným číslovaním
        let testFolderName: string;
        if (bugId) {
            testFolderName = `bug_${bugId}`;
        } else {
            const nextNumber = getNextBugNumber(workspacePath);
            testFolderName = `bug_${nextNumber.toString().padStart(3, '0')}`;
        }
        const testDir = path.join(workspacePath, 'autotest', testFolderName);
        
        const autotestDirExists = fs.existsSync(path.join(workspacePath, 'autotest'));
        
        if (!autotestDirExists) {
            fs.mkdirSync(path.join(workspacePath, 'autotest'));
            // Pri prvom vytvorení autotest/ pridaj do .gitignore
            ensureGitignore(workspacePath);
            response.markdown(`📝 *.gitignore* updatovaný - *autotest/* bude ignorovaný Gitom.\n\n`);
        }
        
        if (!fs.existsSync(testDir)) {
            fs.mkdirSync(testDir, { recursive: true });
        }

        // Uloženie test scenára
        const scenarioPath = path.join(testDir, 'test_scenario.md');
        fs.writeFileSync(scenarioPath, testScenario);
        
                // Embed project overview into generated test so it's self-contained (len pre JS/Playwright)
                if (!isPywinautoBackend && projectOverview && projectOverview.trim().length > 0) {
                        const header = '/* Project overview:\n' + projectOverview.split('\n').map((l: string) => ' * ' + l).join('\n') + '\n */\n\n';
                        generatedCode = header + generatedCode;
                }

                // Prepend diagnostics helper so generated tests can attach network/console/DOM listeners (len pre JS/Playwright)
                if (!isPywinautoBackend) {
                const diagnosticsHelper = `
// Autogenerated diagnostics helper - attach to Playwright page as: await attachDiagnostics(page)
async function attachDiagnostics(page) {
    const _fs = require('fs');
    const _path = require('path');
    try {
        const network = [];
        page.on('request', request => {
            try { network.push({ type: 'request', url: request.url(), method: request.method(), headers: request.headers(), postData: request.postData() }); } catch(e) {}
        });
        page.on('response', async response => {
            try { const body = await response.text().catch(()=>null); network.push({ type: 'response', url: response.url(), status: response.status(), headers: response.headers(), body }); } catch(e) {}
        });
        const consoleLogs = [];
        page.on('console', msg => { try { consoleLogs.push({type: 'console', text: msg.text(), location: msg.location ? msg.location() : null}); } catch(e) {} });
        page.on('pageerror', err => { try { consoleLogs.push({type:'pageerror', message: String(err)}); } catch(e) {} });

        page.saveDiagnostics = async function(dir) {
            try {
                if (!_fs.existsSync(dir)) _fs.mkdirSync(dir, { recursive: true });
                _fs.writeFileSync(_path.join(dir,'network.json'), JSON.stringify(network, null, 2));
                _fs.writeFileSync(_path.join(dir,'console_logs.json'), JSON.stringify(consoleLogs, null, 2));
                try { const html = await page.content(); _fs.writeFileSync(_path.join(dir,'dom.html'), html); } catch(e) {}
            } catch(e) {
                // ignore
            }
        };
    } catch(e) {
        // ignore
    }
}
\n`;

                generatedCode = diagnosticsHelper + generatedCode;
                }

        // Uloženie test scriptu
        const testFileExtension = isPywinautoBackend ? '.py' : '.js';
        const testFilePath = path.join(testDir, 'test.spec' + testFileExtension);
        fs.writeFileSync(testFilePath, generatedCode, 'utf-8');
        
        response.markdown(`✅ **Test bol vygenerovaný a uložený!**\n\n`);
        response.markdown(`📁 **Umiestnenie:** \`autotest/${testFolderName}/\`\n\n`);
        response.markdown(`- 📝 \`test_scenario.md\` - Test scenár (kroky)\n`);
        response.markdown(`- 📦 \`test.spec${testFileExtension}\` - ${isPywinautoBackend ? 'Python pywinauto script' : 'Playwright script'}\n\n`);
        
        // Skontrolovať a nainštalovať runtime závislosti podľa appType
        let runtimeReady = true;
        let pythonExe = '';
        if (isPywinautoBackend) {
            const [pyExe, pyOk] = await ensurePywinautoInstalled(response);
            pythonExe = pyExe;
            runtimeReady = pyOk;
        } else {
            runtimeReady = await ensurePlaywrightInstalled(workspacePath, response);
        }
        
        if (!runtimeReady) {
            response.markdown(`❌ **Nemôžem pokračovať bez potrebných závislostí pre ${isPywinautoBackend ? 'Python pywinauto' : 'web (Playwright)'} test.**\n\n`);
            return;
        }
        
        // 2. Spustenie testu
        response.markdown(`🚀 **Spúšťam test...**\n\n`);
        
        try {
            const testCommand = isPywinautoBackend
                ? `"${pythonExe}" test.spec.py`
                : `node test.spec.js`;
            
            const { stdout, stderr } = await execAsync(testCommand, {
                cwd: testDir,
                timeout: 120000
            });
            
            if (stderr) {
                response.markdown(`⚠️ Console output:\n\`\`\`\n${stderr.substring(0, 500)}\n\`\`\`\n\n`);
            }
            
            response.markdown(`✅ **Test dokončený!**\n\n`);
            
            // Skontrolovať úspešný screenshot
            const successScreenshotPath = path.join(testDir, 'success_screenshot.png');
            const errorScreenshotPath = path.join(testDir, 'error_screenshot.png');
            const notFoundScreenshotPath = path.join(testDir, 'not_found_screenshot.png');
            const notFoundInfoPath = path.join(testDir, 'not_found_info.json');
            const testResultPath = path.join(testDir, 'test_result.md');

            // Priorita: not_found_screenshot (element nenájdený) > error_screenshot
            const analysisScreenshotPath = fs.existsSync(notFoundScreenshotPath) ? notFoundScreenshotPath : errorScreenshotPath;
            const analysisScreenshotLabel = fs.existsSync(notFoundScreenshotPath) ? 'not_found_screenshot.png' : 'error_screenshot.png';
            let notFoundInfo: { searching_for?: string } = {};
            if (fs.existsSync(notFoundInfoPath)) {
                try { notFoundInfo = JSON.parse(fs.readFileSync(notFoundInfoPath, 'utf-8')); } catch {}
            }
            
            if (fs.existsSync(analysisScreenshotPath)) {
                response.markdown(`⚠️ **Test zlyhala pred dokončením!**\n\n`);
                if (notFoundInfo.searching_for) {
                    response.markdown(`🔍 Element **"${notFoundInfo.searching_for}"** nebol nájdený v UI.\n\n`);
                }
                response.markdown(`📸 Screenshot zachytený v momente zlyhania: \`${testFolderName}/${analysisScreenshotLabel}\`\n\n`);
                // Krokové screenshoty
                const _stepsDir = path.join(testDir, 'steps');
                if (fs.existsSync(_stepsDir)) {
                    const _stepFiles = fs.readdirSync(_stepsDir).filter((f: string) => f.endsWith('.png')).sort();
                    if (_stepFiles.length > 0) {
                        response.markdown(`📷 **Krokové screenshoty (${_stepFiles.length} krokov):** ${_stepFiles.map((f: string) => `\`${testFolderName}/steps/${f}\``).join(', ')}\n\n`);
                    }
                }
                
                // Vizuálna analýza error screenshotu
                response.markdown(`👁️ **Analýzujem čo sa pokazilo...**\n\n`);

                const visionModel = await selectAIModel(context, 'vision');
                if (!visionModel) {
                    response.markdown(`*Chyba: Nenašiel sa vision model na analýzu screenshotu.*\n\n`);
                    return;
                }
                response.markdown(`👁️ Vision model: **${visionModel.name || visionModel.id}**\n\n`);
                
                const errorScreenshotBuffer = fs.readFileSync(analysisScreenshotPath);
                const errorScreenshotBase64 = errorScreenshotBuffer.toString('base64');
                
                const errorAnalysisPrompt = notFoundInfo.searching_for
                    ? `Tu je screenshot Windows desktop aplikácie. Test sa pokúšal nájsť element "${notFoundInfo.searching_for}" ale nepodarilo sa.

Pôvodný test scenár:
${testScenario}

Chyba z console:
${stderr}

DÔLEŽITÉ: Aplikácia sa testuje cez Python pywinauto (nie C#, nie FlaUI, nie WinAppDriver). Všetky navrhované opravy MUSIA byť v Python pywinauto syntaxi.

Na screenshote je vidieť aktuálny stav UI. Analýzuj a povedz:
1. Čo vidíš na obrazovke (všetky viditeľné menu položky, tlačidlá, polia)?
2. Kde sa pravdepodobne nachádza element "${notFoundInfo.searching_for}"? (v akom menu, pod akým názvom?)
3. Aký PRESNÝ text má daný element v UI (môže sa líšiť od test scenára)?
4. Konkrétny návrh opravy v Python pywinauto syntaxi, napr: click_by_text(win, 'SKUTOCNY_TEXT') alebo win.child_window(title='...', control_type='MenuItem').click_input()`
                    : `Tu je screenshot v momente ked test zlyhala.

Pôvodný test scenár:
${testScenario}

Chyba z console:
${stderr}

DÔLEŽITÉ: Aplikácia sa testuje cez Python pywinauto. Všetky navrhované opravy MUSIA byť v Python pywinauto syntaxi (nie C#, nie FlaUI).

Analýzuj screenshot a povedz:
1. Na akom kroku test zlyhala?
2. Čo sa na obrazovke nachádza?
3. Prečo pravdepodobne test neprebehol?
4. Aké elementy sú viditeľné?
5. Návrh konkrétnej opravy v Python pywinauto syntaxi.`;
                
                const errorVisionMessages = [
                    vscode.LanguageModelChatMessage.User([
                        new vscode.LanguageModelTextPart(errorAnalysisPrompt),
                        vscode.LanguageModelDataPart.image(
                            Buffer.from(errorScreenshotBase64, 'base64'),
                            'image/png'
                        )
                    ])
                ];

                let errorAnalysis = '';
                try {
                    const errorVisionResponse = await visionModel.sendRequest(errorVisionMessages, {}, token);
                    for await (const chunk of errorVisionResponse.text) {
                        errorAnalysis += chunk;
                    }
                } catch (visionErr: any) {
                    throw visionErr; // let outer handler fallback later
                }
                
                response.markdown(`### 🔍 Analýza zlyhania:\n\n${errorAnalysis}\n\n`);
                
                // Vytvor test_result.md pre chyby
                const errorResultContent = `# Test Result: FAILED ❌

## Test Info
- **Bug ID:** ${bugId || 'N/A'}
- **Timestamp:** ${new Date().toLocaleString('sk-SK')}
- **Status:** FAILED

## Problém
${errorAnalysis}

## Console Output
\`\`\`
${stderr || 'Žiadny stderr output'}
\`\`\`

## Ďalšie kroky
1. Otvor \`test_scenario.md\` a uprav kroky podľa analýzy vyššie
2. Spusti: \`@autotest regenerate ${testFolderName}\`
3. Sleduj browser v headed mode (\`@autotest debug\`)

## Screenshots
- Error screenshot: \`error_screenshot.png\`
`;
                fs.writeFileSync(testResultPath, errorResultContent);
                saveHealingContext(
                    workspacePath,
                    testFolderName,
                    testScenario,
                    errorAnalysis,
                    stderr || 'Žiadny stderr output',
                    'runAutomatedTest:error_screenshot',
                    notFoundInfo.searching_for
                );
                
                response.markdown(`---\n\n`);
                response.markdown(`🛠️ **Ako opraviť:**\n`);
                response.markdown(`1. Otvor súbor: \`autotest/${testFolderName}/test_scenario.md\`\n`);
                response.markdown(`2. Uprav kroky podľa analýzy vyššie\n`);
                response.markdown(`3. Spusti: \`@autotest regenerate ${testFolderName}\`\n\n`);
                response.markdown(`📄 Detail report: \`autotest/${testFolderName}/test_result.md\`\n\n`);
                
                // Aktualizuj pamäť - zaznamenaj zlyhané stratégie
                if (automationMemory) {
                    try {
                        const logsPath = path.join(testDir, 'console_logs.json');
                        const strategyRecords = parseStrategyLogsFromFile(logsPath);
                        for (const rec of strategyRecords) {
                            automationMemory.recordResult(rec.elementType, rec.elementName, rec.strategyName, rec.result);
                        }
                        // Konkrétna note: ak vieme čo sa hľadá, uloz spêcificku info
                        if (notFoundInfo.searching_for) {
                            const visionSummary = errorAnalysis.split('\n').find(l => l.trim().length > 20 && !l.startsWith('#')) || errorAnalysis.substring(0, 100);
                            automationMemory.addNote(`[not_found] '${notFoundInfo.searching_for}' → vision: ${visionSummary.substring(0, 120)}`);
                        } else {
                            automationMemory.addNote(`Test ${testFolderName} FAILED — ${stderr?.split('\n')[0]?.substring(0, 80) || 'unknown error'}`);
                        }
                    } catch {}
                }

                await saveBugHistory(context, {
                    bugId,
                    description: bugDescription,
                    timestamp: new Date().toISOString(),
                    testResult: 'failed'
                });
                return;
            }
            
            if (!fs.existsSync(successScreenshotPath)) {
                response.markdown(`❌ *Screenshot sa nenašiel. Test mohol zlyhať.*\n\n`);
                
                saveHealingContext(
                    workspacePath,
                    testFolderName,
                    testScenario,
                    'Test nevyprodukoval success screenshot.',
                    stderr || 'Žiadny stderr output',
                    'runAutomatedTest:missing_success_screenshot'
                );
                // Uložiť do histórie ako failed
                await saveBugHistory(context, {
                    bugId,
                    description: bugDescription,
                    timestamp: new Date().toISOString(),
                    testResult: 'failed'
                });
                return;
            }
            
            response.markdown(`📸 Screenshot úspešne vytvorený!\n\n`);
            
            // 3. Vizuálna kontrola pomocou Copilot Vision API
            response.markdown(`👁️ **Analyzujem výsledok testu...**\n\n`);
            
            const screenshotBuffer = fs.readFileSync(successScreenshotPath);
            const screenshotBase64 = screenshotBuffer.toString('base64');
            
            const visionPrompt = `Tu je screenshot aplikácie po dokončení testu. 

Test scenár bol:
${testScenario}

Pôvodný bug: "${bugDescription}"
            
Skontroluj screenshot a zhodnoť:
1. Či test prebehol správne až do konca
2. Či je viditeľná očakávaná funkcia alebo výsledok
3. Či aplikácia vyzerá správne
4. Či je bug opravený alebo či test case prešiel úspešne

Odpovedz prehľadne a stručne.`;
            
            // Použij vision model na analýzu screenshotu
            const visionModelForSuccess = await selectAIModel(context, 'vision');
            if (!visionModelForSuccess) {
                response.markdown(`*Chyba: Nenašiel sa vision model na analýzu screenshotu.*\n\n`);
                return;
            }
            response.markdown(`👁️ **Vizuálna analýza pomocou ${visionModelForSuccess.name || visionModelForSuccess.id}...**\n\n`);

            const visionMessages = [
                vscode.LanguageModelChatMessage.User([
                    new vscode.LanguageModelTextPart(visionPrompt),
                    vscode.LanguageModelDataPart.image(
                        Buffer.from(screenshotBase64, 'base64'),
                        'image/png'
                    )
                ])
            ];

            let analysisResult = '';
            try {
                const visionResponse = await visionModelForSuccess.sendRequest(visionMessages, {}, token);
                for await (const chunk of visionResponse.text) {
                    analysisResult += chunk;
                }
            } catch (visionErr: any) {
                throw visionErr; // let outer fallback handler manage it
            }
            
            response.markdown(`### 🔍 Výsledok analýzy:\n\n${analysisResult}\n\n`);
            
            // Vytvor test_result.md pre úspešný test
            const successResultContent = `# Test Result: PASSED ✅

## Test Info
- **Bug ID:** ${bugId || 'N/A'}
- **Bug Description:** ${bugDescription}
- **Timestamp:** ${new Date().toLocaleString('sk-SK')}
- **Status:** PASSED

## Test Scenár
${testScenario}

## AI Vision Analysis
${analysisResult}

## Console Output
\`\`\`
${stderr || stdout || 'Test dokončený bez chýb'}
\`\`\`

## Výsledok
Test prebehol úspešne. Všetky kroky boli vykonané bez chýb.

## Screenshots
- Success screenshot: \`success_screenshot.png\`

## Odporúčanie
✅ Bug je pravdepodobne fixed. Môžeš pokračovať s commit & push.
`;
            fs.writeFileSync(testResultPath, successResultContent);
            clearHealingContext(workspacePath, testFolderName);
            
            response.markdown(`📄 Detail report: \`autotest/${testFolderName}/test_result.md\`\n\n`);
            
            // Aktualizuj UI Automation pamäť zo záznamov testu
            if (automationMemory) {
                try {
                    const logsPath = path.join(testDir, 'console_logs.json');
                    const strategyRecords = parseStrategyLogsFromFile(logsPath);
                    for (const rec of strategyRecords) {
                        automationMemory.recordResult(rec.elementType, rec.elementName, rec.strategyName, rec.result);
                    }
                    // Vždy zaznamenaj PASSED - aby ďalšie testy vedeli že daný prístup fungoval
                    const passNote = strategyRecords.length > 0
                        ? `Test ${testFolderName} PASSED - zaznamenané ${strategyRecords.length} stratégií`
                        : `Test ${testFolderName} PASSED - prístup v teste fungoval`;
                    automationMemory.addNote(passNote);
                } catch {}
            }

            // Uložiť do histórie ako success
            await saveBugHistory(context, {
                bugId,
                description: bugDescription,
                timestamp: new Date().toISOString(),
                testResult: 'success'
            });
            
            // 4. Command Links
            response.markdown(`---\n\n### Čo chceš urobiť?\n\n`);
            
            response.button({
                command: 'autotest.cleanup',
                title: '✅ Som spokojný - Zmazať screenshoty a Pushnúť na Git',
                arguments: [workspacePath, testFolderName]
            });
            
            response.button({
                command: 'autotest.keepScreenshots',
                title: '❌ Neúspešné - Ponechať screenshoty',
                arguments: []
            });
            
        } catch (execError: any) {
            const errDetail = [execError.stderr, execError.stdout].filter(Boolean).join('\n').trim() || execError.message;
            response.markdown(`❌ **Chyba pri spustení:**\n\`\`\`\n${errDetail.substring(0, 3000)}\n\`\`\`\n\n`);
            response.markdown(`*Uisti sa, že máš nainštalovaný ${isPywinautoBackend ? 'Python a pywinauto' : 'Playwright a aplikáciu bežiacu na ' + config.appUrl}.*\n\n`);

            const errorScreenshotPath = path.join(testDir, 'error_screenshot.png');
            const notFoundScreenshotPath2 = path.join(testDir, 'not_found_screenshot.png');
            const notFoundInfoPath2 = path.join(testDir, 'not_found_info.json');
            const testResultPath = path.join(testDir, 'test_result.md');
            const analysisShot2 = fs.existsSync(notFoundScreenshotPath2) ? notFoundScreenshotPath2 : errorScreenshotPath;
            const analysisShotLabel2 = fs.existsSync(notFoundScreenshotPath2) ? 'not_found_screenshot.png' : 'error_screenshot.png';
            let notFoundInfo2: { searching_for?: string } = {};
            if (fs.existsSync(notFoundInfoPath2)) {
                try { notFoundInfo2 = JSON.parse(fs.readFileSync(notFoundInfoPath2, 'utf-8')); } catch {}
            }

            if (fs.existsSync(analysisShot2)) {
                if (notFoundInfo2.searching_for) {
                    response.markdown(`🔍 Element **"${notFoundInfo2.searching_for}"** nebol nájdený v UI.\n\n`);
                }
                response.markdown(`📸 Error screenshot nájdený: \`${testFolderName}/${analysisShotLabel2}\`\n\n`);

                try {
                    const errorScreenshotBuffer = fs.readFileSync(analysisShot2);
                    const errorScreenshotBase64 = errorScreenshotBuffer.toString('base64');

                    const errorAnalysisPrompt = notFoundInfo2.searching_for
                        ? `Tu je screenshot Windows desktop aplikácie. Test sa pokúšal nájsť element "${notFoundInfo2.searching_for}" ale nepodarilo sa.\n\nPôvodný test scenár:\n${testScenario}\n\nChyba zo spustenia:\n${execError.message}\n\nDÔLEŽITÉ: Aplikácia sa testuje cez Python pywinauto. Všetky opravy MUSIA byť v Python pywinauto syntaxi (nie C#, nie FlaUI).\n\nNa screenshote je vidieť aktuálny stav UI. Analýzuj a povedz:\n1. Čo vidíš na obrazovke (všetky viditeľné menu položky, tlačidlá, polia)?\n2. Kde sa pravdepodobne nachádza element "${notFoundInfo2.searching_for}"?\n3. Aký PRESNÝ text má daný element v UI?\n4. Konkrétny návrh opravy v Python pywinauto syntaxi (napr: click_by_text(win, 'SKUTOCNY_TEXT')).`
                        : `Tu je screenshot v momente ked test zlyhala.\n\nPôvodný test scenár:\n${testScenario}\n\nChyba zo spustenia:\n${execError.message}\n\nDÔLEŽITÉ: Aplikácia sa testuje cez Python pywinauto (ak desktop) alebo Playwright (ak web). Všetky opravy musia byť v správnej syntaxi.\n\nAnalýzuj screenshot a povedz:\n1. Na akom kroku test zlyhala?\n2. Čo sa na obrazovke nachádza?\n3. Prečo pravdepodobne test neprebehol?\n4. Aké elementy sú viditeľné?\n5. Návrh konkrétnej opravy.`;

                    const errorVisionMessages = [
                        vscode.LanguageModelChatMessage.User([
                            new vscode.LanguageModelTextPart(errorAnalysisPrompt),
                            vscode.LanguageModelDataPart.image(
                                Buffer.from(errorScreenshotBase64, 'base64'),
                                'image/png'
                            )
                        ])
                    ];

                    const errorVisionResponse = await model.sendRequest(errorVisionMessages, {}, token);
                    let errorAnalysis = '';
                    for await (const chunk of errorVisionResponse.text) {
                        errorAnalysis += chunk;
                    }

                    const errorResultContent = `# Test Result: FAILED ❌\n\n## Test Info\n- **Bug ID:** ${bugId || 'N/A'}\n- **Timestamp:** ${new Date().toLocaleString('sk-SK')}\n- **Status:** FAILED\n\n## Problém\n${errorAnalysis}\n\n## Console Output\n\`\`\`\n${execError.message || 'No error message'}\n\`\`\`\n\n## Screenshots\n- Error screenshot: \`error_screenshot.png\`\n`;

                    fs.writeFileSync(testResultPath, errorResultContent);
                    saveHealingContext(
                        workspacePath,
                        testFolderName,
                        testScenario,
                        errorAnalysis,
                        execError.message || 'No error message',
                        'runAutomatedTest:exec_catch',
                        notFoundInfo2.searching_for
                    );
                    response.markdown(`### 🔍 Analýza zlyhania:\n${errorAnalysis}\n\n`);

                    // ===== AUTO-HEALING: automaticky regeneruj a spusti znova (max 2 pokusy) =====
                    const autoHealEnabled = !errorAnalysis.toUpperCase().includes('VIZUÁLNE PASSED');
                    if (autoHealEnabled) {
                        for (let healAttempt = 1; healAttempt <= 2; healAttempt++) {
                            response.markdown(`🔄 **Auto-healing pokus ${healAttempt}/2** — regenerujem test na základe analýzy...\n\n`);
                            try {
                                const testFileExt = isPywinautoBackend ? '.py' : '.js';
                                const currentScript = fs.existsSync(path.join(testDir, 'test.spec' + testFileExt))
                                    ? fs.readFileSync(path.join(testDir, 'test.spec' + testFileExt), 'utf-8')
                                    : '';

                                const autoHealPrompt = isPywinautoBackend
                                    ? `Si expert na QA pre Windows desktop aplikácie (Python pywinauto).

Test zlyhal. Tu je analýza zlyhania:
${errorAnalysis}

${notFoundInfo2.searching_for ? `Element ktorý sa nepodarilo nájsť: "${notFoundInfo2.searching_for}"` : ''}

Pôvodný test scenár:
${testScenario}

Pôvodný skript (oprav len problematické miesta):
\`\`\`python
${currentScript.substring(0, 3000)}
\`\`\`

${memoryContext ? `UI AUTOMATION PAMÄŤ (použi tieto poznatky):\n${memoryContext}` : ''}

Vytvor OPRAVENÝ kompletný Python pywinauto skript. Použi analýzu vyššie na opravu konkrétneho problému.
Vráť IBA a LEN Python kód, žiadny markdown.`
                                    : `Si expert na QA a Playwright (JavaScript).

Test zlyhal. Tu je analýza zlyhania:
${errorAnalysis}

Pôvodný test scenár:
${testScenario}

Pôvodný skript (oprav len problematické miesta):
\`\`\`javascript
${currentScript.substring(0, 3000)}
\`\`\`

${memoryContext ? `PAMÄŤ Z PREDCHÁDZAJÚCICH TESTOV:\n${memoryContext}` : ''}
${projectOverview ? `PROJECT OVERVIEW (použi správne selektory):\n${projectOverview.substring(0, 1000)}` : ''}

Vytvor OPRAVENÝ kompletný Playwright JavaScript skript.
ZAKÁZANÉ: waitForLoadState okrem po goto, placeholder komentáre.
Vráť IBA a LEN kód, žiadny markdown.`;

                                const healMessages = [vscode.LanguageModelChatMessage.User(autoHealPrompt)];
                                const healResponse = await model.sendRequest(healMessages, {}, token);
                                let healedCode = '';
                                for await (const chunk of healResponse.text) { healedCode += chunk; }
                                healedCode = healedCode.replace(/```(python|javascript|js)?/g, '').trim();

                                if (!healedCode || healedCode.length < 50) { break; }

                                // Embed diagnostics helper pre web
                                if (!isPywinautoBackend) {
                                    const diagHelper = `// Autogenerated diagnostics helper\nasync function attachDiagnostics(page) {\n    const _fs = require('fs'); const _path = require('path');\n    try {\n        const network = []; const consoleLogs = [];\n        page.on('request', req => { try { network.push({ type:'request', url:req.url(), method:req.method() }); } catch(e) {} });\n        page.on('response', async res => { try { network.push({ type:'response', url:res.url(), status:res.status() }); } catch(e) {} });\n        page.on('console', msg => { try { consoleLogs.push({type:msg.type(), text:msg.text()}); } catch(e) {} });\n        page.saveDiagnostics = async function(dir) {\n            try { if (!_fs.existsSync(dir)) _fs.mkdirSync(dir,{recursive:true}); _fs.writeFileSync(_path.join(dir,'network.json'),JSON.stringify(network,null,2)); _fs.writeFileSync(_path.join(dir,'console_logs.json'),JSON.stringify(consoleLogs,null,2)); try { const html = await page.content(); _fs.writeFileSync(_path.join(dir,'dom.html'),html); } catch(e) {} } catch(e) {}\n        };\n    } catch(e) {}\n}\n\n`;
                                    healedCode = diagHelper + healedCode;
                                }

                                // Ulož a spusti opravený test
                                fs.writeFileSync(path.join(testDir, 'test.spec' + testFileExt), healedCode);
                                for (const f of ['success_screenshot.png', 'error_screenshot.png', 'not_found_screenshot.png', 'not_found_info.json']) {
                                    try { fs.unlinkSync(path.join(testDir, f)); } catch {}
                                }
                                const _healStepsDir = path.join(testDir, 'steps');
                                if (fs.existsSync(_healStepsDir)) { try { fs.readdirSync(_healStepsDir).forEach((f: string) => { try { fs.unlinkSync(path.join(_healStepsDir, f)); } catch {} }); fs.rmdirSync(_healStepsDir); } catch {} }

                                const pythonExeHeal = isPywinautoBackend ? (await findPythonExecutable() || 'python') : '';
                                const healCmd = isPywinautoBackend ? `"${pythonExeHeal}" test.spec.py` : `node test.spec.js`;
                                response.markdown(`▶️ Spúšťam opravený test...\n\n`);

                                try {
                                    const { stdout: hOut, stderr: hErr } = await execAsync(healCmd, { cwd: testDir, timeout: 120000 });
                                    const hOut2 = [hOut, hErr].filter(Boolean).join('\n').trim();
                                    if (hOut2) { response.markdown(`📋 Output:\n\`\`\`\n${hOut2.substring(0, 800)}\n\`\`\`\n\n`); }

                                    const healSuccessShot = path.join(testDir, 'success_screenshot.png');
                                    if (fs.existsSync(healSuccessShot)) {
                                        const autoHealResultContent = `# Test Result: PASSED ✅

## Test Info
- **Bug ID:** ${bugId || 'N/A'}
- **Bug Description:** ${bugDescription}
- **Timestamp:** ${new Date().toLocaleString('sk-SK')}
- **Status:** PASSED

## Výsledok
Test bol úspešne opravený cez auto-healing na pokuse ${healAttempt}.

## Auto-healing analýza
${errorAnalysis}

## Console Output (opravený pokus)
\`\`\`
${hOut2 || 'Žiadny output'}
\`\`\`

## Screenshots
- Success screenshot: \`success_screenshot.png\`
`;
                                        fs.writeFileSync(testResultPath, autoHealResultContent);
                                        response.markdown(`✅ **Auto-healing úspešný!** Test prešiel na pokuse ${healAttempt}.\n\n`);
                                        clearHealingContext(workspacePath, testFolderName);
                                        if (automationMemory) { try { automationMemory.addNote(`Test ${testFolderName} AUTO-HEALED po ${healAttempt} pokuse`); } catch {} }
                                        await saveBugHistory(context, { bugId, description: bugDescription, timestamp: new Date().toISOString(), testResult: 'success' });
                                        return;
                                    }
                                    response.markdown(`⚠️ Auto-healing pokus ${healAttempt} neúspešný, skúšam znova...\n\n`);
                                } catch (healErr: any) {
                                    const healErrDetail = [healErr.stderr, healErr.stdout].filter(Boolean).join('\n').trim() || healErr.message;
                                    response.markdown(`⚠️ Auto-healing pokus ${healAttempt} zlyhal: \`${healErrDetail.substring(0, 300)}\`\n\n`);
                                    if (healAttempt < 2) {
                                        // Aktualizuj errorAnalysis pre ďalší pokus
                                        const healErrShot = path.join(testDir, 'not_found_screenshot.png') || path.join(testDir, 'error_screenshot.png');
                                        if (fs.existsSync(healErrShot)) {
                                            const healVm = await selectAIModel(context, 'vision');
                                            if (healVm) {
                                                try {
                                                    const hBuf = fs.readFileSync(healErrShot);
                                                    const hMsgs = [vscode.LanguageModelChatMessage.User([new vscode.LanguageModelTextPart(`Čo vidíš na obrazovke? Stručná analýza (max 3 vety).`), vscode.LanguageModelDataPart.image(hBuf, 'image/png')])];
                                                    const hResp = await healVm.sendRequest(hMsgs, {}, token);
                                                    let newAnalysis = '';
                                                    for await (const c of hResp.text) { newAnalysis += c; }
                                                    // errorAnalysis sa preberie v ďalšom loop-e cez uzavretie
                                                } catch {}
                                            }
                                        }
                                    }
                                }
                            } catch (healSetupErr: any) {
                                response.markdown(`⚠️ Auto-healing setup chyba: ${healSetupErr.message}\n\n`);
                                break;
                            }
                        }
                        response.markdown(`🛠️ **Auto-healing vyčerpal pokusy.** Uprav \`autotest/${testFolderName}/test_scenario.md\` a spusti \`@autotest regenerate ${testFolderName}\`.\n\n`);
                    }
                    // ===== KONIEC AUTO-HEALING =====
                } catch (analysisErr: any) {
                    // If analysis fails, still write basic result file
                    const basicResult = `# Test Result: FAILED ❌\n\n## Error\n${execError.message}\n\n## Note\nError screenshot exists but analysis failed: ${analysisErr.message}`;
                    fs.writeFileSync(testResultPath, basicResult);
                    saveHealingContext(
                        workspacePath,
                        testFolderName,
                        testScenario,
                        `Analysis failed: ${analysisErr.message}`,
                        execError.message || 'unknown error',
                        'runAutomatedTest:analysis_failed'
                    );
                }

            } else {
                // No screenshot available, write simple failure report
                const basicResult = `# Test Result: FAILED ❌\n\n## Error\n${execError.message}\n\n## Note\nNo error screenshot was produced.`;
                fs.writeFileSync(testResultPath, basicResult);
                saveHealingContext(
                    workspacePath,
                    testFolderName,
                    testScenario,
                    'No error screenshot was produced.',
                    execError.message || 'unknown error',
                    'runAutomatedTest:no_error_screenshot'
                );
                response.markdown(`📄 Vytvorený report: \`autotest/${testFolderName}/test_result.md\`\n\n`);
            }

            // Uložiť do histórie ako failed
            if (automationMemory) {
                try {
                    const logsPath = path.join(testDir, 'console_logs.json');
                    const strategyRecords = parseStrategyLogsFromFile(logsPath);
                    for (const rec of strategyRecords) {
                        automationMemory.recordResult(rec.elementType, rec.elementName, rec.strategyName, rec.result);
                    }
                    automationMemory.addNote(`Test ${testFolderName} EXEC_ERROR - ${execError.message?.substring(0, 120) || 'unknown'}`);
                } catch {}
            }
            await saveBugHistory(context, {
                bugId,
                description: bugDescription,
                timestamp: new Date().toISOString(),
                testResult: 'failed'
            });
        }
        
    } catch (err: any) {
        response.markdown(`*Chyba pri komunikácii s AI: ${err.message}*`);
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
    const config = loadConfiguration(context);
    
    // Inicializovať TFS client ak je enabled
    if (config.tfsEnabled && config.tfsOrganization && config.tfsProject) {
        getTfsPat(context).then(async (pat) => {
            if (pat) {
                try {
                    tfsClient = new TfsClient();
                    await tfsClient.connect(config.tfsOrganization!, config.tfsProject!, pat);
                } catch (error) {
                    console.error('TFS client initialization failed:', error);
                }
            }
        });
    }

    const autotestAgent = vscode.chat.createChatParticipant('autotest.agent', async (request, contextObj, response, token) => {
        
        const userQuery = request.prompt.trim().toLowerCase(); 
        const config = loadConfiguration(context);

        response.markdown(`Ahoj! Som tvoj Autotest Agent. 🤖\n\n`);
        
        // ===== PRÍKAZ: @autotest init =====
        if (userQuery.includes('init')) {
            response.markdown(`🔧 **Spúšťam inicializáciu...**\n\n`);
            await runInitializationSetup(context);
            return;
        }
        
        // ===== PRÍKAZ: @autotest select-model alebo model =====
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
            response.markdown(`🐛 **Debug mód...**\n\n`);
            
            const debugChoice = await vscode.window.showQuickPick(
                [
                    { 
                        label: '👁️ Viditeľný browser (Headed)', 
                        value: 'visible',
                        description: 'Vidíš čo test robí - vhodné pre debugging',
                        detail: 'headless: false, slowMo: 100ms'
                    },
                    { 
                        label: '⚡ Rýchly neviditeľný (Headless)', 
                        value: 'fast',
                        description: 'Štandardný rýchly mód bez UI',
                        detail: 'headless: true, slowMo: 0ms'
                    },
                    { 
                        label: '🎬 Pomalý viditeľný (Debug)', 
                        value: 'slow',
                        description: 'Veľmi pomalé vykonávanie pre sledovanie každej akcie',
                        detail: 'headless: false, slowMo: 500ms'
                    }
                ],
                { 
                    placeHolder: 'Vyber mód testovania:',
                    ignoreFocusOut: true
                }
            );

            if (debugChoice?.value === 'visible') {
                await saveDebugConfig(context, { headless: false, slowMo: 100 });
                response.markdown(`✅ **Viditeľný browser zapnutý!** (slowMo: 100ms)\n\n`);
                response.markdown(`*Pri ďalšom teste uvidíš browser okno a akcie budú pomalšie pre lepšiu viditeľnosť.*\n\n`);
            } else if (debugChoice?.value === 'fast') {
                await saveDebugConfig(context, { headless: true, slowMo: 0 });
                response.markdown(`✅ **Headless mód zapnutý!** (rýchly)\n\n`);
                response.markdown(`*Test bude bežať na pozadí bez viditeľného browsera.*\n\n`);
            } else if (debugChoice?.value === 'slow') {
                await saveDebugConfig(context, { headless: false, slowMo: 500 });
                response.markdown(`✅ **Pomalý debug mód zapnutý!** (slowMo: 500ms)\n\n`);
                response.markdown(`*Každá akcia bude trvať 0.5s - ideálne na sledovanie čo sa deje.*\n\n`);
            }
            
            return;
        }
        
        // ===== PRÍKAZ: @autotest record =====
        if (userQuery.includes('record') || userQuery.includes('nahraj') || userQuery.includes('nahrávaj')) {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                response.markdown(`❌ Nie je otvorený žiadny projekt.\n\n`); return;
            }
            const workspacePath = workspaceFolders[0].uri.fsPath;
            const config = loadConfiguration(context);

            // Zisti folder name z príkazu (napr. record bug_002)
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

            const isDesktopMode = config.appType === 'desktop';

            if (!isDesktopMode) {
                // ===== WEB: Playwright Codegen =====
                response.markdown(`🎬 **Playwright Codegen pre ${recFolderName}**\n\n`);
                response.markdown(`Otvorí sa browser s rekordérom. Klikaj v aplikácii, kód sa generuje živý.\nKeď skončíš, **zatvor browser** — skript sa automaticky uloží.\n\n`);
                const recOutputFile = path.join(recTestDir, 'recorded_script.js');
                const recCmd = `npx playwright codegen --output "${recOutputFile}" "${config.appUrl}"`;
                response.markdown(`▶️ Spúšťam: \`${recCmd}\`\n\n`);
                try {
                    // Spusti v novom termináli (blocking — čaká kým user zatvorí browser)
                    await execAsync(recCmd, { cwd: workspacePath, timeout: 600000 });
                    if (fs.existsSync(recOutputFile)) {
                        const recCode = fs.readFileSync(recOutputFile, 'utf-8');
                        response.markdown(`✅ **Nahrávanie dokončené!** Skript uložený: \`autotest/${recFolderName}/recorded_script.js\`\n\n`);
                        // Generuj čistý test zo záznamu cez AI
                        response.markdown(`🤖 **Generujem finálny test zo záznamu...**\n\n`);
                        const recModel = await selectAIModel(context, 'code');
                        if (recModel) {
                            const recPrompt = `Toto je Playwright skript nahraný cez codegen:\n\`\`\`javascript\n${recCode.substring(0, 4000)}\n\`\`\`\n\nUprav ho do štandardného formátu s:\n- chromium.launch({ headless: ${config.headlessMode}, slowMo: ${config.slowMo} })\n- newContext({ viewport: { width: 1920, height: 1080 } })\n- try/catch/finally s success_screenshot.png a error_screenshot.png\n- stepShot(page, 'popis') po každom kliku\n- Odstráň test.describe/test wrapery — chceme priamy async IIFE\nVráť IBA kód, žiadny markdown.`;
                            const recMsgs = [vscode.LanguageModelChatMessage.User(recPrompt)];
                            const recResp = await recModel.sendRequest(recMsgs, {}, token);
                            let recFinal = '';
                            for await (const chunk of recResp.text) { recFinal += chunk; }
                            recFinal = recFinal.replace(/```(javascript|js)?/g, '').trim();
                            const diagHelper = `// Autogenerated diagnostics helper\nasync function attachDiagnostics(page) { const _fs=require('fs'),_path=require('path'); try { const n=[],cl=[]; page.on('request',r=>{try{n.push({type:'request',url:r.url()});}catch(e){}}); page.on('response',async r=>{try{n.push({type:'response',url:r.url(),status:r.status()});}catch(e){}}); page.on('console',m=>{try{cl.push({type:m.type(),text:m.text()});}catch(e){}}); page.saveDiagnostics=async function(dir){try{if(!_fs.existsSync(dir))_fs.mkdirSync(dir,{recursive:true});_fs.writeFileSync(_path.join(dir,'network.json'),JSON.stringify(n,null,2));_fs.writeFileSync(_path.join(dir,'console_logs.json'),JSON.stringify(cl,null,2));}catch(e){}};} catch(e){} }\nconst _sfs=require('fs');let _sc=0;async function stepShot(pg,name=''){_sc++;if(!_sfs.existsSync('steps'))_sfs.mkdirSync('steps',{recursive:true});const n=\`steps/step_\${String(_sc).padStart(2,'0')}\${name?'_'+name.replace(/\\s+/g,'_').replace(/[^a-zA-Z0-9_]/g,'').substring(0,30):''}.png\`;try{await pg.screenshot({path:n,fullPage:true});}catch(e){}}\n\n`;
                            fs.writeFileSync(path.join(recTestDir, 'test.spec.js'), diagHelper + recFinal);
                            response.markdown(`✅ **Test uložený:** \`autotest/${recFolderName}/test.spec.js\`\n\n`);
                            response.markdown(`▶️ Spusti ho: \`@autotest run ${recFolderName}\`\n\n`);
                        }
                    } else {
                        response.markdown(`⚠️ Skript nebol vygenerovaný (browser bol zatvorený bez akcií?).\n\n`);
                    }
                } catch (e: any) {
                    response.markdown(`❌ Codegen chyba: ${e.message?.substring(0, 300)}\n\n`);
                }
            } else {
                // ===== DESKTOP: pywinauto + pynput recorder =====
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

                // Vygeneruj recorder skript
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
    print(f"[{_step[0]:02d}] KLIK ({x},{y}) → '{title}' [{ct}]{' id='+auto_id if auto_id else ''}")
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
print("Klikaj v aplikácii. Stlač ESC alebo Ctrl+S pre stop.")
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

print(f"\\n✓ Zaznamenaných {_step[0]} akcií → {OUTPUT_FILE}")
sys.stdout.flush()
`;
                const recorderPath = path.join(recTestDir, '_recorder.py');
                fs.writeFileSync(recorderPath, recorderScript, 'utf-8');

                const recOutputJson = path.join(recTestDir, 'recorded_actions.json');
                let skipRecording = false;

                // Ak existuje predchádzajúci záznam, opýtaj sa či nahrávať znova
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
                response.markdown(`🖱️ **Klikaj v aplikácii.** Každý klik sa zaznamená s informáciami o elemente.\n`);
                response.markdown(`⏹️ **Stlač ESC alebo Ctrl+S pre zastavenie nahrávanie.**\n\n`);
                response.markdown(`▶️ Spúšťam recorder... (okno CMD zostane otvorené)\n\n`);

                // Spusti recorder v novom CMD okne aby neblokoval a user videl output
                const recTermCmd = `start cmd /k ""${pythonExeRec}" "${recorderPath}""`;
                const { exec: _exec } = require('child_process');
                await new Promise<void>((resolve) => {
                    _exec(recTermCmd, { cwd: recTestDir }, () => resolve());
                });

                // Vymaž starý súbor pred čakaním na nový
                try { fs.unlinkSync(recOutputJson); } catch {}

                // Čakaj kým user stopne nahrávanie (sleduj či vznikol output file)
                response.markdown(`⏳ Čakám na dokončenie nahrávanie...\n(CMD okno sa zatvorí automaticky po ESC/Ctrl+S)\n\n`);
                const maxWait = 600; // 10 min max
                let waited = 0;
                while (!fs.existsSync(recOutputJson) && waited < maxWait) {
                    await new Promise(r => setTimeout(r, 2000));
                    waited += 2;
                }

                if (!fs.existsSync(recOutputJson)) {
                    response.markdown(`⏰ Timeout — recorder neukončil v ${maxWait}s.\n\n`); return;
                }
                } // end if (!skipRecording)

                const recData = JSON.parse(fs.readFileSync(recOutputJson, 'utf-8'));
                const totalSteps = recData.total_steps || recData.actions?.length || 0;
                response.markdown(`✅ **Nahrávanie dokončené!** ${totalSteps} krokov zaznamenaných.\n\n`);

                // Zobraziť prehľad zaznamenaných krokov
                if (recData.actions?.length > 0) {
                    const stepLines = recData.actions.map((a: any) =>
                        `- Krok ${a.step}: **${a.element?.title || '?'}** [${a.element?.control_type || '?'}]${a.element?.auto_id ? ` id="${a.element.auto_id}"` : ''}`
                    ).join('\n');
                    response.markdown(`### Zaznamenané kroky:\n${stepLines}\n\n`);
                }

                // Generuj pywinauto test zo záznamu cez AI
                response.markdown(`🤖 **Generujem pywinauto test zo záznamu...**\n\n`);
                const recModel2 = await selectAIModel(context, 'code');
                if (recModel2) {
                    const recActionsStr = JSON.stringify(recData.actions?.slice(0, 30), null, 2);
                    const recPrompt2 = `Toto sú zaznamenané akcie používateľa v desktop aplikácii (pywinauto UIA):\n\`\`\`json\n${recActionsStr}\n\`\`\`\n\nAplikácia: ${config.appUrl}\nPopis: ${recFolderName}\n\nVytvor Python pywinauto test skript ktorý:\n1. Používa VÝHRADNE: pywinauto, subprocess, os, sys, time, json, datetime — ŽIADNE INÉ KNIŽNICE\n2. ZAKÁZANÉ importy: pyautogui, PIL, win32api, win32con, ctypes, uiautomation — NIKDY ich nepoužívaj\n3. Pripojí sa k aplikácii: Application(backend='uia').connect(title_re='.*${(config.appUrl || 'app').split('\\\\').pop()?.replace(/\\..*$/, '') || 'app'}.*', timeout=5) — ak nebeží, spustí cez os.startfile(r'${config.appUrl}')\n4. Pre každý krok použije REÁLNE zaznamenané element info (title, control_type, auto_id) — hľadaj cez win.child_window(title='...', control_type='...') alebo auto_id\n5. Pre top-level menu (control_type='MenuItem' s parent control_type='MenuBar') VŽDY použi click_top_menu(win, 'text')\n6. Volá step_screenshot() po každom kroku\n7. Má try/except/finally so success_screenshot.png, error_screenshot.png, console_logs.json, sys.exit(0/1)\n8. Obsahuje tieto helper funkcie (skopíruj doslovne):\n\ndef log(msg): logs.append(f'[{datetime.now().strftime(\"%H:%M:%S\")}] {msg}'); print(msg)\n\ndef click_by_text(container, text, timeout=2.5):\n    deadline = time.time() + timeout\n    while time.time() < deadline:\n        for ctrl in container.descendants():\n            try:\n                ct = ctrl.window_text()\n                if text.lower() in ct.lower() and ct.strip(): ctrl.click_input(); log(f'Kliknuté na: "{ct}"'); return ctrl\n            except: pass\n        time.sleep(0.3)\n    raise Exception(f'Element "{text}" nebol nájdený')\n\ndef click_top_menu(win, text, timeout=5):\n    import re as _re\n    deadline = time.time() + timeout\n    while time.time() < deadline:\n        try:\n            for mb in win.descendants(control_type='MenuBar'):\n                for item in mb.children():\n                    try:\n                        ct = item.window_text()\n                        if text.lower() in ct.lower() and ct.strip(): item.click_input(); log(f'Top-menu: "{ct}"'); return item\n                    except: pass\n        except: pass\n        time.sleep(0.3)\n    raise Exception(f'Top-menu "{text}" nenájdené')\n\n_step_c=[0]\ndef step_screenshot(name='', container=None):\n    import os as _os, re as _rer\n    _step_c[0]+=1\n    d='steps'\n    if not _os.path.exists(d): _os.makedirs(d)\n    n=_rer.sub(r'[^a-zA-Z0-9_]','_',name)[:30] if name else ''\n    fn=f'{d}/step_{_step_c[0]:02d}{\"_\"+n if n else \"\"}.png'\n    try: (container if container else win).capture_as_image().save(fn); log(f'Screenshot: {fn}')\n    except Exception as e: log(f'Screenshot chyba: {e}')\n\nVráť IBA Python kód, žiadny markdown, žiadne vysvetlenia.`;
                    const recMsgs2 = [vscode.LanguageModelChatMessage.User(recPrompt2)];
                    const recResp2 = await recModel2.sendRequest(recMsgs2, {}, token);
                    let recFinal2 = '';
                    for await (const chunk of recResp2.text) { recFinal2 += chunk; }
                    recFinal2 = recFinal2.replace(/```(python)?/g, '').trim();
                    fs.writeFileSync(path.join(recTestDir, 'test.spec.py'), recFinal2, 'utf-8');
                    response.markdown(`✅ **Test uložený:** \`autotest/${recFolderName}/test.spec.py\`\n\n`);
                    response.markdown(`▶️ Spusti ho: \`@autotest run ${recFolderName}\`\n\n`);
                }
            }
            return;
        }

        // ===== PRÍKAZ: @autotest history =====
        if (userQuery.includes('history') || userQuery.includes('história')) {
            const history = getBugHistory(context, 10);
            response.markdown(formatBugHistory(history));
            return;
        }
        
        // ===== PRÍKAZ: @autotest regenerate bug_123 alebo regenerate test_456 =====
        if (userQuery.includes('regenerate') || userQuery.includes('regeneruj')) {
            response.markdown(`🔄 **Regenerácia test scriptu...**\n\n`);
            
            // Extrahuj názov priečinka (bug_123 alebo test_12345...)
            const folderMatch = request.prompt.match(/(?:bug_|test_)[\w]+/);
            if (!folderMatch) {
                response.markdown(`❌ Zadaj názov test priečinka, napríklad: \`@autotest regenerate bug_622116\`\n\n`);
                return;
            }
            
            const testFolderName = folderMatch[0];
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) {
                response.markdown(`*Chyba: Nemáš otvorený žiadny projekt.*`);
                return;
            }
            
            const workspacePath = workspaceFolders[0].uri.fsPath;
            const testDir = path.join(workspacePath, 'autotest', testFolderName);
            const scenarioPath = path.join(testDir, 'test_scenario.md');
            
            if (!fs.existsSync(scenarioPath)) {
                response.markdown(`❌ Test scenár nenájdený: \`autotest/${testFolderName}/test_scenario.md\`\n\n`);
                response.markdown(`Uisti sa, že priečinok existuje a obsahuje test_scenario.md súbor.\n\n`);
                return;
            }
            
            // Načítaj upravený scenár
            const updatedScenario = fs.readFileSync(scenarioPath, 'utf-8');

            if (!updatedScenario || updatedScenario.trim().length < 20) {
                response.markdown(`❌ **Test scenár je prázdny!**\n\n`);
                response.markdown(`Súbor \`autotest/${testFolderName}/test_scenario.md\` neobsahuje žiadny obsah.\n\n`);
                response.markdown(`Najprv uprav scenár – pridaj kroky testu, potom spusti regeneráciu znova.\n\n`);
                return;
            }
            
            response.markdown(`📝 Test scenár načítaný z: \`${testFolderName}/test_scenario.md\`\n\n`);
            
            // Vyber kódovací model
            const model = await selectAIModel(context, 'code');
            if (!model) {
                response.markdown(`*Chyba: Nenašiel sa AI model.*`);
                return;
            }
            
            // Načítať login credentials
            let loginCredentials = '';
            if (config.loginRequired && config.username) {
                const password = await getLoginPassword(context);
                if (password) {
                    loginCredentials = `

DÔLEŽITÉ - Aplikácia vyžaduje prihlásenie:
1. Username: "${config.username}"
2. Password: "${password}"

Pre prihlásenie použi tento Playwright kód (PRESNE takto):
  // Prihlásenie
  await page.fill('input[name="username"]', '${config.username}');
  await page.fill('input[name="password"]', '${password}');
  
  // Klikni na login button - POUŽI VIACERO MOŽNOSTÍ (prvá ktorá funguje):
  try {
    await page.getByRole('button', { name: /prihlásiť|login|přihlásit|sign in|submit/i }).click({ timeout: 5000 });
  } catch {
    try {
      await page.locator('button[type="submit"]').click({ timeout: 5000 });
    } catch {
      await page.locator('form button').first().click({ timeout: 5000 });
    }
  }
  
  // Počkaj kým sa aplikácia plne načíta (Blazor SPA — waitForLoadState tu NEFUNGUJE)
  await page.waitForFunction(() => !document.body?.innerText?.includes('Completing login'), { timeout: 30000 });
  await page.waitForTimeout(2000);

Teraz pokračuj s testovaním bugu.`;
                }
            }
            
            // Regeneruj test kód podľa backend
            const isDesktopMode = config.appType === 'desktop';
            const isPywinautoBackend = isDesktopMode && config.desktopBackend === 'pywinauto';

            // Načítaj project overview, desktop metadata a automation pamäť
            let regenProjectOverview = '';
            let regenDesktopMetadata: any = null;
            let regenAutomationMemory: ProjectAutomationMemory | null = null;
            let regenMemoryContext = '';
            let regenTestHealingContext = '';
            let regenProjectHealingLessons = '';
            try {
                const overviewPath = path.join(workspacePath, 'autotest', 'project_overview.md');
                if (fs.existsSync(overviewPath)) {
                    regenProjectOverview = fs.readFileSync(overviewPath, 'utf-8');
                }
                if (isPywinautoBackend) {
                    const metadataPath = path.join(workspacePath, 'autotest', 'desktop_app_metadata.json');
                    if (fs.existsSync(metadataPath)) {
                        regenDesktopMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
                    }
                }
                // Pamäť pre VŠETKY typy testov (web aj desktop)
                const _regenAutotestDir = path.join(workspacePath, 'autotest');
                if (fs.existsSync(_regenAutotestDir)) {
                    regenAutomationMemory = new ProjectAutomationMemory(_regenAutotestDir, config.appUrl || '');
                    regenMemoryContext = regenAutomationMemory.formatForPrompt();
                    if (regenMemoryContext) {
                        response.markdown(`🧠 Načítaná UI Automation pamäť projektu.\n\n`);
                    }
                }

                regenTestHealingContext = loadTestHealingContext(testDir);
                if (regenTestHealingContext) {
                    response.markdown(`🩹 Načítaný healing context: \`${testFolderName}/healing_context.md\`\n\n`);
                }

                regenProjectHealingLessons = loadProjectHealingLessons(workspacePath);
                if (regenProjectHealingLessons) {
                    response.markdown(`📚 Načítané projektové lessons: \`autotest/healing_lessons.md\`\n\n`);
                }
            } catch (e) { /* ignore */ }

            // Načítaj zaznamenané akcie z record príkazu (ak existujú)
            let regenRecordedActions = '';
            const regenRecordedPath = path.join(testDir, 'recorded_actions.json');
            if (fs.existsSync(regenRecordedPath)) {
                try {
                    const recData = JSON.parse(fs.readFileSync(regenRecordedPath, 'utf-8'));
                    const recSteps = recData.total_steps || recData.actions?.length || 0;
                    regenRecordedActions = JSON.stringify(recData.actions?.slice(0, 40), null, 2);
                    response.markdown(`📼 **Načítaných ${recSteps} zaznamenaných krokov** z \`recorded_actions.json\` — použijem reálne element identifikátory.\n\n`);
                } catch {}
            }

            const regenPrompt = isPywinautoBackend
                ? `
Si expert na QA pre Windows desktop aplikácie. Podľa tohto UPRAVENÉHO test scenára vytvor Python test skript používajúc pywinauto:

${updatedScenario}

Cieľ desktop aplikácie: '${config.appUrl}'

${regenProjectOverview ? `PROJECT OVERVIEW:\n${regenProjectOverview}\n` : ''}

${regenDesktopMetadata ? `OVERENÉ ÚDAJE O OKNE (z init):
- Window title regex: "${regenDesktopMetadata.Name}"
- ClassName: "${regenDesktopMetadata.ClassName}"
` : ''}${regenRecordedActions ? `
ZAZNAMENANÉ AKCIE POUŽÍVATEĽA (z nahrávanie — POUŽI TIETO REÁLNE ELEMENT IDENTIFIKÁTORY PREDNOSTNE):
Každá akcia obsahuje title, control_type, auto_id konkrétneho elementu na ktorý používateľ klikol.
NIKDY nevymýšľaj názvy elementov — použi presne tieto zaznamenané hodnoty.
\`\`\`json
${regenRecordedActions}
\`\`\`
` : ''}${regenMemoryContext ? `
UI AUTOMATION PAMÄŤ (z predchádzajúcich testov - POUŽI TIETO POZNATKY PREDNOSTNE):
${regenMemoryContext}
` : ''}${regenTestHealingContext ? `
HEALING CONTEXT PRE TENTO TEST (KRITICKÉ - neopakuj tieto chyby):
${regenTestHealingContext}
` : ''}${regenProjectHealingLessons ? `
PROJEKTOVÉ LESSONS (krížové chyby z iných testov):
${regenProjectHealingLessons.substring(0, 4000)}
` : ''}

KRITICKÉ POŽIADAVKY:
1. Importy: from pywinauto import Application; from pywinauto.keyboard import send_keys; import time, sys, os, json, subprocess; from datetime import datetime

2. Funkcia get_timestamp() a log(msg) s globálnym zoznamom logs.

3. Spustenie aplikácie - NAJPRV skús pripojiť k bežiacej inštancii, ak nebeží, spusti novú:
   proc = None
   title_re = '.*${(regenDesktopMetadata?.Name || config.appUrl).replace(/[.*+?^${}()|[\]\\]/g, '\\\\$&').substring(0, 30)}.*'
   try:
       app = Application(backend='uia').connect(title_re=title_re, timeout=3)
       log('Pripojené k bežiacej inštancii')
   except Exception:
       ${config.appUrl.includes('\\') || config.appUrl.includes('/')
           ? /\.(exe|bat|com)$/i.test(config.appUrl)
               ? `proc = subprocess.Popen(['${config.appUrl.replace(/\\/g, '\\\\')}'])
       time.sleep(3)`
               : `os.startfile(r'${config.appUrl}')  # ClickOnce / .appref-ms / .lnk
       time.sleep(4)
       proc = None`
           : `subprocess.Popen(['explorer.exe', 'shell:appsFolder\\\\${config.appUrl}'])
       time.sleep(4)
       proc = None`}
       app = Application(backend='uia').connect(title_re=title_re, timeout=30)

4. Získanie referencie na okno:
   win = app.window(title_re=title_re)
   win.set_focus(); time.sleep(0.5)

5. POVINNÁ helper funkcia - pridaj ju HNEĎ po log() funkcii (pred try blokom):
   def click_by_text(container, text, screenshot_on_fail=True, timeout=2.5):
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
               log(f'Screenshot uložený (hľadal som: "{text}")')
           except: pass
       raise Exception(f'Element "{text}" nebol nájdený po {timeout}s - pozri not_found_screenshot.png')

6. Helper funkcie — PRIDAJ DO SKRIPTU (hneď po click_by_text):
   def click_top_menu(win, text, timeout=5):
       import re as _re
       deadline = time.time() + timeout
       while time.time() < deadline:
           try:
               for mb in win.descendants(control_type='MenuBar'):
                   for item in mb.children():
                       try:
                           ct = item.window_text()
                           if text.lower() in ct.lower() and ct.strip():
                               item.click_input(); log(f'Kliknuté top-menu (MenuBar): "{ct}"'); return item
                       except: pass
           except: pass
           try:
               win.child_window(title_re=f'.*{_re.escape(text)}.*', control_type='MenuItem').click_input(); return
           except: pass
           for ctrl in win.descendants():
               try:
                   ct = ctrl.window_text()
                   if text.lower() in ct.lower() and ct.strip():
                       if ctrl.element_info.control_type in ['MenuItem','Button','Custom']:
                           ctrl.click_input(); return ctrl
               except: pass
           time.sleep(0.3)
       try:
           items = [c.window_text() for mb in win.descendants(control_type='MenuBar') for c in mb.children() if c.window_text().strip()]
           log(f'DEBUG MenuBar items: {items}')
       except: pass
       raise Exception(f'Top-menu "{text}" nebolo nájdené po {timeout}s')

   Navigácia cez menu — POVINNÉ PRAVIDLÁ:
   # Top-level menu: VŽDY click_top_menu() — NIKDY win.child_window(title=...).click_input()
   click_top_menu(win, 'NazovMenu')
   time.sleep(0.7)
   # Submenu: click_by_text
   click_by_text(win, 'NazovSubmenu')
   time.sleep(0.5)

7. KRITICKٰ PRAVIDLO pre WinForms MDI aplikácie:
   # Co vyzerá ako 'dialóg' NIE JE samostatné okno - je to Panel/Group/Pane vnori
   # v hlavnom MDI okne. NIKDY: app.window(title='...'). VŽDY: win.child_window(...)
   time.sleep(1.0)
   panel = None
   for ct in ['Group', 'Pane', 'Custom', 'Document']:
       try:
           panel = win.child_window(title_re='.*NazovDialogu.*', control_type=ct)
           panel.wait('visible', timeout=3); break
       except: panel = None
   container = panel if panel else win
   val = get_text_of(container, 'NazovLabelu')
   assert val and 'OčakávanáHodnota' in val, f'Očakával som \'OčakávanáHodnota\' ale získal \'{val}\''

8. KROKOVÉ SCREENSHOTY — KRITICKÉ: Po každom kroku MUSÍŠ volať step_screenshot(). Pridaj helper hneď po click_by_text definícii:
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
   
   Príklady:
   click_top_menu(win, 'Evidencie'); step_screenshot('menu_evidencie')
   click_by_text(win, 'Osoby'); step_screenshot('submenu_osoby')
   panel = win.child_window(...); step_screenshot('panel_otvoreny', container=panel)

9. Povinná štruktúra try/except/finally s success_screenshot.png, error_screenshot.png, console_logs.json, sys.exit(0 if test_passed else 1) a proc.terminate().

Vráť IBA a LEN Python kód, žiadny markdown, žiadne vysvetlenia.
`
                                : `
                        Si expert na QA a Playwright. Podľa tohto UPRAVENÉHO test scenára vytvor nový Playwright JavaScript kód:
            
                        ${updatedScenario}
                        ${loginCredentials}
                        ${regenRecordedActions ? `\nZAZNAMENANÉ AKCIE POUŽÍVATEĽA (z nahrávanie — POUŽI TIETO REÁLNE SELEKTORY/AKCIE PREDNOSTNE):\nKaždá akcia obsahuje presný selektor/text elementu na ktorý používateľ klikol.\n\`\`\`json\n${regenRecordedActions}\n\`\`\`\n` : ''}
                        Test pôjde na adresu '${config.appUrl}'.
            
                        DÔLEŽITÉ POŽIADAVKY:
                        1. Browser launch: const browser = await chromium.launch({ headless: ${config.headlessMode}, slowMo: ${config.slowMo} });
                        2. Po launchi vytvor context s veľkým viewportom: const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } }); const page = await context.newPage();
                        3. Obal CELÝ test do try-catch bloku
                        4. V catch bloku:
                             - Ulož screenshot: await page.screenshot({ path: 'error_screenshot.png', fullPage: true });
                             - Vyprintuj chybu: console.error('TEST FAILED:', error.message);
                             - Vyprintuj URL: console.error('Current URL:', page.url());
                        5. Na konci (v try bloku) ulož úspešný screenshot: await page.screenshot({ path: 'success_screenshot.png', fullPage: true });
                        5b. KROKOVÉ SCREENSHOTY — KRITICKÉ: Po každej akcii (klik, navigácia, submit) volaj stepShot(). Pridaj helper HNEĎ za 'await attachDiagnostics(page)':
                             const _sfs = require('fs'); let _sc = 0;
                             async function stepShot(pg, name = '') { _sc++; if (!_sfs.existsSync('steps')) _sfs.mkdirSync('steps', {recursive: true}); const n = 'steps/step_' + String(_sc).padStart(2,'0') + (name ? '_'+name.replace(/\s+/g,'_').replace(/[^a-zA-Z0-9_]/g,'').substring(0,30) : '') + '.png'; try { await pg.screenshot({ path: n, fullPage: true }); } catch(e) {} }
                             Príklady povinného použitia:
                             await page.locator('.tab a:has-text("Evidencia")').click();
                             await stepShot(page, 'po_klik_evidencia');   // VŽDY hneď po každom kliku
                             await page.getByRole('button', {name: /vyhľadať/i}).click();
                             await stepShot(page, 'po_vyhladavani');
                        6. V finally bloku zatvor browser: await browser.close();
                        7. Bezprostredne po vytvorení 'page' zavolaj 'await attachDiagnostics(page);' aby sa zachytili sieťové volania, console logy a DOM snapshot. Pomenuj súbory: 'network.json', 'console_logs.json', 'dom.html'.
                        8. KRITICKÉ - SPA/AJAX ČAKANIE: Aplikácia je SPA (Blazor). Tlačidlá spúšťajú AJAX - stránka sa NENAVIGÁVA.
                             ZAKAŽANÉ metody (vždy timeoutujú v Blazor SPA):
                                 await page.waitForLoadState(...)  ← NIKDY, ani 'networkidle', ani 'load'
                                 await page.waitForNavigation(...)  ← NIKDY
                             POVOLENÉ metódy pre čakanie po AJAX akcii - použi JEDNO z:
                                 await page.waitForResponse(resp => resp.url().includes('/api/') && resp.status() === 200, { timeout: 15000 });
                                 await page.locator('SPECIFICKY_SELEKTOR').first().waitFor({ state: 'attached', timeout: 15000 });
                                 await page.waitForFunction(() => document.querySelectorAll('SELEKTOR').length > 0, { timeout: 15000 });
                             UPOZORNENIE pre waitForSelector a locator.waitFor:
                                 - NIKDY nepoužívaj state:'visible' na selektory ktoré matchujú veľa elementov (napr. 'table tbody tr')
                                 - Ak selektor môže matchovať viac elementov, vždy použi .first() alebo .nth(0)
                                 - Bezpečný vzor: await page.locator('table tbody tr').first().waitFor({ state: 'attached', timeout: 15000 });
                             waitForLoadState je povolené LEN hneď po page.goto().

                        9. KOMPLETNÝ KÓD — KRITICKÉ: Každý krok scenára MUSÍ mať reálny fungujúci kód. NIKDY nevytváraj placeholder komentáre ako "(implementácia...)" alebo "(TODO)". Ak nevieš presný selektor, použi fallback.

                        ${regenProjectOverview ? `10. POVINNÉ SELEKTORY z project_overview.md (MUSÍŠ POUŽÍVAŤ TIETO):
                             - Záložka/tab: page.locator('li.tab a:has-text("NazovZalozky")').click()
                             - Filter input: nájdi label → for="ID" → page.locator('#ID').fill(hodnota)
                             - Dropdown: page.locator('label:has-text("NazovDropdown")').locator('..').locator('div.dtc-dropdown-trigger').click(), potom page.locator('input.dtc-dropdown-filter.dtc-inputtext:visible').fill(hodnota), potom page.getByTitle(hodnota).click()
                             - Detail ikona: page.locator('.v-icon-detail').first().click()
                             - Vyhľadať záznamy: page.getByRole('button', {name: /vyhľadať záznamy/i}).click()
` : ''}
                        ${regenMemoryContext ? `11. PAMÄŤ Z PREDCHÁDZAJÚCICH TESTOV (uč sa z týchto chýb):
${regenMemoryContext}
` : ''}
                        ${regenTestHealingContext ? `12. HEALING CONTEXT PRE TENTO TEST (neopakuj tieto chyby):
${regenTestHealingContext}
` : ''}
                        ${regenProjectHealingLessons ? `13. PROJEKTOVÉ LESSONS (krížové chyby z iných testov):
${regenProjectHealingLessons.substring(0, 4000)}
` : ''}
                        Vráť IBA a LEN kód, žiadne vysvetlenné, žiadny markdown naokolo.
                        `;
            
            const regenMessages = [vscode.LanguageModelChatMessage.User(regenPrompt)];
            const regenResponse = await model.sendRequest(regenMessages, {}, token);
            
            let regeneratedCode = '';
            for await (const chunk of regenResponse.text) {
                regeneratedCode += chunk;
            }
            regeneratedCode = regeneratedCode.replace(/```(python|javascript|typescript)?/g, '').trim();

                        // If project overview exists, embed it as a header and prepend diagnostics helper (len pre JS/Playwright)
                        try {
                                const overviewPath = path.join(workspacePath, 'autotest', 'project_overview.md');
                                let projectOverview = '';
                                if (fs.existsSync(overviewPath)) {
                                        projectOverview = fs.readFileSync(overviewPath, 'utf-8');
                                }

                                if (!isPywinautoBackend && projectOverview && projectOverview.trim().length > 0) {
                                        const header = '/* Project overview:\n' + projectOverview.split('\n').map((l: string) => ' * ' + l).join('\n') + '\n */\n\n';
                                        regeneratedCode = header + regeneratedCode;
                                }

                                if (!isPywinautoBackend) {
                                const diagnosticsHelper = `
// Autogenerated diagnostics helper - attach to Playwright page as: await attachDiagnostics(page)
async function attachDiagnostics(page) {
    const _fs = require('fs');
    const _path = require('path');
    try {
        const network = [];
        page.on('request', request => {
            try { network.push({ type: 'request', url: request.url(), method: request.method(), headers: request.headers(), postData: request.postData() }); } catch(e) {}
        });
        page.on('response', async response => {
            try { const body = await response.text().catch(()=>null); network.push({ type: 'response', url: response.url(), status: response.status(), headers: response.headers(), body }); } catch(e) {}
        });
        const consoleLogs = [];
        page.on('console', msg => { try { consoleLogs.push({type: 'console', text: msg.text(), location: msg.location ? msg.location() : null}); } catch(e) {} });
        page.on('pageerror', err => { try { consoleLogs.push({type:'pageerror', message: String(err)}); } catch(e) {} });

        page.saveDiagnostics = async function(dir) {
            try {
                if (!_fs.existsSync(dir)) _fs.mkdirSync(dir, { recursive: true });
                _fs.writeFileSync(_path.join(dir,'network.json'), JSON.stringify(network, null, 2));
                _fs.writeFileSync(_path.join(dir,'console_logs.json'), JSON.stringify(consoleLogs, null, 2));
                try { const html = await page.content(); _fs.writeFileSync(_path.join(dir,'dom.html'), html); } catch(e) {}
            } catch(e) {
                // ignore
            }
        };
    } catch(e) {
        // ignore
    }
}
\n`;

                                regeneratedCode = diagnosticsHelper + regeneratedCode;
                                }
                        } catch (e) {
                                // Ignore errors while embedding diagnostics
                        }

                        // Ulož nový test script
                        const testFileExtension = isPywinautoBackend ? '.py' : '.js';
                        const testFilePath = path.join(testDir, 'test.spec' + testFileExtension);
                        fs.writeFileSync(testFilePath, regeneratedCode);
            
            response.markdown(`✅ **Test script regenerovaný!**\n\n`);
            response.markdown(`📁 Uložený do: \`autotest/${testFolderName}/test.spec${testFileExtension}\`\n\n`);

            let runtimeReady = true;
            let regenPythonExe = '';
            if (isPywinautoBackend) {
                const [pyExe, pyOk] = await ensurePywinautoInstalled(response);
                regenPythonExe = pyExe;
                runtimeReady = pyOk;
            } else {
                runtimeReady = await ensurePlaywrightInstalled(workspacePath, response);
            }
            
            if (!runtimeReady) {
                response.markdown(`❌ **Regenerovaný test sa nespustil, chýbajú runtime závislosti.**\n\n`);
                return;
            }

            response.markdown(`🚀 Spúšťam test...\n\n`);

            // Vymaž staré screenshoty pred novým spustením
            for (const oldFile of ['success_screenshot.png', 'error_screenshot.png', 'not_found_screenshot.png', 'not_found_info.json', 'test_result.md']) {
                try { fs.unlinkSync(path.join(testDir, oldFile)); } catch {}
            }
            const _regenStepsDir = path.join(testDir, 'steps');
            if (fs.existsSync(_regenStepsDir)) { try { fs.readdirSync(_regenStepsDir).forEach((f: string) => { try { fs.unlinkSync(path.join(_regenStepsDir, f)); } catch {} }); fs.rmdirSync(_regenStepsDir); } catch {} }
            
            // Spusti regenerovaný test
            try {
                const testCommand = isPywinautoBackend
                    ? `"${regenPythonExe}" test.spec.py`
                    : `node test.spec.js`;
                
                const { stdout, stderr } = await execAsync(testCommand, {
                    cwd: testDir,
                    timeout: 120000
                });
                
                const combinedOutput = [stdout, stderr].filter(Boolean).join('\n').trim();
                if (combinedOutput) {
                    response.markdown(`⚠️ Console output:\n\`\`\`\n${combinedOutput.substring(0, 1000)}\n\`\`\`\n\n`);
                }
                
                const successScreenshotPath = path.join(testDir, 'success_screenshot.png');
                const errorScreenshotPath = path.join(testDir, 'error_screenshot.png');
                const testResultPath = path.join(testDir, 'test_result.md');

                if (fs.existsSync(errorScreenshotPath)) {
                    response.markdown(`⚠️ **Test stále zlyhala.**\n\n`);
                    response.markdown(`📸 Error screenshot: \`${testFolderName}/error_screenshot.png\`\n\n`);
                    // Kroková historia
                    const _rStepsDir = path.join(testDir, 'steps');
                    if (fs.existsSync(_rStepsDir)) {
                        const _rStepFiles = fs.readdirSync(_rStepsDir).filter((f: string) => f.endsWith('.png')).sort();
                        if (_rStepFiles.length > 0) {
                            response.markdown(`📷 **Kroky (${_rStepFiles.length}):** ${_rStepFiles.map((f: string) => `\`${testFolderName}/steps/${f}\``).join(', ')}\n\n`);
                        }
                    }

                    // Vision analýza chybového screenshotu
                    response.markdown(`👁️ **Analýzujem čo sa pokazilo...**\n\n`);
                    const visionModel = await selectAIModel(context, 'vision');
                    let errorAnalysis = 'Vision model nebol dostupný.';
                    if (visionModel) {
                        response.markdown(`👁️ Vision model: **${visionModel.name || visionModel.id}**\n\n`);
                        const errorScreenshotBase64 = fs.readFileSync(errorScreenshotPath).toString('base64');
                        const _isPyRegen = isPywinautoBackend;
                        const errorAnalysisPrompt = `Tu je screenshot v momente keď test zlyhala.\n\nTest scenár:\n${updatedScenario}\n\nChyba z console:\n${combinedOutput}\n\n${_isPyRegen ? 'DÔLEŽITÉ: Aplikácia sa testuje cez Python pywinauto. Všetky opravy MUSÍA byť v Python pywinauto syntaxi (nie C#, nie FlaUI). Ak bol problém s nájdením menu položky, použi click_top_menu(win, \"text\") namiesto child_window.' : 'DÔLEŽITÉ: Aplikácia je Blazor SPA. Opravy v Playwright JavaScript. ZAKAZ: waitForLoadState okrem po goto.'}

Analýzuj screenshot a povedz:\n1. Na akom kroku test zlyhala?\n2. Čo sa na obrazovke nachádza?\n3. Prečo pravdepodobne test neprebehol?\n4. Konkrétna oprava v ${_isPyRegen ? 'Python pywinauto' : 'Playwright JavaScript'} syntaxi.`;
                        try {
                            const errorVisionMessages = [
                                vscode.LanguageModelChatMessage.User([
                                    new vscode.LanguageModelTextPart(errorAnalysisPrompt),
                                    vscode.LanguageModelDataPart.image(Buffer.from(errorScreenshotBase64, 'base64'), 'image/png')
                                ])
                            ];
                            const errorVisionResponse = await visionModel.sendRequest(errorVisionMessages, {}, token);
                            errorAnalysis = '';
                            for await (const chunk of errorVisionResponse.text) {
                                errorAnalysis += chunk;
                            }
                        } catch (e: any) {
                            errorAnalysis = `Vision analýza zlyhala: ${e.message}`;
                        }
                        response.markdown(`### 🔍 Analýza zlyhania:\n\n${errorAnalysis}\n\n`);
                    }

                    fs.writeFileSync(testResultPath, `# Test Result: FAILED ❌\n\n## Test Info\n- **Folder:** ${testFolderName}\n- **Timestamp:** ${new Date().toLocaleString('sk-SK')}\n- **Status:** FAILED\n\n## Problém\n${errorAnalysis}\n\n## Console Output\n\`\`\`\n${combinedOutput || 'Žiadny output'}\n\`\`\`\n\n## Ďalšie kroky\n1. Otvor \`test_scenario.md\` a uprav kroky podľa analýzy vyššie\n2. Spusti: \`@autotest regenerate ${testFolderName}\`\n`);
                    saveHealingContext(
                        workspacePath,
                        testFolderName,
                        updatedScenario,
                        errorAnalysis,
                        combinedOutput || 'Žiadny output',
                        'regenerate:error_screenshot'
                    );
                    response.markdown(`📄 Detail report: \`autotest/${testFolderName}/test_result.md\`\n\n`);
                    // Aktualizuj pamäť zo záznamov testu
                    if (regenAutomationMemory) {
                        try {
                            const stratRecs = parseStrategyLogsFromFile(path.join(testDir, 'console_logs.json'));
                            for (const r of stratRecs) { regenAutomationMemory.recordResult(r.elementType, r.elementName, r.strategyName, r.result); }
                            regenAutomationMemory.addNote(`Test ${testFolderName} regenerate FAILED`);
                        } catch {}
                    }
                    await saveBugHistory(context, {
                        bugId: testFolderName.replace(/^(bug_|test_)/, ''),
                        description: updatedScenario.split('\n').find((l: string) => l.trim().length > 5) || testFolderName,
                        timestamp: new Date().toISOString(),
                        testResult: 'failed'
                    });
                    response.markdown(`✅ **Test prešiel úspešne!**\n\n`);
                    response.markdown(`📸 Screenshot: \`${testFolderName}/success_screenshot.png\`\n\n`);

                    // Vision analýza úspešného screenshotu
                    response.markdown(`👁️ **Analyzujem výsledok testu...**\n\n`);
                    const visionModelOk = await selectAIModel(context, 'vision');
                    let analysisResult = 'Vision model nebol dostupný.';
                    if (visionModelOk) {
                        response.markdown(`👁️ Vision model: **${visionModelOk.name || visionModelOk.id}**\n\n`);
                        const screenshotBase64 = fs.readFileSync(successScreenshotPath).toString('base64');
                        const visionPrompt = `Tu je screenshot aplikácie po dokončení testu.\n\nTest scenár:\n${updatedScenario}\n\nSkontroluj screenshot a zhodnoť:\n1. Či test prebehol správne až do konca\n2. Či je viditeľná očakávaná funkcia alebo výsledok\n3. Či aplikácia vyzerá správne\n\nOdpovedz prehľadne a stručne.`;
                        try {
                            const visionMessages = [
                                vscode.LanguageModelChatMessage.User([
                                    new vscode.LanguageModelTextPart(visionPrompt),
                                    vscode.LanguageModelDataPart.image(Buffer.from(screenshotBase64, 'base64'), 'image/png')
                                ])
                            ];
                            const visionResponse = await visionModelOk.sendRequest(visionMessages, {}, token);
                            analysisResult = '';
                            for await (const chunk of visionResponse.text) {
                                analysisResult += chunk;
                            }
                        } catch (e: any) {
                            analysisResult = `Vision analýza zlyhala: ${e.message}`;
                        }
                        response.markdown(`### 🔍 Výsledok analýzy:\n\n${analysisResult}\n\n`);
                    }

                    fs.writeFileSync(testResultPath, `# Test Result: PASSED ✅\n\n## Test Info\n- **Folder:** ${testFolderName}\n- **Timestamp:** ${new Date().toLocaleString('sk-SK')}\n- **Status:** PASSED\n\n## AI Vision Analysis\n${analysisResult}\n\n## Console Output\n\`\`\`\n${combinedOutput || 'Test dokončený bez chýb'}\n\`\`\`\n`);
                    clearHealingContext(workspacePath, testFolderName);
                    response.markdown(`📄 Detail report: \`autotest/${testFolderName}/test_result.md\`\n\n`);
                    // Aktualizuj pamäť zo záznamov úspešného testu
                    if (regenAutomationMemory) {
                        try {
                            const stratRecs = parseStrategyLogsFromFile(path.join(testDir, 'console_logs.json'));
                            for (const r of stratRecs) { regenAutomationMemory.recordResult(r.elementType, r.elementName, r.strategyName, r.result); }
                            regenAutomationMemory.addNote(`Test ${testFolderName} regenerate PASSED`);
                        } catch {}
                    }
                    await saveBugHistory(context, {
                        bugId: testFolderName.replace(/^(bug_|test_)/, ''),
                        description: updatedScenario.split('\n').find((l: string) => l.trim().length > 5) || testFolderName,
                        timestamp: new Date().toISOString(),
                        testResult: 'success'
                    });

                } else {
                    response.markdown(`⚠️ **Žiadny screenshot sa nevytvoril.**\n\n`);
                    if (!combinedOutput) {
                        response.markdown(`Test prebehol bez výstupu – pravdepodobne vygenerovaný kód neobsahoval žiadne Playwright kroky.\n\n`);
                    }
                    response.markdown(`Skontroluj \`autotest/${testFolderName}/test.spec.js\` a uprav test_scenario.md.\n\n`);
                }
                
            } catch (execError: any) {
                const errDetail = [execError.stderr, execError.stdout].filter(Boolean).join('\n').trim() || execError.message;
                response.markdown(`❌ **Chyba pri spustení:**\n\`\`\`\n${errDetail.substring(0, 3000)}\n\`\`\`\n\n`);

                // Vision analýza - pozri čo je na screenshote (success aj error)
                const _catchSuccessShot = path.join(testDir, 'success_screenshot.png');
                const _catchNotFoundShot = path.join(testDir, 'not_found_screenshot.png');
                const _catchErrorShot = path.join(testDir, 'error_screenshot.png');
                const _catchShot = fs.existsSync(_catchSuccessShot) ? _catchSuccessShot
                    : fs.existsSync(_catchNotFoundShot) ? _catchNotFoundShot
                    : fs.existsSync(_catchErrorShot) ? _catchErrorShot : null;
                if (_catchShot) {
                    const _isSuccess = _catchShot === _catchSuccessShot;
                    response.markdown(`📸 Screenshot: \`${testFolderName}/${path.basename(_catchShot)}\`\n\n`);
                    response.markdown(`👁️ **Analyzujem screenshot...**\n\n`);
                    const _vm = await selectAIModel(context, 'vision');
                    if (_vm) {
                        const _buf = fs.readFileSync(_catchShot);
                        const _prompt = _isSuccess
                            ? `Tu je screenshot Windows desktop aplikácie. Test skript skončil s chybou (assert/exit code 1), ale screenshot bol uložený.\n\nTest scenár:\n${updatedScenario}\n\nChyba:\n${errDetail.substring(0, 500)}\n\nZhodnot:\n1. Čo vidíš na obrazovke?\n2. Vyzerat test vizualne úspšene? (je viditeľný očakávaný výsledok?)\n3. Ak áno - napíš VIZUÁLNE PASSED a popíš čo vidíš.\n4. Ak nie - čo chýba.`
                            : `Tu je screenshot keď test zlyhal.\n\nTest scenár:\n${updatedScenario}\n\nChyba:\n${errDetail.substring(0, 500)}\n\nPovedz:\n1. Čo vidíš na obrazovke?\n2. Kde test pravdepodobne zlyhal?\n3. Ako to opraviť?`;
                        try {
                            const _msgs = [vscode.LanguageModelChatMessage.User([
                                new vscode.LanguageModelTextPart(_prompt),
                                vscode.LanguageModelDataPart.image(_buf, 'image/png')
                            ])];
                            const _resp = await _vm.sendRequest(_msgs, {}, token);
                            let _analysis = '';
                            for await (const chunk of _resp.text) { _analysis += chunk; }
                            response.markdown(`### 👁️ Analýza:\n${_analysis}\n\n`);
                            // Ulož analýzu do memory + test_result.md
                            const _visualPassed = _isSuccess && _analysis.toUpperCase().includes('VIZUÁLNE PASSED');
                            const _memPath = path.join(workspacePath, 'autotest');
                            try {
                                const _mem = new ProjectAutomationMemory(_memPath, config?.appUrl || testFolderName);
                                _mem.addNote(`Test ${testFolderName} ${_visualPassed ? 'VIZUÁLNE PASSED' : 'FAILED'} - Vision analýza: ${_analysis.substring(0, 200)}`);
                                if (_visualPassed) { _mem.recordResult('test', testFolderName, 'visual-assert', 'success'); }
                                _mem.save();
                            } catch {}
                            const _resultPath = path.join(testDir, 'test_result.md');
                            fs.writeFileSync(_resultPath, `# Test Result: ${_visualPassed ? 'VIZUÁLNE PASSED ✅' : 'FAILED ❌'}\n\n## Test Info\n- **Folder:** ${testFolderName}\n- **Timestamp:** ${new Date().toLocaleString('sk-SK')}\n- **Status:** ${_visualPassed ? 'VISUAL_PASSED' : 'FAILED'}\n\n## Vision Analýza\n${_analysis}\n\n## Chyba skriptu\n\`\`\`\n${errDetail.substring(0, 1000)}\n\`\`\`\n`);
                            if (_visualPassed) {
                                clearHealingContext(workspacePath, testFolderName);
                                response.markdown(`✅ **Vizuálne PASSED** \u2014 screenshot potvrdzuje správny výsledok.\n\n`);
                                response.markdown(`📝 Ulóſené do: \`autotest/${testFolderName}/test_result.md\`\n\n`);
                                await saveBugHistory(context, { bugId: testFolderName.replace(/^(bug_|test_)/, ''), description: updatedScenario.split('\n').find((l: string) => l.trim().length > 5) || testFolderName, timestamp: new Date().toISOString(), testResult: 'success' });
                            } else {
                                saveHealingContext(
                                    workspacePath,
                                    testFolderName,
                                    updatedScenario,
                                    _analysis,
                                    errDetail.substring(0, 1000),
                                    'regenerate:exec_catch'
                                );
                                response.markdown(`📝 Report: \`autotest/${testFolderName}/test_result.md\`\n\n`);
                                // ===== AUTO-HEALING pre regenerate catch =====
                                let _rhHealed = false;
                                for (let _rhi = 1; _rhi <= 2 && !_rhHealed; _rhi++) {
                                    response.markdown(`🔄 **Auto-healing pokus ${_rhi}/2** — regenerujem na základe analýzy...\n\n`);
                                    try {
                                        const _rhExt2 = isPywinautoBackend ? '.py' : '.js';
                                        const _rhCurr = fs.existsSync(path.join(testDir, 'test.spec' + _rhExt2))
                                            ? fs.readFileSync(path.join(testDir, 'test.spec' + _rhExt2), 'utf-8').substring(0, 3000) : '';
                                        const _rhPr = isPywinautoBackend
                                            ? `Python pywinauto test zlyhal.\n\nAnalýza zlyhania:\n${_analysis}\n\nTest scenár:\n${updatedScenario}\n\nPosledný skript:\n\`\`\`python\n${_rhCurr}\n\`\`\`\n${regenMemoryContext ? `UI Automation pamäť:\n${regenMemoryContext}` : ''}\n\nDÔLEŽITÉ OPRAVY:\n- Pre top-level menu POUŽI click_top_menu(win, 'text') namiesto child_window(title=...).click_input()\n- click_top_menu helper: skúša MenuBar.children() ako prvý prístup\n- Nezabudni definovať click_top_menu v skripte\n\nVráť IBA kompletný Python kód, žiadny markdown.`
                                            : `Playwright test zlyhal.\n\nAnalýza:\n${_analysis}\n\nTest scenár:\n${updatedScenario}\n\nPosledný skript:\n\`\`\`javascript\n${_rhCurr}\n\`\`\`\n${regenProjectOverview ? `Selektory z project_overview:\n${regenProjectOverview.substring(0, 600)}` : ''}\n${regenMemoryContext ? `Pamäť:\n${regenMemoryContext}` : ''}\n\nZAKÁZANÉ: waitForLoadState okrem po goto, placeholder komentáre.\nVráť IBA kompletný JavaScript kód.`;
                                        const _rhMs2 = [vscode.LanguageModelChatMessage.User(_rhPr)];
                                        const _rhRs2 = await model.sendRequest(_rhMs2, {}, token);
                                        let _rhC2 = '';
                                        for await (const c of _rhRs2.text) { _rhC2 += c; }
                                        _rhC2 = _rhC2.replace(/```(python|javascript|js)?/g, '').trim();
                                        if (_rhC2.length < 50) { break; }
                                        if (!isPywinautoBackend) {
                                            const _dh2 = `// Autogenerated diagnostics helper\nasync function attachDiagnostics(page) { const _fs=require('fs'),_path=require('path'); try { const n=[],cl=[]; page.on('request',r=>{try{n.push({type:'request',url:r.url()});}catch(e){}}); page.on('response',async r=>{try{n.push({type:'response',url:r.url(),status:r.status()});}catch(e){}}); page.on('console',m=>{try{cl.push({type:m.type(),text:m.text()});}catch(e){}}); page.saveDiagnostics=async function(dir){try{if(!_fs.existsSync(dir))_fs.mkdirSync(dir,{recursive:true});_fs.writeFileSync(_path.join(dir,'network.json'),JSON.stringify(n,null,2));_fs.writeFileSync(_path.join(dir,'console_logs.json'),JSON.stringify(cl,null,2));}catch(e){}};} catch(e){} }\n\n`;
                                            _rhC2 = _dh2 + _rhC2;
                                        }
                                        fs.writeFileSync(path.join(testDir, 'test.spec' + _rhExt2), _rhC2);
                                        for (const f of ['success_screenshot.png','error_screenshot.png','not_found_screenshot.png','not_found_info.json']) { try { fs.unlinkSync(path.join(testDir, f)); } catch {} }
                                        const _rhStepsDir = path.join(testDir, 'steps');
                                        if (fs.existsSync(_rhStepsDir)) { try { fs.readdirSync(_rhStepsDir).forEach((f: string) => { try { fs.unlinkSync(path.join(_rhStepsDir, f)); } catch {} }); fs.rmdirSync(_rhStepsDir); } catch {} }
                                        const _rhPyExe = isPywinautoBackend ? (await findPythonExecutable() || 'python') : '';
                                        const _rhCmd2 = isPywinautoBackend ? `"${_rhPyExe}" test.spec.py` : `node test.spec.js`;
                                        response.markdown(`▶️ Spúšťam opravený test...\n\n`);
                                        const { stdout: _rO2, stderr: _rE2 } = await execAsync(_rhCmd2, { cwd: testDir, timeout: 120000 });
                                        const _rOut2 = [_rO2, _rE2].filter(Boolean).join('\n').trim();
                                        if (_rOut2) { response.markdown(`📋 Output:\n\`\`\`\n${_rOut2.substring(0, 600)}\n\`\`\`\n\n`); }
                                        if (fs.existsSync(path.join(testDir, 'success_screenshot.png'))) {
                                            response.markdown(`✅ **Auto-healing úspešný!** Test prešiel na pokuse ${_rhi}.\n\n`);
                                            clearHealingContext(workspacePath, testFolderName);
                                            if (regenAutomationMemory) { try { regenAutomationMemory.addNote(`Test ${testFolderName} AUTO-HEALED po ${_rhi} pokuse`); } catch {} }
                                            await saveBugHistory(context, { bugId: testFolderName.replace(/^(bug_|test_)/, ''), description: updatedScenario.split('\n').find((l: string) => l.trim().length > 5) || testFolderName, timestamp: new Date().toISOString(), testResult: 'success' });
                                            _rhHealed = true;
                                        } else {
                                            response.markdown(`⚠️ Auto-healing pokus ${_rhi} neúspešný...\n\n`);
                                        }
                                    } catch (rhErr2: any) {
                                        response.markdown(`⚠️ Auto-healing chyba: ${rhErr2.message?.substring(0, 200)}\n\n`); break;
                                    }
                                }
                                if (!_rhHealed) {
                                    await saveBugHistory(context, { bugId: testFolderName.replace(/^(bug_|test_)/, ''), description: updatedScenario.split('\n').find((l: string) => l.trim().length > 5) || testFolderName, timestamp: new Date().toISOString(), testResult: 'failed' });
                                    response.markdown(`🛠️ Auto-healing vyčerpal pokusy. Uprav \`autotest/${testFolderName}/test_scenario.md\` a spusti \`@autotest regenerate ${testFolderName}\` znova.\n\n`);
                                }
                                // ===== KONIEC AUTO-HEALING =====
                            }
                        } catch (e: any) {
                            response.markdown(`*Vision analýza zlyhala: ${e.message}*\n\n`);
                        }
                    }
                }
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
                    : arg.startsWith('bug_') ? arg : arg;
                await runExistingTest(workspacePath, folderName, response, context, token);
                return;
            }
            
            // No argument - list available tests
            const autotestPath = path.join(workspacePath, 'autotest');
            if (!fs.existsSync(autotestPath)) {
                response.markdown(`❌ Priečinok \`autotest/\` neexistuje. Spusti najprv \`@autotest init\`.\n\n`);
            } else {
                const entries = fs.readdirSync(autotestPath).filter(e =>
                    fs.statSync(path.join(autotestPath, e)).isDirectory() && e !== 'data');
                if (entries.length === 0) {
                    response.markdown(`ℹ️ Žiadne testy. Vytvor test pomocou \`@autotest test\`.\n\n`);
                } else {
                    response.markdown(`📋 **Dostupné testy:**\n${entries.map(e => `- \`@autotest run ${e}\``).join('\n')}\n\n`);
                }
            }
            return;
        }

        // ===== PRÍKAZ: @autotest test (bez bug ID) =====
        if (userQuery.includes('test') && !userQuery.match(/\d+/)) {
            response.markdown(`📝 **Zadaj popis bugu...**\n\n`);
            let bugDescription = await getBugDescriptionWithClipboardOption();
            
            if (!bugDescription) {
                response.markdown(`*Popis bugu nebol zadaný. Skús znovu.*`);
                return;
            }
            
            // Handle file creation option
            if (bugDescription === '__CREATE_FILE__') {
                const workspaceFolders = vscode.workspace.workspaceFolders;
                if (!workspaceFolders || workspaceFolders.length === 0) {
                    response.markdown(`*Chyba: Nemáš otvorený žiadny projekt.*`);
                    return;
                }
                
                const workspacePath = workspaceFolders[0].uri.fsPath;
                const bugNumber = getNextBugNumber(workspacePath);
                const bugFolderName = `bug_${bugNumber.toString().padStart(3, '0')}`;
                const bugDir = path.join(workspacePath, 'autotest', bugFolderName);
                
                // Create directory structure
                if (!fs.existsSync(path.join(workspacePath, 'autotest'))) {
                    fs.mkdirSync(path.join(workspacePath, 'autotest'));
                    ensureGitignore(workspacePath);
                }
                
                fs.mkdirSync(bugDir, { recursive: true });
                
                // Create test_scenario.md with template
                const scenarioPath = path.join(bugDir, 'test_scenario.md');
                const template = `# Test Scenár: [Názov testu]

## Cieľ:
[Stručný popis čo test overuje]

## Preconditions:
- [Podmienky pred testom - napr. prihlásený používateľ, existujúce dáta]

## Test kroky:
1. [Prvý krok - napíš jasne a konkrétne, napr. "Otvor stránku /customers"]
2. [Druhý krok - ak treba vybrať niečo, špecifikuj ČO, napr. "Klikni na prvý riadok v tabuľke"]
3. [Ďalšie kroky...]

## Očakávaný výsledok:
[Ako by mala aplikácia reagovať - buď konkrétny, napr. "Tabuľka obsahuje aspoň 1 riadok", "Panel detail je viditeľný"]
`;
                
                fs.writeFileSync(scenarioPath, template);
                
                // Open the file for editing
                const doc = await vscode.workspace.openTextDocument(scenarioPath);
                await vscode.window.showTextDocument(doc);
                
                response.markdown(`📁 Vytvorený priečinok: \`autotest/${bugFolderName}\`\n\n`);
                response.markdown(`📝 Otvorený súbor: \`test_scenario.md\`\n\n`);
                response.markdown(`✏️ **Uprav test scenár a spusti znova:** \`@autotest regenerate ${bugFolderName}\`\n\n`);
                
                return;
            }
            
            // Pokračuj s testovaním pomocou manuálneho popisu
            await runAutomatedTest(context, response, token, bugDescription, undefined, config);
            return;
        }
        
        // ===== PRÍKAZ: @autotest over bug 123 =====
        const bugMatch = request.prompt.match(/\d+/);
        const bugId = bugMatch ? bugMatch[0] : null;

        if (!bugId) {
            response.markdown(`*Zadaj príkaz, napríklad:*\n`);
            response.markdown(`- \`@autotest init\` - Nastaviť konfiguráciu\n`);
            response.markdown(`- \`@autotest model\` - Vybrať AI model s vision support\n`);
            response.markdown(`- \`@autotest debug\` - Prepnúť viditeľný/neviditeľný browser\n`);
            response.markdown(`- \`@autotest over bug 123\` - Otestovať bug z TFS\n`);
            response.markdown(`- \`@autotest test\` - Otestovať podľa manuálneho popisu\n`);
            response.markdown(`- \`@autotest run bug_001\` - Spustiť existujúci test znova\n`);
            response.markdown(`- \`@autotest run 1\` - Spustiť test číslo 1 znova\n`);
            response.markdown(`- \`@autotest regenerate bug_123\` - Regenerovať test zo scenára\n`);
            response.markdown(`- \`@autotest record bug_001\` - Nahrať akcie používateľa a vygenerovať test\n`);
            response.markdown(`- \`@autotest history\` - Zobraziť históriu testov\n`);
            
            // Skontrolovať, či je konfigurácia nastavená
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
            // TFS nie je nakonfigurované - pýtaj sa manuálne
            response.markdown(`ℹ️ TFS nie je nakonfigurované. Zadaj popis bugu manuálne.\n\n`);
            bugDescription = await getBugDescriptionWithClipboardOption();
        }

        // Handle file creation option
        if (bugDescription === '__CREATE_FILE__') {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                response.markdown(`*Chyba: Nemáš otvorený žiadny projekt.*`);
                return;
            }
            
            const workspacePath = workspaceFolders[0].uri.fsPath;
            const bugFolderName = `bug_${bugId}`;
            const bugDir = path.join(workspacePath, 'autotest', bugFolderName);
            
            // Create directory structure
            if (!fs.existsSync(path.join(workspacePath, 'autotest'))) {
                fs.mkdirSync(path.join(workspacePath, 'autotest'));
                ensureGitignore(workspacePath);
            }
            
            fs.mkdirSync(bugDir, { recursive: true });
            
            // Create test_scenario.md with template
            const scenarioPath = path.join(bugDir, 'test_scenario.md');
            const template = `# Test Scenár: Bug #${bugId}

## Cieľ:
[Stručný popis čo test overuje]

## Preconditions:
- [Podmienky pred testom - napr. prihlásený používateľ, existujúce dáta]

## Test kroky:
1. [Prvý krok - napíš jasne a konkrétne, napr. "Otvor stránku /customers"]
2. [Druhý krok - ak treba vybrať niečo, špecifikuj ČO, napr. "Klikni na prvý riadok v tabuľke"]
3. [Ďalšie kroky...]

## Očakávaný výsledok:
[Ako by mala aplikácia reagovať - buď konkrétny, napr. "Tabuľka obsahuje aspoň 1 riadok", "Panel detail je viditeľný"]
`;
            
            fs.writeFileSync(scenarioPath, template);
            
            // Open the file for editing
            const doc = await vscode.workspace.openTextDocument(scenarioPath);
            await vscode.window.showTextDocument(doc);
            
            response.markdown(`📁 Vytvorený priečinok: \`autotest/${bugFolderName}\`\n\n`);
            response.markdown(`📝 Otvorený súbor: \`test_scenario.md\`\n\n`);
            response.markdown(`✏️ **Uprav test scenár a spusti znova:** \`@autotest regenerate ${bugFolderName}\`\n\n`);
            
            return;
        }

        if (!bugDescription) {
            response.markdown(`*Popis bugu nebol zadaný. Test sa nemôže spustiť.*`);
            return;
        }

        // Spustiť automatizovaný test
        await runAutomatedTest(context, response, token, bugDescription, bugId, config);
        
        return;
    });

    context.subscriptions.push(autotestAgent);
    
    // ===== Registrácia príkazov =====
    
    // Init príkaz
    const initCommand = vscode.commands.registerCommand('autotest.init', async () => {
        await runInitializationSetup(context);
    });
    
    // Reconfigure príkaz
    const reconfigureCommand = vscode.commands.registerCommand('autotest.reconfigure', async () => {
        const confirm = await vscode.window.showWarningMessage(
            'Naozaj chceš resetovať konfiguráciu?',
            'Áno', 'Nie'
        );
        if (confirm === 'Áno') {
            await resetConfiguration(context);
            tfsClient = null;
            vscode.window.showInformationMessage('✅ Konfigurácia bola resetovaná!');
        }
    });
    
    // TFS Setup príkaz
    const tfsSetupCommand = vscode.commands.registerCommand('autotest.tfsSetup', async () => {
        await setupTfsConnection(context);
    });
    
    // Cleanup príkaz
    const cleanupCommand = vscode.commands.registerCommand('autotest.cleanup', async (workspacePath: string, testFolderName?: string) => {
        try {
            // Zmaž screenshoty a výsledky zo špecifického test folderu
            if (testFolderName) {
                const testDir = path.join(workspacePath, 'autotest', testFolderName);
                const filesToDelete = ['success_screenshot.png', 'error_screenshot.png', 'not_found_screenshot.png', 'not_found_info.json', 'test_result.md', 'network.json', 'console_logs.json', 'dom.html'];
                for (const file of filesToDelete) {
                    const filePath = path.join(testDir, file);
                    if (fs.existsSync(filePath)) {
                        fs.unlinkSync(filePath);
                    }
                }
                const _cleanStepsDir = path.join(testDir, 'steps');
                if (fs.existsSync(_cleanStepsDir)) { try { fs.readdirSync(_cleanStepsDir).forEach((f: string) => { try { fs.unlinkSync(path.join(_cleanStepsDir, f)); } catch {} }); fs.rmdirSync(_cleanStepsDir); } catch {} }
            }
            
            vscode.window.showInformationMessage('🧹 Dočasné súbory boli zmazané!');
            
            // Git commit a push
            try {
                await execAsync('git add . && git commit -m "Test prešiel - bug opravený" && git push', {
                    cwd: workspacePath
                });
                vscode.window.showInformationMessage('✅ Zmeny boli pushnuté na Git!');
            } catch (gitError: any) {
                vscode.window.showWarningMessage(`⚠️ Git operácia zlyhala: ${gitError.message}`);
            }
            
        } catch (error: any) {
            vscode.window.showErrorMessage(`Chyba pri upratovaní: ${error.message}`);
        }
    });
    
    // Keep screenshots príkaz
    const keepScreenshotsCommand = vscode.commands.registerCommand('autotest.keepScreenshots', () => {
        vscode.window.showInformationMessage('📁 Screenshoty boli ponechané na ďalšie preskúmanie.');
    });

    // Run existing test príkaz
    const runTestCommand = vscode.commands.registerCommand('autotest.runTest', async (folderName?: string) => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            vscode.window.showErrorMessage('Nie je otvorený žiadny projekt!');
            return;
        }
        const workspacePath = workspaceFolders[0].uri.fsPath;
        
        if (!folderName) {
            const input = await vscode.window.showInputBox({
                prompt: 'Zadaj číslo alebo názov testu',
                placeHolder: 'bug_001 alebo 1 alebo test_init'
            });
            if (!input) { return; }
            folderName = /^\d+$/.test(input.trim())
                ? `bug_${input.trim().padStart(3, '0')}`
                : input.trim();
        }

        folderName = normalizeTestFolderName(folderName);
        if (!folderName) {
            vscode.window.showErrorMessage('Neplatný názov test priečinka.');
            return;
        }
        
        // Spusti cez Output Channel
        const channel = vscode.window.createOutputChannel('Autotest Run');
        channel.show();
        channel.appendLine(`Spúšťam test: ${folderName}`);
        
        const testDir = path.join(workspacePath, 'autotest', folderName);
        const testResultPath = path.join(testDir, 'test_result.md');
        const scenarioPath = path.join(testDir, 'test_scenario.md');

        // Označ test ako RUNNING hneď po štarte, aby dashboard reflektoval prebiehajúci beh.
        try {
            fs.writeFileSync(testResultPath, `# Test Result: RUNNING ⏳\n\n## Test Info\n- **Bug ID:** ${normalizeBugId(folderName) || 'N/A'}\n- **Timestamp:** ${new Date().toLocaleString('sk-SK')}\n- **Status:** RUNNING\n`);
        } catch {}
        notifyDashboardRefresh();
        
        // Hľadaj test súbory v poradí: test.spec.py, test.spec.js
        let testFile: string | null = null;
        let testType: 'python' | 'javascript' | null = null;
        
        const pyFile = path.join(testDir, 'test.spec.py');
        const jsFile = path.join(testDir, 'test.spec.js');
        
        if (fs.existsSync(pyFile)) {
            testFile = pyFile;
            testType = 'python';
        } else if (fs.existsSync(jsFile)) {
            testFile = jsFile;
            testType = 'javascript';
        }
        
        if (!testFile) {
            channel.appendLine(`❌ Chyba: Nenašiel sa test súbor v autotest/${folderName}`);
            channel.appendLine(`Očakávané súbory: test.spec.py, test.spec.js`);
            try {
                fs.writeFileSync(testResultPath, `# Test Result: FAILED ❌\n\n## Test Info\n- **Bug ID:** ${normalizeBugId(folderName) || 'N/A'}\n- **Timestamp:** ${new Date().toLocaleString('sk-SK')}\n- **Status:** FAILED\n\n## Error\nNenašiel sa spustiteľný test súbor v priečinku testu.`);
            } catch {}
            notifyDashboardRefresh();
            return;
        }
        
        try {
            channel.appendLine(`📄 Nájdený test: ${path.basename(testFile)} (${testType})`);
            channel.appendLine(`🚀 Spúšťam...\n`);
            
            const command = testType === 'python'
                ? `python "${testFile}"`
                : `node "${testFile}"`;
            
            const { stdout, stderr } = await execAsync(command, { cwd: testDir, timeout: 120000 });
            if (stdout) { channel.appendLine(stdout); }
            if (stderr) { channel.appendLine('⚠️ STDERR:\n' + stderr); }

            const successScreenshotPath = path.join(testDir, 'success_screenshot.png');
            const errorScreenshotPath = path.join(testDir, 'error_screenshot.png');
            const notFoundScreenshotPath = path.join(testDir, 'not_found_screenshot.png');
            const passed = fs.existsSync(successScreenshotPath) && !fs.existsSync(errorScreenshotPath) && !fs.existsSync(notFoundScreenshotPath);
            const runStatus = passed ? 'PASSED' : 'FAILED';
            const bugId = normalizeBugId(folderName) || undefined;
            let scenarioDescription = folderName;
            try {
                if (fs.existsSync(scenarioPath)) {
                    const scenarioText = fs.readFileSync(scenarioPath, 'utf-8');
                    const firstLine = scenarioText.split(/\r?\n/).find((l) => l.trim().length > 5);
                    if (firstLine) {
                        scenarioDescription = firstLine.trim();
                    }
                }
            } catch {}

            try {
                fs.writeFileSync(
                    testResultPath,
                    `# Test Result: ${passed ? 'PASSED ✅' : 'FAILED ❌'}\n\n## Test Info\n- **Bug ID:** ${bugId || 'N/A'}\n- **Timestamp:** ${new Date().toLocaleString('sk-SK')}\n- **Status:** ${runStatus}\n\n## Output\n\`\`\`\n${[stdout, stderr].filter(Boolean).join('\n').substring(0, 2000) || 'Bez výstupu'}\n\`\`\`\n`
                );
            } catch {}

            await saveBugHistory(context, {
                bugId,
                description: scenarioDescription,
                timestamp: new Date().toISOString(),
                testResult: passed ? 'success' : 'failed'
            });

            channel.appendLine(`\n${passed ? '✅' : '❌'} Test dokončený. Status: ${runStatus}`);
            notifyDashboardRefresh();
        } catch (e: any) {
            channel.appendLine(`\n❌ Chyba pri spustení: ${e.message}`);
            try {
                fs.writeFileSync(
                    testResultPath,
                    `# Test Result: FAILED ❌\n\n## Test Info\n- **Bug ID:** ${normalizeBugId(folderName) || 'N/A'}\n- **Timestamp:** ${new Date().toLocaleString('sk-SK')}\n- **Status:** FAILED\n\n## Error\n\`\`\`\n${e.message || 'Neznáma chyba'}\n\`\`\`\n`
                );
            } catch {}

            await saveBugHistory(context, {
                bugId: normalizeBugId(folderName) || undefined,
                description: folderName,
                timestamp: new Date().toISOString(),
                testResult: 'failed'
            });
            notifyDashboardRefresh();
        }
    });

    const dashboardCommand = vscode.commands.registerCommand('autotest.openDashboard', async () => {
        openAutotestDashboard(context);
    });
    
    context.subscriptions.push(
        initCommand,
        reconfigureCommand,
        tfsSetupCommand,
        cleanupCommand,
        keepScreenshotsCommand,
        runTestCommand,
        dashboardCommand
    );
}

export function deactivate() {}



