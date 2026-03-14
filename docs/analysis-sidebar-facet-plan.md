# Sidebar Facet API Plan

## Scope

- Improve `TOP TOPICS` and `TOP TAGS` quality in the analysis backend by filtering high-frequency non-meaningful English and Chinese tokens.
- Expose stable facet stats in the snapshot API so an external frontend can render collapsed facet chips and apply list filtering.
- Keep `aggregate.tagCounts` and `aggregate.topicCounts` unchanged as the raw aggregate source of truth.

## API Changes

- Add `AnalysisFacetStat` to the contracts package:
  - `value: string`
  - `count: number`
- Extend `AnalysisJobSnapshotResponse` with:
  - `topTagStats: AnalysisFacetStat[]`
  - `topTopicStats: AnalysisFacetStat[]`
- Preserve `topTags` and `topTopics` for compatibility:
  - derive them from the corresponding stats arrays
  - keep the same order
  - raise the limit to `50`

## Snapshot Facet Rules

- Source only from `aggregate.tagCounts` and `aggregate.topicCounts`.
- Sort by `count desc`.
- Break ties by `value asc`.
- Return at most `50` items.
- Include counts in `topTagStats` and `topTopicStats`.

## External UI Integration

- Consume `topTagStats` and `topTopicStats` instead of bare string arrays.
- Render chip text as `value(count)` with no spaces.
- Use collapsed-by-height behavior instead of fixed item count:
  - desktop defaults to `3` lines
  - narrow screens default to `2` lines
- Show `More` only when the content exceeds the collapsed height.
- Expanded state still caps rendering at the first `50` facet stats.
- Facet interaction is single-select:
  - clicking a new chip replaces the active facet
  - clicking the active chip clears the filter
- Left list filtering must use exact facet value matching.
- The external frontend must ensure left-list records already include `tags` and `topics`, or extend its data source accordingly.

## Test Plan

- `packages/shared` unit tests:
  - English stopwords do not enter derived tags/topics.
  - Meaningful tokens are still retained.
  - Mixed Chinese/English content remains stable after filtering.
- API/service tests:
  - snapshot returns `topTagStats` and `topTopicStats` with counts
  - facet stats are sorted by `count desc`, then `value asc`
  - facet stats are capped at `50`
  - `topTags` and `topTopics` remain present and match the stats order
  - `aggregate.tagCounts` and `aggregate.topicCounts` remain unchanged

## Assumptions

- The analysis backend is the only code in scope for this change set.
- The right sidebar and left list UI live outside this repository.
- This task improves facet quality and API usability only; it does not attempt to de-duplicate tag/topic semantics.
