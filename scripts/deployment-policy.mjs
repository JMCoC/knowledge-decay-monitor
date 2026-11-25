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
 * @returns {{target: "production", sha: string} | null}
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

  if (input.eventName === "push" && input.ref === "refs/heads/main") {
    return { target: "production", sha: input.testedSha };
  }

  return null;
}
