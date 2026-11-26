-- RTL-385: the judges the system made for tasks (migration 0055 converted each judge_criteria to
-- one, off, at a sample of 100) read at most 10 percent of their traces, as a new task judge does
-- (TASK_JUDGE_SAMPLE_RATE in lib/views/scorers/config.ts). The task job judged a daily sample of 20
-- runs under $0.50 a task, so a judge that a person turns on must not start on every trace. The
-- switch, the criteria and the results stay. A judge a person made is not changed.
UPDATE "trace_scorers"
SET "sample_rate" = 10
WHERE "kind" = 'judge' AND "created_by" = 'system:task-scorers' AND "sample_rate" > 10;
