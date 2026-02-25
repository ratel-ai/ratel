import { useMemo } from "react";
import type { TimeOffRequest } from "../types/hr";

interface CalendarViewProps {
  requests: TimeOffRequest[];
  month: number; // 0-11
  year: number;
}

export function CalendarView({ requests, month, year }: CalendarViewProps) {
  const calendar = useMemo(() => {
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const daysInMonth = lastDay.getDate();
    const startOffset = firstDay.getDay();

    const days: Array<{ date: number | null; requests: TimeOffRequest[] }> = [];

    // Empty cells for offset
    for (let i = 0; i < startOffset; i++) {
      days.push({ date: null, requests: [] });
    }

    // Days with requests
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const dayRequests = requests.filter((r) => {
        if (r.status !== "approved") return false;
        return dateStr >= r.startDate && dateStr <= r.endDate;
      });
      days.push({ date: d, requests: dayRequests });
    }

    return days;
  }, [requests, month, year]);

  const monthName = new Date(year, month).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });

  return (
    <div className="calendar-view">
      <div className="calendar-header">{monthName}</div>
      <div className="calendar-weekdays">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <div key={d} className="calendar-weekday">{d}</div>
        ))}
      </div>
      <div className="calendar-grid">
        {calendar.map((day, i) => (
          <div
            key={i}
            className={`calendar-day ${day.date ? "" : "calendar-day--empty"} ${day.requests.length ? "calendar-day--has-pto" : ""}`}
          >
            {day.date && (
              <>
                <span className="calendar-day-num">{day.date}</span>
                {day.requests.length > 0 && (
                  <div className="calendar-day-pto">
                    {day.requests.slice(0, 2).map((r) => (
                      <div key={r.id} className="calendar-pto-dot" title={r.employeeName}>
                        {r.employeeName.slice(0, 2)}
                      </div>
                    ))}
                    {day.requests.length > 2 && (
                      <div className="calendar-pto-more">+{day.requests.length - 2}</div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
