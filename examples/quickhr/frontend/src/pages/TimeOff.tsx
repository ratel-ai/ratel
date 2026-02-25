import { useEffect, useState } from "react";
import { useHRStore } from "../store/hrStore";
import { TimeOffCard } from "../components/TimeOffCard";
import { TimeOffForm } from "../components/TimeOffForm";
import { CalendarView } from "../components/CalendarView";
import { Modal } from "../components/Modal";

type TabType = "requests" | "calendar";

export function TimeOff() {
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

  const [tab, setTab] = useState<TabType>("requests");
  const [modalOpen, setModalOpen] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(new Date().getMonth());
  const [calendarYear, setCalendarYear] = useState(new Date().getFullYear());

  useEffect(() => {
    fetchEmployees();
    fetchTimeOffRequests();
  }, [fetchEmployees, fetchTimeOffRequests]);

  const handleSubmit = async (
    data: Parameters<typeof createTimeOffRequest>[0]
  ) => {
    await createTimeOffRequest(data);
    setModalOpen(false);
  };

  const handlePrevMonth = () => {
    if (calendarMonth === 0) {
      setCalendarMonth(11);
      setCalendarYear(calendarYear - 1);
    } else {
      setCalendarMonth(calendarMonth - 1);
    }
  };

  const handleNextMonth = () => {
    if (calendarMonth === 11) {
      setCalendarMonth(0);
      setCalendarYear(calendarYear + 1);
    } else {
      setCalendarMonth(calendarMonth + 1);
    }
  };

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>Time Off</h1>
          <p>Review and manage PTO requests.</p>
        </div>
        <button className="btn btn--primary" onClick={() => setModalOpen(true)}>
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
        onClose={() => setModalOpen(false)}
        title="Request Time Off"
      >
        <TimeOffForm
          employees={employees}
          onSubmit={handleSubmit}
          onCancel={() => setModalOpen(false)}
        />
      </Modal>
    </div>
  );
}
