import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { 
    loadConfiguration, 
    saveUserRole, 
    saveEnvironmentConfig, 
    saveTfsConfig, 
    saveTfsPat,
    getTfsPat,
    resetConfiguration,
    savePreferredCodeModel,
    savePreferredVisionModel,
    saveLoginConfig,
    saveLoginPassword,
    getLoginPassword,
    saveDebugConfig,
    AutotestConfig
} from './config';
import { 
    getBugDescriptionWithClipboardOption,
    saveBugHistory,
    getBugHistory,
    formatBugHistory,
    BugHistoryItem
} from './bug-input';
import { TfsClient } from './tfs-client';

const execAsync = promisify(exec);
let tfsClient: TfsClient | null = null;

/**
 * Zabezpečí že autotest/ je v .gitignore používateľovho projektu
 */
function ensureGitignore(workspacePath: string): void {
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
            // .gitignore neexistuje - vytvor nový
            fs.writeFileSync(gitignorePath, autotestEntries + '\n');
            return;
        }
        
        // .gitignore existuje - skontroluj či už obsahuje autotest/
        const gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
        
        if (!gitignoreContent.includes('autotest/')) {
            // Pridaj na koniec
            const newContent = gitignoreContent.endsWith('\n') 
                ? gitignoreContent + autotestEntries + '\n'
                : gitignoreContent + '\n' + autotestEntries + '\n';
            
            fs.writeFileSync(gitignorePath, newContent);
        }
    } catch (error) {
        console.error('Failed to update .gitignore:', error);
        // Nefatálna chyba - pokračuj ďalej
    }
}

/**
 * Skontroluje či je Playwright nainštalovaný a v prípade potreby ho nainštaluje
 */
async function ensurePlaywrightInstalled(workspacePath: string, response: vscode.ChatResponseStream): Promise<boolean> {
    const playwrightPath = path.join(workspacePath, 'node_modules', 'playwright');
    
    // Playwright už je nainštalovaný
    if (fs.existsSync(playwrightPath)) {
        return true;
    }
    
    response.markdown(`📦 **Inštalujem Playwright (prvé použitie)...**\n\n`);
    response.markdown(`*Toto môže trvať 1-2 minúty. Playwright sa inštaluje len raz pre každý projekt.*\n\n`);
    
    try {
        // Inštalácia Playwright npm balíčka
        response.markdown(`⏳ Inštalujem npm balíček...\n\n`);
        await execAsync('npm install playwright', {
            cwd: workspacePath,
            timeout: 120000 // 2 minúty
        });
        
        // Inštalácia browserov
        response.markdown(`⏳ Sťahujem browsery (Chromium)...\n\n`);
        await execAsync('npx playwright install chromium', {
            cwd: workspacePath,
            timeout: 180000 // 3 minúty
        });
        
        response.markdown(`✅ **Playwright úspešne nainštalovaný!**\n\n`);
        return true;
        
    } catch (error: any) {
        response.markdown(`❌ **Chyba pri inštalácii Playwright:**\n\`\`\`\n${error.message}\n\`\`\`\n\n`);
        response.markdown(`*Skús manuálne spustiť:\n\`npm install playwright\`\n\`npx playwright install chromium\`*\n\n`);
        return false;
    }
}

/**
 * Vyber AI model
 * @param purpose - 'code' pre generovanie testov/scenárov, 'vision' pre analýzu obrázkov
 * @param forceSelect - ak true, vždy zobraz picker (ignoruj uloženú voľbu)
 */
async function selectAIModel(context: vscode.ExtensionContext, purpose: 'code' | 'vision' = 'code', forceSelect = false): Promise<vscode.LanguageModelChat | null> {
    const config = loadConfiguration(context);
    
    const savedId = purpose === 'code' ? config.preferredCodeModelId : config.preferredVisionModelId;

    // Ak je už vybraný model a nevynucujeme výber, skús ho použiť
    if (!forceSelect && savedId) {
        const models = await vscode.lm.selectChatModels({ id: savedId });
        if (models.length > 0) {
            return models[0];
        }
    }
    
    // Načítaj všetky dostupné modely
    const allModels = await vscode.lm.selectChatModels();
    
    if (allModels.length === 0) {
        vscode.window.showErrorMessage('Nenašli sa žiadne dostupné AI modely. Uisti sa, že máš aktívne GitHub Copilot subscription.');
        return null;
    }

    // Pre vision: filtruj modely s image support
    const visionCapableModels = allModels.filter(model => {
        const modelIdLower = model.id.toLowerCase();
        const familyLower = model.family.toLowerCase();
        return modelIdLower.includes('gpt-4') ||
               modelIdLower.includes('vision') ||
               modelIdLower.includes('4o') ||
               modelIdLower.includes('claude') ||
               familyLower.includes('gpt-4') ||
               familyLower.includes('vision') ||
               familyLower.includes('claude');
    });

    const availableModels = purpose === 'vision'
        ? (visionCapableModels.length > 0 ? visionCapableModels : allModels)
        : allModels;

    const title = purpose === 'code'
        ? 'Autotest - Model na generovanie testov a scenárov'
        : 'Autotest - Model na analýzu obrázkov (Vision)';
    const placeHolder = purpose === 'code'
        ? 'Vyber model na generovanie kódu (napr. claude, gpt-4o, o3...):'
        : 'Vyber model na analýzu screenshotov (musí podporovať vision):';
    
    // Ponúkni používateľovi výber
    const modelChoices = allModels.map(model => ({
        label: model.name || model.id,
        description: `${model.vendor} - ${model.family || 'N/A'}`,
        detail: visionCapableModels.includes(model) ? '✓ Podporuje vision/OCR' : 'Kódovací model',
        model: model
    }));
    
    const selected = await vscode.window.showQuickPick(modelChoices, {
        placeHolder,
        title,
        ignoreFocusOut: true
    });
    
    if (!selected) {
        // Použij prvý dostupný ak používateľ zruší
        return availableModels[0];
    }
    
    // Ulož výber podľa účelu
    if (purpose === 'code') {
        await savePreferredCodeModel(context, selected.model.id);
    } else {
        await savePreferredVisionModel(context, selected.model.id);
    }
    vscode.window.showInformationMessage(`✅ ${purpose === 'code' ? 'Kódovací model' : 'Vision model'} nastavený: ${selected.label}`);
    
    return selected.model;
}

/**
 * Inicializačný setup - @autotest init
 */
