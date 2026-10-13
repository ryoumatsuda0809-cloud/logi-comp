import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ReportDocument, type ReportData } from "./ReportDocument";

const report: ReportData = {
  id: "11111111-2222-3333-4444-555555555555",
  report_date: "2026-10-13",
  vehicle_class: "4t",
  total_wait_minutes: 45,
  estimated_wait_cost: 750,
  formal_report: null,
  has_discrepancy: false,
  timeline_snapshot: [],
  submitted_at: "2026-10-13T09:00:00Z",
  organization_id: null,
  user_id: null,
};

describe("ReportDocument — 未確認の施設の注記", () => {
  afterEach(() => cleanup());

  it("未確認の施設での打刻があれば、位置が未確認と明記する", () => {
    render(
      <ReportDocument
        report={report}
        parties={{ carrier: "運送A", shippers: ["甲社"], unverifiedFacilities: ["第二物流センター"] }}
      />,
    );
    expect(screen.getByText(/施設の位置は未確認です（第二物流センター）/)).toBeTruthy();
    expect(screen.getByText(/荷主の敷地であることは確認されていません/)).toBeTruthy();
  });

  it("確認済みの施設だけなら、注記は出さない", () => {
    render(<ReportDocument report={report} parties={{ carrier: "運送A", shippers: ["甲社"] }} />);
    expect(screen.queryByText(/施設の位置は未確認です/)).toBeNull();
  });
});
