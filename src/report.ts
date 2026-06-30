import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Extrahuje čistý text z report/dokument súboru (PDF, DOCX, XLSX, CSV, XML, TXT…).
 * Používa sa, keď appka vygeneruje report, ktorý agent nemôže otvoriť v prehliadači (file: je blokovaný).
 */
export async function extractReportText(filePath: string): Promise<string> {
    if (!fs.existsSync(filePath)) { throw new Error(`Súbor neexistuje: ${filePath}`); }
    const ext = path.extname(filePath).toLowerCase();
    const buffer = fs.readFileSync(filePath);

    switch (ext) {
        case '.pdf': {
            // unpdf = serverless pdfjs build (bez workera a bez natívnych závislostí), bundluje sa čisto.
            const { getDocumentProxy, extractText } = await import('unpdf');
            const pdf = await getDocumentProxy(new Uint8Array(buffer));
            const { text } = await extractText(pdf, { mergePages: true });
            return (Array.isArray(text) ? text.join('\n') : String(text || '')).trim();
        }
        case '.docx': {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const mammoth = require('mammoth') as any;
            const r = await mammoth.extractRawText({ buffer });
            return String(r?.value || '').trim();
        }
        case '.xlsx':
        case '.xlsm':
        case '.xls': {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const XLSX = require('xlsx') as any;
            const wb = XLSX.read(buffer, { type: 'buffer' });
            const sheets: string[] = (wb.SheetNames || []).map((name: string) =>
                `## Hárok: ${name}\n${XLSX.utils.sheet_to_csv(wb.Sheets[name])}`.trim());
            return sheets.join('\n\n').trim();
        }
        case '.csv':
        case '.xml':
        case '.txt':
        case '.json':
        case '.html':
        case '.htm':
            return buffer.toString('utf-8').trim();
        default:
            // Skús ako text; ak je to binárka, vráti nečitateľné, ale aspoň nespadne.
            return buffer.toString('utf-8').trim();
    }
}

interface ReadReportInput { path: string; }

class ReadReportTool implements vscode.LanguageModelTool<ReadReportInput> {
    async invoke(
        options: vscode.LanguageModelToolInvocationOptions<ReadReportInput>,
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelToolResult> {
        const p = options.input?.path;
        if (!p) {
            return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('Chýba parameter "path".')]);
        }
        try {
            const text = await extractReportText(p);
            const MAX = 100_000;
            const clipped = text.length > MAX ? text.slice(0, MAX) + '\n…(obsah skrátený)' : text;
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(clipped || '(súbor neobsahuje čitateľný text)')
            ]);
        } catch (e: any) {
            return new vscode.LanguageModelToolResult([
                new vscode.LanguageModelTextPart(`Chyba pri čítaní reportu: ${e?.message || e}`)
            ]);
        }
    }

    async prepareInvocation(
        options: vscode.LanguageModelToolInvocationPrepareOptions<ReadReportInput>
    ): Promise<vscode.PreparedToolInvocation> {
        const name = options.input?.path ? path.basename(options.input.path) : 'report';
        return { invocationMessage: `Čítam report ${name}…` };
    }
}

/** Zaregistruje Language Model Tool na čítanie reportov. */
export function registerReportTool(): vscode.Disposable {
    return vscode.lm.registerTool('autotest_readReport', new ReadReportTool());
}
