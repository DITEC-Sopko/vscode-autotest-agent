/**
 * Zdieľané utility funkcie pre web a desktop agentov.
 * Importované z agent-web.ts a agent-desktop.ts.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import {
    loadConfiguration,
    savePreferredCodeModel,
    savePreferredVisionModel,
    AutotestConfig
} from './config';

export const execAsync = promisify(exec);

export function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function getNextBugNumber(workspacePath: string): number {
    const autotestDir = path.join(workspacePath, 'autotest');
    if (!fs.existsSync(autotestDir)) { return 1; }
    const entries = fs.readdirSync(autotestDir);
    const bugNumbers: number[] = [];
    for (const entry of entries) {
        const match = entry.match(/^bug_(\d+)$/);
        if (match) { bugNumbers.push(parseInt(match[1], 10)); }
    }
    return bugNumbers.length === 0 ? 1 : Math.max(...bugNumbers) + 1;
}

export function getNextTestNumber(workspacePath: string): number {
    const autotestDir = path.join(workspacePath, 'autotest');
    if (!fs.existsSync(autotestDir)) { return 1; }
    const entries = fs.readdirSync(autotestDir);
    const testNumbers: number[] = [];
    for (const entry of entries) {
        const match = entry.match(/^test_(\d+)$/);
        if (match) { testNumbers.push(parseInt(match[1], 10)); }
    }
    return testNumbers.length === 0 ? 1 : Math.max(...testNumbers) + 1;
}

export function ensureGitignore(workspacePath: string): void {
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
            fs.writeFileSync(gitignorePath, autotestEntries + '\n');
            return;
        }
        const content = fs.readFileSync(gitignorePath, 'utf-8');
        if (!content.includes('autotest/')) {
            const newContent = content.endsWith('\n') ? content + autotestEntries + '\n' : content + '\n' + autotestEntries + '\n';
            fs.writeFileSync(gitignorePath, newContent);
        }
    } catch (error) {
        console.error('Failed to update .gitignore:', error);
    }
}

export async function ensurePlaywrightInstalled(workspacePath: string, response: vscode.ChatResponseStream): Promise<boolean> {
    if (fs.existsSync(path.join(workspacePath, 'node_modules', 'playwright'))) {
        return true;
    }
    response.markdown(`📦 **Inštalujem Playwright (prvé použitie)...**\n\n`);
    try {
        response.markdown(`⏳ Inštalujem npm balíček...\n\n`);
        await execAsync('npm install playwright', { cwd: workspacePath, timeout: 120000 });
        response.markdown(`⏳ Sťahujem browsery (Chromium)...\n\n`);
        await execAsync('npx playwright install chromium', { cwd: workspacePath, timeout: 180000 });
        response.markdown(`✅ **Playwright úspešne nainštalovaný!**\n\n`);
        return true;
    } catch (error: any) {
        response.markdown(`❌ **Chyba pri inštalácii Playwright:**\n\`\`\`\n${error.message}\n\`\`\`\n\n`);
        return false;
    }
}

export async function findPythonExecutable(): Promise<string | null> {
    for (const cmd of ['python', 'python3', 'py']) {
        try {
            const { stdout } = await execAsync(`${cmd} --version`, { timeout: 5000 });
            if (stdout.includes('Python 3') || stdout.includes('Python 2')) { return cmd; }
        } catch {}
    }
    const directPaths = [
        `${process.env.LOCALAPPDATA}\\Programs\\Python\\Python310\\python.exe`,
        `${process.env.LOCALAPPDATA}\\Programs\\Python\\Python311\\python.exe`,
        `${process.env.LOCALAPPDATA}\\Programs\\Python\\Python312\\python.exe`,
        `${process.env.LOCALAPPDATA}\\Programs\\Python\\Python39\\python.exe`,
        'C:\\Python310\\python.exe',
        'C:\\Python311\\python.exe',
    ];
    for (const p of directPaths) {
        if (p && fs.existsSync(p)) { return p; }
    }
    return null;
}

export async function ensurePywinautoInstalled(response: vscode.ChatResponseStream): Promise<[string, boolean]> {
    const python = await findPythonExecutable();
    if (!python) {
        response.markdown(`❌ **Python nebol nájdený.** Inštaluj Python 3 z https://www.python.org/downloads/\n\n`);
        return ['', false];
    }
    try {
        const { stdout } = await execAsync(`"${python}" -m pip show pywinauto`, { timeout: 10000 });
        if (stdout.includes('pywinauto')) { return [python, true]; }
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

export async function selectAIModel(
    context: vscode.ExtensionContext,
    purpose: 'code' | 'vision' = 'code',
    forceSelect = false
): Promise<vscode.LanguageModelChat | null> {
    const config = loadConfiguration(context);
    const savedId = purpose === 'code' ? config.preferredCodeModelId : config.preferredVisionModelId;

    if (!forceSelect && savedId) {
        const models = await vscode.lm.selectChatModels({ id: savedId });
        if (models.length > 0) { return models[0]; }
    }

    const allModels = await vscode.lm.selectChatModels();
    if (allModels.length === 0) {
        vscode.window.showErrorMessage('Nenašli sa žiadne dostupné AI modely. Uisti sa, že máš aktívne GitHub Copilot subscription.');
        return null;
    }

    const visionCapableModels = allModels.filter(m => {
        const id = m.id.toLowerCase();
        const fam = m.family.toLowerCase();
        return id.includes('gpt-4') || id.includes('vision') || id.includes('4o') || id.includes('claude') ||
               fam.includes('gpt-4') || fam.includes('vision') || fam.includes('claude');
    });

    const available = purpose === 'vision' ? (visionCapableModels.length > 0 ? visionCapableModels : allModels) : allModels;

    const selected = await vscode.window.showQuickPick(
        allModels.map(m => ({
            label: m.name || m.id,
            description: `${m.vendor} - ${m.family || 'N/A'}`,
            detail: visionCapableModels.includes(m) ? '✓ Podporuje vision/OCR' : 'Kódovací model',
            model: m
        })),
        {
            placeHolder: purpose === 'code' ? 'Vyber model na generovanie kódu:' : 'Vyber model na analýzu screenshotov:',
            title: purpose === 'code' ? 'Autotest - Kódovací model' : 'Autotest - Vision model',
            ignoreFocusOut: true
        }
    );

    if (!selected) { return available[0]; }

    if (purpose === 'code') {
        await savePreferredCodeModel(context, selected.model.id);
    } else {
        await savePreferredVisionModel(context, selected.model.id);
    }
    vscode.window.showInformationMessage(`✅ ${purpose === 'code' ? 'Kódovací model' : 'Vision model'} nastavený: ${selected.label}`);
    return selected.model;
}

// ─── Healing context ─────────────────────────────────────────────────────────

export function getHealingContextPath(testDir: string): string {
    return path.join(testDir, 'healing_context.md');
}

export function loadTestHealingContext(testDir: string): string {
    const filePath = getHealingContextPath(testDir);
    if (!fs.existsSync(filePath)) { return ''; }
    try { return fs.readFileSync(filePath, 'utf-8').trim(); } catch { return ''; }
}

export function loadProjectHealingLessons(workspacePath: string): string {
    const filePath = path.join(workspacePath, 'autotest', 'healing_lessons.md');
    if (!fs.existsSync(filePath)) { return ''; }
    try { return fs.readFileSync(filePath, 'utf-8').trim(); } catch { return ''; }
}

export function refreshProjectHealingLessons(autotestDir: string): void {
    try {
        if (!fs.existsSync(autotestDir)) { return; }
        const sections: string[] = [];
        const folders = fs.readdirSync(autotestDir)
            .filter(e => { const f = path.join(autotestDir, e); return fs.statSync(f).isDirectory() && e !== 'data'; })
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        for (const folder of folders) {
            const content = loadTestHealingContext(path.join(autotestDir, folder));
            if (content) { sections.push(`## ${folder}\n\n${content}`); }
        }
        const outPath = path.join(autotestDir, 'healing_lessons.md');
        if (sections.length === 0) { try { fs.unlinkSync(outPath); } catch {} return; }
        fs.writeFileSync(outPath, [
            '# Healing Lessons (Auto-generated)', '',
            'Agregovaný prehľad aktuálnych problémov a návrhov opráv.', '',
            ...sections
        ].join('\n'), 'utf-8');
    } catch {}
}

export function saveHealingContext(
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
        if (!fs.existsSync(testDir)) { fs.mkdirSync(testDir, { recursive: true }); }
        const content = [
            '# Healing Context', '',
            `- Source: ${source}`,
            `- Timestamp: ${new Date().toISOString()}`,
            searchingFor ? `- Missing element: ${searchingFor}` : '- Missing element: n/a',
            '', '## Problem',
            (errorAnalysis || '').trim().substring(0, 3000) || 'n/a',
            '', '## Where It Failed', '```',
            (failureDetail || '').trim().substring(0, 1600) || 'n/a',
            '```', '', '## Scenario Context',
            (testScenario || '').trim().substring(0, 1200) || 'n/a',
            '', '## Possible Fixes',
            '- Use this file as hard context for next regenerate.',
            '- Delete this file after PASS to avoid stale fixes.', ''
        ].join('\n');
        fs.writeFileSync(getHealingContextPath(testDir), content, 'utf-8');
        refreshProjectHealingLessons(path.join(workspacePath, 'autotest'));
    } catch {}
}

export function clearHealingContext(workspacePath: string, testFolderName: string): void {
    try {
        const testDir = path.join(workspacePath, 'autotest', testFolderName);
        try { fs.unlinkSync(getHealingContextPath(testDir)); } catch {}
        refreshProjectHealingLessons(path.join(workspacePath, 'autotest'));
    } catch {}
}

// ─── Spoločná pomôcka pre vision analýzu screenshotu ────────────────────────

export async function analyzeScreenshotWithVision(
    visionModel: vscode.LanguageModelChat,
    token: vscode.CancellationToken,
    screenshotPath: string,
    prompt: string
): Promise<string> {
    const buf = fs.readFileSync(screenshotPath);
    const msgs = [vscode.LanguageModelChatMessage.User([
        new vscode.LanguageModelTextPart(prompt),
        vscode.LanguageModelDataPart.image(buf, 'image/png')
    ])];
    const resp = await visionModel.sendRequest(msgs, {}, token);
    let result = '';
    for await (const chunk of resp.text) { result += chunk; }
    return result;
}

// ─── Spoločný diagnostics helper pre web testy ───────────────────────────────

export const WEB_DIAGNOSTICS_HELPER = `// Autogenerated diagnostics helper - attach to Playwright page as: await attachDiagnostics(page)
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
            } catch(e) {}
        };
    } catch(e) {}
}
`;
