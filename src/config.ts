import * as vscode from 'vscode';

/**
 * Konfiguračná štruktúra pre TestPilot AI
 */
export interface AutotestConfig {
    userRole: 'developer' | 'tester' | 'unknown';
    appUrl: string;
    appType: 'web' | 'desktop' | 'mobile';
    environment: 'local' | 'remote';
    tfsEnabled: boolean;
    tfsOrganization?: string;
    tfsProject?: string;
    tfsAssignedToMe?: boolean;
    tfsStates?: string;
    tfsTypes?: string;
    skipAvailabilityCheck?: boolean;
    preferredCodeModelId?: string;
    preferredVisionModelId?: string;
    loginRequired?: boolean;
    username?: string;
    headlessMode?: boolean;
    slowMo?: number;
    desktopBackend?: 'pywinauto';
}

/**
 * Načíta konfiguráciu z VS Code storage
 */
export function loadConfiguration(context: vscode.ExtensionContext): AutotestConfig {
    const userRole = context.globalState.get<string>('userRole') as 'developer' | 'tester' | 'unknown' || 'unknown';
    const envConfig = context.workspaceState.get<{
        url: string;
        appType: string;
        environment: string;
        skipAvailabilityCheck?: boolean;
    }>('envConfig');
    
    const tfsConfig = context.workspaceState.get<{
        enabled: boolean;
        organization?: string;
        project?: string;
        assignedToMe?: boolean;
        states?: string;
        types?: string;
    }>('tfsConfig');
    
    const loginConfig = context.workspaceState.get<{
        required: boolean;
        username?: string;
    }>('loginConfig');
    
    const debugConfig = context.workspaceState.get<{
        headless?: boolean;
        slowMo?: number;
    }>('debugConfig');
    
    const desktopConfig = context.workspaceState.get<{
        backend?: 'pywinauto';
    }>('desktopConfig');
    
    // Backward compat: fall back to old single preferredModelId for code model
    const preferredCodeModelId = context.globalState.get<string>('preferredCodeModelId')
        || context.globalState.get<string>('preferredModelId');
    const preferredVisionModelId = context.globalState.get<string>('preferredVisionModelId');

    return {
        userRole,
        appUrl: envConfig?.url || 'http://localhost:3000',
        appType: (envConfig?.appType as any) || 'web',
        environment: (envConfig?.environment as any) || 'local',
        tfsEnabled: tfsConfig?.enabled || false,
        tfsOrganization: tfsConfig?.organization,
        tfsProject: tfsConfig?.project,
        tfsAssignedToMe: tfsConfig?.assignedToMe !== undefined ? tfsConfig.assignedToMe : true,
        tfsStates: tfsConfig?.states || 'Proposed, Active',
        tfsTypes: tfsConfig?.types || 'Bug, Requirement, Test Case',
        skipAvailabilityCheck: envConfig?.skipAvailabilityCheck || false,
        preferredCodeModelId,
        preferredVisionModelId,
        loginRequired: loginConfig?.required || false,
        username: loginConfig?.username,
        headlessMode: debugConfig?.headless !== undefined ? debugConfig.headless : true,
        slowMo: debugConfig?.slowMo || 0,
        desktopBackend: desktopConfig?.backend || 'pywinauto'
    };
}

/**
 * Uloží environment konfiguráciu
 */
export async function saveEnvironmentConfig(
    context: vscode.ExtensionContext,
    config: {
        url: string;
        appType: string;
        environment: string;
        skipAvailabilityCheck?: boolean;
    }
): Promise<void> {
    await context.workspaceState.update('envConfig', config);
}

/**
 * Uloží user role do global state
 */
export async function saveUserRole(
    context: vscode.ExtensionContext,
    role: 'developer' | 'tester'
): Promise<void> {
    await context.globalState.update('userRole', role);
    // Synchronizovať medzi zariadeniami
    context.globalState.setKeysForSync(['userRole']);
}

/**
 * Uloží TFS konfiguráciu
 */
export async function saveTfsConfig(
    context: vscode.ExtensionContext,
    config: {
        enabled: boolean;
        organization?: string;
        project?: string;
        assignedToMe?: boolean;
        states?: string;
        types?: string;
    }
): Promise<void> {
    await context.workspaceState.update('tfsConfig', config);
}

/**
 * Uloží TFS PAT token do secure storage
 */
export async function saveTfsPat(
    context: vscode.ExtensionContext,
    pat: string
): Promise<void> {
    await context.secrets.store('tfs-pat', pat);
}

/**
 * Načíta TFS PAT token zo secure storage
 */
export async function getTfsPat(
    context: vscode.ExtensionContext
): Promise<string | undefined> {
    return await context.secrets.get('tfs-pat');
}

/**
 * Uloží preferovaný model na generovanie kódu/scenárov
 */
export async function savePreferredCodeModel(
    context: vscode.ExtensionContext,
    modelId: string
): Promise<void> {
    await context.globalState.update('preferredCodeModelId', modelId);
    context.globalState.setKeysForSync(['preferredCodeModelId']);
}

/**
 * Uloží preferovaný model na analýzu obrázkov (vision)
 */
export async function savePreferredVisionModel(
    context: vscode.ExtensionContext,
    modelId: string
): Promise<void> {
    await context.globalState.update('preferredVisionModelId', modelId);
    context.globalState.setKeysForSync(['preferredVisionModelId']);
}

/**
 * Uloží login konfiguráciu
 */
export async function saveLoginConfig(
    context: vscode.ExtensionContext,
    config: {
        required: boolean;
        username?: string;
    }
): Promise<void> {
    await context.workspaceState.update('loginConfig', config);
}

/**
 * Uloží login heslo do secure storage
 */
export async function saveLoginPassword(
    context: vscode.ExtensionContext,
    password: string
): Promise<void> {
    await context.secrets.store('login-password', password);
}

/**
 * Uloží debug konfiguráciu (headless mode, slowMo)
 */
export async function saveDebugConfig(
    context: vscode.ExtensionContext,
    config: {
        headless?: boolean;
        slowMo?: number;
    }
): Promise<void> {
    await context.workspaceState.update('debugConfig', config);
}

/**
 * Načíta login heslo zo secure storage
 */
export async function getLoginPassword(
    context: vscode.ExtensionContext
): Promise<string | undefined> {
    return await context.secrets.get('login-password');
}

/**
 * Uloží desktop automation backend konfiguráciu
 */
export async function saveDesktopBackend(
    context: vscode.ExtensionContext,
    backend: 'pywinauto'
): Promise<void> {
    await context.workspaceState.update('desktopConfig', { backend });
}

/**
 * Resetuje všetku konfiguráciu
 */
export async function resetConfiguration(context: vscode.ExtensionContext): Promise<void> {
    await context.globalState.update('userRole', undefined);
    await context.globalState.update('preferredModelId', undefined);
    await context.globalState.update('preferredCodeModelId', undefined);
    await context.globalState.update('preferredVisionModelId', undefined);
    await context.workspaceState.update('envConfig', undefined);
    await context.workspaceState.update('tfsConfig', undefined);
    await context.workspaceState.update('loginConfig', undefined);
    await context.workspaceState.update('debugConfig', undefined);
    await context.workspaceState.update('desktopConfig', undefined);
    await context.secrets.delete('tfs-pat');
    await context.secrets.delete('login-password');
}
