
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
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "Route not found" });
	});

	it("returns route-not-found for an unregistered root path (integration style)", async () => {
		const response = await SELF.fetch("http://example.com");
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "Route not found" });
	});

	it("rejects unauthenticated registration with 401", async () => {
		const response = await SELF.fetch(
			"http://example.com/api/auth/register",
			{ method: "POST" }
		);

		expect(response.status).toBe(401);
	});

	it("rejects unauthenticated auth/me requests with 401", async () => {
		const response = await SELF.fetch(
			"http://example.com/api/auth/me"
		);

		expect(response.status).toBe(401);
	});
	it("rejects unauthenticated profile updates with 401", async () => {
  const response = await SELF.fetch(
    "http://example.com/api/users/me",
    { method: "PATCH", body: JSON.stringify({ bio: "Test" }) }
  );

  expect(response.status).toBe(401);
});
});
