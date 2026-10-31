"use client";

import { useEffect } from "react";

/** Last-resort root boundary: every visual dependency is inline. */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[global] render error:", error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background:
            "radial-gradient(circle at 50% 36%, rgba(237, 81, 38, 0.1), transparent 28%), #0a0e0c",
          color: "#f4efe6",
          fontFamily: "system-ui, sans-serif",
          textAlign: "center",
          padding: "1.5rem",
          boxSizing: "border-box",
        }}
      >
        <div
          style={{
            width: "100%",
            maxWidth: "34rem",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            padding: "2.5rem 2rem",
            boxSizing: "border-box",
            border: "1px solid #29312c",
            borderRadius: "1rem",
            background: "rgba(7, 10, 8, 0.94)",
            boxShadow: "0 32px 100px -40px rgba(0, 0, 0, 0.95)",
          }}
        >
          <svg
            viewBox="0 0 552 256"
            role="img"
            aria-label="Honey badger looking for a way home"
            style={{
              display: "block",
              width: "11rem",
              height: "auto",
              color: "#cfc6b7",
              filter: "drop-shadow(0 10px 24px rgba(0, 0, 0, 0.7))",
            }}
          >
            <ellipse cx="276" cy="226" rx="186" ry="25" fill="rgba(237, 81, 38, 0.1)" />
            <path
              fill="currentColor"
              fillRule="evenodd"
              clipRule="evenodd"
              d="M516.661 80.3597C523.746 89.197 549.125 92.252 550.693 99.507C553.93 114.481 536.281 148.864 515.026 150.401C499.246 150.316 483.977 150.401 458.347 150.401C411.384 150.401 389.43 189.762 377.592 212.431C401.327 212.431 427.988 238.991 428.343 255.128H311.405C287.087 254.208 274.5 240.034 261.399 227.432C258.087 224.246 254.828 221.111 251.468 218.242C232.693 202.873 213.414 189.762 190.742 189.762C164.882 189.762 148.941 202.057 140.439 212.431C164.174 212.816 193.018 238.222 194.08 255.128H34.2167C-10.2583 255.128 1.37132 170.982 1.37132 170.982C10.9359 71.0823 81.7848 0 165.741 0C187.704 0 203.645 4.22652 220.295 9.60571C263.161 24.5997 288.421 50.4236 347.469 44.9547C382.199 39.9569 405.626 21.6028 437.092 24.9748C476.398 26.6533 502.591 61.6951 516.661 80.3597ZM485.704 82.3408C485.704 77.0656 458.96 53.5748 437.092 53.5748C415.224 53.5748 388.207 64.9027 388.207 64.9027C369.316 72.5374 352.128 77.388 324.204 77.388C296.28 77.388 273.311 67.9161 259.43 61.6725C234.804 49.3408 197.82 32.1541 164.415 32.1541C49.406 35.2887 27.5914 169.031 34.2167 170.982C43.2003 173.627 77.7448 99.507 164.415 99.507C200.8 99.507 240.83 116.967 240.83 116.967C281.928 138.596 354.15 153.315 395.785 104.87C410.434 95.1171 423.198 86.2937 444.181 84.7187C458.347 83.6555 485.704 87.616 485.704 82.3408Z"
            />
          </svg>
          <p
            style={{
              margin: "1.5rem 0 0",
              color: "#ed5126",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: "0.6875rem",
              textTransform: "uppercase",
              letterSpacing: "0.1em",
            }}
          >
            Root system interrupted
          </p>
          <h1
            style={{
              margin: "0.75rem 0 0",
              fontSize: "1.875rem",
              lineHeight: 1.15,
              fontWeight: 750,
              letterSpacing: "-0.035em",
            }}
          >
            We lost the trail.
          </h1>
          <p
            style={{
              maxWidth: "28rem",
              margin: "1rem 0 0",
              color: "#9f9a90",
              fontSize: "0.875rem",
              lineHeight: 1.6,
            }}
          >
            A temporary error interrupted the app. Try again, or head back to your organizations.
          </p>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              justifyContent: "center",
              gap: "0.75rem",
              marginTop: "1.5rem",
            }}
          >
            <button
              type="button"
              onClick={() => reset()}
              style={{
                borderRadius: "0.5rem",
                border: "none",
                background: "#f4efe6",
                color: "#0a0e0c",
                padding: "0.625rem 1rem",
                fontSize: "0.875rem",
                fontWeight: 650,
                cursor: "pointer",
              }}
            >
              Try again
            </button>
            <a
              href="/organizations"
              style={{
                borderRadius: "0.5rem",
                border: "1px solid #29312c",
                color: "#cfc6b7",
                padding: "0.625rem 1rem",
                fontSize: "0.875rem",
                fontWeight: 600,
                textDecoration: "none",
              }}
            >
              Back to organizations
            </a>
          </div>
          {error.digest && (
            <p
              style={{
                margin: "1.5rem 0 0",
                color: "#716e67",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: "0.625rem",
                textTransform: "uppercase",
                letterSpacing: "0.08em",
              }}
            >
              Reference: {error.digest}
            </p>
          )}
        </div>
      </body>
    </html>
  );
}
