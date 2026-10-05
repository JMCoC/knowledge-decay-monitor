const EXPECTED_REPOSITORY = "jmcoc/knowledge-decay-monitor";
const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/i;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCommitSha(value) {
  return typeof value === "string" && FULL_COMMIT_SHA.test(value);
}

function sameCommit(left, right) {
  return isCommitSha(left) && isCommitSha(right) && left.toLowerCase() === right.toLowerCase();
}

function isExpectedRepository(value) {
  return typeof value === "string" && value.toLowerCase() === EXPECTED_REPOSITORY;
}

/**
 * @param {unknown} value
 * @returns {{target: "preview" | "production", sha: string, prNumber?: number} | null}
 */
export function chooseDeployment(value) {
  if (!isRecord(value)) return null;

  const input = value;
  if (
    input.qualityResult !== "success" ||
    input.authorizedActor !== true ||
    !isExpectedRepository(input.repository) ||
    !sameCommit(input.testedSha, input.headSha)
  ) {
    return null;
  }

  if (input.eventName === "pull_request") {
    if (
      input.prState !== "open" ||
      input.draft !== false ||
      !isExpectedRepository(input.headRepository) ||
      typeof input.prNumber !== "number" ||
      !Number.isSafeInteger(input.prNumber) ||
      input.prNumber <= 0 ||
      input.ref !== `refs/pull/${input.prNumber}/merge`
    ) {
      return null;
    }

    return { target: "preview", sha: input.testedSha, prNumber: input.prNumber };
  }

  if (input.eventName === "push" && input.ref === "refs/heads/main") {
    return { target: "production", sha: input.testedSha };
  }

  return null;
}
