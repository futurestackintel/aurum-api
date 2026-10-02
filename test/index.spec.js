import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";

describe("API worker root route", () => {
	it("returns route-not-found for an unregistered root path (unit style)", async () => {
		const request = new Request("http://example.com");
		// Create an empty context to pass to `worker.fetch()`.
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		// Wait for all `Promise`s passed to `ctx.waitUntil()` to settle before running test assertions
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "Route not found" });
	});

	it("returns route-not-found for an unregistered root path (integration style)", async () => {
		const response = await SELF.fetch("http://example.com");
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "Route not found" });
	});
});
