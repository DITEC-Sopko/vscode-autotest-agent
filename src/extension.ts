import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { loadConfiguration } from './config';
import { TfsClient, LinkedTestCase } from './tfs-client';
import { getTfsPat } from './config';
import { runTest, rerunTest, regenerateScenario } from './runner';
import { runInit, openSettings, setupTfs } from './setup';
import { pickModel } from './util';
import { DashboardProvider, launchSignal, dashboardRefreshSignal } from './dashboard';
import { registerReportTool } from './report';
import { getBugDescriptionWithClipboardOption, getBugHistory, formatBugHistory } from './bug-input';

let tfsClient: TfsClient | null = null;

async function ensureTfs(context: vscode.ExtensionContext): Promise<TfsClient | null> {
    const cfg = loadConfiguration(context);
    if (!cfg.tfsEnabled || !cfg.tfsOrganization || !cfg.tfsProject) { return null; }
    const pat = await getTfsPat(context);
    if (!pat) { return null; }
    if (!tfsClient) {
        tfsClient = new TfsClient();
        try { await tfsClient.connect(cfg.tfsOrganization, cfg.tfsProject, pat); } catch { tfsClient = null; }
    }
    return tfsClient;
}

/**
 * Zobrazí v chate tlačidlá pre voľbu, ako spracovať bug s prepojeným Test Casom
 * (rovnako ako tlačidlo spustenia testu). Kliknutie znovu vyvolá participanta
 * s pôvodným dopytom rozšíreným o marker `tc:<id>` alebo `tc:none`.
 * @param baseQuery pôvodný dopyt bez markera, napr. `bug #123` alebo `regenerate bug_123`.
 */
