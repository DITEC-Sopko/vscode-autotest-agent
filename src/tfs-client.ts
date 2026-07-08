import * as azdev from 'azure-devops-node-api';
import { WorkItem, WorkItemExpand } from 'azure-devops-node-api/interfaces/WorkItemTrackingInterfaces';

/** Prepojený Test Case nájdený cez relácie work itemu (Related / Tested By). */
export interface LinkedTestCase {
    id: number;
    title: string;
    /** Ľudsky čitateľný typ prepojenia, napr. „Tested By" alebo „Related". */
    relation: string;
    /** Kroky test casu naformátované ako markdown (môže byť prázdne). */
    steps: string;
}

/**
 * TFS/Azure DevOps Client wrapper
 */
export class TfsClient {
    private connection: azdev.WebApi | null = null;
    private organizationUrl: string = '';
    private projectName: string = '';

    /**
     * Pripojí sa k TFS/Azure DevOps
     */
    async connect(organizationUrl: string, projectName: string, pat: string): Promise<boolean> {
        try {
            this.organizationUrl = organizationUrl;
            this.projectName = projectName;

            const authHandler = azdev.getPersonalAccessTokenHandler(pat);
            this.connection = new azdev.WebApi(organizationUrl, authHandler);

            // Test connection
            const coreApi = await this.connection.getCoreApi();
            await coreApi.getProjects();

            return true;
        } catch (error: any) {
            console.error('TFS connection error:', error);
            throw new Error(`Pripojenie k TFS zlyhalo: ${error.message}`);
        }
    }

    /**
     * Validuje pripojenie k TFS
     */
    async validateConnection(): Promise<{ success: boolean; message: string }> {
        if (!this.connection) {
            return { success: false, message: 'Nie si pripojený k TFS' };
        }

        try {
            const coreApi = await this.connection.getCoreApi();
            const projects = await coreApi.getProjects();
            
            const projectExists = projects.some(p => p.name === this.projectName);
            
            if (!projectExists) {
                return { 
                    success: false, 
                    message: `Projekt "${this.projectName}" nebol najdený v organizácii` 
                };
            }

            return { success: true, message: 'Pripojenie k TFS je aktívne ✅' };
        } catch (error: any) {
            return { success: false, message: `Validácia zlyhala: ${error.message}` };
        }
    }

    /**
     * Načíta detaily bugu z TFS
     */
    async getBugDetails(bugId: number): Promise<{ title: string; description: string; comments: string[]; changedDate: string } | null> {
        if (!this.connection) {
            throw new Error('Nie si pripojený k TFS');
        }

        try {
            const witApi = await this.connection.getWorkItemTrackingApi();
            const workItem = await witApi.getWorkItem(bugId, undefined, undefined, undefined, this.projectName);

            if (!workItem || !workItem.fields) {
                return null;
            }

            const title = workItem.fields['System.Title'] || '';

            // Poskladaj popis zo VŠETKÝCH relevantných polí bugu (nie len jedného),
            // aby mal generátor scenára kompletný kontext. Prázdne polia sa vynechajú.
            const sections: Array<{ heading: string; field: string }> = [
                { heading: 'Popis', field: 'System.Description' },
                { heading: 'Kroky na reprodukciu', field: 'Microsoft.VSTS.TCM.ReproSteps' },
                { heading: 'Akceptačné kritériá', field: 'Microsoft.VSTS.Common.AcceptanceCriteria' },
                { heading: 'Systémové informácie', field: 'Microsoft.VSTS.TCM.SystemInfo' }
            ];
            const parts: string[] = [];
            for (const s of sections) {
                const clean = this.stripHtml(String(workItem.fields[s.field] || ''));
                if (clean) { parts.push(`## ${s.heading}:\n${clean}`); }
            }
            const cleanDescription = parts.join('\n\n');

            // Načítaj komentáre/diskusiu – podstatné info sa často presunie tam.
            const comments = await this.getWorkItemComments(witApi, bugId);

            return {
                title,
                description: cleanDescription,
                comments,
                changedDate: String(workItem.fields['System.ChangedDate'] || '')
            };
        } catch (error: any) {
            console.error('Error getting bug details:', error);
            throw new Error(`Nepodarilo sa načítať bug #${bugId}: ${error.message}`);
        }
    }

