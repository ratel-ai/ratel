import { useState } from "react";
import { AgentifiedProvider, Inspector } from "@agentified/react";
import { Dashboard } from "./pages/Dashboard";
import { Employees } from "./pages/Employees";
import { TimeOff } from "./pages/TimeOff";
import { Chat } from "./components/Chat";

type Page = "dashboard" | "employees" | "timeoff";

function renderPage(page: Page) {
  switch (page) {
    case "dashboard":
      return <Dashboard />;
    case "employees":
      return <Employees />;
    case "timeoff":
      return <TimeOff />;
  }
}

export function App() {
  const [page, setPage] = useState<Page>("dashboard");

  return (
    <AgentifiedProvider agentUrl="/api/chat">
      <div className="app-container">
        <div className="quickhr-platform">
          <header className="app-header">
            <div className="header-left">
              <h1 className="logo">QuickHR</h1>
              <nav className="nav-tabs">
                <button
                  className={`nav-tab ${page === "dashboard" ? "active" : ""}`}
                  onClick={() => setPage("dashboard")}
                >
                  Dashboard
                </button>
                <button
                  className={`nav-tab ${page === "employees" ? "active" : ""}`}
                  onClick={() => setPage("employees")}
                >
                  Employees
                </button>
                <button
                  className={`nav-tab ${page === "timeoff" ? "active" : ""}`}
                  onClick={() => setPage("timeoff")}
                >
                  Time Off
                </button>
              </nav>
            </div>
          </header>

          <main className="quickhr-main">{renderPage(page)}</main>
        </div>

        <aside className="chat-sidebar">
          <Chat />
        </aside>

        <Inspector position="bottom-right" defaultOpen={false} />
      </div>
    </AgentifiedProvider>
  );
}
