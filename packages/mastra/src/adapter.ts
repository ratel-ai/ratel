import type { BaseEvent, CustomEvent, RunAgentInput } from "@ag-ui/client";
import type { MastraAgent } from "@ag-ui/mastra";
import { Subject, merge, type Observable } from "rxjs";

export interface AgentifiedEvent {
  type: string;
  [key: string]: unknown;
}

export interface AgentifiedMastraAdapterConfig {
  mastraAgent: MastraAgent;
}

export class AgentifiedMastraAdapter {
  private mastraAgent: MastraAgent;
  private eventSubject = new Subject<BaseEvent>();

  constructor(config: AgentifiedMastraAdapterConfig) {
    this.mastraAgent = config.mastraAgent;
  }

  get onEvent(): (event: AgentifiedEvent) => void {
    return (event) => {
      this.eventSubject.next({
        type: "CUSTOM",
        name: event.type,
        value: event,
      } as CustomEvent);
    };
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return merge(
      this.mastraAgent.run(input),
      this.eventSubject.asObservable(),
    );
  }
}
