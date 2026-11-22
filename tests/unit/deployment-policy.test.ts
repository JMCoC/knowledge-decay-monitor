import { describe, expect, it } from "vitest";
import { chooseDeployment, type DeploymentPolicyInput } from "../../scripts/deployment-policy.mjs";

const repository = "JMCoC/knowledge-decay-monitor";
const sha = "a".repeat(40);

const productionInput: DeploymentPolicyInput = {
  eventName: "push",
  ref: "refs/heads/main",
  qualityResult: "success",
  testedSha: sha,
  headSha: sha,
  repository,
  authorizedActor: true,
};

describe("deployment policy", () => {
  it("rejects a pull request with passing quality gates", () => {
    expect(chooseDeployment({
      ...productionInput,
      eventName: "pull_request",
      ref: "refs/pull/8/merge",
    })).toBeNull();
  });

  it.each(["failure", "cancelled", "skipped", "pending"]) (
    "rejects a main push when quality is %s",
    (qualityResult) => {
      expect(chooseDeployment({ ...productionInput, qualityResult })).toBeNull();
    },
  );

  it.each([
    ["develop", { ref: "refs/heads/develop" }],
    ["an unauthorized actor", { authorizedActor: false }],
    ["a different repository", { repository: "another/repository" }],
    ["a stale commit", { headSha: "b".repeat(40) }],
    ["a malformed commit", { testedSha: `${sha}-dirty` }],
  ])("rejects a main push with %s", (_label, override) => {
    expect(chooseDeployment({ ...productionInput, ...override })).toBeNull();
  });

  it("allows the current authorized main push for Production", () => {
    expect(chooseDeployment(productionInput)).toEqual({ target: "production", sha });
  });

  it("rejects unknown events and extra-invalid data", () => {
    expect(chooseDeployment({ ...productionInput, eventName: "pull_request_target" })).toBeNull();
    expect(chooseDeployment(null as unknown as DeploymentPolicyInput)).toBeNull();
  });
});
