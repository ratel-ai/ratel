import { useCallback, useEffect } from "react";
import { useAgentifiedTool } from "@agentified/react";
import { useHRStore } from "../store/hrStore";
import { useUIStore } from "../store/uiStore";
import { TimeOffCard } from "../components/TimeOffCard";
import { TimeOffForm } from "../components/TimeOffForm";
import { CalendarView } from "../components/CalendarView";
import { Modal } from "../components/Modal";

export function TimeOff() {
  useAgentifiedTool("open_timeoff_request_modal", useCallback(async (args: unknown) => {
    const prefill = args as Record<string, string> | undefined;
    const store = useUIStore.getState();
    store.setPage("timeoff");
    store.openTimeOffModal(prefill);
    return { opened: true };
  }, []));

  useAgentifiedTool("switch_tab", useCallback(async (args: unknown) => {
    const { tab } = args as { tab: "requests" | "calendar" };
    useUIStore.getState().setTimeOffTab(tab);
    return { switched: true, tab };
  }, []));

  useAgentifiedTool("navigate_calendar", useCallback(async (args: unknown) => {
    const { month, year } = args as { month: number; year: number };
    const store = useUIStore.getState();
    store.setPage("timeoff");
    store.setTimeOffTab("calendar");
    store.setCalendarMonth(month, year);
    return { navigated: true, month, year };
  }, []));

  const {
    employees,
    timeOffRequests,
    fetchEmployees,
    fetchTimeOffRequests,
    createTimeOffRequest,
    approveTimeOff,
    rejectTimeOff,
    loading,
  } = useHRStore();

  const tab = useUIStore((s) => s.timeOffTab);
  const setTab = useUIStore((s) => s.setTimeOffTab);
  const modalOpen = useUIStore((s) => s.timeOffModalOpen);
  const prefill = useUIStore((s) => s.timeOffModalPrefill);
  const openModal = useUIStore((s) => s.openTimeOffModal);
  const closeModal = useUIStore((s) => s.closeTimeOffModal);
  const calendarMonth = useUIStore((s) => s.calendarMonth);
  const calendarYear = useUIStore((s) => s.calendarYear);
  const setCalendarMonth = useUIStore((s) => s.setCalendarMonth);

  useEffect(() => {
    fetchEmployees();
    fetchTimeOffRequests();
  }, [fetchEmployees, fetchTimeOffRequests]);

  const handleSubmit = async (
    data: Parameters<typeof createTimeOffRequest>[0]
  ) => {
    await createTimeOffRequest(data);
    closeModal();
  };

  const handlePrevMonth = () => {
    if (calendarMonth === 0) {
      setCalendarMonth(11, calendarYear - 1);
    } else {
      setCalendarMonth(calendarMonth - 1, calendarYear);
    }
  };

  const handleNextMonth = () => {
    if (calendarMonth === 11) {
      setCalendarMonth(0, calendarYear + 1);
    } else {
      setCalendarMonth(calendarMonth + 1, calendarYear);
    }
  };

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>Time Off</h1>
          <p>Review and manage PTO requests.</p>
        </div>
        <button className="btn btn--primary" onClick={() => openModal()}>
          + Request Time Off
        </button>
      </div>

      <div className="tabs">
        <button
          className={`tab ${tab === "requests" ? "tab--active" : ""}`}
          onClick={() => setTab("requests")}
        >
          Requests
        </button>
        <button
          className={`tab ${tab === "calendar" ? "tab--active" : ""}`}
          onClick={() => setTab("calendar")}
        >
          Calendar
        </button>
      </div>

      {tab === "requests" && (
        <div className="timeoff-requests">
          {loading ? (
            <p className="loading-state">Loading...</p>
          ) : timeOffRequests.length === 0 ? (
            <p className="empty-state">No time off requests</p>
          ) : (
            <div className="timeoff-list">
              {timeOffRequests.map((r) => (
                <TimeOffCard
                  key={r.id}
                  request={r}
                  onApprove={() => approveTimeOff(r.id, "EMP006")}
                  onReject={() => rejectTimeOff(r.id)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "calendar" && (
        <div className="timeoff-calendar">
          <div className="calendar-nav">
            <button className="btn btn--secondary" onClick={handlePrevMonth}>
              &larr;
            </button>
            <button className="btn btn--secondary" onClick={handleNextMonth}>
              &rarr;
            </button>
          </div>
          <CalendarView
            requests={timeOffRequests}
            month={calendarMonth}
            year={calendarYear}
          />
        </div>
      )}

      <Modal
        open={modalOpen}
        onClose={closeModal}
        title="Request Time Off"
      >
        <TimeOffForm
          employees={employees}
          prefill={prefill}
          onSubmit={handleSubmit}
          onCancel={closeModal}
        />
      </Modal>
    </div>
  );
}
