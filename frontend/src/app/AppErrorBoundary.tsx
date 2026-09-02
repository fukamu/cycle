import { Component, type ReactNode } from "react";

import {
  toErrorPresentation,
  type ErrorPresentation,
} from "../shared/api/errorPresentation";
import { isRouteModuleLoadError } from "./routeModuleLoader";

type AppErrorBoundaryProps = {
  readonly children: ReactNode;
  readonly onRetry?: () => void;
  readonly onRouteModuleRetry?: () => void;
};

type AppFailure = {
  readonly presentation: ErrorPresentation;
  readonly retryWithReload: boolean;
};

type AppErrorBoundaryState = {
  readonly failure: AppFailure | null;
};

export class AppErrorBoundary extends Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { failure: null };

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return {
      failure: {
        presentation: toErrorPresentation(error),
        retryWithReload: isRouteModuleLoadError(error),
      },
    };
  }

  private readonly retry = () => {
    if (
      this.state.failure?.retryWithReload === true &&
      this.props.onRouteModuleRetry !== undefined
    ) {
      this.props.onRouteModuleRetry();
      return;
    }
    if (this.props.onRetry !== undefined) {
      this.props.onRetry();
      return;
    }
    this.setState({ failure: null });
  };

  render() {
    const { failure } = this.state;
    if (failure === null) return this.props.children;
    const { presentation } = failure;

    return (
      <main className="page">
        <div className="app-message app-message--error" role="alert">
          <p>{presentation.message}</p>
          {presentation.requestId !== undefined && (
            <p>
              問い合わせID: <code>{presentation.requestId}</code>
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
