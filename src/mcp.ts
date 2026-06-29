import * as fs from 'fs';
import * as path from 'path';

/** MCP server pre danú platformu. */
export type Platform = 'desktop' | 'web';

/**
 * Zapíše/aktualizuje `.vscode/mcp.json` pre danú platformu. Zachová ostatné servery.
 * Vráti true ak sa súbor vytvoril/zmenil.
 */
export function ensureMcpConfigured(workspacePath: string, platform: Platform, headless: boolean): boolean {
    const vscodeDir = path.join(workspacePath, '.vscode');
    const mcpPath = path.join(vscodeDir, 'mcp.json');

    const server = platform === 'desktop'
        ? { command: 'npx', args: ['-y', 'terminator-mcp-agent@latest'], env: { LOG_LEVEL: 'info' } }
        : { command: 'npx', args: ['-y', '@playwright/mcp@latest', headless ? '--headless' : '--no-headless', '--output-dir', 'autotest/_mcp_output'] };
    const name = platform === 'desktop' ? 'terminator' : 'playwright';

    let root: any = {};
    if (fs.existsSync(mcpPath)) {
        try { root = JSON.parse(fs.readFileSync(mcpPath, 'utf-8')) || {}; } catch { root = {}; }
    }
    if (typeof root !== 'object' || root === null) { root = {}; }
    if (typeof root.servers !== 'object' || root.servers === null) { root.servers = {}; }

    const before = JSON.stringify(root.servers[name] || null);
    root.servers[name] = server;
    if (fs.existsSync(mcpPath) && before === JSON.stringify(server)) { return false; }

    if (!fs.existsSync(vscodeDir)) { fs.mkdirSync(vscodeDir, { recursive: true }); }
    fs.writeFileSync(mcpPath, JSON.stringify(root, null, 2) + '\n', 'utf-8');
    return true;
}
