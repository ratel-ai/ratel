import { useCallback, useEffect } from "react";
import { AgentifiedProvider, Inspector, useAgentifiedTool, useAgentifiedClient } from "@agentified/react";
import { Dashboard } from "./pages/Dashboard";
import { Employees } from "./pages/Employees";
import { TimeOff } from "./pages/TimeOff";
import { Chat } from "./components/Chat";
import { useUIStore } from "./store/uiStore";
import { useHRStore } from "./store/hrStore";

function renderPage(page: "dashboard" | "employees" | "timeoff") {
  switch (page) {
    case "dashboard":
      return <Dashboard />;
    case "employees":
      return <Employees />;
    case "timeoff":
      return <TimeOff />;
  }
}

function FrontendTools() {
  useAgentifiedTool("confirm_action", useCallback(
    async (args: unknown) => {
      const { action, details } = args as { action: string; details?: string };
      const message = details ? `${action}\n\n${details}` : action;
      return { confirmed: window.confirm(message) };
    }, [],
  ));

  useAgentifiedTool("navigate_to_page", useCallback(async (args: unknown) => {
    const { page } = args as { page: "dashboard" | "employees" | "timeoff" };
    useUIStore.getState().setPage(page);
    return { navigated: true, page };
  }, []));

  useAgentifiedTool("get_page_snapshot", useCallback(async () => {
    const ui = useUIStore.getState();
    const hr = useHRStore.getState();
    const domText = document.querySelector(".quickhr-main")?.textContent?.slice(0, 2000) || "";
    return {
      page: ui.page,
      timeOffTab: ui.timeOffTab,
      employeeModalOpen: ui.employeeModalOpen,
      timeOffModalOpen: ui.timeOffModalOpen,
      calendarMonth: ui.calendarMonth,
      calendarYear: ui.calendarYear,
      employeeCount: hr.employees.length,
      timeOffRequestCount: hr.timeOffRequests.length,
      visibleText: domText,
    };
  }, []));

  return null;
}

function ContextSync() {
  const client = useAgentifiedClient();
  const page = useUIStore((s) => s.page);
  const employeeModalOpen = useUIStore((s) => s.employeeModalOpen);
  const timeOffModalOpen = useUIStore((s) => s.timeOffModalOpen);
  const timeOffTab = useUIStore((s) => s.timeOffTab);

  useEffect(() => {
    const openModals: string[] = [];
    if (employeeModalOpen) openModals.push("employeeModal");
    if (timeOffModalOpen) openModals.push("timeOffModal");
    client.setSharedContext({ page, openModals, activeTab: page === "timeoff" ? timeOffTab : undefined });
  }, [client, page, employeeModalOpen, timeOffModalOpen, timeOffTab]);

  return null;
}

export function App() {
  const page = useUIStore((s) => s.page);
  const setPage = useUIStore((s) => s.setPage);

  return (
    <AgentifiedProvider agentUrl="/api/chat">
      <FrontendTools />
      <ContextSync />
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

        <Inspector defaultOpen={false} />
      </div>
    </AgentifiedProvider>
  );
}
