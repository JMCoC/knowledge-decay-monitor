import type {
  CorrectionCandidateSnapshot,
  CorrectionSubmissionSnapshot,
  CorrectionRoundItemSnapshot,
  FindingReviewSnapshot,
  MemberAssignment,
  ReviewRound,
} from "@/types/contracts";

const memberA = { id: "00000000-0000-4000-8000-000000000101", fullName: "Member A" };
const memberB = { id: "00000000-0000-4000-8000-000000000102", fullName: "Member B" };

const findingOne: FindingReviewSnapshot = {
  id: "00000000-0000-4000-8000-000000000201",
  analysisId: "00000000-0000-4000-8000-000000000301",
  type: "contradiction",
  explanation: "The retention period differs between two sections.",
  severityOriginal: "High",
  severityCurrent: "High",
  status: "confirmed",
  assignee: memberA,
  createdAt: "2026-11-08T12:00:00.000Z",
  revision: 1,
  canChangeStatus: true,
  canChangeSeverity: true,
  canAssign: true,
  canPrepareRound: true,
};

const findingTwo: FindingReviewSnapshot = {
  ...findingOne,
  id: "00000000-0000-4000-8000-000000000202",
  explanation: "The approval owner is out of date.",
  severityOriginal: "Medium",
  severityCurrent: "Medium",
};

const findingThree: FindingReviewSnapshot = {
  ...findingOne,
  id: "00000000-0000-4000-8000-000000000203",
  explanation: "A named role no longer matches the current process.",
  severityOriginal: "Low",
  severityCurrent: "Low",
};

const itemOne: CorrectionRoundItemSnapshot = {
  itemId: "00000000-0000-4000-8000-000000000401",
  finding: findingOne,
  initialAssignee: memberA,
  assignee: memberA,
  revision: 1,
  currentSubmissionId: "00000000-0000-4000-8000-000000000501",
};

const itemTwo: CorrectionRoundItemSnapshot = {
  itemId: "00000000-0000-4000-8000-000000000402",
  finding: findingTwo,
  initialAssignee: memberA,
  assignee: memberA,
  revision: 1,
  currentSubmissionId: "00000000-0000-4000-8000-000000000501",
};

const itemThree: CorrectionRoundItemSnapshot = {
  itemId: "00000000-0000-4000-8000-000000000403",
  finding: findingThree,
  initialAssignee: memberA,
  assignee: memberA,
  revision: 1,
  currentSubmissionId: "00000000-0000-4000-8000-000000000502",
};

const groupedSubmission: CorrectionSubmissionSnapshot = {
  submissionId: "00000000-0000-4000-8000-000000000501",
  versionId: "00000000-0000-4000-8000-000000000601",
  state: "confirmed",
  submitter: memberA,
  itemIds: [itemOne.itemId, itemTwo.itemId],
  upload: {
    versionId: "00000000-0000-4000-8000-000000000601",
    uploadState: "confirmed",
    attemptId: null,
    canOpen: true,
    canResume: false,
    canRecover: false,
  },
  confirmedAt: "2026-11-09T10:00:00.000Z",
};

const singleItemSubmission: CorrectionSubmissionSnapshot = {
  submissionId: "00000000-0000-4000-8000-000000000502",
  versionId: "00000000-0000-4000-8000-000000000602",
  state: "confirmed",
  submitter: memberA,
  itemIds: [itemThree.itemId],
  upload: {
    versionId: "00000000-0000-4000-8000-000000000602",
    uploadState: "confirmed",
    attemptId: null,
    canOpen: true,
    canResume: false,
    canRecover: false,
  },
  confirmedAt: "2026-11-09T10:30:00.000Z",
};

const allItems = [itemOne, itemTwo, itemThree];

/** One Member covers three findings with one grouped file and one independent file. */
export const memberThreeFindingsRoundFixture: ReviewRound = {
  roundId: "00000000-0000-4000-8000-000000000701",
  documentId: "00000000-0000-4000-8000-000000000801",
  mode: "assigned_findings",
  baseActiveVersionId: "00000000-0000-4000-8000-000000000901",
  status: "consolidating",
  revision: 3,
  createdAt: "2026-11-08T13:00:00.000Z",
  openedAt: "2026-11-08T14:00:00.000Z",
  items: allItems,
  submissions: [groupedSubmission, singleItemSubmission],
  coverage: {
    revision: 3,
    complete: true,
    coveredItemCount: 3,
    requiredItemCount: 3,
  },
  candidate: null,
};