    /** Načíta komentáre work itemu (best-effort, naprieč rôznymi verziami API). */
    private async getWorkItemComments(witApi: any, bugId: number): Promise<string[]> {
        try {
            const res: any = await witApi.getComments(this.projectName, bugId);
            const arr: any[] = res?.comments || (Array.isArray(res) ? res : []);
            return arr
                .map(c => this.stripHtml(c?.text || ''))
                .filter((t: string) => t.length > 0);
        } catch {
            return [];
        }
    }

    /**
     * Odstráni HTML tagy z textu
     */
    private stripHtml(html: string): string {
        if (!html) {
            return '';
        }
        return html.replace(/<[^>]*>/g, '').trim();
    }

    /**
     * Nájde Test Case-y prepojené na daný work item (bug/task/requirement)
     * cez relácie **Related** alebo **Tested By**. Vráti len položky typu „Test Case",
     * vrátane naparsovaných krokov.
     */
    async getLinkedTestCases(workItemId: number): Promise<LinkedTestCase[]> {
        if (!this.connection) {
            throw new Error('Nie si pripojený k TFS');
        }

        try {
            const witApi = await this.connection.getWorkItemTrackingApi();
            const wi = await witApi.getWorkItem(workItemId, undefined, undefined, WorkItemExpand.Relations, this.projectName);
            const relations = wi?.relations || [];

            // Zaujímajú nás len relácie Related a Tested By (forward = „tento bug je testovaný X").
            const relLabels: Record<string, string> = {
                'System.LinkTypes.Related': 'Related',
                'Microsoft.VSTS.Common.TestedBy-Forward': 'Tested By'
            };

            const candidates = relations
                .map(r => ({ id: this.extractWorkItemId(r?.url || ''), relation: relLabels[r?.rel || ''] || '' }))
                .filter(c => c.id > 0 && c.relation);

            const result: LinkedTestCase[] = [];
            for (const c of candidates) {
                if (result.some(r => r.id === c.id)) { continue; }
                try {
                    const tc = await witApi.getWorkItem(c.id, undefined, undefined, undefined, this.projectName);
                    const type = String(tc.fields?.['System.WorkItemType'] || '');
                    if (type !== 'Test Case') { continue; }
                    result.push({
                        id: c.id,
                        title: String(tc.fields?.['System.Title'] || `Test Case #${c.id}`),
                        relation: c.relation,
                        steps: this.parseTestSteps(String(tc.fields?.['Microsoft.VSTS.TCM.Steps'] || ''))
                    });
                } catch { /* jedna nedostupná položka nesmie zhodiť celé hľadanie */ }
            }
            return result;
        } catch (error: any) {
            console.error('Error getting linked test cases:', error);
            throw new Error(`Nepodarilo sa načítať prepojené test case-y pre #${workItemId}: ${error.message}`);
        }
    }

    /** Vytiahne číselné ID work itemu z URL relácie (…/workItems/1234). */
    private extractWorkItemId(url: string): number {
        const m = url.match(/\/(\d+)\s*$/);
        return m ? parseInt(m[1], 10) : 0;
    }

