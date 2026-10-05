import { describe, expect, it } from "vitest";
import { chooseDeployment, type DeploymentPolicyInput } from "../../scripts/deployment-policy.mjs";

const repository = "JMCoC/knowledge-decay-monitor";
const sha = "a".repeat(40);

const previewInput: DeploymentPolicyInput = {
  eventName: "pull_request",
  ref: "refs/pull/8/merge",
  qualityResult: "success",
  testedSha: sha,
  headSha: sha,
  headRepository: repository,
  repository,
  prState: "open",
  draft: false,
  prNumber: 8,
  authorizedActor: true,
};

describe("deployment policy", () => {
  it("allows an authorized current internal PR for Preview", () => {
    expect(chooseDeployment(previewInput)).toEqual({ target: "preview", sha, prNumber: 8 });
  });

  it.each(["failure", "cancelled", "skipped", "pending"]) (
    "rejects a PR when quality is %s",
    (qualityResult) => {
      expect(chooseDeployment({ ...previewInput, qualityResult })).toBeNull();
    },
  );

  it.each([
    ["fork", { headRepository: "outsider/knowledge-decay-monitor" }],
    ["draft", { draft: true }],
    ["unauthorized actor", { authorizedActor: false }],
    ["closed PR", { prState: "closed" }],
    ["changed head", { headSha: "b".repeat(40) }],
    ["different repository", { repository: "another/repository" }],
    ["wrong PR ref", { ref: "refs/pull/9/merge" }],
    ["invalid tested SHA", { testedSha: "not-a-commit" }],
    ["invalid PR number", { prNumber: 0 }],
  ])("rejects %s", (_label, override) => {
    expect(chooseDeployment({ ...previewInput, ...override } as DeploymentPolicyInput)).toBeNull();
  });

  it("allows only the current authorized main push for Production", () => {
    expect(
      chooseDeployment({
        eventName: "push",
        ref: "refs/heads/main",
        qualityResult: "success",
        testedSha: sha,
        headSha: sha,
        repository,
        authorizedActor: true,
      }),
    ).toEqual({ target: "production", sha });
  });

  it.each([
    ["develop", { ref: "refs/heads/develop" }],
    ["an unauthorized actor", { authorizedActor: false }],
    ["a failed quality job", { qualityResult: "failure" }],
    ["a stale commit", { headSha: "b".repeat(40) }],
    ["a malformed commit", { testedSha: `${sha}-dirty` }],
  ])("rejects a main push with %s", (_label, override) => {
    expect(
      chooseDeployment({
        eventName: "push",
        ref: "refs/heads/main",
        qualityResult: "success",
        testedSha: sha,
        headSha: sha,
        repository,
        authorizedActor: true,
        ...override,
      }),
    ).toBeNull();
  });

  it("rejects unknown events and extra-invalid data", () => {
    expect(chooseDeployment({ ...previewInput, eventName: "pull_request_target" })).toBeNull();
    expect(chooseDeployment(null as unknown as DeploymentPolicyInput)).toBeNull();
  });
});
