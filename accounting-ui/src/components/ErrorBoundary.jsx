import { Component } from "react";

const isDev = import.meta.env.DEV;

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    if (isDev) {
      console.error("ErrorBoundary caught an error:", error, info);
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: 24,
            margin: "24px auto",
            maxWidth: 640,
            background: "var(--bg-card, #fff)",
            border: "1px solid #e5484d",
            borderRadius: 8,
          }}
        >
          <h2 style={{ marginTop: 0, color: "#e5484d" }}>Something went wrong</h2>
          <p>
            This page ran into an unexpected error and couldn't finish rendering.
            {this.props.backTo ? " You can go back and try again." : ""}
          </p>
          {isDev && (
            <pre
              style={{
                whiteSpace: "pre-wrap",
                background: "#1e1e1e",
                color: "#f88",
                padding: 12,
                borderRadius: 6,
                fontSize: 12,
                overflowX: "auto",
              }}
            >
              {this.state.error.message}
              {"\n"}
              {this.state.error.stack}
            </pre>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button
              type="button"
              onClick={() => this.setState({ error: null })}
              style={{ padding: "8px 16px", cursor: "pointer" }}
            >
              Try Again
            </button>
            {this.props.backTo && (
              <button
                type="button"
                onClick={() => {
                  this.setState({ error: null });
                  window.location.assign(this.props.backTo);
                }}
                style={{ padding: "8px 16px", cursor: "pointer" }}
              >
                {this.props.backToLabel || "Go Back"}
              </button>
            )}
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
