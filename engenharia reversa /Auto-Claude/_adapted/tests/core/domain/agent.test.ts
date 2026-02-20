import { expect, test } from "bun:test";
import { Agent } from "@domain/agent";

test("Agent initialization with Path Alias", () => {
    const agent = new Agent("alias-id");
    expect(agent.id).toBe("alias-id");
});
