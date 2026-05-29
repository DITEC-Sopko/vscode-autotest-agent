import * as vscode from 'vscode';

/**
 * História bugov
 */
export interface BugHistoryItem {
    bugId?: string;
    description: string;
    timestamp: string;
    testResult?: 'success' | 'failed' | 'running';
}

/**
 * Interaktívne zadanie bug popisu
 */
export async function askForBugDescription(): Promise<string | undefined> {
    const description = await vscode.window.showInputBox({
        prompt: 'Opíš bug, ktorý chceš otestovať (čo nefunguje, očakávané správanie):',
        placeHolder: 'Napr: Zľavový kód LETO20 nefunguje v košíku. Mal by aplikovať 20% zľavu.',
        ignoreFocusOut: true,
        validateInput: (value) => {
            if (!value || value.trim().length < 10) {
                return 'Popis musí mať aspoň 10 znakov';
            }
            return null;
        }
    });
    
    return description?.trim();
}

/**
 * Načíta text z clipboardu
 */
export async function loadFromClipboard(): Promise<string | undefined> {
    try {
        const clipboardText = await vscode.env.clipboard.readText();
        if (clipboardText && clipboardText.trim().length > 0) {
            return clipboardText.trim();
        }
    } catch (error) {
        console.error('Chyba pri načítaní z clipboardu:', error);
    }
    return undefined;
}

/**
 * Ponúkne možnosť načítať z clipboardu alebo zadať manuálne
 */
export async function getBugDescriptionWithClipboardOption(): Promise<string | undefined> {
    const clipboardText = await loadFromClipboard();
    
    if (clipboardText && clipboardText.length > 10) {
        const useClipboard = await vscode.window.showQuickPick(
            [
                { label: '📋 Použiť text z clipboardu', value: 'clipboard', description: clipboardText.substring(0, 60) + '...' },
                { label: '✍️ Zadať manuálne', value: 'manual' }
            ],
            {
                placeHolder: 'Máš text v clipboarde. Chceš ho použiť?'
            }
        );
        
        if (useClipboard?.value === 'clipboard') {
            return clipboardText;
        }
    }
    
    return await askForBugDescription();
}

/**
 * Uloží bug do histórie
 */
export async function saveBugHistory(
    context: vscode.ExtensionContext,
    bugItem: BugHistoryItem
): Promise<void> {
    const history = context.workspaceState.get<BugHistoryItem[]>('bugHistory') || [];
    history.unshift(bugItem); // Pridaj na začiatok
    
    // Ponechaj len posledných 20 záznamov
    const trimmedHistory = history.slice(0, 20);
    
    await context.workspaceState.update('bugHistory', trimmedHistory);
}

/**
 * Načíta históriu bugov
 */
export function getBugHistory(
    context: vscode.ExtensionContext,
    limit: number = 5
): BugHistoryItem[] {
    const history = context.workspaceState.get<BugHistoryItem[]>('bugHistory') || [];
    return history.slice(0, limit);
}

/**
 * Formátuje bug históriu pre zobrazenie v chate
 */
export function formatBugHistory(history: BugHistoryItem[]): string {
    if (history.length === 0) {
        return '*Žiadna história testov.*';
    }
    
    let markdown = '### 📜 História testov:\n\n';
    
    history.forEach((item, index) => {
        const icon = item.testResult === 'success' ? '✅' : item.testResult === 'failed' ? '❌' : '⏳';
        const date = new Date(item.timestamp).toLocaleString('sk-SK');
        const bugIdText = item.bugId ? `Bug #${item.bugId}` : 'Manual test';
        
        markdown += `${index + 1}. ${icon} **${bugIdText}** - ${date}\n`;
        markdown += `   > ${item.description.substring(0, 100)}${item.description.length > 100 ? '...' : ''}\n\n`;
    });
    
    return markdown;
}

/**
 * Vymaže históriu
 */
export async function clearBugHistory(context: vscode.ExtensionContext): Promise<void> {
    await context.workspaceState.update('bugHistory', []);
}