    /**
     * Naparsuje kroky Test Casu z poľa `Microsoft.VSTS.TCM.Steps` (XML).
     * Každý `<step>` má dva `<parameterizedString>` – akciu a očakávaný výsledok.
     */
    private parseTestSteps(xml: string): string {
        if (!xml) {
            return '';
        }
        const steps: string[] = [];
        const stepRe = /<step\b[^>]*>([\s\S]*?)<\/step>/g;
        const paramRe = /<parameterizedString\b[^>]*>([\s\S]*?)<\/parameterizedString>/g;
        let stepMatch: RegExpExecArray | null;
        let idx = 1;
        while ((stepMatch = stepRe.exec(xml)) !== null) {
            const inner = stepMatch[1];
            const params: string[] = [];
            let pMatch: RegExpExecArray | null;
            paramRe.lastIndex = 0;
            while ((pMatch = paramRe.exec(inner)) !== null) {
                params.push(this.decodeStepText(pMatch[1]));
            }
            const action = params[0] || '';
            const expected = params[1] || '';
            if (!action && !expected) { continue; }
            let line = `${idx}. ${action || '(bez popisu akcie)'}`;
            if (expected) { line += `\n   Očakávaný výsledok: ${expected}`; }
            steps.push(line);
            idx++;
        }
        return steps.join('\n');
    }

    /** Dekóduje HTML-encoded text kroku a odstráni HTML tagy. */
    private decodeStepText(raw: string): string {
        const decoded = raw
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&');
        return this.stripHtml(decoded);
    }

    /**
     * Načíta bugy/requirements/test scénáre priradené aktuálnemu používateľovi
     */
    async getMyWorkItems(
        states: string[] = ['Proposed', 'Active'],
        workItemTypes: string[] = ['Bug', 'Requirement', 'Test Case'],
        assignedToMe: boolean = true
    ): Promise<Array<{ id: number; title: string; type: string; state: string; url: string; changedDate: string }>> {
        if (!this.connection) {
            throw new Error('Nie si pripojený k TFS');
        }

        try {
            const witApi = await this.connection.getWorkItemTrackingApi();

            const assignedClause = assignedToMe ? `AND [System.AssignedTo] = @Me` : '';
            const wiql = `
                SELECT [System.Id], [System.Title], [System.WorkItemType], [System.State]
                FROM WorkItems
                WHERE [System.TeamProject] = '${this.projectName}'
                    ${assignedClause}
                    AND [System.State] IN (${states.map(s => `'${s}'`).join(', ')})
                    AND [System.WorkItemType] IN (${workItemTypes.map(t => `'${t}'`).join(', ')})
                ORDER BY [System.ChangedDate] DESC
            `;

            const queryResult = await witApi.queryByWiql({ query: wiql });

            if (!queryResult.workItems || queryResult.workItems.length === 0) {
                return [];
            }

            const workItems = await Promise.all(
                queryResult.workItems.map(async (wi) => {
                    const id = wi.id;
                    if (!id) {
                        return null;
                    }

                    try {
                        const details = await witApi.getWorkItem(id, undefined, undefined, undefined, this.projectName);
                        const url = `${this.organizationUrl}/${this.projectName}/_workitems/edit/${id}`;

                        return {
                            id,
                            title: String(details.fields?.['System.Title'] || 'N/A'),
                            type: String(details.fields?.['System.WorkItemType'] || 'Unknown'),
                            state: String(details.fields?.['System.State'] || 'Unknown'),
                            changedDate: String(details.fields?.['System.ChangedDate'] || ''),
                            url
                        };
                    } catch {
                        return {
                            id,
                            title: 'Nepodarilo sa načítať',
                            type: 'Unknown',
                            state: 'Unknown',
                            changedDate: '',
                            url: `${this.organizationUrl}/${this.projectName}/_workitems/edit/${id}`
                        };
                    }
                })
            );

            return workItems.filter((item): item is { id: number; title: string; type: string; state: string; url: string; changedDate: string } => item !== null);
        } catch (error: any) {
            console.error('Error getting my work items:', error);
            throw new Error(`Nepodarilo sa načítať work items: ${error.message}`);
        }
    }

    /**
     * Odpojí sa od TFS
     */
    disconnect(): void {
        this.connection = null;
        this.organizationUrl = '';
        this.projectName = '';
    }
}
