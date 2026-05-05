import type { TimeOffRequest } from "../types/hr";

interface TimeOffCardProps {
  request: TimeOffRequest;
  onApprove?: () => void;
  onReject?: () => void;
}

export function TimeOffCard({ request, onApprove, onReject }: TimeOffCardProps) {
  const typeIcons = { vacation: "🏖️", sick: "🤒", personal: "📅" };
  const statusColors = {
    pending: "status--warning",
    approved: "status--active",
    rejected: "status--inactive",
  };

  const formatDate = (d: string) =>
    new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });

  return (
    <div className="timeoff-card">
      <div className="timeoff-card-icon">{typeIcons[request.type]}</div>
      <div className="timeoff-card-info">
        <div className="timeoff-card-name">{request.employeeName}</div>
        <div className="timeoff-card-dates">
          {formatDate(request.startDate)} - {formatDate(request.endDate)} ({request.days} days)
        </div>
        {request.notes && <div className="timeoff-card-notes">{request.notes}</div>}
      </div>
      <div className="timeoff-card-right">
        <span className={`timeoff-card-status ${statusColors[request.status]}`}>
          {request.status}
        </span>
        {request.status === "pending" && onApprove && onReject && (
          <div className="timeoff-card-actions">
            <button className="btn btn--small btn--success" onClick={onApprove}>
              Approve
            </button>
            <button className="btn btn--small btn--danger" onClick={onReject}>
              Reject
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
