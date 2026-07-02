import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { loadConfiguration, savePreferredCodeModel } from './config';

/** Vyberie LLM model na generovanie scenára (preferovaný alebo prvý dostupný). */
export async function selectModel(context: vscode.ExtensionContext): Promise<vscode.LanguageModelChat | undefined> {
    const cfg = loadConfiguration(context);
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (models.length === 0) { return undefined; }
    if (cfg.preferredCodeModelId) {
        const m = models.find(x => x.id === cfg.preferredCodeModelId);
        if (m) { return m; }
    }
    return models[0];
}

/** Quick pick na zmenu preferovaného modelu. */
export async function pickModel(context: vscode.ExtensionContext): Promise<void> {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (models.length === 0) { vscode.window.showWarningMessage('Žiadny dostupný AI model.'); return; }
    const choice = await vscode.window.showQuickPick(
        models.map(m => ({ label: m.name || m.id, value: m.id })),
        { placeHolder: 'Vyber AI model na generovanie scenárov', ignoreFocusOut: true }
    );
    if (choice) { await savePreferredCodeModel(context, choice.value); }
}

/** Najbližšie voľné číslo pre manuálny test (test_NNN). */
export function getNextTestNumber(workspacePath: string): number {
    return nextNumber(workspacePath, /^test_(\d+)$/);
}

function nextNumber(workspacePath: string, re: RegExp): number {
    const dir = path.join(workspacePath, 'autotest');
    if (!fs.existsSync(dir)) { return 1; }
    const nums = fs.readdirSync(dir).map(e => e.match(re)).filter(Boolean).map(m => parseInt(m![1], 10));
    return nums.length === 0 ? 1 : Math.max(...nums) + 1;
}

/** Zaístí, aby sa generované testy a výstupy neukladali do gitu (celý autotest/ vrátane .gitignore). */
export function ensureGitignore(workspacePath: string): void {
    const dir = path.join(workspacePath, 'autotest');
    if (!fs.existsSync(dir)) { return; }
    const gi = path.join(dir, '.gitignore');
    const content = '# Autotest Agent – generované testy a výstupy (nepatria do gitu)\n*\n';
    try { fs.writeFileSync(gi, content, 'utf-8'); } catch { /* ignore */ }
}
