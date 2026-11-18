
import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
  SELF,
} from "cloudflare:test";
import { beforeAll, describe, it, expect } from "vitest";
import securityAuditMigration from "../migrations/0034_security_audit_log.sql?raw";
import worker from "../src";

beforeAll(async () => {
  // Apply the actual security audit migration to the isolated test database.
  await env.DB.exec(securityAuditMigration);
});

async function expectAuthDenial(path) {
  const record = await env.DB.prepare(`
    SELECT action, actor_type, resource_type, resource_id, outcome
    FROM security_audit_log
    WHERE resource_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).bind(path).first();

  expect(record).toEqual({
    action: "auth.authentication_denied",
    actor_type: "anonymous",
    resource_type: "api_route",
    resource_id: path,
    outcome: "denied",
  });
}

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

  it("rejects unauthenticated registration with 401 and records the denial", async () => {
    const response = await SELF.fetch(
      "http://example.com/api/auth/register",
      { method: "POST" }
    );

    expect(response.status).toBe(401);
    await expectAuthDenial("/api/auth/register");
  });

  it("rejects unauthenticated auth/me requests with 401 and records the denial", async () => {
    const response = await SELF.fetch(
      "http://example.com/api/auth/me"
    );

    expect(response.status).toBe(401);
    await expectAuthDenial("/api/auth/me");
  });

  it("rejects unauthenticated profile updates with 401 and records the denial", async () => {
    const response = await SELF.fetch(
      "http://example.com/api/users/me",
      {
        method: "PATCH",
        body: JSON.stringify({ bio: "Test" }),
      }
    );

    expect(response.status).toBe(401);
    await expectAuthDenial("/api/users/me");
  });
});
