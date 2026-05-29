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
    async getBugDetails(bugId: number): Promise<{ title: string; description: string } | null> {
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

            return {
                title,
                description: cleanDescription
            };
        } catch (error: any) {
            console.error('Error getting bug details:', error);
            throw new Error(`Nepodarilo sa načítať bug #${bugId}: ${error.message}`);
        }
    }

    /**
     * Vytvorí nový bug v TFS
     */
    async createBug(
        title: string,
        description: string,
        reproSteps: string,
        screenshotPath?: string
    ): Promise<{ id: number; url: string }> {
        if (!this.connection) {
            throw new Error('Nie si pripojený k TFS');
        }

        try {
            const witApi = await this.connection.getWorkItemTrackingApi();

            // Vytvorenie work item dokumentu
            const patchDocument = [
                {
                    op: 'add',
                    path: '/fields/System.Title',
                    value: title
                },
                {
                    op: 'add',
                    path: '/fields/System.Description',
                    value: description
                },
                {
                    op: 'add',
                    path: '/fields/Microsoft.VSTS.TCM.ReproSteps',
                    value: reproSteps
                }
            ];

            const workItem = await witApi.createWorkItem(
                undefined,
                patchDocument as any,
                this.projectName,
                'Bug'
            );

            if (!workItem || !workItem.id) {
                throw new Error('Work item sa nepodarilo vytvoriť');
            }

            const bugUrl = `${this.organizationUrl}/${this.projectName}/_workitems/edit/${workItem.id}`;

            // Ak existuje screenshot, pripoj ho ako attachment
            if (screenshotPath) {
                await this.attachScreenshot(workItem.id, screenshotPath);
            }

            return {
                id: workItem.id,
                url: bugUrl
            };
        } catch (error: any) {
            console.error('Error creating bug:', error);
            throw new Error(`Nepodarilo sa vytvoriť bug: ${error.message}`);
        }
    }

    /**
     * Aktualizuje stav bugu
     */
    async updateBugStatus(bugId: number, state: string): Promise<boolean> {
        if (!this.connection) {
            throw new Error('Nie si pripojený k TFS');
        }

        try {
            const witApi = await this.connection.getWorkItemTrackingApi();

            const patchDocument = [
                {
                    op: 'add',
                    path: '/fields/System.State',
                    value: state
                }
            ];

            await witApi.updateWorkItem(
                undefined,
                patchDocument as any,
                bugId,
                this.projectName
            );

            return true;
        } catch (error: any) {
            console.error('Error updating bug status:', error);
            throw new Error(`Nepodarilo sa aktualizovať stav bugu: ${error.message}`);
        }
    }

    /**
     * Pripojí screenshot ako attachment k work item
     */
    private async attachScreenshot(workItemId: number, screenshotPath: string): Promise<void> {
        if (!this.connection) {
            return;
        }

        try {
            const fs = require('fs');
            const path = require('path');
            
            if (!fs.existsSync(screenshotPath)) {
                console.warn('Screenshot file not found:', screenshotPath);
                return;
            }

            const witApi = await this.connection.getWorkItemTrackingApi();
            const fileContent = fs.readFileSync(screenshotPath);
            const fileName = path.basename(screenshotPath);

            // Upload attachment
            const attachment = await witApi.createAttachment(
                undefined,
                fileContent,
                fileName,
                undefined,
                this.projectName
            );

            if (!attachment || !attachment.url) {
                throw new Error('Attachment upload failed');
            }

            // Link attachment to work item
            const patchDocument = [
                {
                    op: 'add',
                    path: '/relations/-',
                    value: {
                        rel: 'AttachedFile',
                        url: attachment.url,
                        attributes: {
                            comment: 'Screenshot z automatického testu'
                        }
                    }
                }
            ];

            await witApi.updateWorkItem(
                undefined,
                patchDocument as any,
                workItemId,
                this.projectName
            );
        } catch (error: any) {
            console.error('Error attaching screenshot:', error);
            // Neprerušujeme proces kvôli zlyhaniu attachmentu
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
     * Odpojí sa od TFS
     */
    disconnect(): void {
        this.connection = null;
        this.organizationUrl = '';
        this.projectName = '';
    }
}
