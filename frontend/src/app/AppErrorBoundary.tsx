import { Component, type ReactNode } from "react";

import {
  toErrorPresentation,
  type ErrorPresentation,
} from "../shared/api/errorPresentation";

type AppErrorBoundaryProps = {
  readonly children: ReactNode;
  readonly onRetry?: () => void;
};

type AppErrorBoundaryState = {
  readonly failure: ErrorPresentation | null;
};

export class AppErrorBoundary extends Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { failure: null };

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return { failure: toErrorPresentation(error) };
  }

  private readonly retry = () => {
    if (this.props.onRetry !== undefined) {
      this.props.onRetry();
      return;
    }
    this.setState({ failure: null });
  };

  render() {
    const { failure } = this.state;
    if (failure === null) return this.props.children;

    return (
      <main className="page">
        <div className="app-message app-message--error" role="alert">
          <p>{failure.message}</p>
          {failure.requestId !== undefined && (
            <p>
              問い合わせID: <code>{failure.requestId}</code>
            </p>
          )}
          <button type="button" onClick={this.retry}>
            再試行
          </button>
        </div>
      </main>
    );
  }
}
