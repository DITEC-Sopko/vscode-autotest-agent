import * as fs from 'fs';
import * as path from 'path';

export interface StrategyRecord {
    elementType: string;   // 'menuItem', 'button', 'window', 'textBox', atÄŹ.
    elementName: string;   // napr. 'HlavnĂ©', 'OK', 'PouĹľĂ­vateÄľ'
    strategyName: string;  // napr. 'FindFirst-NameProperty', 'MenuBar-Children'
    successCount: number;
    failureCount: number;
    lastResult: 'success' | 'failure';
    lastUpdated: string;
}

export interface AutomationMemoryData {
    appId: string;
    createdAt: string;
    updatedAt: string;
    strategies: StrategyRecord[];
    notes: string[];
}

/**
 * PerzistentnĂˇ pamĂ¤ĹĄ UI Automation stratĂ©giĂ­ pre jeden projekt.
 * UkladĂˇ ÄŤo fungovalo a ÄŤo nie, aby AI vygeneroval lepĹˇie skripty nabudĂşce.
 */
export class ProjectAutomationMemory {
    private memoryPath: string;
    public data: AutomationMemoryData;

    constructor(autotestDir: string, appId: string) {
        this.memoryPath = path.join(autotestDir, 'ui_automation_memory.json');
        this.data = this.load(appId);
    }

    private load(appId: string): AutomationMemoryData {
        if (fs.existsSync(this.memoryPath)) {
            try {
                return JSON.parse(fs.readFileSync(this.memoryPath, 'utf-8'));
            } catch {}
        }
        return {
            appId,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            strategies: [],
            notes: []
        };
    }

    save(): void {
        this.data.updatedAt = new Date().toISOString();
        fs.writeFileSync(this.memoryPath, JSON.stringify(this.data, null, 2), 'utf-8');
    }

    recordResult(
        elementType: string,
        elementName: string,
        strategyName: string,
        result: 'success' | 'failure'
    ): void {
        const existing = this.data.strategies.find(
            s => s.elementType === elementType &&
                 s.elementName === elementName &&
                 s.strategyName === strategyName
        );
        if (existing) {
            if (result === 'success') { existing.successCount++; }
            else { existing.failureCount++; }
            existing.lastResult = result;
            existing.lastUpdated = new Date().toISOString();
        } else {
            this.data.strategies.push({
                elementType,
                elementName,
                strategyName,
                successCount: result === 'success' ? 1 : 0,
                failureCount: result === 'failure' ? 1 : 0,
                lastResult: result,
                lastUpdated: new Date().toISOString()
            });
        }
        this.save();
    }

    addNote(note: string): void {
        this.data.notes.push(`[${new Date().toISOString().substring(0, 19)}] ${note}`);
        // DrĹľ max 50 poznĂˇmok
        if (this.data.notes.length > 50) {
            this.data.notes = this.data.notes.slice(-50);
        }
        this.save();
    }

    /**
     * FormĂˇtuje pamĂ¤ĹĄ pre AI prompt.
     * Vracia prĂˇzdny string ak eĹˇte nie sĂş Ĺľiadne zĂˇznamy.
     */
    formatForPrompt(): string {
        if (this.data.strategies.length === 0 && this.data.notes.length === 0) {
            return '';
        }

        const lines: string[] = ['### UI Automation pamĂ¤ĹĄ projektu (histĂłria stratĂ©giĂ­):'];

        const successful = this.data.strategies.filter(s => s.successCount > 0);
        const failedOnly = this.data.strategies.filter(s => s.failureCount > 0 && s.successCount === 0);

        if (successful.length > 0) {
            lines.push('\n**âś… FUNGUJĂšCE stratĂ©gie pre tento projekt (POUĹ˝I TIETO PREDNOSTNE):**');
            for (const s of successful) {
                lines.push(`- [${s.elementType}] "${s.elementName}" â†’ "${s.strategyName}" (${s.successCount}x Ăşspech)`);
            }
        }

        if (failedOnly.length > 0) {
            lines.push('\n**âťŚ NEFUNGUJĂšCE stratĂ©gie (VYHNI SA IM - skoÄŤia na ÄŹalĹˇĂ­ fallback):**');
            for (const s of failedOnly) {
                lines.push(`- [${s.elementType}] "${s.elementName}" â†’ "${s.strategyName}" (${s.failureCount}x zlyhanie)`);
            }
        }

        if (this.data.notes.length > 0) {
            const recentNotes = this.data.notes.slice(-5);
            lines.push('\n**PoslednĂ© poznĂˇmky z testov:**');
            for (const n of recentNotes) {
                lines.push(`- ${n}`);
            }
        }

        return lines.join('\n');
    }
}