function presentTestCaseButtons(
    response: vscode.ChatResponseStream,
    baseQuery: string,
    bugId: string,
    testCases: LinkedTestCase[]
): void {
    response.markdown(`🔗 Pre bug #${bugId} som na TFS našiel prepojený test case (${testCases.map(t => `#${t.id} „${t.title}" – ${t.relation}`).join(', ')}).\n\n`);
    response.markdown(`**Ako vygenerovať test scenár?**\n\n`);
    response.button({
        command: 'workbench.action.chat.open',
        title: '🐞 Len podľa popisu bugu',
        arguments: [{ query: `@autotest ${baseQuery} tc:none` }]
    });
    for (const tc of testCases) {
        const stepCount = tc.steps ? tc.steps.split('\n').filter(l => /^\d+\./.test(l.trim())).length : 0;
        const suffix = stepCount ? ` (${stepCount} krokov)` : '';
        response.button({
            command: 'workbench.action.chat.open',
            title: `📋 Celý test case #${tc.id}: ${tc.title}${suffix}`,
            arguments: [{ query: `@autotest ${baseQuery} tc:${tc.id}` }]
        });
    }
}

/** Zloží popis pre generátor scenára z popisu bugu a krokov prepojeného test casu. */
function buildDescriptionWithTestCase(bugDescription: string, tc: LinkedTestCase): string {
    let block = `\n\n## Prepojený Test Case #${tc.id}: ${tc.title} (${tc.relation})\n`
        + `Vykonaj celý tento testovací prípad ako celok a spolu s ním over aj opravu bugu vyššie.`;
    if (tc.steps) {
        block += `\n\n### Kroky test casu:\n${tc.steps}`;
    } else {
        block += `\n\n(Test case nemá v TFS definované kroky – vychádzaj z jeho názvu a popisu bugu.)`;
    }
    return `${bugDescription}${block}`;
}

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        registerReportTool(),
        vscode.window.registerWebviewViewProvider(DashboardProvider.viewType, new DashboardProvider(context)),
        vscode.commands.registerCommand('autotest.init', () => runInit(context)),
        vscode.commands.registerCommand('autotest.settings', () => openSettings(context)),
        vscode.commands.registerCommand('autotest.tfsSetup', () => setupTfs(context)),
        vscode.commands.registerCommand('autotest.model', () => pickModel(context)),
        vscode.commands.registerCommand('autotest.openDashboard', () => vscode.commands.executeCommand('autotest.dashboardView.focus')),
        // Tlačidlo „Spustiť v agent mode" volá tento príkaz → marker `.running` sa zapíše
        // až pri REÁLNOM spustení (nie pri generovaní scenára), potom forwardne do chatu.
        vscode.commands.registerCommand('autotest.launchAgentRun', async (arg: { folder?: string; query?: string }) => {
            const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (ws && arg?.folder) {
                try { const rd = path.join(ws, 'autotest', arg.folder); if (fs.existsSync(rd)) { fs.writeFileSync(path.join(rd, '.running'), ''); } } catch { /* ignore */ }
            }
            launchSignal.fire();
            // Beh testu sa spustí v AKTUÁLNEJ Copilot relácii (bez zakladania novej).
            await vscode.commands.executeCommand('workbench.action.chat.open', { query: arg?.query ?? '', mode: 'agent', isPartialQuery: false });
        }),
        vscode.commands.registerCommand('autotest.fetchTfsBugs', async () => {
            const cfg = loadConfiguration(context);
            if (!cfg.tfsEnabled) { return { ok: false, error: 'TFS nie je zapnuté v Nastaveniach.' }; }
            const tfs = await ensureTfs(context);
            if (!tfs) { return { ok: false, error: 'Pripojenie k TFS zlyhalo (skontroluj organization/projekt/token).' }; }
            try {
                const states = (cfg.tfsStates || 'Proposed, Active').split(',').map(s => s.trim()).filter(Boolean);
                const types = (cfg.tfsTypes || 'Bug, Requirement, Test Case').split(',').map(s => s.trim()).filter(Boolean);
                const bugs = await tfs.getMyWorkItems(states, types, cfg.tfsAssignedToMe !== false);
                const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                const withTest = bugs.map(b => {
                    const dir = ws ? path.join(ws, 'autotest', `bug_${b.id}`) : '';
                    const hasTest = !!(dir && fs.existsSync(dir));
                    // Neaktuálny scenár: bug sa zmenil po vytvorení/regenerácii scenára (podľa meta.json).
                    let outdated = false;
                    if (hasTest && b.changedDate) {
                        try {
                            const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf-8'));
                            if (meta?.bugChangedDate && new Date(b.changedDate).getTime() > new Date(meta.bugChangedDate).getTime()) { outdated = true; }
                        } catch { /* meta chýba → nevieme porovnať, ber ako aktuálny */ }
                    }
                    return { ...b, hasTest, outdated };
                });
                return { ok: true, bugs: withTest };
            } catch (e: any) {
                return { ok: false, error: e?.message || 'Načítanie work items zlyhalo.' };
            }
        })
    );

    const agent = vscode.chat.createChatParticipant('autotest.agent', async (request, _ctx, response, token) => {
        const cfg = loadConfiguration(context);
        const prompt = request.prompt.trim();
        const lower = prompt.toLowerCase();
        // Marker voľby test casu z chat tlačidla: `tc:none` = len popis bugu, `tc:<id>` = celý test case.
        const tcChoiceMatch = prompt.match(/\btc:(none|\d+)\b/i);

        if (request.command === 'init' || lower === 'init') { await runInit(context); response.markdown('✅ Inicializované.'); return; }
        if (request.command === 'model' || lower === 'model') { await pickModel(context); response.markdown('✅ Model nastavený.'); return; }
        if (request.command === 'history' || lower === 'history') { response.markdown(formatBugHistory(getBugHistory(context, 10))); return; }

        const runMatch = lower.match(/^run\s+([\w]+)/);
        if (runMatch) {
            const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (ws) { await rerunTest(context, response, ws, runMatch[1], cfg); }
            return;
        }
        const regMatch = lower.match(/^regenerate\s+([\w]+)/);
        if (regMatch) {
            const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            const folder = regMatch[1];
            if (!ws) { return; }
            const bugIdMatch = folder.match(/^bug_(\d+)$/);
            if (!bugIdMatch) {
                response.markdown('ℹ️ Regenerácia je dostupná len pre TFS testy (`bug_*`). Manuálny scenár uprav priamo v `test_scenario.md`.');
                return;
            }
            const bugId = bugIdMatch[1];
            const tfs = await ensureTfs(context);
            if (!tfs) { response.markdown('*Chyba: pripojenie k TFS zlyhalo (skontroluj Nastavenia).*'); return; }
            let d: { title: string; description: string; comments: string[]; changedDate: string } | null = null;
            try { d = await tfs.getBugDetails(parseInt(bugId)); } catch { /* ignore */ }
            if (!d) { response.markdown(`*Chyba: nepodarilo sa načítať bug #${bugId} z TFS.*`); return; }
            let txt = `${d.title}\n\n${d.description}`;
            if (d.comments && d.comments.length) {
                txt += `\n\n## Komentáre (TFS diskusia – najnovšie info môže meniť pôvodný popis):\n`
                    + d.comments.map((c, i) => `${i + 1}. ${c}`).join('\n');
            }
            // Ak je k bugu prepojený Test Case (Related / Tested By), ponúkni voľbu v chate:
            // scenár len z popisu bugu, alebo celý test case + otestovať ako celok.
            let linkedTestCases: LinkedTestCase[] = [];
            try { linkedTestCases = await tfs.getLinkedTestCases(parseInt(bugId)); } catch { /* ignore */ }
            if (linkedTestCases.length) {
                if (!tcChoiceMatch) { presentTestCaseButtons(response, `regenerate ${folder}`, bugId, linkedTestCases); return; }
                const val = tcChoiceMatch[1].toLowerCase();
                if (val !== 'none') {
                    const tc = linkedTestCases.find(t => t.id === parseInt(val));
                    if (tc) { txt = buildDescriptionWithTestCase(txt, tc); }
                }
            }
            await regenerateScenario(context, response, token, ws, folder, bugId, txt, d.changedDate, cfg);
            dashboardRefreshSignal.fire();
            return;
        }

        const bugMatch = prompt.match(/bug\s*#?\s*(\d+)/i);
        let bugId: string | undefined;
        let description: string | undefined;
        let bugChangedDate: string | undefined;
        if (bugMatch) {
            bugId = bugMatch[1];
            let linkedTestCases: LinkedTestCase[] = [];
            const tfs = await ensureTfs(context);
            if (tfs) {
                try {
                    const d = await tfs.getBugDetails(parseInt(bugId));
                    if (d) {
                        let txt = `${d.title}\n\n${d.description}`;
                        if (d.comments && d.comments.length) {
                            txt += `\n\n## Komentáre (TFS diskusia – najnovšie info môže meniť pôvodný popis):\n`
                                + d.comments.map((c, i) => `${i + 1}. ${c}`).join('\n');
                        }
                        description = txt;
                        bugChangedDate = d.changedDate;
                    }
                } catch { /* ignore */ }
                try { linkedTestCases = await tfs.getLinkedTestCases(parseInt(bugId)); } catch { /* ignore */ }
            }
            if (!description) { description = await getBugDescriptionWithClipboardOption(); }
            // Ak je k bugu prepojený Test Case (Related / Tested By), ponúkni voľbu v chate:
            // scenár len z popisu bugu, alebo celý test case + otestovať ako celok.
            if (description && description !== '__CREATE_FILE__' && linkedTestCases.length) {
                if (!tcChoiceMatch) { presentTestCaseButtons(response, `bug #${bugId}`, bugId, linkedTestCases); return; }
                const val = tcChoiceMatch[1].toLowerCase();
                if (val !== 'none') {
                    const tc = linkedTestCases.find(t => t.id === parseInt(val));
                    if (tc) { description = buildDescriptionWithTestCase(description, tc); }
                }
            }
        } else {
            description = await getBugDescriptionWithClipboardOption();
        }
        if (!description || description === '__CREATE_FILE__') { response.markdown('*Popis nezadaný.*'); return; }
        await runTest(context, response, token, description, bugId, cfg, bugChangedDate);
    });
    agent.iconPath = new vscode.ThemeIcon('beaker');
    context.subscriptions.push(agent);
}

export function deactivate() { /* noop */ }
