-- RTL-423 (decision ask-no-confirm): an ask that built a dashboard keeps the ids of the widgets it
-- made, so a later change or removal of one sets the outcome to edited. A nullable column on a
-- new table: no rewrite.
ALTER TABLE "ask_requests" ADD COLUMN "widget_ids" jsonb;