/**
 * Parsuje console_logs.json a extrahuje záznamy o stratégiách.
 * Podporuje 3 formáty:
 *  1. PS formát: [{message: "STRATEGY_SUCCESS: type|name|strategy"}, ...]
 *  2. pywinauto v2: {logs: ["[ts] Kliknuté na: \"X\"", ...], test_passed: bool}
 *  3. pywinauto v1: ["[ts] message", ...] — pole stringov
 */
export function parseStrategyLogsFromFile(consoleLogsPath: string): Array<{
    elementType: string;
    elementName: string;
    strategyName: string;
    result: 'success' | 'failure';
}> {
    const results: Array<{ elementType: string; elementName: string; strategyName: string; result: 'success' | 'failure' }> = [];
    if (!fs.existsSync(consoleLogsPath)) { return results; }

    try {
        const raw = fs.readFileSync(consoleLogsPath, 'utf-8');
        const parsed = JSON.parse(raw);

        // Normalizuj na pole stringov
        let lines: string[] = [];
        if (Array.isArray(parsed)) {
            // PS formát: [{message: "..."}, ...] alebo pywinauto v1: ["...", ...]
            for (const item of parsed) {
                if (typeof item === 'string') {
                    lines.push(item);
                } else if (item && typeof item.message === 'string') {
                    lines.push(item.message);
                }
            }
        } else if (parsed && Array.isArray(parsed.logs)) {
            // pywinauto v2: {logs: [...], test_passed: bool}
            for (const item of parsed.logs) {
                if (typeof item === 'string') { lines.push(item); }
            }
        }

        for (const line of lines) {
            // PS formát: STRATEGY_SUCCESS / STRATEGY_FAILURE
            const successMatch = line.match(/STRATEGY_SUCCESS:\s*([^|]+)\|([^|]+)\|(.+)/);
            if (successMatch) {
                results.push({ elementType: successMatch[1].trim(), elementName: successMatch[2].trim(), strategyName: successMatch[3].trim(), result: 'success' });
                continue;
            }
            const failureMatch = line.match(/STRATEGY_FAILURE:\s*([^|]+)\|([^|]+)\|(.+)/);
            if (failureMatch) {
                results.push({ elementType: failureMatch[1].trim(), elementName: failureMatch[2].trim(), strategyName: failureMatch[3].trim(), result: 'failure' });
                continue;
            }

            // pywinauto formát: Kliknuté na: "X"
            const clickMatch = line.match(/Kliknut[ée] na:\s*"([^"]+)"/);
            if (clickMatch) {
                results.push({ elementType: 'button', elementName: clickMatch[1].trim(), strategyName: 'click_by_text', result: 'success' });
                continue;
            }

            // pywinauto formát: Element "X" nebol nájdený
            const notFoundMatch = line.match(/Element\s*"([^"]+)"\s*nebol n[aá]jden/);
            if (notFoundMatch) {
                results.push({ elementType: 'button', elementName: notFoundMatch[1].trim(), strategyName: 'click_by_text', result: 'failure' });
                continue;
            }

            // pywinauto formát: hľadal som: "X"
            const searchingMatch = line.match(/h[ľl]adal som:\s*"([^"]+)"/);
            if (searchingMatch) {
                results.push({ elementType: 'button', elementName: searchingMatch[1].trim(), strategyName: 'click_by_text', result: 'failure' });
                continue;
            }
        }
    } catch {}

    return results;
}


