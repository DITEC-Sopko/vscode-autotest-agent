import * as azdev from 'azure-devops-node-api';
import { WorkItem } from 'azure-devops-node-api/interfaces/WorkItemTrackingInterfaces';

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
    async getBugDetails(bugId: number): Promise<{ title: string; description: string; comments: string[] } | null> {
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
            const description = workItem.fields['System.Description'] || 
                              workItem.fields['Microsoft.VSTS.TCM.ReproSteps'] || 
                              '';

            // Odstráň HTML tagy z popisu ak existujú
            const cleanDescription = this.stripHtml(description);

            // Načítaj komentáre/diskusiu – podstatné info sa často presunie tam.
            const comments = await this.getWorkItemComments(witApi, bugId);

            return {
                title,
                description: cleanDescription,
                comments
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
     * Načíta bugy/requirements/test scénáre priradené aktuálnemu používateľovi
     */
    async getMyWorkItems(
        states: string[] = ['Proposed', 'Active'],
        workItemTypes: string[] = ['Bug', 'Requirement', 'Test Case'],
        assignedToMe: boolean = true
    ): Promise<Array<{ id: number; title: string; type: string; state: string; url: string }>> {
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
                            url
                        };
                    } catch {
                        return {
                            id,
                            title: 'Nepodarilo sa načítať',
                            type: 'Unknown',
                            state: 'Unknown',
                            url: `${this.organizationUrl}/${this.projectName}/_workitems/edit/${id}`
                        };
                    }
                })
            );

            return workItems.filter((item): item is { id: number; title: string; type: string; state: string; url: string } => item !== null);
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
