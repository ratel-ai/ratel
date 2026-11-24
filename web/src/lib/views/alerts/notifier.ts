import type { AlertCondition, AlertNoticeKind, AlertQuery } from "@/lib/views/alerts/types";

/** One message: a rule fired, or recovered. */
export interface AlertNotice extends AlertCondition {
  eventId: string;
  kind: AlertNoticeKind;
  ruleId: string;
  ruleName: string;
  projectId: string;
  projectName: string;
  query: AlertQuery;
  value: number | null;
  at: Date;
  /** The destinations that already have this message. */
  sentTo: readonly string[];
}

export interface NoticeOutcome {
  /** Every destination that has the message now, the ones before this attempt included. */
  sentTo: string[];
  /** Why a destination does not have it, or null. Never holds a secret. */
  error: string | null;
}

/** The way out of an alert. */
export interface AlertNotifier {
  send(notice: AlertNotice): Promise<NoticeOutcome>;
}

/** Keeps the notices it was given: for tests. `fail` makes the next sends fail. */
export function memoryNotifier(): AlertNotifier & { notices: AlertNotice[]; fail: number } {
  const notifier = {
    notices: [] as AlertNotice[],
    fail: 0,
    async send(notice: AlertNotice): Promise<NoticeOutcome> {
      if (notifier.fail > 0) {
        notifier.fail -= 1;
        return { sentTo: [...notice.sentTo], error: "unreachable" };
      }
      notifier.notices.push(notice);
      return { sentTo: ["memory"], error: null };
    },
  };
  return notifier;
}
