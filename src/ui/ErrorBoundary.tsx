import { Component, type ReactNode } from "react";

/** Contains render errors to one region of the UI instead of blanking the whole app. */
export class ErrorBoundary extends Component<{ name: string; children: ReactNode; onReset?: () => void }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) { return { err }; }
  componentDidCatch(err: Error) { console.error(`[${this.props.name}]`, err); }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div className="pm-msg error" style={{ margin: 8 }}>
        <b>{this.props.name} failed to render.</b><br />{this.state.err.message}<br />
        <button className="btn" style={{ marginTop: 6 }} onClick={() => { this.props.onReset?.(); this.setState({ err: null }); }}>Retry</button>
      </div>
    );
  }
}
