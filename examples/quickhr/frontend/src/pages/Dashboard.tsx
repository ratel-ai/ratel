import { useEffect } from "react";
import { useHRStore } from "../store/hrStore";
import { StatCard } from "../components/StatCard";
import { TimeOffCard } from "../components/TimeOffCard";

export function Dashboard() {
  const { employees, timeOffRequests, stats, fetchEmployees, fetchTimeOffRequests, fetchStats } =
    useHRStore();

  useEffect(() => {
    fetchEmployees();
    fetchTimeOffRequests();
    fetchStats();
  }, [fetchEmployees, fetchTimeOffRequests, fetchStats]);

  const recentHires = [...employees]
    .filter((e) => e.status !== "inactive")
    .sort((a, b) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime())
    .slice(0, 5);

  const pendingRequests = timeOffRequests.filter((r) => r.status === "pending");

  return (
    <div className="page-content">
      <h1>Dashboard</h1>
      <p>Welcome back! Here's your overview.</p>

      <div className="stats-grid">
        <StatCard label="Total Employees" value={stats?.totalEmployees ?? "-"} />
        <StatCard label="Pending Requests" value={stats?.pendingRequests ?? "-"} color="warning" />
        <StatCard label="Active" value={stats?.activeEmployees ?? "-"} color="success" />
        <StatCard label="Onboarding" value={stats?.onboardingEmployees ?? "-"} color="info" />
      </div>

      <div className="dashboard-sections">
        <div className="dashboard-section">
          <h2>Recent Hires</h2>
          {recentHires.length === 0 ? (
            <p className="empty-state">No recent hires</p>
          ) : (
            <div className="recent-hires-list">
              {recentHires.map((e) => (
                <div key={e.id} className="recent-hire-item">
                  <div className="recent-hire-avatar">
                    {e.name.split(" ").map((n) => n[0]).join("").slice(0, 2)}
                  </div>
                  <div className="recent-hire-info">
                    <div className="recent-hire-name">{e.name}</div>
                    <div className="recent-hire-meta">
                      {e.role} • {e.department}
                    </div>
                  </div>
                  <div className="recent-hire-date">
                    {new Date(e.startDate).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="dashboard-section">
          <h2>Pending Time Off</h2>
          {pendingRequests.length === 0 ? (
            <p className="empty-state">No pending requests</p>
          ) : (
            <div className="pending-requests-list">
              {pendingRequests.slice(0, 5).map((r) => (
                <TimeOffCard key={r.id} request={r} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
