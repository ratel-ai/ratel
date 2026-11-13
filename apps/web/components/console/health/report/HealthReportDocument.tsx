import { BadgerMark } from "@ratel/design-system/badger-mark";
import { cn } from "@ratel/design-system/cn";
import type { HealthReport } from "@/components/console/health/report/report-model";

/**
 * The Agent health report as an A4 document: a dark cover with the reading
 * in one sentence, the readings with their trends, how runs went, every
 * problem with its cost and fix, the workflows, and a colophon that says what
 * the report leaves out. Pure layout over `buildHealthReport`.
 * Its stylesheet (`health-report.css`) is imported by the pages that render it.
 */
export function HealthReportDocument({ report }: { report: HealthReport }) {
  return (
    <article className="hr" data-health-report="true">
      <header className="hr-masthead">
        <span className="hr-brand">
          <BadgerMark />
          Ratel
        </span>
        <span className="hr-kicker">Agent health report · {report.generatedOn}</span>
      </header>

      <section className="hr-cover">
        <p className="hr-kicker">
          {report.organizationName ? `${report.organizationName} · ` : ""}Agent health
        </p>
        <h1 className="hr-display">{report.projectName}</h1>
        <p className="hr-cover-sub hr-mono">
          {report.windowLabel} · {report.runs}
          {report.source ? ` · ${report.source}` : ""}
        </p>
        <p className="hr-verdict" data-report-verdict="true">
          {report.verdict}
        </p>
      </section>

      {report.readings.length > 0 && (
        <section className="hr-section">
          <h2 className="hr-display">Readings</h2>
          <p className="hr-lead">
            The headline figures for the window, with the change against the window before it.
          </p>
          <div className={cn("hr-readings", report.readings.length === 3 && "three")}>
            {report.readings.map((reading) => (
              <div key={reading.key} className="hr-reading" data-report-reading={reading.key}>
                <div className="hr-kicker">{reading.label}</div>
                <div className="hr-figure">
                  <span className="hr-value hr-display">{reading.value}</span>
                  {reading.unit && <span className="hr-unit">{reading.unit}</span>}
                  {reading.delta && (
                    <span
                      className={cn(
                        "hr-delta hr-mono",
                        reading.delta.tone === "good" ? "good" : "bad",
                      )}
                    >
                      {reading.delta.text}
                    </span>
                  )}
                </div>
                <div className="hr-sub">{reading.sub}</div>
                {reading.path && (
                  <svg viewBox="0 0 100 26" preserveAspectRatio="none" aria-hidden>
                    <path
                      d={reading.path}
                      fill="none"
                      stroke="#111312"
                      strokeWidth="1.2"
                      vectorEffect="non-scaling-stroke"
                    />
                  </svg>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {report.shapes.length > 0 && (
        <section className="hr-section">
          <h2 className="hr-display">How runs went</h2>
          <p className="hr-lead">
            Every run in the window, by the shape it took. Most common first.
          </p>
          <div className="hr-shapes">
            {report.shapes.map((shape) => (
              <div key={shape.key} className="hr-shape">
                <span className="hr-shape-name">{shape.label}</span>
                <span className="hr-mono">
                  {shape.share} <span className="hr-unit">· {shape.count}</span>
                </span>
                <span className="hr-shape-desc">{shape.description}</span>
                <span className="hr-bar">
                  <span style={{ width: `${shape.width}%` }} />
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {report.ready && (
        <section className="hr-section hr-page-break">
          <h2 className="hr-display">
            Issues{report.problemsSpan ? ` · ${report.problemsSpan}` : ""}
          </h2>
          <p className="hr-lead">Worst first. Each one says what it costs and what to change.</p>
          {report.problems.length === 0 ? (
            <p className="hr-empty">Nothing has cleared its floor in this window.</p>
          ) : (
            report.problems.map((problem) => (
              <div
                key={problem.key}
                className={cn("hr-problem", problem.tone)}
                data-report-problem={problem.key}
              >
                <div>
                  <span className={cn("hr-tone", problem.tone)}>
                    {problem.tone === "coral" ? "Fix now" : "Watch"}
                  </span>
                  <h3>{problem.title}</h3>
                  {problem.tools && <div className="hr-tools">{problem.tools}</div>}
                </div>
                <div className="hr-big">
                  <div className="hr-value hr-display">{problem.figure}</div>
                  <div className="hr-caption">{problem.caption}</div>
                </div>
                <p className="hr-claim">{problem.claim}</p>
                <p className="hr-cost">{problem.cost}</p>
                <p className="hr-fix">
                  <b>What to do:</b> {problem.fix}
                </p>
              </div>
            ))
          )}
          {report.hiddenProblems > 0 && (
            <p className="hr-lead">
              +{report.hiddenProblems} more {report.hiddenProblems === 1 ? "issue" : "issues"} not
              shown in this report.
            </p>
          )}
        </section>
      )}

      {report.workflows.length > 0 && (
        <section className="hr-section">
          <h2 className="hr-display">Tasks</h2>
          <p className="hr-lead">
            What the agent does for a request: the tools it runs, in order, and how well each task
            runs.
          </p>
          <table>
            <thead>
              <tr>
                <th>Task</th>
                <th>Status</th>
                <th className="num">Runs</th>
                <th className="num">Finish</th>
                <th className="num">Typical</th>
              </tr>
            </thead>
            <tbody>
              {report.workflows.map((workflow) => (
                <tr key={workflow.id}>
                  <td>
                    <div>{workflow.name}</div>
                    <div className="hr-steps">{workflow.steps}</div>
                  </td>
                  <td>
                    <span className={cn("hr-status", workflow.status === "failing" && "failing")}>
                      {workflow.statusLabel}
                    </span>
                  </td>
                  <td className="num">{workflow.runs}</td>
                  <td className="num">{workflow.finish}</td>
                  <td className="num">{workflow.time ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <footer className="hr-colophon">
        <div>
          <h4>How this is read</h4>
          <p>
            Agent health reads the agent&apos;s own traces: which tools it searched for, called and
            retried, and how each run ended. Figures are counted, not sampled, and an issue is
            listed only once it clears its floor.
          </p>
        </div>
        <div>
          <h4>Not in this report</h4>
          <ul>
            <li>Example runs and anything said in them</li>
            <li>Requests from the agent&apos;s users</li>
            <li>Trace, run and session ids, setup details and keys</li>
          </ul>
        </div>
      </footer>
    </article>
  );
}
