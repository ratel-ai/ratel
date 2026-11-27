import { conditionText, measuredText, unitOf } from "@/lib/views/alerts/format";
import type { AlertNotice } from "@/lib/views/alerts/notifier";

/** The body of one Slack post: short, with the numbers and the way to the alert. */
export function slackMessage(notice: AlertNotice, alertUrl: string): { text: string } {
  const unit = unitOf(notice.query);
  const title = notice.kind === "fire" ? ":rotating_light: Alert" : ":white_check_mark: Recovered";
  const value = notice.value === null ? "no data" : measuredText(notice.value, unit);
  return {
    text: [
      `${title}: *${escaped(notice.ruleName)}* (${escaped(notice.projectName)})`,
      escaped(`Value ${value}. Alert when ${conditionText(notice, notice)}.`),
      `<${alertUrl}|Open the alert>`,
    ].join("\n"),
  };
}

export function slackTestMessage(destinationName: string, projectName: string): { text: string } {
  return {
    text: `Test message from Ratel: *${escaped(destinationName)}* (${escaped(projectName)}) receives alerts here.`,
  };
}

/** Slack's three control characters, so a name is never a link or a mention. */
function escaped(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
