/** Internal alerts of the fake service. Nothing here reaches the user. */
export interface FakeAlerts {
  /** A project went over the daily fake cap. Called once per project and UTC day. */
  capReached(input: {
    projectId: string;
    organizationId: string | null;
    day: string;
    runId: string;
  }): void;
}
