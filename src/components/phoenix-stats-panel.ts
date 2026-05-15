import { Box, Container, Text } from '@mariozechner/pi-tui';
import { theme } from '../theme.js';
import {
  fetchPhoenixStats,
  type PhoenixEvaluatorScore,
  type PhoenixStats,
} from '../observability/phoenixStats.js';

type State =
  | { kind: 'hidden' }
  | { kind: 'loading' }
  | { kind: 'ok'; stats: PhoenixStats; fetchedAt: number }
  | { kind: 'offline'; endpoint: string; reason: string };

function colorScore(score: number | null): (text: string) => string {
  if (score === null) return theme.muted;
  if (score < 0.6) return theme.error;
  if (score < 0.8) return theme.warning;
  return theme.success;
}

function formatScore(e: PhoenixEvaluatorScore): string {
  if (e.meanScore === null) return theme.muted(`${e.name} —`);
  const colored = colorScore(e.meanScore)(e.meanScore.toFixed(2));
  return `${theme.muted(e.name)} ${colored}`;
}

function formatLatency(ms: number): string {
  if (ms < 1) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export class PhoenixStatsPanelComponent extends Container {
  private readonly box: Box;
  private state: State = { kind: 'hidden' };
  private requestVersion = 0;
  private requestRender: () => void;

  constructor(requestRender: () => void) {
    super();
    this.requestRender = requestRender;
    this.box = new Box(1, 0, () => '');
    this.addChild(this.box);
    this.refresh();
  }

  isVisible(): boolean {
    return this.state.kind !== 'hidden';
  }

  hide(): void {
    this.state = { kind: 'hidden' };
    this.refresh();
    this.requestRender();
  }

  /**
   * Toggle panel and trigger a fresh fetch when revealed. Concurrent calls
   * are race-safe via requestVersion — only the latest fetch can mutate state.
   */
  async toggle(): Promise<void> {
    if (this.state.kind !== 'hidden') {
      this.hide();
      return;
    }
    await this.refreshFetch();
  }

  async refreshFetch(): Promise<void> {
    this.state = { kind: 'loading' };
    this.refresh();
    this.requestRender();

    const myVersion = ++this.requestVersion;
    const result = await fetchPhoenixStats();
    if (myVersion !== this.requestVersion) return;

    if (result.kind === 'ok') {
      this.state = { kind: 'ok', stats: result.stats, fetchedAt: Date.now() };
    } else {
      this.state = { kind: 'offline', endpoint: result.endpoint, reason: result.reason };
    }
    this.refresh();
    this.requestRender();
  }

  private refresh(): void {
    this.box.clear();
    if (this.state.kind === 'hidden') return;

    if (this.state.kind === 'loading') {
      this.box.addChild(new Text(theme.muted('─ Phoenix ─'), 0, 0));
      this.box.addChild(new Text(theme.muted('fetching project stats…'), 0, 0));
      return;
    }

    if (this.state.kind === 'offline') {
      this.box.addChild(new Text(theme.mutedDark('─ Phoenix ─'), 0, 0));
      this.box.addChild(
        new Text(theme.mutedDark(`Phoenix offline · ${this.state.endpoint}`), 0, 0),
      );
      this.box.addChild(new Text(theme.mutedDark(`(${this.state.reason})`), 0, 0));
      return;
    }

    const { stats } = this.state;
    this.box.addChild(
      new Text(`${theme.dim('─ Phoenix ─')} ${theme.muted(stats.projectName)}`, 0, 0),
    );

    const headerParts = [
      `${theme.muted('traces')} ${stats.traceCount}`,
      `${theme.muted('cost')} ${formatCost(stats.costUsd)}`,
      `${theme.muted('p50')} ${formatLatency(stats.p50Ms)}`,
      `${theme.muted('p99')} ${formatLatency(stats.p99Ms)}`,
    ];
    this.box.addChild(new Text(headerParts.join('   '), 0, 0));

    if (stats.evaluators.length > 0) {
      // Two-per-line layout to keep the panel short under DebugPanel.
      const cells = stats.evaluators.map(formatScore);
      for (let i = 0; i < cells.length; i += 2) {
        const line = cells.slice(i, i + 2).join('   ');
        this.box.addChild(new Text(line, 0, 0));
      }
    }
  }
}
