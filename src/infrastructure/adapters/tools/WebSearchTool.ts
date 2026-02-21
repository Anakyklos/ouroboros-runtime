import { ITool } from "../../../core/ports/ITool";
import { z } from "zod";

export const WebSearchArgsSchema = z.object({
    query: z.string().describe("Search query to execute on the web"),
});

export type WebSearchArgs = z.infer<typeof WebSearchArgsSchema>;

/**
 * A tool that performs a web search.
 * In a real production Ouroboros environment, this would hit an API like DuckDuckGo, Tavily, or Google.
 * For this adaptation, if an API key isn't provided, it can return a generic/mocked structured response
 * or we can implement a basic scraper.
 */
export class WebSearchTool implements ITool<WebSearchArgs, string> {
    public readonly name = "WebSearch";
    public readonly description = "Search the web for information, especially useful for competitor analysis.";
    public readonly schema = WebSearchArgsSchema;

    async execute(input: WebSearchArgs): Promise<string> {
        // Basic mock implementation for the proof of concept.
        // In reality, we'd use `fetch` to call a real search API here.
        console.log(`[WebSearchTool] Simulating search for: "${input.query}"`);

        if (input.query.toLowerCase().includes("competitor") || input.query.toLowerCase().includes("alternative")) {
            return JSON.stringify([
                { title: "Competitor A", snippet: "Users often complain about the slow UI and lack of integrations.", url: "https://competitor-a.com/reviews" },
                { title: "Alternative B", snippet: "Great features but the pricing is too high for small teams.", url: "https://alt-b.io/pricing-complaints" }
            ], null, 2);
        }

        return `Simulated search results for: ${input.query}\n- Result 1: Some interesting fact.\n- Result 2: Another detail.`;
    }
}
