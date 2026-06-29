import * as vscode from 'vscode';
import { loadConfiguration } from './config';
import { TfsClient } from './tfs-client';
import { getTfsPat } from './config';
import { runTest, rerunTest } from './runner';
import { runInit, openSettings, setupTfs } from './setup';
import { pickModel } from './util';
import { DashboardProvider } from './dashboard';
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

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(DashboardProvider.viewType, new DashboardProvider(context)),
        vscode.commands.registerCommand('autotest.init', () => runInit(context)),
        vscode.commands.registerCommand('autotest.settings', () => openSettings(context)),
        vscode.commands.registerCommand('autotest.tfsSetup', () => setupTfs(context)),
        vscode.commands.registerCommand('autotest.model', () => pickModel(context)),
        vscode.commands.registerCommand('autotest.openDashboard', () => vscode.commands.executeCommand('autotest.dashboardView.focus'))
    );

    const agent = vscode.chat.createChatParticipant('autotest.agent', async (request, _ctx, response, token) => {
        const cfg = loadConfiguration(context);
        const prompt = request.prompt.trim();
        const lower = prompt.toLowerCase();

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
            if (ws) { await rerunTest(context, response, ws, regMatch[1], cfg); }
            return;
        }

        const bugMatch = prompt.match(/bug\s*#?\s*(\d+)/i);
        let bugId: string | undefined;
        let description: string | undefined;
        if (bugMatch) {
            bugId = bugMatch[1];
            const tfs = await ensureTfs(context);
            if (tfs) {
                try {
                    const d = await tfs.getBugDetails(parseInt(bugId));
                    if (d) { description = `${d.title}\n\n${d.description}`; }
                } catch { /* ignore */ }
            }
            if (!description) { description = await getBugDescriptionWithClipboardOption(); }
        } else {
            description = await getBugDescriptionWithClipboardOption();
        }
        if (!description || description === '__CREATE_FILE__') { response.markdown('*Popis nezadaný.*'); return; }
        await runTest(context, response, token, description, bugId, cfg);
    });
    agent.iconPath = new vscode.ThemeIcon('beaker');
    context.subscriptions.push(agent);
}

export function deactivate() { /* noop */ }