async function runInitializationSetup(context: vscode.ExtensionContext): Promise<void> {
    try {
        // 1. Výber role
        const roleSelection = await vscode.window.showQuickPick(
            [
                { label: '👨‍💻 Developer', value: 'developer', description: 'Automatické testovanie bugov' },
                { label: '🧪 Tester', value: 'tester', description: 'Test scenáre + Bug reporting do TFS' }
            ],
            {
                placeHolder: 'Vyber svoju rolu v projekte:',
                title: 'Autotest Agent - Konfigurácia',
                ignoreFocusOut: true
            }
        );

        if (!roleSelection) {
            vscode.window.showWarningMessage('Konfigurácia zrušená');
            return;
        }

        await saveUserRole(context, roleSelection.value as any);

        // 2. Local vs Remote testing
        const envType = await vscode.window.showQuickPick(
            [
                { label: '💻 Local', value: 'local', description: 'Testovanie na localhost' },
                { label: '🌐 Remote', value: 'remote', description: 'Testovanie na vzdialenom serveri' }
            ],
            { 
                placeHolder: 'Kde chceš testovať aplikáciu?',
                ignoreFocusOut: true
            }
        );

        if (!envType) {
            vscode.window.showWarningMessage('Konfigurácia zrušená');
            return;
        }

        // 3. Typ aplikácie
        const appType = await vscode.window.showQuickPick(
            [
                { label: '🌐 Web', value: 'web' },
                { label: '🖥️ Desktop', value: 'desktop' },
                { label: '📱 Mobile', value: 'mobile' }
            ],
            { 
                placeHolder: 'Aký typ aplikácie testuješ?',
                ignoreFocusOut: true
            }
        );

        if (!appType) {
            vscode.window.showWarningMessage('Konfigurácia zrušená');
            return;
        }

        // 4. URL zadanie
        const appUrl = await vscode.window.showInputBox({
            prompt: 'Zadaj URL aplikácie:',
            placeHolder: 'http://localhost:3000 alebo https://staging.app.com',
            value: envType.value === 'local' ? 'http://localhost:3000' : '',
            ignoreFocusOut: true,
            validateInput: (value) => {
                if (!value || (!value.startsWith('http://') && !value.startsWith('https://'))) {
                    return 'URL musí začínať http:// alebo https://';
                }
                return null;
            }
        });

        if (!appUrl) {
            vscode.window.showWarningMessage('Konfigurácia zrušená');
            return;
        }

        // Uložiť environment config
        await saveEnvironmentConfig(context, {
            url: appUrl,
            appType: appType.value,
            environment: envType.value,
            skipAvailabilityCheck: false
        });

        // 5. Prihlasovanie (login credentials)
        const requiresLogin = await vscode.window.showQuickPick(
            [
                { label: '✅ Áno', value: 'yes', description: 'Aplikácia vyžaduje prihlásenie' },
                { label: '❌ Nie', value: 'no', description: 'Veřejná aplikácia bez login formu' }
            ],
            { 
                placeHolder: 'Vyžaduje aplikácia prihlásenie (username/password)?',
                ignoreFocusOut: true
            }
        );

        if (requiresLogin?.value === 'yes') {
            const username = await vscode.window.showInputBox({
                prompt: 'Zadaj prihlasovacie meno (username):',
                placeHolder: 'admin, testuser, ...',
                ignoreFocusOut: true,
                validateInput: (value) => {
                    if (!value || value.trim().length === 0) {
                        return 'Username nemôže byť prázdny';
                    }
                    return null;
                }
            });

            if (!username) {
                vscode.window.showWarningMessage('Konfigurácia zrušená');
                return;
            }

            const password = await vscode.window.showInputBox({
                prompt: 'Zadaj heslo:',
                placeHolder: 'heslo...',
                password: true, // Skryje znaky pri písaní
                ignoreFocusOut: true,
                validateInput: (value) => {
                    if (!value || value.trim().length === 0) {
                        return 'Heslo nemôže byť prázdne';
                    }
                    return null;
                }
            });

            if (!password) {
                vscode.window.showWarningMessage('Konfigurácia zrušená');
                return;
            }

            // Uložiť login config
            await saveLoginConfig(context, {
                required: true,
                username: username
            });

            // Uložiť heslo do secure storage
            await saveLoginPassword(context, password);
            
            vscode.window.showInformationMessage(`✅ Prihlasovacie údaje uložené: ${username}`);
        } else {
            await saveLoginConfig(context, { required: false });
        }

        // 6. TFS konfigurácia (pre obe role)
        const tfsChoice = await vscode.window.showQuickPick(
            [
                { label: '✅ Áno', value: 'yes', description: 'Odporúčané - načítava bug detaily z TFS' },
                { label: '❌ Nie', value: 'no' },
                { label: '⏰ Neskôr', value: 'later' }
            ],
            { 
                placeHolder: 'Chceš pripojiť TFS/Azure DevOps?',
                ignoreFocusOut: true
            }
        );

        if (tfsChoice?.value === 'yes') {
            await setupTfsConnection(context);
        } else {
            await saveTfsConfig(context, { enabled: false });
        }

        vscode.window.showInformationMessage(`✅ Konfigurácia úspešne uložená! Rola: ${roleSelection.value}, URL: ${appUrl}`);
    } catch (error: any) {
        vscode.window.showErrorMessage(`Chyba pri konfigurácii: ${error.message}`);
    }
}

/**
 * TFS Setup
 */
async function setupTfsConnection(context: vscode.ExtensionContext): Promise<void> {
    try {
        // 1. Organization URL
        const orgUrl = await vscode.window.showInputBox({
            prompt: 'Zadaj TFS Organization URL:',
            placeHolder: 'https://dev.azure.com/org alebo http://tfs-server:8080/tfs/project',
            ignoreFocusOut: true,
            validateInput: (value) => {
                if (!value || (!value.startsWith('http://') && !value.startsWith('https://'))) {
                    return 'URL musí začínať http:// alebo https://';
                }
                return null;
            }
        });

        if (!orgUrl) {
            vscode.window.showWarningMessage('TFS konfigurácia zrušená');
            return;
        }

        // 2. Project Name
        const projectName = await vscode.window.showInputBox({
            prompt: 'Zadaj názov projektu v TFS:',
            placeHolder: 'MyProject',
            ignoreFocusOut: true
        });

        if (!projectName) {
            vscode.window.showWarningMessage('TFS konfigurácia zrušená');
            return;
        }

        // 3. PAT Token
        const patInfo = await vscode.window.showInformationMessage(
            'Potrebuješ Personal Access Token (PAT) z Azure DevOps/TFS',
            { modal: true, detail: 'Kde nájsť PAT:\n1. Otvor Azure DevOps/TFS\n2. Ikona profilu → Personal Access Tokens\n3. New Token\n4. Scope: Work Items (Read) alebo (Read & Write)\n5. Skopíruj token' },
            'Pokračovať'
        );

        if (patInfo !== 'Pokračovať') {
            vscode.window.showWarningMessage('TFS konfigurácia zrušená');
            return;
        }

        const pat = await vscode.window.showInputBox({
            prompt: 'Zadaj Personal Access Token (PAT):',
            placeHolder: 'Tvoj PAT token',
            password: true,
            ignoreFocusOut: true,
            validateInput: (value) => {
                if (!value || value.length < 10) {
                    return 'PAT token musí mať aspoň 10 znakov';
                }
                return null;
            }
        });

        if (!pat) {
            vscode.window.showWarningMessage('TFS konfigurácia zrušená');
            return;
        }

        // Validácia pripojenia
        vscode.window.showInformationMessage('🔄 Validujem pripojenie k TFS...');
        
        const client = new TfsClient();
        await client.connect(orgUrl, projectName, pat);
        const validation = await client.validateConnection();

        if (!validation.success) {
            vscode.window.showErrorMessage(`TFS validácia zlyhala: ${validation.message}`);
            return;
        }

        // Uložiť konfiguráciu
        await saveTfsConfig(context, {
            enabled: true,
            organization: orgUrl,
            project: projectName
        });
        await saveTfsPat(context, pat);

        // Inicializovať global TFS client
        tfsClient = client;

        vscode.window.showInformationMessage(`✅ TFS pripojenie úspešne nastavené! (${projectName})`);
    } catch (error: any) {
        vscode.window.showErrorMessage(`Chyba pri pripojení k TFS: ${error.message}`);
    }
}

/**
 * Hlavná funkcia pre spustenie automatizovaného testu
 */
