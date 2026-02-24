import type { BaseEvent, CustomEvent, RunAgentInput } from "@ag-ui/client";
import type { MastraAgent } from "@ag-ui/mastra";
import { Observable, Subject } from "rxjs";

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

  readonly onEvent: (event: AgentifiedEvent) => void;

  constructor(config: AgentifiedMastraAdapterConfig) {
    this.mastraAgent = config.mastraAgent;
    this.onEvent = (event) => {
      this.eventSubject.next({
        type: "CUSTOM",
        name: event.type,
        value: event,
      } as CustomEvent);
    };
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      const agentSub = this.mastraAgent.run(input).subscribe({
        next: (event) => subscriber.next(event),
        error: (err) => subscriber.error(err),
        complete: () => subscriber.complete(),
      });
      const eventSub = this.eventSubject.subscribe({
        next: (event) => subscriber.next(event),
      });
      return () => {
        agentSub.unsubscribe();
        eventSub.unsubscribe();
      };
    });
  }
}
