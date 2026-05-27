import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
    vscode.window.showInformationMessage('Autotest Agent je aktívny!');

    const autotestAgent = vscode.chat.createChatParticipant('autotest.agent', async (request, context, response, token) => {
        
        const userQuery = request.prompt; 

        response.markdown(`Ahoj! Som tvoj Autotest Agent. 🤖\n\n`);
        
        // 1. Zistenie čísla bugu z príkazu
        const bugMatch = userQuery.match(/\d+/);
        const bugId = bugMatch ? bugMatch[0] : 'Neznámy';

        if (bugId === 'Neznámy') {
            response.markdown(`*Zabudol si zadať číslo bugu. Skús napríklad: @autotest over bug 123*`);
            return;
        }

        // 2. Získanie kontextu (Tu by bežal MCP protokol. Teraz simulujeme odpoveď z Jiry/GitHubu)
        response.markdown(`🔍 Hľadám detaily pre **Bug #${bugId}**...\n\n`);
        const bugDescription = `V košíku nefunguje zľavový kód 'LETO20'. Po jeho zadaní sa má zobraziť zľava a výsledná cena má byť 10€. Teraz sa nič nestane.`;
        response.markdown(`> **Popis z bug trackera:** ${bugDescription}\n\n`);

        // 3. Generovanie automatizovaného testu pomocou Copilot LLM
        response.markdown(`⚙️ Generujem Playwright automatizovaný test...\n\n`);

        try {
            // Zavoláme vstavané Language Model API (Mozog Copilota)
            const [model] = await vscode.lm.selectChatModels({ family: 'gpt-4o' }); // Vyberieme najlepší model
            
            if (!model) {
                response.markdown(`*Chyba: Nenašiel sa AI model. Uisti sa, že máš aktívneho Copilota.*`);
                return;
            }

            // Inštrukcia pre AI: Ako má vyzerať náš test
            const prompt = `
            Si expert na QA a Playwright. Napíš čistý JavaScript kód (Playwright), ktorý overí tento bug: "${bugDescription}".
            Test pôjde na adresu 'http://localhost:3000', vykoná akcie (zadanie kódu) a úplne na konci vytvorí screenshot.
            Screenshot sa musí uložiť do 'test_screenshots/check.png'.
            Vráť IBA a LEN kód, žiadne vysvetľovanie, žiadny markdown naokolo.
            `;

            const messages = [ vscode.LanguageModelChatMessage.User(prompt) ];
            const chatResponse = await model.sendRequest(messages, {}, token);
            
            let generatedCode = '';
            for await (const chunk of chatResponse.text) {
                generatedCode += chunk;
            }

            // Očistíme kód, ak by nám AI predsa len pridalo ```javascript
            generatedCode = generatedCode.replace(/```javascript|```typescript|```/g, '').trim();

            // 4. Uloženie kódu do reálneho súboru v tvojom projekte
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (workspaceFolders) {
                const workspacePath = workspaceFolders[0].uri.fsPath;
                
                // Vytvoríme priečinok test_screenshots, ak neexistuje
                const testDir = path.join(workspacePath, 'test_screenshots');
                if (!fs.existsSync(testDir)){
                    fs.mkdirSync(testDir);
                }

                // Uložíme vygenerovaný test do súboru
                const testFilePath = path.join(workspacePath, 'autotest.spec.js');
                fs.writeFileSync(testFilePath, generatedCode);
                
                response.markdown(`✅ **Test bol úspešne vygenerovaný a uložený do \`autotest.spec.js\`!**\n\n`);
                response.markdown(`Tu je náhľad vygenerovaného kódu:\n\`\`\`javascript\n${generatedCode}\n\`\`\``);
                
            } else {
                response.markdown(`*Chyba: Nemáš otvorený žiadny projekt, neviem kam uložiť súbor.*`);
            }

        } catch (err) {
            response.markdown(`*Nastala chyba pri komunikácii s AI: ${err}*`);
        }

        return;
    });

    context.subscriptions.push(autotestAgent);
}

export function deactivate() {}