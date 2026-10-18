-- The existing v2 fingerprint calculation represents an empty comparison
-- scope as SQL NULL internally. Keep that exact representation in this
-- private-only snapshot while estimates still expose an empty UUID array.
alter table private.analysis_candidate_pair_snapshots
  alter column comparison_version_ids drop not null;

comment on column private.analysis_candidate_pair_snapshots.comparison_version_ids is
  'Sorted comparison scope; NULL preserves existing v2 internal fingerprint semantics for an empty scope.';
