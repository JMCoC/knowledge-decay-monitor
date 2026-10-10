import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProcessingStatusBadge } from "@/modules/repository/ui/processing-status-badge";

describe("Repository upload and processing states", () => {
  it("distinguishes no version from an unreconciled legacy version", () => {
    const noVersion = renderToStaticMarkup(createElement(ProcessingStatusBadge, {
      hasVersion: false,
      processingStatus: null,
      uploadState: null,
    }));
    const unreconciled = renderToStaticMarkup(createElement(ProcessingStatusBadge, {
      hasVersion: true,
      processingStatus: "ready",
      uploadState: null,
    }));

    expect(noVersion).toContain("No version");
    expect(unreconciled).toContain("Needs reconciliation");
  });

  it("does not present pending uploads as ready for processing", () => {
    const markup = renderToStaticMarkup(createElement(ProcessingStatusBadge, {
      hasVersion: true,
      processingStatus: "uploaded",
      uploadState: "pending",
    }));

    expect(markup).toContain("Upload incomplete");
  });

  it("shows processing only after a confirmed upload", () => {
    const markup = renderToStaticMarkup(createElement(ProcessingStatusBadge, {
      hasVersion: true,
      processingStatus: "uploaded",
      uploadState: "confirmed",
    }));

    expect(markup).toContain("Uploaded");
  });
  it("identifies an accepted durable job as queued", () => {
    const markup=renderToStaticMarkup(createElement(ProcessingStatusBadge,{
      hasVersion:true,processingStatus:"uploaded",uploadState:"confirmed",processingQueued:true,
    }));
    expect(markup).toContain("Queued");
  });
});
