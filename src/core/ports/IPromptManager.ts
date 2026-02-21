export interface IPromptManager {
    loadPromptTemplate(templateName: string): Promise<string>;
    renderPrompt(templateName: string, variables: Record<string, string>): Promise<string>;
}