async function runAutomatedTest(
    context: vscode.ExtensionContext,
    response: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    bugDescription: string,
    bugId: string | undefined,
    config: AutotestConfig
): Promise<void> {
    // 1. Generovanie automatizovaného testu pomocou Copilot LLM
    response.markdown(`⚙️ Generujem Playwright automatizovaný test...\n\n`);

    try {
        // Vyber kódovací model na generovanie testu
        const model = await selectAIModel(context, 'code');
        
        if (!model) {
            response.markdown(`*Chyba: Nenašiel sa AI model. Uisti sa, že máš aktívne GitHub Copilot subscription a si prihlásený.*`);
            return;
        }
        
        response.markdown(`🤖 Kódovací model: **${model.name || model.id}** (${model.vendor})\n\n`);

        // Načítať login credentials ak sú nastavené
        let loginCredentials = '';
        if (config.loginRequired && config.username) {
            const password = await getLoginPassword(context);
            if (password) {
                loginCredentials = `

DÔLEŽITÉ - Aplikácia vyžaduje prihlásenie:
1. Username: "${config.username}"
2. Password: "${password}"

Pre prihlásenie použi tento Playwright kód (PRESNE takto):
  // Prihlásenie
  await page.fill('input[name="username"]', '${config.username}');
  await page.fill('input[name="password"]', '${password}');
  
  // Klikni na login button - POUŽI VIACERO MOŽNOSTÍ (prvá ktorá funguje):
  try {
    // Možnosť 1: Hľadaj button s textom "Prihlásiť", "Login", "Přihlásit", atď.
    await page.getByRole('button', { name: /prihlásiť|login|přihlásit|sign in|submit/i }).click({ timeout: 5000 });
  } catch {
    try {
      // Možnosť 2: Hľadaj button type="submit"
      await page.locator('button[type="submit"]').click({ timeout: 5000 });
    } catch {
      // Možnosť 3: Hľadaj akýkoľvek button vo forme
      await page.locator('form button').first().click({ timeout: 5000 });
    }
  }
  
  // Počkaj na navigáciu po prihlásení
  await page.waitForLoadState('networkidle', { timeout: 10000 });

Teraz pokračuj s testovaním bugu.`;
            }
        }

          // Ensure workspace path and optionally load project overview
          const workspaceFolders = vscode.workspace.workspaceFolders;
          const workspacePath = workspaceFolders && workspaceFolders[0] ? workspaceFolders[0].uri.fsPath : process.cwd();
          let projectOverview = '';
          try {
                const overviewPath = path.join(workspacePath, 'autotest', 'project_overview.md');
                if (fs.existsSync(overviewPath)) {
                     projectOverview = fs.readFileSync(overviewPath, 'utf-8');
                     response.markdown(`🗂️ Načítaný project overview: \`autotest/project_overview.md\`\n\n`);
                }
          } catch (e) {
                // ignore
          }

          // Generovanie test scenára
          response.markdown(`📝 **Vytváram test scenár...**\n\n`);
        
          const scenarioPrompt = `
Si expert na QA. Vytvor detaílný test scenár (v markdown formáte) pre tento bug: "${bugDescription}".

Project overview:
${projectOverview}

Test bude bežať na aplikácii: ${config.appUrl}
${config.loginRequired ? `\nAPLIKÁCIA VYŽADUJE PRIHLÁSENIE - začni prihlásením.` : ''}

DÔLEŽITÉ PRAVIDLÁ:
1. Ak bug/popis NEUVÁDZA konkrétne údaje (napr. "ktorého klienta vybrať"), použi DEFAULT stratégiu:
    - "Vyber klienta" → "Vyber prvého klienta v tabuľke"
    - "Otvor dokument" → "Otvor prvý dokument v zozname"
    - "Zadaj dátum" → "Zadaj dnešný dátum"

2. Ak bug hovorí o tlačidle/akcii VŠEOBECNE (napr. "zobrazí detail"), špecifikuj ČO hľadať:
    - "Zobrazí detail klienta" → "Klikni na tlačidlo/link 'Detail' alebo ikonu detail (class 'icon-detail')"
    - "Filtruje záznamy" → "Klikni na tlačidlo 'Filter' alebo ikonu filtra"

3. Pre VALIDÁCIE:
    - Ak má byť tabuľka/grid naplnená, špecifikuj: "Skontroluj že tabuľka obsahuje aspoň 1 riadok"
    - Ak má byť prázdna: "Skontroluj že tabuľka je prázdna"

Formát scenára:
# Test Scenár: [Názov]

## Cieľ:
[Stručný popis čo test overuje]

## Preconditions:
- [Podmienky pred testom]

## Test kroky:
1. [Prvý krok - napísany jasne a čitateľne s KONKRÉTNYMI údajmi]
2. [Druhý krok - ak treba vybrať niečo, špecifikuj ČO (prvý riadok, konkrétny ID, ...)]
...

## Očakávaný výsledok:
[Ako by mala aplikácia reagovať - KONKRÉTNE (tabuľka má X riadkov, panel je viditeľný, ...)]

Vráť IBA markdown scenár, žiadny iný text.
`;

        const scenarioMessages = [vscode.LanguageModelChatMessage.User(scenarioPrompt)];
        const scenarioResponse = await model.sendRequest(scenarioMessages, {}, token);
        
        let testScenario = '';
        for await (const chunk of scenarioResponse.text) {
            testScenario += chunk;
        }
        testScenario = testScenario.replace(/```markdown|```/g, '').trim();
        
        response.markdown(`✅ **Test scenár vytvorený!**\n\n`);
        
        // Generovanie Playwright kódu
        response.markdown(`⚙️ **Generujem Playwright test script...**\n\n`);
        
        const prompt = `
        Si expert na QA a Playwright. Podľa tohto test scenára vytvor Playwright JavaScript kód:
        
        ${testScenario}
        ${loginCredentials}
        
        Test pôjde na adresu '${config.appUrl}'.
        
        DÔLEŽITÉ POŽIADAVKY:
        1. Browser launch: const browser = await chromium.launch({ headless: ${config.headlessMode}, slowMo: ${config.slowMo} });
        2. Po launchi vytvor context s veľkým viewportom: const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } }); const page = await context.newPage();
        3. Obal CEĽÝ test do try-catch bloku
        4. V catch bloku:
           - Ulož screenshot: await page.screenshot({ path: 'error_screenshot.png', fullPage: true });
           - Vyprintuj chybu: console.error('TEST FAILED:', error.message);
           - Vyprintuj URL: console.error('Current URL:', page.url());
        5. Bezprostredne po vytvorení 'page' zavolaj 'await attachDiagnostics(page);' aby sa zachytili sieťové volania, console logy a DOM snapshot. Pomenuj súbory: 'network.json', 'console_logs.json', 'dom.html'.
        6. Na konci (v try bloku) ulož úspešný screenshot: await page.screenshot({ path: 'success_screenshot.png', fullPage: true });
        7. V finally bloku zatvor browser: await browser.close();
        8. KRITICKÉ - SPA/AJAX ČAKANIE: Aplikácia je SPA (Blazor). Tlačidlá spúšťajú AJAX - stránka sa NENAVIGÁVA.
           ZAKAŽANÉ metody (vždy timeoutujú v Blazor SPA):
             await page.waitForLoadState(...)  ← NIKDY, ani 'networkidle', ani 'load'
             await page.waitForNavigation(...)  ← NIKDY
           POVOLENÉ metódy pre čakanie po AJAX akcii - použi JEDNO z:
             await page.waitForResponse(resp => resp.url().includes('/api/') && resp.status() === 200, { timeout: 15000 });
             await page.locator('SPECIFICKY_SELEKTOR').first().waitFor({ state: 'attached', timeout: 15000 });
             await page.waitForFunction(() => document.querySelectorAll('SELEKTOR').length > 0, { timeout: 15000 });
           UPOZORNENIE pre waitForSelector a locator.waitFor:
             - NIKDY nepoužívaj state:'visible' na selektory ktoré matchujú veľa elementov (napr. 'table tbody tr')
             - Ak selektor môže matchovať viac elementov, vždy použi .first() alebo .nth(0)
             - Bezpečný vzor: await page.locator('table tbody tr').first().waitFor({ state: 'attached', timeout: 15000 });
           waitForLoadState je povolené LEN hneď po page.goto().
        
        Vráť IBA a LEN kód, žiadne vysvetľovanie, žiadny markdown naokolo.
        `;

        const messages = [vscode.LanguageModelChatMessage.User(prompt)];
        const chatResponse = await model.sendRequest(messages, {}, token);
        
        let generatedCode = '';
        for await (const chunk of chatResponse.text) {
            generatedCode += chunk;
        }

        generatedCode = generatedCode.replace(/```javascript|```typescript|```/g, '').trim();

        if (!workspaceFolders) {
            response.markdown(`*Chyba: Nemáš otvorený žiadny projekt.*`);
            return;
        }
        
        // Vytvorenie štruktúrovaného priečinku
        const testFolderName = bugId ? `bug_${bugId}` : `test_${Date.now()}`;
        const testDir = path.join(workspacePath, 'autotest', testFolderName);
        
        const autotestDirExists = fs.existsSync(path.join(workspacePath, 'autotest'));
        
        if (!autotestDirExists) {
            fs.mkdirSync(path.join(workspacePath, 'autotest'));
            // Pri prvom vytvorení autotest/ pridaj do .gitignore
            ensureGitignore(workspacePath);
            response.markdown(`📝 *.gitignore* updatovaný - *autotest/* bude ignorovaný Gitom.\n\n`);
        }
        
        if (!fs.existsSync(testDir)) {
            fs.mkdirSync(testDir, { recursive: true });
        }

        // Uloženie test scenára
        const scenarioPath = path.join(testDir, 'test_scenario.md');
        fs.writeFileSync(scenarioPath, testScenario);
        
                // Embed project overview into generated test so it's self-contained
                if (projectOverview && projectOverview.trim().length > 0) {
                        const header = '/* Project overview:\n' + projectOverview.split('\n').map(l => ' * ' + l).join('\n') + '\n */\n\n';
                        generatedCode = header + generatedCode;
                }

                // Prepend diagnostics helper so generated tests can attach network/console/DOM listeners
                const diagnosticsHelper = `
// Autogenerated diagnostics helper - attach to Playwright page as: await attachDiagnostics(page)
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
            } catch(e) {
                // ignore
            }
        };
    } catch(e) {
        // ignore
    }
}
\n`;

                generatedCode = diagnosticsHelper + generatedCode;

        // Uloženie test scriptu
        const testFilePath = path.join(testDir, 'test.spec.js');
        fs.writeFileSync(testFilePath, generatedCode);
        
        response.markdown(`✅ **Test bol vygenerovaný a uložený!**\n\n`);
        response.markdown(`📁 **Umiestnenie:** \`autotest/${testFolderName}/\`\n\n`);
        response.markdown(`- 📝 \`test_scenario.md\` - Test scenár (kroky)\n`);
        response.markdown(`- 📦 \`test.spec.js\` - Playwright script\n\n`);
        
        // Skontrolovať a nainštalovať Playwright ak chýba
        const playwrightReady = await ensurePlaywrightInstalled(workspacePath, response);
        if (!playwrightReady) {
            response.markdown(`❌ **Nemôžem pokračovať bez Playwright.**\n\n`);
            return;
        }
        
        // 2. Spustenie testu
        response.markdown(`🚀 **Spúšťam test...**\n\n`);
        
        try {
            const { stdout, stderr } = await execAsync('node test.spec.js', {
                cwd: testDir,
                timeout: 120000
            });
            
            if (stderr) {
                response.markdown(`⚠️ Console output:\n\`\`\`\n${stderr.substring(0, 500)}\n\`\`\`\n\n`);
            }
            
            response.markdown(`✅ **Test dokončený!**\n\n`);
            
            // Skontrolovať úspešný screenshot
            const successScreenshotPath = path.join(testDir, 'success_screenshot.png');
            const errorScreenshotPath = path.join(testDir, 'error_screenshot.png');
            const testResultPath = path.join(testDir, 'test_result.md');
            
            if (fs.existsSync(errorScreenshotPath)) {
                response.markdown(`⚠️ **Test zlyhala pred dokončením!**\n\n`);
                response.markdown(`📸 Screenshot zachytený v momente zlyhania: \`${testFolderName}/error_screenshot.png\`\n\n`);
                
                // Vizuálna analýza error screenshotu
                response.markdown(`👁️ **Analýzujem čo sa pokazilo...**\n\n`);

                const visionModel = await selectAIModel(context, 'vision');
                if (!visionModel) {
                    response.markdown(`*Chyba: Nenašiel sa vision model na analýzu screenshotu.*\n\n`);
                    return;
                }
                response.markdown(`👁️ Vision model: **${visionModel.name || visionModel.id}**\n\n`);
                
                const errorScreenshotBuffer = fs.readFileSync(errorScreenshotPath);
                const errorScreenshotBase64 = errorScreenshotBuffer.toString('base64');
                
                const errorAnalysisPrompt = `Tu je screenshot v momente ked test zlyhala.

Pôvodný test scenár:
${testScenario}

Chyba z console:
${stderr}

Analýzuj screenshot a povedz:
1. Na akom kroku test zlyhala?
2. Čo sa na obrazovke nachádza?
3. Prečo pravdepodobne test nepreošel?
4. Aké elementy sú viditelné?
5. Návrh čo zmeniť v test_scenario.md aby test fungoval.`;
                
                const errorVisionMessages = [
                    vscode.LanguageModelChatMessage.User([
                        new vscode.LanguageModelTextPart(errorAnalysisPrompt),
                        vscode.LanguageModelDataPart.image(
                            Buffer.from(errorScreenshotBase64, 'base64'),
                            'image/png'
                        )
                    ])
                ];

                let errorAnalysis = '';
                try {
                    const errorVisionResponse = await visionModel.sendRequest(errorVisionMessages, {}, token);
                    for await (const chunk of errorVisionResponse.text) {
                        errorAnalysis += chunk;
                    }
                } catch (visionErr: any) {
                    throw visionErr; // let outer handler fallback later
                }
                
                response.markdown(`### 🔍 Analýza zlyhania:\n\n${errorAnalysis}\n\n`);
                
                // Vytvor test_result.md pre chyby
                const errorResultContent = `# Test Result: FAILED ❌

## Test Info
- **Bug ID:** ${bugId || 'N/A'}
- **Timestamp:** ${new Date().toLocaleString('sk-SK')}
- **Status:** FAILED

## Problém
${errorAnalysis}

## Console Output
\`\`\`
${stderr || 'Žiadny stderr output'}
\`\`\`

## Ďalšie kroky
1. Otvor \`test_scenario.md\` a uprav kroky podľa analýzy vyššie
2. Spusti: \`@autotest regenerate ${testFolderName}\`
3. Sleduj browser v headed mode (\`@autotest debug\`)

## Screenshots
- Error screenshot: \`error_screenshot.png\`
`;
                fs.writeFileSync(testResultPath, errorResultContent);
                
                response.markdown(`---\n\n`);
                response.markdown(`🛠️ **Ako opraviť:**\n`);
                response.markdown(`1. Otvor súbor: \`autotest/${testFolderName}/test_scenario.md\`\n`);
                response.markdown(`2. Uprav kroky podľa analýzy vyššie\n`);
                response.markdown(`3. Spusti: \`@autotest regenerate ${testFolderName}\`\n\n`);
                response.markdown(`📄 Detail report: \`autotest/${testFolderName}/test_result.md\`\n\n`);
                
                await saveBugHistory(context, {
                    bugId,
                    description: bugDescription,
                    timestamp: new Date().toISOString(),
                    testResult: 'failed'
                });
                return;
            }
            
            if (!fs.existsSync(successScreenshotPath)) {
                response.markdown(`❌ *Screenshot sa nenašiel. Test mohol zlyhať.*\n\n`);
                
                // Uložiť do histórie ako failed
                await saveBugHistory(context, {
                    bugId,
                    description: bugDescription,
                    timestamp: new Date().toISOString(),
                    testResult: 'failed'
                });
                return;
            }
            
            response.markdown(`📸 Screenshot úspešne vytvorený!\n\n`);
            
            // 3. Vizuálna kontrola pomocou Copilot Vision API
            response.markdown(`👁️ **Analyzujem výsledok testu...**\n\n`);
            
            const screenshotBuffer = fs.readFileSync(successScreenshotPath);
            const screenshotBase64 = screenshotBuffer.toString('base64');
            
            const visionPrompt = `Tu je screenshot aplikácie po dokončení testu. 

Test scenár bol:
${testScenario}

Pôvodný bug: "${bugDescription}"
            
Skontroluj screenshot a zhodnoť:
1. Či test prebehol správne až do konca
2. Či je viditeľná očakávaná funkcia alebo výsledok
3. Či aplikácia vyzerá správne
4. Či je bug opravený alebo či test case prešiel úspešne

Odpovedz prehľadne a stručne.`;
            
            // Použij vision model na analýzu screenshotu
            const visionModelForSuccess = await selectAIModel(context, 'vision');
            if (!visionModelForSuccess) {
                response.markdown(`*Chyba: Nenašiel sa vision model na analýzu screenshotu.*\n\n`);
                return;
            }
            response.markdown(`👁️ **Vizuálna analýza pomocou ${visionModelForSuccess.name || visionModelForSuccess.id}...**\n\n`);

            const visionMessages = [
                vscode.LanguageModelChatMessage.User([
                    new vscode.LanguageModelTextPart(visionPrompt),
                    vscode.LanguageModelDataPart.image(
                        Buffer.from(screenshotBase64, 'base64'),
                        'image/png'
                    )
                ])
            ];

            let analysisResult = '';
            try {
                const visionResponse = await visionModelForSuccess.sendRequest(visionMessages, {}, token);
                for await (const chunk of visionResponse.text) {
                    analysisResult += chunk;
                }
            } catch (visionErr: any) {
                throw visionErr; // let outer fallback handler manage it
            }
            
            response.markdown(`### 🔍 Výsledok analýzy:\n\n${analysisResult}\n\n`);
            
            // Vytvor test_result.md pre úspešný test
            const successResultContent = `# Test Result: PASSED ✅

## Test Info
- **Bug ID:** ${bugId || 'N/A'}
- **Bug Description:** ${bugDescription}
- **Timestamp:** ${new Date().toLocaleString('sk-SK')}
- **Status:** PASSED

## Test Scenár
${testScenario}

## AI Vision Analysis
${analysisResult}

## Console Output
\`\`\`
${stderr || stdout || 'Test dokončený bez chýb'}
\`\`\`

## Výsledok
Test prebehol úspešne. Všetky kroky boli vykonané bez chýb.

## Screenshots
- Success screenshot: \`success_screenshot.png\`

## Odporúčanie
✅ Bug je pravdepodobne fixed. Môžeš pokračovať s commit & push.
`;
            fs.writeFileSync(testResultPath, successResultContent);
            
            response.markdown(`📄 Detail report: \`autotest/${testFolderName}/test_result.md\`\n\n`);
            
            // Uložiť do histórie ako success
            await saveBugHistory(context, {
                bugId,
                description: bugDescription,
                timestamp: new Date().toISOString(),
                testResult: 'success'
            });
            
            // 4. Command Links
            response.markdown(`---\n\n### Čo chceš urobiť?\n\n`);
            
            response.button({
                command: 'autotest.cleanup',
                title: '✅ Som spokojný - Zmazať screenshoty a Pushnúť na Git',
                arguments: [workspacePath, testFolderName]
            });
            
            response.button({
                command: 'autotest.keepScreenshots',
                title: '❌ Neúspešné - Ponechať screenshoty',
                arguments: []
            });
            
        } catch (execError: any) {
            response.markdown(`❌ **Chyba pri spustení:**\n\`\`\`\n${execError.message}\n\`\`\`\n\n`);
            response.markdown(`*Uisti sa, že máš nainštalovaný Playwright a aplikáciu bežiacu na ${config.appUrl}.*\n\n`);

            const errorScreenshotPath = path.join(testDir, 'error_screenshot.png');
            const testResultPath = path.join(testDir, 'test_result.md');

            if (fs.existsSync(errorScreenshotPath)) {
                response.markdown(`📸 Error screenshot nájdený: \`${testFolderName}/error_screenshot.png\`\n\n`);

                try {
                    const errorScreenshotBuffer = fs.readFileSync(errorScreenshotPath);
                    const errorScreenshotBase64 = errorScreenshotBuffer.toString('base64');

                    const errorAnalysisPrompt = `Tu je screenshot v momente ked test zlyhala.\n\nPôvodný test scenár:\n${testScenario}\n\nChyba zo spustenia:\n${execError.message}\n\nAnalýzuj screenshot a povedz:\n1. Na akom kroku test zlyhala?\n2. Čo sa na obrazovke nachádza?\n3. Prečo pravdepodobne test nepreošel?\n4. Aké elementy sú viditeľné?\n5. Návrh čo zmeniť v test_scenario.md aby test fungoval.`;

                    const errorVisionMessages = [
                        vscode.LanguageModelChatMessage.User([
                            new vscode.LanguageModelTextPart(errorAnalysisPrompt),
                            vscode.LanguageModelDataPart.image(
                                Buffer.from(errorScreenshotBase64, 'base64'),
                                'image/png'
                            )
                        ])
                    ];

                    const errorVisionResponse = await model.sendRequest(errorVisionMessages, {}, token);
                    let errorAnalysis = '';
                    for await (const chunk of errorVisionResponse.text) {
                        errorAnalysis += chunk;
                    }

                    const errorResultContent = `# Test Result: FAILED ❌\n\n## Test Info\n- **Bug ID:** ${bugId || 'N/A'}\n- **Timestamp:** ${new Date().toLocaleString('sk-SK')}\n- **Status:** FAILED\n\n## Problém\n${errorAnalysis}\n\n## Console Output\n\`\`\`\n${execError.message || 'No error message'}\n\`\`\`\n\n## Screenshots\n- Error screenshot: \`error_screenshot.png\`\n`;

                    fs.writeFileSync(testResultPath, errorResultContent);
                    response.markdown(`📄 Detail report: \`autotest/${testFolderName}/test_result.md\`\n\n`);
                } catch (analysisErr: any) {
                    // If analysis fails, still write basic result file
                    const basicResult = `# Test Result: FAILED ❌\n\n## Error\n${execError.message}\n\n## Note\nError screenshot exists but analysis failed: ${analysisErr.message}`;
                    fs.writeFileSync(testResultPath, basicResult);
                }

            } else {
                // No screenshot available, write simple failure report
                const basicResult = `# Test Result: FAILED ❌\n\n## Error\n${execError.message}\n\n## Note\nNo error screenshot was produced.`;
                fs.writeFileSync(testResultPath, basicResult);
                response.markdown(`📄 Vytvorený report: \`autotest/${testFolderName}/test_result.md\`\n\n`);
            }

            // Uložiť do histórie ako failed
            await saveBugHistory(context, {
                bugId,
                description: bugDescription,
                timestamp: new Date().toISOString(),
                testResult: 'failed'
            });
        }
        
    } catch (err: any) {
        response.markdown(`*Chyba pri komunikácii s AI: ${err.message}*`);
    }
}