const memberBGroupedSubmission: CorrectionSubmissionSnapshot = {
  ...groupedSubmission,
  submissionId: "00000000-0000-4000-8000-000000000503",
  versionId: "00000000-0000-4000-8000-000000000603",
  submitter: memberB,
  itemIds: [itemTwo.itemId],
  upload: {
    ...groupedSubmission.upload,
    versionId: "00000000-0000-4000-8000-000000000603",
  },
};

/** The same document can have independent work owned by two Members. */
export const twoMemberRoundFixture: ReviewRound = {
  ...memberThreeFindingsRoundFixture,
  roundId: "00000000-0000-4000-8000-000000000702",
  items: [
    { ...itemOne, currentSubmissionId: groupedSubmission.submissionId },
    {
      ...itemTwo,
      finding: { ...findingTwo, assignee: memberB },
      initialAssignee: memberB,
      assignee: memberB,
      currentSubmissionId: memberBGroupedSubmission.submissionId,
    },
    { ...itemThree, currentSubmissionId: groupedSubmission.submissionId },
  ],
  submissions: [
    { ...groupedSubmission, itemIds: [itemOne.itemId, itemThree.itemId] },
    memberBGroupedSubmission,
  ],
};

const directCandidate: CorrectionCandidateSnapshot = {
  candidateId: "00000000-0000-4000-8000-000000000551",
  versionId: "00000000-0000-4000-8000-000000000610",
  selectionKind: "direct",
  status: "processing",
  processingStatus: "processing",
  versionStatus: null,
  revision: 1,
  coverageRevision: 3,
  itemIds: allItems.map(({ itemId }) => itemId),
};

/** A complete single-file submission can be selected without another upload. */
export const directFileCandidateRoundFixture: ReviewRound = {
  ...memberThreeFindingsRoundFixture,
  status: "candidate_processing",
  items: allItems.map((item) => ({ ...item, currentSubmissionId: "00000000-0000-4000-8000-000000000504" })),
  submissions: [{
    ...groupedSubmission,
    submissionId: "00000000-0000-4000-8000-000000000504",
    versionId: directCandidate.versionId,
    itemIds: allItems.map(({ itemId }) => itemId),
    upload: { ...groupedSubmission.upload, versionId: directCandidate.versionId },
  }],
  candidate: directCandidate,
};

const consolidatedCandidate: CorrectionCandidateSnapshot = {
  ...directCandidate,
  candidateId: "00000000-0000-4000-8000-000000000552",
  versionId: "00000000-0000-4000-8000-000000000611",
  selectionKind: "consolidated",
};

/** Admin/QA uploads a manually consolidated file after separate Member deliveries. */
export const consolidatedCandidateRoundFixture: ReviewRound = {
  ...memberThreeFindingsRoundFixture,
  status: "candidate_processing",
  candidate: consolidatedCandidate,
};

export const returnedMemberAssignmentFixture: MemberAssignment = {
  finding: findingTwo,
  evidence: [{
    id: "00000000-0000-4000-8000-000000000951",
    documentId: "00000000-0000-4000-8000-000000000801",
    documentName: "Retention policy",
    versionId: "00000000-0000-4000-8000-000000000901",
    versionNumber: 1,
    chunkId: "00000000-0000-4000-8000-000000000952",
    pageNumber: 4,
    section: "Retention",
    sectionHeading: "Review period",
    snapshot: "The review period is stated as twelve months.",
  }],
  document: {
    documentId: "00000000-0000-4000-8000-000000000801",
    name: "Retention policy",
    activeVersionId: "00000000-0000-4000-8000-000000000901",
    activeVersionNumber: 1,
  },
  round: {
    roundId: "00000000-0000-4000-8000-000000000701",
    phase: "waiting",
  },
  ownSubmissions: [groupedSubmission],
  returns: [{
    itemId: itemTwo.itemId,
    reason: "Please update the approval owner to match the current process.",
    createdAt: "2026-11-10T11:00:00.000Z",
  }],
  canSubmit: true,
};

/** Administrative proposals are allowed without fabricated Member assignments. */
export const administrativeProposalRoundFixture: ReviewRound = {
  roundId: "00000000-0000-4000-8000-000000000703",
  documentId: "00000000-0000-4000-8000-000000000801",
  mode: "administrative",
  baseActiveVersionId: "00000000-0000-4000-8000-000000000901",
  status: "consolidating",
  revision: 1,
  createdAt: "2026-11-11T09:00:00.000Z",
  openedAt: "2026-11-11T09:10:00.000Z",
  items: [],
  submissions: [],
  coverage: {
    revision: 1,
    complete: true,
    coveredItemCount: 0,
    requiredItemCount: 0,
  },
  candidate: null,
};
