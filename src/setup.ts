import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
    saveEnvironmentConfig, saveTfsConfig, saveTfsPat,
    saveLoginConfig, saveLoginPassword, saveDebugConfig, resetConfiguration
} from './config';
import { pickModel } from './util';

/** Init wizard cez QuickPick. */
export async function runInit(context: vscode.ExtensionContext): Promise<void> {
    const appType = await vscode.window.showQuickPick(['web', 'desktop'], { placeHolder: 'Typ aplikácie', ignoreFocusOut: true });
    if (!appType) { return; }
    const url = await vscode.window.showInputBox({ prompt: appType === 'web' ? 'URL aplikácie' : 'Cesta k aplikácii (.exe / .appref-ms)', ignoreFocusOut: true });
    if (url === undefined) { return; }
    await saveEnvironmentConfig(context, { url, appType, environment: 'local' });

    const needLogin = await vscode.window.showQuickPick(['Bez prihlásenia', 'Vyžaduje prihlásenie'], { placeHolder: 'Prihlásenie', ignoreFocusOut: true });
    if (needLogin === 'Vyžaduje prihlásenie') {
        const username = await vscode.window.showInputBox({ prompt: 'Používateľské meno', ignoreFocusOut: true });
        await saveLoginConfig(context, { required: true, username: username || undefined });
        const pwd = await vscode.window.showInputBox({ prompt: 'Heslo (uloží sa do secure storage)', password: true, ignoreFocusOut: true });
        if (pwd) { await saveLoginPassword(context, pwd); }
    } else {
        await saveLoginConfig(context, { required: false });
    }

    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (ws) {
        const dir = path.join(ws, 'autotest');
        if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
    }
    vscode.window.showInformationMessage('✅ Autotest inicializovaný.');
}

/** TFS pripojenie. */
export async function setupTfs(context: vscode.ExtensionContext): Promise<void> {
    const org = await vscode.window.showInputBox({ prompt: 'TFS organization URL', ignoreFocusOut: true });
    if (!org) { return; }
    const project = await vscode.window.showInputBox({ prompt: 'Projekt', ignoreFocusOut: true });
    if (!project) { return; }
    const pat = await vscode.window.showInputBox({ prompt: 'Personal Access Token', password: true, ignoreFocusOut: true });
    if (!pat) { return; }
    await saveTfsConfig(context, { enabled: true, organization: org, project });
    await saveTfsPat(context, pat);
    vscode.window.showInformationMessage('✅ TFS nakonfigurované.');
}

/** Kombinované menu nastavení. */
export async function openSettings(context: vscode.ExtensionContext): Promise<void> {
    const choice = await vscode.window.showQuickPick(
        [
            { label: '⚙️ Aplikácia a prostredie', value: 'app' },
            { label: '🔗 TFS pripojenie', value: 'tfs' },
            { label: '🤖 AI model', value: 'model' },
            { label: '🎬 Debug mód', value: 'debug' },
            { label: '♻️ Reset konfigurácie', value: 'reset' }
        ],
        { placeHolder: 'Čo chceš zmeniť?', ignoreFocusOut: true }
    );
    if (!choice) { return; }
    if (choice.value === 'app') { await runInit(context); }
    else if (choice.value === 'tfs') { await setupTfs(context); }
    else if (choice.value === 'model') { await pickModel(context); }
    else if (choice.value === 'debug') {
        const d = await vscode.window.showQuickPick(
            [{ label: '👁️ Viditeľný', value: 'h' }, { label: '⚡ Headless', value: 'f' }],
            { placeHolder: 'Mód', ignoreFocusOut: true }
        );
        if (d?.value === 'h') { await saveDebugConfig(context, { headless: false, slowMo: 100 }); }
        else if (d?.value === 'f') { await saveDebugConfig(context, { headless: true, slowMo: 0 }); }
    }
    else if (choice.value === 'reset') {
        const c = await vscode.window.showWarningMessage('Resetovať konfiguráciu?', 'Áno', 'Nie');
        if (c === 'Áno') { await resetConfiguration(context); }
    }
}