export function activate(context: vscode.ExtensionContext) {
    vscode.window.showInformationMessage('Autotest Agent je aktívny!');

    // Načítať konfiguráciu pri štarte
    const config = loadConfiguration(context);
    
    // Inicializovať TFS client ak je enabled
    if (config.tfsEnabled && config.tfsOrganization && config.tfsProject) {
        getTfsPat(context).then(async (pat) => {
            if (pat) {
                try {
                    tfsClient = new TfsClient();
                    await tfsClient.connect(config.tfsOrganization!, config.tfsProject!, pat);
                } catch (error) {
                    console.error('TFS client initialization failed:', error);
                }
            }
        });
    }

    const autotestAgent = vscode.chat.createChatParticipant('autotest.agent', async (request, contextObj, response, token) => {
        
        const userQuery = request.prompt.trim().toLowerCase(); 
        const config = loadConfiguration(context);

        response.markdown(`Ahoj! Som tvoj Autotest Agent. 🤖\n\n`);
        
        // ===== PRÍKAZ: @autotest init =====
        if (userQuery.includes('init')) {
            response.markdown(`🔧 **Spúšťam inicializáciu...**\n\n`);
            await runInitializationSetup(context);
            return;
        }
        
        // ===== PRÍKAZ: @autotest select-model alebo model =====
        if (userQuery.includes('select-model') || userQuery.includes('model') || userQuery.includes('vyber model')) {
            response.markdown(`🤖 **Výber AI modelov...**\n\n`);
            
            const codeModel = await selectAIModel(context, 'code', true);
            if (codeModel) {
                response.markdown(`✅ Kódovací model: **${codeModel.name || codeModel.id}** (${codeModel.vendor})\n\n`);
            }

            const visionModel = await selectAIModel(context, 'vision', true);
            if (visionModel) {
                response.markdown(`✅ Vision model: **${visionModel.name || visionModel.id}** (${visionModel.vendor})\n\n`);
            }
            return;
        }
        
        // ===== PRÍKAZ: @autotest debug =====
        if (userQuery.includes('debug') || userQuery.includes('show') || userQuery.includes('visible')) {
            response.markdown(`🐛 **Debug mód...**\n\n`);
            
            const debugChoice = await vscode.window.showQuickPick(
                [
                    { 
                        label: '👁️ Viditeľný browser (Headed)', 
                        value: 'visible',
                        description: 'Vidíš čo test robí - vhodné pre debugging',
                        detail: 'headless: false, slowMo: 100ms'
                    },
                    { 
                        label: '⚡ Rýchly neviditeľný (Headless)', 
                        value: 'fast',
                        description: 'Štandardný rýchly mód bez UI',
                        detail: 'headless: true, slowMo: 0ms'
                    },
                    { 
                        label: '🎬 Pomalý viditeľný (Debug)', 
                        value: 'slow',
                        description: 'Veľmi pomalé vykonávanie pre sledovanie každej akcie',
                        detail: 'headless: false, slowMo: 500ms'
                    }
                ],
                { 
                    placeHolder: 'Vyber mód testovania:',
                    ignoreFocusOut: true
                }
            );

            if (debugChoice?.value === 'visible') {
                await saveDebugConfig(context, { headless: false, slowMo: 100 });
                response.markdown(`✅ **Viditeľný browser zapnutý!** (slowMo: 100ms)\n\n`);
                response.markdown(`*Pri ďalšom teste uvidíš browser okno a akcie budú pomalšie pre lepšiu viditeľnosť.*\n\n`);
            } else if (debugChoice?.value === 'fast') {
                await saveDebugConfig(context, { headless: true, slowMo: 0 });
                response.markdown(`✅ **Headless mód zapnutý!** (rýchly)\n\n`);
                response.markdown(`*Test bude bežať na pozadí bez viditeľného browsera.*\n\n`);
            } else if (debugChoice?.value === 'slow') {
                await saveDebugConfig(context, { headless: false, slowMo: 500 });
                response.markdown(`✅ **Pomalý debug mód zapnutý!** (slowMo: 500ms)\n\n`);
                response.markdown(`*Každá akcia bude trvať 0.5s - ideálne na sledovanie čo sa deje.*\n\n`);
            }
            
            return;
        }
        
        // ===== PRÍKAZ: @autotest history =====
        if (userQuery.includes('history') || userQuery.includes('história')) {
            const history = getBugHistory(context, 10);
            response.markdown(formatBugHistory(history));
            return;
        }
        
        // ===== PRÍKAZ: @autotest regenerate bug_123 alebo regenerate test_456 =====
        if (userQuery.includes('regenerate') || userQuery.includes('regeneruj')) {
            response.markdown(`🔄 **Regenerácia test scriptu...**\n\n`);
            
            // Extrahuj názov priečinka (bug_123 alebo test_12345...)
            const folderMatch = request.prompt.match(/(?:bug_|test_)[\w]+/);
            if (!folderMatch) {
                response.markdown(`❌ Zadaj názov test priečinka, napríklad: \`@autotest regenerate bug_622116\`\n\n`);
                return;
            }
            
            const testFolderName = folderMatch[0];
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) {
                response.markdown(`*Chyba: Nemáš otvorený žiadny projekt.*`);
                return;
            }
            
            const workspacePath = workspaceFolders[0].uri.fsPath;
            const testDir = path.join(workspacePath, 'autotest', testFolderName);
            const scenarioPath = path.join(testDir, 'test_scenario.md');
            
            if (!fs.existsSync(scenarioPath)) {
                response.markdown(`❌ Test scenár nenájdený: \`autotest/${testFolderName}/test_scenario.md\`\n\n`);
                response.markdown(`Uisti sa, že priečinok existuje a obsahuje test_scenario.md súbor.\n\n`);
                return;
            }
            
            // Načítaj upravený scenár
            const updatedScenario = fs.readFileSync(scenarioPath, 'utf-8');

            if (!updatedScenario || updatedScenario.trim().length < 20) {
                response.markdown(`❌ **Test scenár je prázdny!**\n\n`);
                response.markdown(`Súbor \`autotest/${testFolderName}/test_scenario.md\` neobsahuje žiadny obsah.\n\n`);
                response.markdown(`Najprv uprav scenár – pridaj kroky testu, potom spusti regeneráciu znova.\n\n`);
                return;
            }
            
            response.markdown(`📝 Test scenár načítaný z: \`${testFolderName}/test_scenario.md\`\n\n`);
            
            // Vyber kódovací model
            const model = await selectAIModel(context, 'code');
            if (!model) {
                response.markdown(`*Chyba: Nenašiel sa AI model.*`);
                return;
            }
            
            // Načítať login credentials
            let loginCredentials = '';
            if (config.loginRequired && config.username) {
                const password = await getLoginPassword(context);
                if (password) {
                    loginCredentials = `

DÔLEŽITÉ - Aplikácia vyžaduje prihlásenie:
1. Username: "${config.username}"
2. Password: "${password}"

Pre prihlásenie použi tento Playwright kód (PRESNE takto):
  // Prihlásenie
  await page.fill('input[name="username"]', '${config.username}');
  await page.fill('input[name="password"]', '${password}');
  
  // Klikni na login button - POUŽI VIACERO MOŽNOSTÍ (prvá ktorá funguje):
  try {
    await page.getByRole('button', { name: /prihlásiť|login|přihlásit|sign in|submit/i }).click({ timeout: 5000 });
  } catch {
    try {
      await page.locator('button[type="submit"]').click({ timeout: 5000 });
    } catch {
      await page.locator('form button').first().click({ timeout: 5000 });
    }
  }
  
  await page.waitForLoadState('networkidle', { timeout: 10000 });

Teraz pokračuj s testovaním bugu.`;
                }
            }
            
            // Regeneruj Playwright kód
            const regenPrompt = `
            Si expert na QA a Playwright. Podľa tohto UPRAVENÉHO test scenára vytvor nový Playwright JavaScript kód:
            
            ${updatedScenario}
            ${loginCredentials}
            
            Test pôjde na adresu '${config.appUrl}'.
            
            DÔLEŽITÉ POŽIADAVKY:
            1. Browser launch: const browser = await chromium.launch({ headless: ${config.headlessMode}, slowMo: ${config.slowMo} });
            2. Po launchi vytvor context s veľkým viewportom: const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } }); const page = await context.newPage();
            3. Obal CELÝ test do try-catch bloku
            4. V catch bloku:
               - Ulož screenshot: await page.screenshot({ path: 'error_screenshot.png', fullPage: true });
               - Vyprintuj chybu: console.error('TEST FAILED:', error.message);
               - Vyprintuj URL: console.error('Current URL:', page.url());
            5. Na konci (v try bloku) ulož úspešný screenshot: await page.screenshot({ path: 'success_screenshot.png', fullPage: true });
            6. V finally bloku zatvor browser: await browser.close();
            7. Bezprostredne po vytvorení 'page' zavolaj 'await attachDiagnostics(page);' aby sa zachytili sieťové volania, console logy a DOM snapshot. Pomenuj súbory: 'network.json', 'console_logs.json', 'dom.html'.
            8. KRITICKÉ - SPA/AJAX ČAKANIE: Aplikácia je SPA (Blazor). Tlačidlá spúšťajú AJAX - stránka sa NENAVIGÁVA.
               ZAKAŽANÉ metody (vždy timeoutujú v Blazor SPA):
                 await page.waitForLoadState(...)  ← NIKDY, ani 'networkidle', ani 'load'
                 await page.waitForNavigation(...)  ← NIKDY
               POVOLENÉ metódy pre čakanie po AJAX akcii - použi JEDNO z:
                 await page.waitForResponse(resp => resp.url().includes('/api/') && resp.status() === 200, { timeout: 15000 });
                 await page.locator('SPECIFICKY_SELEKTOR').first().waitFor({ state: 'attached', timeout: 15000 });
                 await page.waitForFunction(() => document.querySelectorAll('SELEKTOR').length > 0, { timeout: 15000 });
               UPOZORNENIE pre waitForSelector a locator.waitFor:
                 - NIKDY nepoužívaj state:'visible' na selektory ktoré matchujú veľa elementov (napr. 'table tbody tr')
                 - Ak selektor môže matchovať viac elementov, vždy použi .first() alebo .nth(0)
                 - Bezpečný vzor: await page.locator('table tbody tr').first().waitFor({ state: 'attached', timeout: 15000 });
               waitForLoadState je povolené LEN hneď po page.goto().
            
            Vráť IBA a LEN kód, žiadne vysvetlenné, žiadny markdown naokolo.
            `;
            
            const regenMessages = [vscode.LanguageModelChatMessage.User(regenPrompt)];
            const regenResponse = await model.sendRequest(regenMessages, {}, token);
            
            let regeneratedCode = '';
            for await (const chunk of regenResponse.text) {
                regeneratedCode += chunk;
            }
            regeneratedCode = regeneratedCode.replace(/```javascript|```typescript|```/g, '').trim();

                        // If project overview exists, embed it as a header and prepend diagnostics helper
                        try {
                                const overviewPath = path.join(workspacePath, 'autotest', 'project_overview.md');
                                let projectOverview = '';
                                if (fs.existsSync(overviewPath)) {
                                        projectOverview = fs.readFileSync(overviewPath, 'utf-8');
                                }

                                if (projectOverview && projectOverview.trim().length > 0) {
                                        const header = '/* Project overview:\n' + projectOverview.split('\n').map(l => ' * ' + l).join('\n') + '\n */\n\n';
                                        regeneratedCode = header + regeneratedCode;
                                }

                                const diagnosticsHelper = `
// Autogenerated diagnostics helper - attach to Playwright page as: await attachDiagnostics(page)
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
            } catch(e) {
                // ignore
            }
        };
    } catch(e) {
        // ignore
    }
}
\n`;

                                regeneratedCode = diagnosticsHelper + regeneratedCode;
                        } catch (e) {
                                // Ignore errors while embedding diagnostics
                        }

                        // Ulož nový test script
                        const testFilePath = path.join(testDir, 'test.spec.js');
                        fs.writeFileSync(testFilePath, regeneratedCode);
            
            response.markdown(`✅ **Test script regenerovaný!**\n\n`);
            response.markdown(`📁 Uložený do: \`autotest/${testFolderName}/test.spec.js\`\n\n`);
            response.markdown(`🚀 Spúšťam test...\n\n`);
            
            // Spusti regenerovaný test
            try {
                const { stdout, stderr } = await execAsync('node test.spec.js', {
                    cwd: testDir,
                    timeout: 120000
                });
                
                const combinedOutput = [stdout, stderr].filter(Boolean).join('\n').trim();
                if (combinedOutput) {
                    response.markdown(`⚠️ Console output:\n\`\`\`\n${combinedOutput.substring(0, 1000)}\n\`\`\`\n\n`);
                }
                
                const successScreenshotPath = path.join(testDir, 'success_screenshot.png');
                const errorScreenshotPath = path.join(testDir, 'error_screenshot.png');
                const testResultPath = path.join(testDir, 'test_result.md');

                if (fs.existsSync(errorScreenshotPath)) {
                    response.markdown(`⚠️ **Test stále zlyhala.**\n\n`);
                    response.markdown(`📸 Error screenshot: \`${testFolderName}/error_screenshot.png\`\n\n`);

                    // Vision analýza chybového screenshotu
                    response.markdown(`👁️ **Analýzujem čo sa pokazilo...**\n\n`);
                    const visionModel = await selectAIModel(context, 'vision');
                    let errorAnalysis = 'Vision model nebol dostupný.';
                    if (visionModel) {
                        response.markdown(`👁️ Vision model: **${visionModel.name || visionModel.id}**\n\n`);
                        const errorScreenshotBase64 = fs.readFileSync(errorScreenshotPath).toString('base64');
                        const errorAnalysisPrompt = `Tu je screenshot v momente keď test zlyhala.\n\nTest scenár:\n${updatedScenario}\n\nChyba z console:\n${combinedOutput}\n\nAnalýzuj screenshot a povedz:\n1. Na akom kroku test zlyhala?\n2. Čo sa na obrazovke nachádza?\n3. Prečo pravdepodobne test neprebehol?\n4. Návrh čo zmeniť v test_scenario.md aby test fungoval.`;
                        try {
                            const errorVisionMessages = [
                                vscode.LanguageModelChatMessage.User([
                                    new vscode.LanguageModelTextPart(errorAnalysisPrompt),
                                    vscode.LanguageModelDataPart.image(Buffer.from(errorScreenshotBase64, 'base64'), 'image/png')
                                ])
                            ];
                            const errorVisionResponse = await visionModel.sendRequest(errorVisionMessages, {}, token);
                            errorAnalysis = '';
                            for await (const chunk of errorVisionResponse.text) {
                                errorAnalysis += chunk;
                            }
                        } catch (e: any) {
                            errorAnalysis = `Vision analýza zlyhala: ${e.message}`;
                        }
                        response.markdown(`### 🔍 Analýza zlyhania:\n\n${errorAnalysis}\n\n`);
                    }

                    fs.writeFileSync(testResultPath, `# Test Result: FAILED ❌\n\n## Test Info\n- **Folder:** ${testFolderName}\n- **Timestamp:** ${new Date().toLocaleString('sk-SK')}\n- **Status:** FAILED\n\n## Problém\n${errorAnalysis}\n\n## Console Output\n\`\`\`\n${combinedOutput || 'Žiadny output'}\n\`\`\`\n\n## Ďalšie kroky\n1. Otvor \`test_scenario.md\` a uprav kroky podľa analýzy vyššie\n2. Spusti: \`@autotest regenerate ${testFolderName}\`\n`);
                    response.markdown(`📄 Detail report: \`autotest/${testFolderName}/test_result.md\`\n\n`);
                    response.markdown(`🛠️ Uprav \`autotest/${testFolderName}/test_scenario.md\` a spusti \`@autotest regenerate ${testFolderName}\` znova.\n\n`);
                    await saveBugHistory(context, {
                        bugId: testFolderName.replace(/^(bug_|test_)/, ''),
                        description: updatedScenario.split('\n').find((l: string) => l.trim().length > 5) || testFolderName,
                        timestamp: new Date().toISOString(),
                        testResult: 'failed'
                    });
                    response.markdown(`✅ **Test prešiel úspešne!**\n\n`);
                    response.markdown(`📸 Screenshot: \`${testFolderName}/success_screenshot.png\`\n\n`);

                    // Vision analýza úspešného screenshotu
                    response.markdown(`👁️ **Analyzujem výsledok testu...**\n\n`);
                    const visionModelOk = await selectAIModel(context, 'vision');
                    let analysisResult = 'Vision model nebol dostupný.';
                    if (visionModelOk) {
                        response.markdown(`👁️ Vision model: **${visionModelOk.name || visionModelOk.id}**\n\n`);
                        const screenshotBase64 = fs.readFileSync(successScreenshotPath).toString('base64');
                        const visionPrompt = `Tu je screenshot aplikácie po dokončení testu.\n\nTest scenár:\n${updatedScenario}\n\nSkontroluj screenshot a zhodnoť:\n1. Či test prebehol správne až do konca\n2. Či je viditeľná očakávaná funkcia alebo výsledok\n3. Či aplikácia vyzerá správne\n\nOdpovedz prehľadne a stručne.`;
                        try {
                            const visionMessages = [
                                vscode.LanguageModelChatMessage.User([
                                    new vscode.LanguageModelTextPart(visionPrompt),
                                    vscode.LanguageModelDataPart.image(Buffer.from(screenshotBase64, 'base64'), 'image/png')
                                ])
                            ];
                            const visionResponse = await visionModelOk.sendRequest(visionMessages, {}, token);
                            analysisResult = '';
                            for await (const chunk of visionResponse.text) {
                                analysisResult += chunk;
                            }
                        } catch (e: any) {
                            analysisResult = `Vision analýza zlyhala: ${e.message}`;
                        }
                        response.markdown(`### 🔍 Výsledok analýzy:\n\n${analysisResult}\n\n`);
                    }

                    fs.writeFileSync(testResultPath, `# Test Result: PASSED ✅\n\n## Test Info\n- **Folder:** ${testFolderName}\n- **Timestamp:** ${new Date().toLocaleString('sk-SK')}\n- **Status:** PASSED\n\n## AI Vision Analysis\n${analysisResult}\n\n## Console Output\n\`\`\`\n${combinedOutput || 'Test dokončený bez chýb'}\n\`\`\`\n`);
                    response.markdown(`📄 Detail report: \`autotest/${testFolderName}/test_result.md\`\n\n`);
                    await saveBugHistory(context, {
                        bugId: testFolderName.replace(/^(bug_|test_)/, ''),
                        description: updatedScenario.split('\n').find((l: string) => l.trim().length > 5) || testFolderName,
                        timestamp: new Date().toISOString(),
                        testResult: 'success'
                    });

                } else {
                    response.markdown(`⚠️ **Žiadny screenshot sa nevytvoril.**\n\n`);
                    if (!combinedOutput) {
                        response.markdown(`Test prebehol bez výstupu – pravdepodobne vygenerovaný kód neobsahoval žiadne Playwright kroky.\n\n`);
                    }
                    response.markdown(`Skontroluj \`autotest/${testFolderName}/test.spec.js\` a uprav test_scenario.md.\n\n`);
                }
                
            } catch (execError: any) {
                response.markdown(`❌ **Chyba pri spustení:**\n\`\`\`\n${execError.message}\n\`\`\`\n\n`);
            }
            
            return;
        }
        
        // ===== PRÍKAZ: @autotest test (bez bug ID) =====
        if (userQuery.includes('test') && !userQuery.match(/\d+/)) {
            response.markdown(`📝 **Zadaj popis bugu...**\n\n`);
            const bugDescription = await getBugDescriptionWithClipboardOption();
            
            if (!bugDescription) {
                response.markdown(`*Popis bugu nebol zadaný. Skús znovu.*`);
                return;
            }
            
            // Pokračuj s testovaním pomocou manuálneho popisu
            await runAutomatedTest(context, response, token, bugDescription, undefined, config);
            return;
        }
        
        // ===== PRÍKAZ: @autotest over bug 123 =====
        const bugMatch = request.prompt.match(/\d+/);
        const bugId = bugMatch ? bugMatch[0] : null;

        if (!bugId) {
            response.markdown(`*Zadaj príkaz, napríklad:*\n`);
            response.markdown(`- \`@autotest init\` - Nastaviť konfiguráciu\n`);
            response.markdown(`- \`@autotest model\` - Vybrať AI model s vision support\n`);
            response.markdown(`- \`@autotest debug\` - Prepnúť viditeľný/neviditeľný browser\n`);
            response.markdown(`- \`@autotest over bug 123\` - Otestovať bug z TFS\n`);
            response.markdown(`- \`@autotest test\` - Otestovať podľa manuálneho popisu\n`);
            response.markdown(`- \`@autotest regenerate bug_123\` - Regenerovať test zo scenára\n`);
            response.markdown(`- \`@autotest history\` - Zobraziť históriu testov\n`);
            
            // Skontrolovať, či je konfigurácia nastavená
            if (config.userRole === 'unknown') {
                response.markdown(`\n⚠️ **Konfigurácia nie je nastavená. Spusti \`@autotest init\` najskôr.**\n`);
            }
            return;
        }

        // Načítať popis bugu (z TFS alebo manuálne)
        let bugDescription: string | undefined;
        
        if (config.tfsEnabled && tfsClient) {
            response.markdown(`🔍 Hľadám detaily pre **Bug #${bugId}** v TFS...\n\n`);
            try {
                const bugDetails = await tfsClient.getBugDetails(parseInt(bugId));
                if (bugDetails) {
                    bugDescription = `${bugDetails.title}\n\n${bugDetails.description}`;
                    response.markdown(`> **Popis z TFS:** ${bugDescription.substring(0, 200)}...\n\n`);
                } else {
                    response.markdown(`⚠️ Bug #${bugId} sa nenašiel v TFS. Zadaj popis manuálne.\n\n`);
                    bugDescription = await getBugDescriptionWithClipboardOption();
                }
            } catch (error: any) {
                response.markdown(`⚠️ Chyba pri načítaní z TFS: ${error.message}. Zadaj popis manuálne.\n\n`);
                bugDescription = await getBugDescriptionWithClipboardOption();
            }
        } else {
            // TFS nie je nakonfigurované - pýtaj sa manuálne
            response.markdown(`ℹ️ TFS nie je nakonfigurované. Zadaj popis bugu manuálne.\n\n`);
            bugDescription = await getBugDescriptionWithClipboardOption();
        }

        if (!bugDescription) {
            response.markdown(`*Popis bugu nebol zadaný. Test sa nemôže spustiť.*`);
            return;
        }

        // Spustiť automatizovaný test
        await runAutomatedTest(context, response, token, bugDescription, bugId, config);
        
        return;
    });

    context.subscriptions.push(autotestAgent);
    
    // ===== Registrácia príkazov =====
    
    // Init príkaz
    const initCommand = vscode.commands.registerCommand('autotest.init', async () => {
        await runInitializationSetup(context);
    });
    
    // Reconfigure príkaz
    const reconfigureCommand = vscode.commands.registerCommand('autotest.reconfigure', async () => {
        const confirm = await vscode.window.showWarningMessage(
            'Naozaj chceš resetovať konfiguráciu?',
            'Áno', 'Nie'
        );
        if (confirm === 'Áno') {
            await resetConfiguration(context);
            tfsClient = null;
            vscode.window.showInformationMessage('✅ Konfigurácia bola resetovaná!');
        }
    });
    
    // TFS Setup príkaz
    const tfsSetupCommand = vscode.commands.registerCommand('autotest.tfsSetup', async () => {
        await setupTfsConnection(context);
    });
    
    // Cleanup príkaz
    const cleanupCommand = vscode.commands.registerCommand('autotest.cleanup', async (workspacePath: string, testFolderName?: string) => {
        try {
            // Zmaž screenshoty a výsledky zo špecifického test folderu
            if (testFolderName) {
                const testDir = path.join(workspacePath, 'autotest', testFolderName);
                const filesToDelete = ['success_screenshot.png', 'error_screenshot.png', 'test_result.md', 'network.json', 'console_logs.json', 'dom.html'];
                for (const file of filesToDelete) {
                    const filePath = path.join(testDir, file);
                    if (fs.existsSync(filePath)) {
                        fs.unlinkSync(filePath);
                    }
                }
            }
            
            vscode.window.showInformationMessage('🧹 Dočasné súbory boli zmazané!');
            
            // Git commit a push
            try {
                await execAsync('git add . && git commit -m "Test prešiel - bug opravený" && git push', {
                    cwd: workspacePath
                });
                vscode.window.showInformationMessage('✅ Zmeny boli pushnuté na Git!');
            } catch (gitError: any) {
                vscode.window.showWarningMessage(`⚠️ Git operácia zlyhala: ${gitError.message}`);
            }
            
        } catch (error: any) {
            vscode.window.showErrorMessage(`Chyba pri upratovaní: ${error.message}`);
        }
    });
    
    // Keep screenshots príkaz
    const keepScreenshotsCommand = vscode.commands.registerCommand('autotest.keepScreenshots', () => {
        vscode.window.showInformationMessage('📁 Screenshoty boli ponechané na ďalšie preskúmanie.');
    });
    
    context.subscriptions.push(
        initCommand,
        reconfigureCommand,
        tfsSetupCommand,
        cleanupCommand,
        keepScreenshotsCommand
    );
}

export function deactivate() {}
